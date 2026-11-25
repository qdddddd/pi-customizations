/**
 * Reader for Claude Code (2.1.x) session transcripts, ~/.claude/projects/<project>/<session>.jsonl.
 *
 * Rebuilds the conversation the way `claude --resume` does and converts it into pi messages:
 *  - the active branch is the parentUuid chain ending at the last entry in the file;
 *  - a compact boundary starts a chain. Its summary message replaces everything before it, and the
 *    "preserved segment" it names (messages kept verbatim) is spliced in after the summary;
 *  - one API response is stored as several entries sharing message.id. The chain can run through the
 *    result of one tool call and leave the response's other blocks and their results on side branches,
 *    so blocks are gathered by message.id and results by tool_use id from all retained entries.
 *
 * Secrets are redacted while reading, before any text is clipped. This module has no pi runtime
 * dependencies so it can be tested with plain node.
 */
import { execFile } from "node:child_process";
import { createReadStream, existsSync } from "node:fs";
import { open, readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { AssistantMessage, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";

// Claude Code entries are loosely typed JSON; fields are validated where they are read.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

export const claudeDir = () => process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
/** Claude Code names a project directory after the project path with every non-alphanumeric character replaced. */
export const encodeProject = (path: string) => path.replace(/[^a-zA-Z0-9]/g, "-");

// ---------------------------------------------------------------------------------------------
// Session discovery
// ---------------------------------------------------------------------------------------------

export interface SessionInfo {
	id: string;
	path: string;
	/** Name of the directory under ~/.claude/projects that holds the transcript. */
	project: string;
	size: number;
	mtimeMs: number;
	title?: string;
	prompt?: string;
	cwd?: string;
	/** Timestamp of the newest conversation entry, the same entry an import ends with. */
	lastTs?: number;
	live?: { pid: number; status?: string };
}

const TAIL = 256 * 1024;
// Claude Code records its own side queries (prompt suggestions, tool-result and away summaries, forked
// reviewers) as sessions; about a third of all sessions are these, and none is work to continue.
const HELPER_SESSION = /^(?:Human: |\[(?:SUGGESTION MODE|tool result)\b|Describe your most recent action|The user stepped away and is coming back)/;
const HELPER_MARGIN = 40;
const STUB_SIZE = 20_000;

async function readRange(path: string, position: number, length: number): Promise<string> {
	const handle = await open(path, "r");
	try {
		const buffer = Buffer.alloc(length);
		const { bytesRead } = await handle.read(buffer, 0, length, position);
		return buffer.toString("utf8", 0, bytesRead);
	} finally {
		await handle.close();
	}
}

function lastField(lines: string[], type: string, key: string): string | undefined {
	const prefix = `{"type":"${type}"`;
	for (let i = lines.length - 1; i >= 0; i--) {
		if (!lines[i].startsWith(prefix)) continue;
		try {
			const value = JSON.parse(lines[i])[key];
			if (typeof value === "string" && value) return value;
		} catch {
			// partial line from a session that is still being written
		}
	}
	return undefined;
}

/** Title, last prompt and cwd come from the tail of the file: Claude Code re-appends them every turn. */
async function peek(path: string, size: number): Promise<Pick<SessionInfo, "title" | "prompt" | "cwd" | "lastTs">> {
	const tail = await readRange(path, Math.max(0, size - TAIL), TAIL);
	const lines = (size > TAIL ? tail.slice(tail.indexOf("\n") + 1) : tail).split("\n");
	let last: Entry | undefined;
	for (let i = lines.length - 1; i >= 0 && !last; i--) {
		if (!lines[i] || METADATA_LINE.test(lines[i].slice(0, 40))) continue;
		try {
			last = slim(JSON.parse(lines[i]));
		} catch {
			// partial line
		}
	}
	return {
		title: lastField(lines, "custom-title", "customTitle") ?? lastField(lines, "agent-name", "agentName") ?? lastField(lines, "ai-title", "aiTitle"),
		prompt: lastField(lines, "last-prompt", "lastPrompt"),
		cwd: last?.cwd,
		lastTs: last?.ts,
	};
}

/** Start time of each running process among `pids`. */
async function processStarts(pids: number[]): Promise<Map<number, number>> {
	const starts = new Map<number, number>();
	if (pids.length === 0) return starts;
	// ps exits non-zero when some of the pids are gone, but still lists the others.
	const output = await promisify(execFile)("ps", ["-o", "pid=,lstart=", "-p", pids.join(",")], { env: { ...process.env, LC_ALL: "C" } }).then(
		(result) => result.stdout,
		(error) => String(error?.stdout ?? ""),
	);
	for (const line of output.split("\n")) {
		const match = /^\s*(\d+)\s+(.+?)\s*$/.exec(line);
		const started = match ? Date.parse(match[2]) : NaN;
		if (match && Number.isFinite(started)) starts.set(Number(match[1]), started);
	}
	return starts;
}

/**
 * Claude Code sessions that are still running, keyed by session id. Claude Code leaves a record per process in
 * ~/.claude/sessions; a process that started after the session did has reused a dead process's pid.
 */
export async function liveSessions(): Promise<Map<string, { pid: number; status?: string }>> {
	const dir = join(claudeDir(), "sessions");
	const records = (
		await Promise.all(
			(await readdir(dir).catch(() => [] as string[])).filter((name) => name.endsWith(".json")).map((name) => readFile(join(dir, name), "utf8").then((text) => JSON.parse(text), () => undefined)),
		)
	).filter((record) => Number.isInteger(record?.pid) && typeof record.sessionId === "string");
	const starts = await processStarts(records.map((record) => record.pid));
	const live = new Map<string, { pid: number; status?: string }>();
	for (const record of records) {
		// startedAt is in milliseconds; procStart is the process start in UTC, written by older versions.
		const began = typeof record.startedAt === "number" ? record.startedAt : Date.parse(`${record.procStart} UTC`);
		const started = starts.get(record.pid);
		// ps reports whole seconds.
		if (started !== undefined && started <= began + 2000) live.set(record.sessionId, { pid: record.pid, status: record.status });
	}
	return live;
}

/**
 * Most recent sessions first. Only top-level <project>/<id>.jsonl files are sessions; subagent
 * transcripts live in <project>/<id>/subagents/ and are never listed.
 */
export async function listSessions(projects: string[] | "all", limit: number): Promise<SessionInfo[]> {
	const root = join(claudeDir(), "projects");
	// Magpie's scratch sessions (thousands of one-shot classifier runs) would drown real work.
	const names = projects === "all" ? (await readdir(root).catch(() => [] as string[])).filter((name) => !name.startsWith("-private-var-folders")) : projects;
	const files = (
		await Promise.all(
			names.map(async (project) => {
				const entries = await readdir(join(root, project)).catch(() => [] as string[]);
				return Promise.all(
					entries
						.filter((name) => name.endsWith(".jsonl"))
						.map(async (name) => {
							const path = join(root, project, name);
							const info = await stat(path).catch(() => undefined);
							return info && info.size > 1024 ? { id: name.slice(0, -6), path, project, size: info.size, mtimeMs: info.mtimeMs } : undefined;
						}),
				);
			}),
		)
	)
		.flat()
		.filter((file): file is NonNullable<typeof file> => !!file)
		.sort((a, b) => b.mtimeMs - a.mtimeMs)
		.slice(0, limit + HELPER_MARGIN);
	const live = await liveSessions();
	const sessions = await Promise.all(
		files.map(async (file): Promise<SessionInfo | undefined> => {
			const meta = await peek(file.path, file.size).catch(() => undefined);
			return meta && { ...file, ...meta, live: live.get(file.id) }; // unreadable (e.g. root-owned) sessions cannot be imported
		}),
	);
	// Claude Code re-appends the title and last prompt every turn, so a small session with neither never held a conversation.
	const real = (session: SessionInfo) => !!(session.title || session.prompt) || session.size > STUB_SIZE;
	return sessions.filter((session): session is SessionInfo => !!session && real(session) && !HELPER_SESSION.test(session.prompt ?? "")).slice(0, limit);
}

// ---------------------------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------------------------

/** The parts of a conversation entry the importer needs. Everything else is dropped while reading. */
export interface Entry {
	uuid: string;
	parent: string | null;
	type: "user" | "assistant" | "system" | "attachment";
	ts: number;
	cwd?: string;
	branch?: string;
	meta?: boolean; // user: isMeta
	summary?: boolean; // user: isCompactSummary
	origin?: Json; // user: { kind: "human" | "peer" | "task-notification" | ... }
	content?: Json; // user: string | blocks; assistant: text and tool_use blocks
	mid?: string; // assistant: message.id shared by the entries of one API response
	model?: string;
	subtype?: string; // system
	compact?: Json; // compact_boundary: compactMetadata
	logicalParent?: string | null; // compact_boundary: the last entry before the compaction
	attachment?: Json; // queued_command and task_reminder only
}

export interface Loaded {
	/** Entries since the last compact boundary, in file order (the boundary itself first). */
	seg: Entry[];
	/** The entries that precede that boundary, newest WINDOW only: the source of its preserved segment. */
	window: Entry[];
	boundaries: number;
	/** Memory directory named in the session's latest system prompt. */
	memoryDir?: string;
}

const WINDOW = 600;
/** Per-string cap while reading, so a 100 MB transcript does not become 100 MB of heap. */
const STORE_CAP = 12_000;
// Metadata entries (titles, API request logs, file history, ...) start with {"type":"<name>"; they are skipped unparsed.
const METADATA_LINE = /^\{"type":"(?!user"|assistant"|system"|attachment")/;
const MEMORY_PROMPT = /persistent file-based memory at `([^`]+)`/;

export function clipMiddle(text: string, max: number): string {
	if (text.length <= max) return text;
	const head = Math.ceil(max * 0.6);
	return `${text.slice(0, head)}\n[… ${text.length - max} characters omitted …]\n${text.slice(text.length - (max - head))}`;
}

const clean = (text: string, cap = STORE_CAP) => clipMiddle(redact(text), cap);

function mapStrings(value: Json, fn: (text: string) => string): Json {
	if (typeof value === "string") return fn(value);
	if (Array.isArray(value)) return value.map((item) => mapStrings(item, fn));
	if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, mapStrings(item, fn)]));
	return value;
}

/** Text is redacted and clipped; images keep their data, which must never pass through redaction. */
function slimUserContent(content: Json, cap: number): Json {
	if (typeof content === "string") return clean(content, cap);
	if (!Array.isArray(content)) return content;
	return content.map((block: Json) => {
		if (block?.type === "text") return { type: "text", text: clean(String(block.text ?? ""), cap) };
		if (block?.type !== "tool_result") return block;
		const inner = block.content;
		return {
			type: "tool_result",
			tool_use_id: block.tool_use_id,
			is_error: block.is_error,
			content: typeof inner === "string" ? clean(inner) : Array.isArray(inner) ? inner.map((part: Json) => (part?.type === "text" ? { type: "text", text: clean(String(part.text ?? "")) } : part?.type === "image" ? { type: "image" } : part)) : inner,
		};
	});
}

function slim(raw: Json): Entry | undefined {
	const type = raw.type;
	if (raw.isSidechain || typeof raw.uuid !== "string") return undefined;
	if (type !== "user" && type !== "assistant" && type !== "system" && type !== "attachment") return undefined;
	const entry: Entry = { uuid: raw.uuid, parent: raw.parentUuid ?? null, type, ts: Date.parse(raw.timestamp) || 0, cwd: raw.cwd, branch: raw.gitBranch };
	if (type === "user") {
		entry.meta = !!raw.isMeta;
		entry.summary = !!raw.isCompactSummary;
		entry.origin = raw.origin;
		// Claude Code's compaction summary is kept whole; it replaces everything before it.
		entry.content = slimUserContent(raw.message?.content, entry.summary ? Infinity : STORE_CAP);
	} else if (type === "assistant") {
		entry.mid = raw.message?.id ?? raw.uuid;
		entry.model = raw.message?.model;
		const blocks: Json[] = Array.isArray(raw.message?.content) ? raw.message.content : [];
		entry.content = blocks
			.filter((block) => block?.type === "text" || block?.type === "tool_use")
			.map((block) => (block.type === "tool_use" ? { type: "tool_use", id: block.id, name: block.name, input: mapStrings(block.input, (text) => clean(text)) } : { type: "text", text: clean(String(block.text ?? "")) }));
	} else if (type === "system") {
		entry.subtype = raw.subtype;
		if (raw.subtype === "compact_boundary") {
			entry.compact = raw.compactMetadata;
			entry.logicalParent = raw.logicalParentUuid ?? null;
		}
	} else if (raw.attachment?.type === "queued_command" || raw.attachment?.type === "task_reminder") {
		entry.attachment = mapStrings(raw.attachment, (text) => clean(text));
	}
	return entry;
}

/**
 * JSONL records split on LF only. node:readline also splits on U+2028 and U+2029, which JSON allows
 * unescaped inside strings, and would cut such a record in two.
 */
async function* jsonlLines(path: string): AsyncGenerator<string> {
	let pending: string[] = [];
	for await (const chunk of createReadStream(path, { encoding: "utf8", highWaterMark: 1 << 20 }) as AsyncIterable<string>) {
		let start = 0;
		for (let newline = chunk.indexOf("\n"); newline !== -1; newline = chunk.indexOf("\n", start)) {
			pending.push(chunk.slice(start, newline));
			yield pending.join("");
			pending = [];
			start = newline + 1;
		}
		if (start < chunk.length) pending.push(chunk.slice(start));
	}
	if (pending.length) yield pending.join("");
}

export async function loadTranscript(path: string, signal?: AbortSignal): Promise<Loaded> {
	let seg: Entry[] = [];
	let window: Entry[] = [];
	let boundaries = 0;
	let memoryDir: string | undefined;
	for await (const line of jsonlLines(path)) {
		signal?.throwIfAborted();
		if (METADATA_LINE.test(line.slice(0, 40))) continue;
		let raw: Json;
		try {
			raw = JSON.parse(line);
		} catch {
			continue; // partial last line of a session that is still being written
		}
		if (raw.attachment?.type === "prompt_snapshot") {
			const found = MEMORY_PROMPT.exec(JSON.stringify(raw.attachment.systemPrompt ?? ""));
			if (found) memoryDir = found[1].replace(/\/+$/, "");
		}
		const entry = slim(raw);
		if (!entry) continue;
		if (entry.subtype === "compact_boundary") {
			window = [...window, ...seg].slice(-WINDOW);
			seg = [];
			boundaries++;
		}
		seg.push(entry);
	}
	return { seg, window, boundaries, memoryDir };
}

// ---------------------------------------------------------------------------------------------
// Active conversation
// ---------------------------------------------------------------------------------------------

export interface Chain {
	/** Root to leaf, with the preserved segment spliced in after the compaction summary. */
	entries: Entry[];
	index: Map<string, Entry>;
	summary?: Entry;
	boundary?: Entry;
}

export function buildChain(loaded: Loaded): Chain {
	const index = new Map<string, Entry>();
	for (const entry of [...loaded.window, ...loaded.seg]) index.set(entry.uuid, entry);
	// shortcut: the leaf is the last entry in the file. It matched the latest childless entry in every
	// transcript checked; a rewind past a compaction would need the full parent graph.
	const path: Entry[] = [];
	const seen = new Set<string>();
	for (let cur = loaded.seg.at(-1); cur && !seen.has(cur.uuid); cur = cur.parent ? index.get(cur.parent) : undefined) {
		seen.add(cur.uuid);
		path.push(cur);
	}
	path.reverse();

	const boundary = path[0]?.subtype === "compact_boundary" ? path[0] : undefined;
	const summary = path.find((entry) => entry.summary);
	const preserved = boundary?.compact?.preservedSegment;
	if (preserved && summary) {
		// A segment can reach back past an earlier compaction; its boundary continues at the entry it replaced.
		const up = (entry: Entry) => (entry.subtype === "compact_boundary" ? entry.logicalParent : entry.parent);
		const kept: Entry[] = [];
		for (let cur = index.get(preserved.tailUuid); cur && kept.length < 2000; cur = up(cur) ? index.get(up(cur)!) : undefined) {
			kept.push(cur);
			if (cur.uuid === preserved.headUuid) break;
		}
		// A partial segment (head missing from the file) would start mid-conversation, so it is skipped.
		if (kept.at(-1)?.uuid === preserved.headUuid) {
			const at = path.findIndex((entry) => entry.uuid === (preserved.anchorUuid ?? summary.uuid));
			const after = (at >= 0 ? at : path.indexOf(summary)) + 1;
			path.splice(after, 0, ...kept.reverse().filter((entry) => !seen.has(entry.uuid)));
		}
	}
	return { entries: path, index, summary, boundary };
}

interface Result {
	text: string;
	isError: boolean;
}

function resultText(content: Json): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part: Json) => (part?.type === "text" ? String(part.text ?? "") : part?.type === "image" ? "[image omitted]" : part?.type === "tool_reference" ? `[tool: ${part.tool_name}]` : ""))
		.filter(Boolean)
		.join("\n");
}

/** Tool results by tool_use id. Results on the active chain win; the rest of the file fills in parallel calls. */
function toolResults(chain: Chain): Map<string, Result> {
	const results = new Map<string, Result>();
	for (const entry of [...chain.entries, ...chain.index.values()]) {
		if (entry.type !== "user" || !Array.isArray(entry.content)) continue;
		for (const block of entry.content) {
			if (block?.type === "tool_result" && typeof block.tool_use_id === "string" && !results.has(block.tool_use_id)) {
				results.set(block.tool_use_id, { text: resultText(block.content), isError: !!block.is_error });
			}
		}
	}
	return results;
}

// ---------------------------------------------------------------------------------------------
// Conversion to pi messages
// ---------------------------------------------------------------------------------------------

export type PiMessage = UserMessage | AssistantMessage | ToolResultMessage;

export interface Msg {
	message: PiMessage;
	tokens: number;
	ts: number;
	/** One-line text of a user message that starts a turn, for the outline of what was left out. */
	prompt?: string;
}

const CAPS = { text: 8000, prompt: 12_000, result: 4000, command: 4000, arg: 1500, bash: 2500, read: 500, edit: 300, other: 1500, error: 800 };
const IMAGE_TOKENS = 1500;
const MAX_IMAGES = 6;
const MAX_IMAGE_BASE64 = 3_000_000;
const SYSTEM_REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>\s*/g;
// Built-in slash commands whose echo says nothing about the work.
const SKIPPED_COMMANDS = /^\/(?:compact|clear|model|effort|status|help|cost|usage|context|config|theme|vim|rename|resume|exit|login|logout|doctor|memory|fast|ide|permissions)$/;
const ZERO_USAGE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

const oneLine = (text: string, max: number) => {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

export function stamp(ms: number): string {
	const d = new Date(ms);
	const p = (n: number) => String(n).padStart(2, "0");
	return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Claude Code's file and shell tools appear under pi's names so the model keeps using the tools it has. */
function mapTool(name: string, input: Json): { name: string; args: Json } {
	const text = (value: Json) => (typeof value === "string" ? value : undefined);
	const path = text(input?.file_path);
	if (name === "Bash" && text(input?.command) !== undefined) {
		return { name: "bash", args: { command: input.command, ...(typeof input.timeout === "number" ? { timeout: Math.ceil(input.timeout / 1000) } : {}) } };
	}
	if (name === "Read" && path) {
		return { name: "read", args: { path, ...(typeof input.offset === "number" ? { offset: input.offset } : {}), ...(typeof input.limit === "number" ? { limit: input.limit } : {}) } };
	}
	if (name === "Write" && path && text(input?.content) !== undefined) return { name: "write", args: { path, content: input.content } };
	if (name === "Edit" && path && text(input?.old_string) !== undefined && text(input?.new_string) !== undefined) {
		return { name: "edit", args: { path, edits: [{ oldText: input.old_string, newText: input.new_string }] } };
	}
	if (name === "MultiEdit" && path && Array.isArray(input?.edits)) {
		return { name: "edit", args: { path, edits: input.edits.map((edit: Json) => ({ oldText: edit?.old_string, newText: edit?.new_string })) } };
	}
	return { name, args: input ?? {} };
}

function resultCap(tool: string, isError: boolean): number {
	if (isError) return CAPS.error;
	return tool === "bash" ? CAPS.bash : tool === "read" ? CAPS.read : tool === "edit" || tool === "write" ? CAPS.edit : CAPS.other;
}

// CJK characters are about one token each; the rest of these transcripts (commands, JSON, logs, prose)
// averages about 3.2 characters per token.
const WIDE = /[\u2e80-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]/g;
const textTokens = (text: string) => {
	const wide = text.match(WIDE)?.length ?? 0;
	return (text.length - wide) / 3.2 + wide;
};

export function estimateTokens(message: PiMessage): number {
	let tokens = 8;
	const content = message.content;
	if (typeof content === "string") tokens += textTokens(content);
	else {
		for (const block of content) {
			if (block.type === "text") tokens += textTokens(block.text);
			else if (block.type === "image") tokens += IMAGE_TOKENS;
			else if (block.type === "toolCall") tokens += textTokens(block.name + JSON.stringify(block.arguments));
		}
	}
	return Math.ceil(tokens);
}

interface Input {
	text: string;
	/** Base64 image sources ({ data, media_type }). */
	images: Json[];
	turn: boolean;
}

/** Text that stands for a user entry, or undefined when it carries nothing worth replaying. */
function userInput(entry: Entry, content: Json, origin: Json, meta: boolean): Input | undefined {
	if (entry.summary) return undefined;
	const blocks: Json[] = Array.isArray(content) ? content : [];
	const images = blocks.filter((block) => block?.type === "image" && block.source?.type === "base64" && typeof block.source.data === "string").map((block) => block.source);
	let text = (typeof content === "string" ? content : blocks.filter((block) => block?.type === "text").map((block) => String(block.text ?? "")).join("\n")).replace(SYSTEM_REMINDER, "").trim();
	if (!text && images.length === 0) return undefined;
	if (/^<local-command-(?:caveat|stdout|stderr)>/.test(text)) return undefined;

	const command = /<command-name>\s*(\/[^<\s]+)\s*<\/command-name>/.exec(text);
	if (command) {
		if (SKIPPED_COMMANDS.test(command[1])) return undefined;
		const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(text)?.[1].trim();
		return { text: args ? `${command[1]} ${args}` : command[1], images, turn: true };
	}
	if (/^\[Request interrupted by user/.test(text)) return { text, images, turn: false };
	const kind: string | undefined = origin?.kind;
	if (kind === "peer") {
		const body = /<cross-session-message[^>]*>([\s\S]*?)<\/cross-session-message>/.exec(text)?.[1].trim() ?? text.replace(/^Another Claude session sent a message:\s*/, "");
		return { text: `[Message from Claude Code session "${origin?.name ?? "peer"}"]\n${body}`, images, turn: false };
	}
	if (kind === "task-notification") {
		const summary = /<summary>([\s\S]*?)<\/summary>/.exec(text)?.[1].trim() ?? oneLine(text, 300);
		const status = /<status>([\s\S]*?)<\/status>/.exec(text)?.[1].trim();
		const result = /<result>([\s\S]*?)<\/result>/.exec(text)?.[1].trim();
		return { text: `[Background task${status ? ` ${status}` : ""}] ${summary}${result ? `\n${clipMiddle(result, CAPS.result)}` : ""}`, images, turn: false };
	}
	if (meta) return undefined; // skill bodies and other harness-injected context
	if (kind && kind !== "human") text = `[${kind}] ${text}`;
	return { text, images, turn: true };
}

function convert(chain: Chain, cost: (message: PiMessage) => number) {
	const results = toolResults(chain);
	// Every retained fragment of a response that reaches the active chain, in file order.
	const active = new Set(chain.entries.filter((entry) => entry.type === "assistant").map((entry) => entry.mid!));
	const groups = new Map<string, Entry[]>();
	for (const entry of chain.index.values()) {
		if (entry.type === "assistant" && active.has(entry.mid!)) groups.set(entry.mid!, [...(groups.get(entry.mid!) ?? []), entry]);
	}
	const emitted = new Set<string>();
	const peers = new Set<string>();
	const messages: Msg[] = [];
	let tasks: Json[] = [];
	let model: string | undefined;

	const addUser = (entry: Entry, content: Json, origin: Json, meta: boolean) => {
		const input = userInput(entry, content, origin, meta);
		if (!input) return;
		if (origin?.msg_id) {
			if (peers.has(origin.msg_id)) return; // one peer message arrives both as an attachment and as a user entry
			peers.add(origin.msg_id);
		}
		const text = clipMiddle(input.text, CAPS.prompt);
		const images = input.images.filter((source) => source.data.length <= MAX_IMAGE_BASE64).map((source) => ({ type: "image" as const, data: source.data as string, mimeType: String(source.media_type ?? "image/png") }));
		const message: UserMessage = { role: "user", content: images.length ? [...(text ? [{ type: "text" as const, text }] : []), ...images] : text, timestamp: entry.ts };
		messages.push({ message, tokens: cost(message), ts: entry.ts, prompt: input.turn ? oneLine(text, 200) : undefined });
	};

	for (const entry of chain.entries) {
		if (entry.type === "user") {
			addUser(entry, entry.content, entry.origin, !!entry.meta);
		} else if (entry.type === "attachment") {
			const attachment = entry.attachment;
			if (attachment?.type === "task_reminder" && Array.isArray(attachment.content)) tasks = attachment.content;
			else if (attachment?.type === "queued_command" && typeof attachment.prompt === "string") addUser(entry, attachment.prompt, attachment.origin, false);
		} else if (entry.type === "assistant" && !emitted.has(entry.mid!)) {
			emitted.add(entry.mid!);
			const group = groups.get(entry.mid!)!;
			if (group[0].model === "<synthetic>") continue; // API errors and "no response" placeholders
			const content: AssistantMessage["content"] = [];
			const calls: { id: string; tool: string }[] = [];
			const seenBlocks = new Set<string>();
			for (const part of group) {
				for (const block of part.content as Json[]) {
					const key = block.type === "tool_use" ? `call:${block.id}` : `text:${block.text}`;
					if (seenBlocks.has(key)) continue; // a block written twice would duplicate a tool call id
					seenBlocks.add(key);
					if (block.type === "text" && String(block.text ?? "").trim()) {
						content.push({ type: "text", text: clipMiddle(String(block.text), CAPS.text) });
					} else if (block.type === "tool_use" && typeof block.id === "string") {
						const mapped = mapTool(String(block.name), block.input);
						const limit = mapped.name === "bash" ? CAPS.command : CAPS.arg;
						content.push({ type: "toolCall", id: block.id, name: mapped.name, arguments: mapStrings(mapped.args, (text) => clipMiddle(text, limit)) });
						calls.push({ id: block.id, tool: mapped.name });
					}
				}
			}
			if (content.length === 0) continue;
			model = group[0].model ?? model;
			const message: AssistantMessage = {
				role: "assistant",
				content,
				api: "anthropic-messages",
				provider: "claude-code",
				model: group[0].model ?? "claude",
				usage: structuredClone(ZERO_USAGE),
				stopReason: calls.length ? "toolUse" : "stop",
				timestamp: group[0].ts,
			};
			messages.push({ message, tokens: cost(message), ts: group[0].ts });
			for (const call of calls) {
				const found = results.get(call.id);
				const text = found ? clipMiddle(found.text, resultCap(call.tool, found.isError)) : "(no result was recorded; the call was interrupted)";
				const result: ToolResultMessage = {
					role: "toolResult",
					toolCallId: call.id,
					toolName: call.tool,
					content: [{ type: "text", text: text || "(no output)" }],
					isError: found ? found.isError : true,
					timestamp: group[0].ts,
				};
				messages.push({ message: result, tokens: cost(result), ts: group[0].ts });
			}
		}
	}
	return { messages, tasks, model };
}

/**
 * Newest messages that fit the budget, starting at a user message so the replay opens with a prompt and
 * never with a tool result whose call was cut. When the last run alone exceeds the budget, its prompt
 * is kept in front of as much of the end of the run as fits beside it.
 */
export function fit(messages: Msg[], budget: number): { kept: Msg[]; dropped: Msg[] } {
	const fromEnd = (limit: number) => {
		let start = messages.length;
		let total = 0;
		for (let i = messages.length - 1; i >= 0; i--) {
			if (total + messages[i].tokens > limit && start < messages.length) break;
			total += messages[i].tokens;
			start = i;
		}
		return start;
	};
	let start = fromEnd(budget);
	let head: Msg | undefined;
	if (start > 0) {
		let begin = start;
		while (begin < messages.length && messages[begin].message.role !== "user") begin++;
		if (begin < messages.length) {
			start = begin;
		} else {
			let prompt = start - 1;
			while (prompt >= 0 && messages[prompt].message.role !== "user") prompt--;
			if (prompt >= 0) {
				head = messages[prompt];
				start = Math.max(fromEnd(budget - head.tokens), prompt + 1);
			}
			while (start < messages.length && messages[start].message.role === "toolResult") start++;
		}
	}
	const kept = head ? [head, ...messages.slice(start)] : messages.slice(start);
	const keptSet = new Set(kept);
	return { kept, dropped: messages.filter((msg) => !keptSet.has(msg)) };
}

/** Keeps the newest images and replaces older ones with a note, since each costs ~1.5k tokens. */
function limitImages(messages: Msg[], cost: (message: PiMessage) => number) {
	let seen = 0;
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i].message;
		if (message.role !== "user" || typeof message.content === "string") continue;
		message.content = message.content.map((block) => (block.type === "image" && ++seen > MAX_IMAGES ? { type: "text" as const, text: "[older image omitted]" } : block));
		messages[i].tokens = cost(message);
	}
}

export interface ReplayOptions {
	/** Token budget for replayed messages. */
	budget: number;
	id: string;
	path: string;
	title?: string;
	/** Name of the transcript's directory under ~/.claude/projects, which encodes Claude Code's project path. */
	project?: string;
	/** Working directory to use when the one Claude Code used no longer exists. */
	fallbackCwd: string;
	/** Real tokens per estimated token, from counting an earlier replay of the same transcript. */
	ratio?: number;
}

export interface Replay {
	messages: Msg[];
	/** Text of the pi compaction entry that stands for everything not replayed. */
	summary: string;
	tokensBefore: number;
	/** Existing directory for the pi session. */
	cwd: string;
	/** Directory Claude Code worked in, when it differs from cwd because it no longer exists. */
	lostCwd?: string;
	model?: string;
	memoryDir?: string;
	lastTs: number;
	stats: { compactions: number; replayed: number; omitted: number; tokens: number; summarized: boolean; tasks: number };
}

function cleanSummary(text: string): string {
	return text
		.replace(SYSTEM_REMINDER, "")
		.replace(/^This session is being continued from a previous conversation[^\n]*\n+/, "")
		// Claude Code tells its own model to carry on unprompted; pi waits for the user.
		.replace(/\n?Continue the conversation from where it left off[^\n]*\n?/, "\n")
		.trim();
}

/** A removed worktree falls back to its repository, then to the caller's directory. */
function existingDir(path: string | undefined): string | undefined {
	if (!path) return undefined;
	if (existsSync(path)) return path;
	const repo = /^(.*)\/\.claude\/worktrees\/[^/]+$/.exec(path)?.[1];
	return repo && existsSync(repo) ? repo : undefined;
}

export function buildReplay(loaded: Loaded, options: ReplayOptions): Replay | undefined {
	const chain = buildChain(loaded);
	if (chain.entries.length === 0) return undefined;
	// A counted replay calibrates the estimate: each message costs its estimate times the measured ratio.
	const cost = (message: PiMessage) => Math.ceil(estimateTokens(message) * (options.ratio ?? 1));
	const { messages, tasks, model } = convert(chain, cost);
	limitImages(messages, cost);
	const { kept, dropped } = fit(messages, options.budget);

	const newest = [...chain.entries].reverse();
	// Claude Code keeps a transcript under its project's path; a later cd only changes the shell's cwd.
	const shellCwd = newest.find((entry) => entry.cwd)?.cwd;
	const projectCwd = newest.find((entry) => entry.cwd && encodeProject(entry.cwd) === options.project)?.cwd ?? shellCwd;
	const cwd = existingDir(projectCwd) ?? options.fallbackCwd;
	const branch = newest.find((entry) => entry.cwd === projectCwd && entry.branch)?.branch;
	const lastTs = chain.entries.at(-1)?.ts ?? 0;
	const ccSummary = chain.summary ? textOfContent(chain.summary.content) : "";

	const where = [
		`Working directory: ${cwd}.`,
		projectCwd && projectCwd !== cwd ? `Claude Code worked in ${projectCwd}${branch ? ` (git branch ${branch})` : ""}, which no longer exists.` : branch ? `Git branch: ${branch}.` : "",
		shellCwd && shellCwd !== projectCwd ? `Its shell was last in ${shellCwd}.` : "",
		`Last activity: ${stamp(lastTs)}.`,
	];
	const parts = [
		`This conversation continues Claude Code session ${options.title ? `"${options.title}" ` : ""}(${options.id}), imported into pi. Everything before the replayed messages is covered by the summary below. Claude Code tool calls ran there; bash, read, edit and write are pi's names for Claude Code's Bash, Read, Edit and Write, and other Claude Code tools (TaskUpdate, SendMessage, ...) are not available in pi. Wait for the user's next instruction instead of resuming work on your own.`,
		where.filter(Boolean).join(" "),
		`Full transcript (JSONL, search it with rg or jq for details older than what is replayed): ${options.path}`,
	];
	if (ccSummary) parts.push(`## Claude Code's summary of the earlier conversation\n\n${cleanSummary(ccSummary)}`);

	const prompts = dropped.filter((msg) => msg.prompt);
	if (prompts.length) {
		const shown = prompts.slice(-40);
		const lines = shown.map((msg) => `- [${stamp(msg.ts)}] ${msg.prompt}`);
		parts.push(`## Earlier prompts that are not replayed (oldest first${prompts.length > shown.length ? `, ${prompts.length - shown.length} older ones not listed` : ""})\n\n${lines.join("\n")}`);
	}
	const openTasks = tasks.filter((task) => task?.status !== "completed").map((task) => `- [${task.status}] ${task.subject}`);
	if (openTasks.length) parts.push(`## Open tasks in Claude Code's task list\n\n${openTasks.slice(0, 20).join("\n")}`);

	return {
		messages: kept,
		summary: redact(parts.join("\n\n")),
		tokensBefore: Number(chain.boundary?.compact?.preTokens) || dropped.reduce((sum, msg) => sum + msg.tokens, 0),
		cwd,
		lostCwd: projectCwd && projectCwd !== cwd ? projectCwd : undefined,
		model,
		memoryDir: loaded.memoryDir,
		lastTs,
		stats: { compactions: loaded.boundaries, replayed: kept.length, omitted: dropped.length, tokens: kept.reduce((sum, msg) => sum + msg.tokens, 0), summarized: !!ccSummary, tasks: openTasks.length },
	};
}

function textOfContent(content: Json): string {
	if (typeof content === "string") return content;
	return Array.isArray(content) ? content.filter((block) => block?.type === "text").map((block) => String(block.text ?? "")).join("\n") : "";
}

/**
 * High-confidence secret shapes only: a broader pattern would garble code in replayed tool calls.
 * Runs before any clipping, so a cut can never separate a secret from the marker that identifies it.
 */
export function redact(value: string): string {
	return value
		.replace(/-----BEGIN [^-\n]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-\n]*PRIVATE KEY-----|$)/g, "[redacted key]")
		.replace(/\b(?:sk-[\w-]{12,}|gh[pousr]_\w{20,}|github_pat_\w+|AKIA[A-Z0-9]{16}|xox[baprs]-[\w-]{10,}|\d{8,10}:[\w-]{35}|eyJ[\w-]{10,}\.eyJ[\w-]{10,}\.[\w-]{10,})\b/g, "[redacted token]")
		.replace(/(\bBearer\s+)[\w.+/=-]{12,}/gi, "$1[redacted]")
		.replace(/(\bauthorization["']?\s*[:=]\s*["']?basic\s+)[A-Za-z0-9+/=]{8,}/gi, "$1[redacted]")
		.replace(/(\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@"'`]{1,64}:)[^/\s@"'`]{3,128}(?=@)/gi, "$1[redacted]")
		.replace(/(\b[A-Z0-9_]*(?:API_KEY|TOKEN|SECRET|PASSWORD|PASSWD)[A-Z0-9_]*=["']?)(?!\$)[\w+/=.-]{12,}/g, "$1[redacted]");
}
