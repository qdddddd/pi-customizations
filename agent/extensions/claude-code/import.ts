import { chmod, readdir, realpath, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { getAgentDir, SessionManager, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { copyId, findCopies, IMPORT_TYPE, type Copy } from "./copies.ts";
import { counterFor } from "./count.ts";
import { importedMemoryDir, loadMemory, projectRoot } from "./memory.ts";
import { buildReplay, claudeDir, encodeProject, listSessions, loadTranscript, stamp, type Replay, type SessionInfo } from "./transcript.ts";

const DEFAULT_BUDGET = 80_000;
const LIST_LIMIT = 25;
const SUBCOMMANDS = ["resume", "list", "memory"];
const USAGE = "/cc [resume] [<id prefix|title|latest>] [--fresh] [--budget 120k] [--exact] [--all], /cc list [--all], /cc memory";

interface Args {
	sub: string;
	query: string;
	all: boolean;
	budget: number;
	/** Import again even when a pi copy exists. A new budget or an exact count needs a new import too. */
	fresh: boolean;
	/** Count the replay exactly with real requests when the model has no free counter. */
	exact: boolean;
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Print mode has no UI and drops notifications, so those messages go to stderr. */
const say = (ctx: ExtensionCommandContext, message: string, level: "info" | "warning" | "error" = "info") => (ctx.hasUI ? ctx.ui.notify(message, level) : console.error(message));

/** The first word may name a subcommand; options are explicit flags, and every other word is the literal query. */
function parseArgs(args: string): Args {
	const words = args.trim().split(/\s+/).filter(Boolean);
	const parsed: Args = { sub: SUBCOMMANDS.includes(words[0]) ? words.shift()! : "resume", query: "", all: false, budget: DEFAULT_BUDGET, fresh: false, exact: false };
	const rest: string[] = [];
	for (let i = 0; i < words.length; i++) {
		const word = words[i];
		if (word === "--all") parsed.all = true;
		else if (word === "--fresh") parsed.fresh = true;
		else if (word === "--exact") parsed.exact = parsed.fresh = true;
		else if (word === "--budget" || word.startsWith("--budget=")) {
			const value = word === "--budget" ? words[++i] : word.slice("--budget=".length);
			const size = /^(\d+(?:\.\d+)?)([km]?)$/i.exec(value ?? "");
			if (!size) throw new Error(`--budget takes a token count such as 120k, not "${value ?? ""}".`);
			parsed.budget = Math.round(Number(size[1]) * ({ k: 1e3, m: 1e6 }[size[2].toLowerCase()] ?? 1));
			parsed.fresh = true;
		} else rest.push(word);
	}
	parsed.query = rest.join(" ");
	return parsed;
}

/** pi session directories: the per-directory defaults and, when configured, the session directory in use. */
async function sessionDirs(ctx: ExtensionCommandContext): Promise<string[]> {
	const root = join(getAgentDir(), "sessions");
	const dirs = (await readdir(root, { withFileTypes: true }).catch(() => [])).filter((entry) => entry.isDirectory()).map((entry) => join(root, entry.name));
	const configured = sessionDir(ctx);
	return configured ? [configured, ...dirs] : dirs;
}

/** Where pi's own /new would put a session: the per-directory default, or the configured session directory. */
function sessionDir(ctx: ExtensionCommandContext): string | undefined {
	const current = ctx.sessionManager.getSessionDir();
	return dirname(current) === join(getAgentDir(), "sessions") ? undefined : current;
}

/** Claude Code activity newer than everything the copy holds. */
const behind = (session: SessionInfo, copy: Copy) => (session.lastTs ?? 0) > copy.lastActivity;

function label(session: SessionInfo, copies: Map<string, Copy[]>): string {
	const where = session.cwd ? session.cwd.replace(homedir(), "~").split("/").slice(-2).join("/") : session.project;
	const prompt = session.prompt ? ` “${session.prompt.replace(/\s+/g, " ").slice(0, 60)}”` : "";
	const copy = copies.get(session.id)?.[0];
	const inPi = copy ? (behind(session, copy) ? " · in pi, Claude Code newer" : " · in pi") : "";
	return `${stamp(session.mtimeMs)}  ${session.title ?? session.id.slice(0, 8)}  (${where}, ${(session.size / 1e6).toFixed(1)} MB)${session.live ? " ● open in Claude Code" : ""}${inPi}${prompt}  [${session.id.slice(0, 8)}]`;
}

/** Claude Code project directories that belong to cwd: its own, its repository's, and every worktree of that repository. */
async function projectDirs(pi: ExtensionAPI, cwd: string): Promise<string[]> {
	const names = await readdir(join(claudeDir(), "projects")).catch(() => [] as string[]);
	const root = await projectRoot(pi, cwd);
	const git = await pi.exec("git", ["worktree", "list", "--porcelain"], { cwd, timeout: 3000 }).catch(() => undefined);
	const worktrees = git?.code === 0 ? git.stdout.split("\n").filter((line) => line.startsWith("worktree ")).map((line) => line.slice("worktree ".length)) : [];
	const own = new Set([root, await realpath(cwd), ...worktrees].map(encodeProject));
	// Removed worktrees are gone from git, but Claude Code keeps their transcripts.
	return names.filter((name) => own.has(name) || name.startsWith(`${encodeProject(root)}--claude-worktrees-`));
}

/** Sessions of this project, or of every project when this one has none (or when asked). */
async function candidates(pi: ExtensionAPI, ctx: ExtensionCommandContext, all: boolean, limit = LIST_LIMIT) {
	if (!all) {
		const dirs = await projectDirs(pi, ctx.cwd);
		const own = dirs.length ? await listSessions(dirs, limit) : [];
		if (own.length) return { sessions: own, scope: "this project" };
	}
	return { sessions: await listSessions("all", limit), scope: "all projects" };
}

/** Sessions whose id starts with the query or whose title contains it, searched across every session, this project's first. */
async function find(pi: ExtensionAPI, ctx: ExtensionCommandContext, query: string, all: boolean): Promise<SessionInfo[]> {
	if (query === "latest") return (await candidates(pi, ctx, all, 1)).sessions;
	const needle = query.toLowerCase();
	const matching = (sessions: SessionInfo[]) => sessions.filter((session) => session.id.startsWith(needle) || (session.title ?? "").toLowerCase().includes(needle));
	if (!all) {
		const dirs = await projectDirs(pi, ctx.cwd);
		const own = dirs.length ? matching(await listSessions(dirs, Infinity)) : [];
		if (own.length) return own;
	}
	return matching(await listSessions("all", Infinity));
}

async function choose(pi: ExtensionAPI, ctx: ExtensionCommandContext, args: Args, copies: Map<string, Copy[]>): Promise<SessionInfo | undefined> {
	let sessions: SessionInfo[];
	let title: string;
	if (args.query) {
		sessions = await find(pi, ctx, args.query, args.all);
		if (sessions.length === 0) {
			say(ctx, `No Claude Code session matches "${args.query}".`, "error");
			return undefined;
		}
		if (sessions.length === 1 || !ctx.hasUI) return sessions[0];
		title = `Claude Code sessions matching "${args.query}", newest first`;
	} else {
		if (!ctx.hasUI) {
			say(ctx, `Name the session: ${USAGE}`, "error");
			return undefined;
		}
		const found = await candidates(pi, ctx, args.all);
		if (found.sessions.length === 0) {
			say(ctx, "No Claude Code sessions found.", "warning");
			return undefined;
		}
		sessions = found.sessions;
		title = `Claude Code sessions (${found.scope}), newest first`;
	}
	const labels = sessions.slice(0, 50).map((session) => label(session, copies));
	const picked = await ctx.ui.select(title, labels);
	return picked === undefined ? undefined : sessions[labels.indexOf(picked)];
}

/** Writes the pi session, private like the transcript it copies. A failed write leaves no partial session behind. */
async function writeSession(ctx: ExtensionCommandContext, session: SessionInfo, replay: Replay, name: string, id: string): Promise<string> {
	const sm = SessionManager.create(replay.cwd, sessionDir(ctx), { id });
	try {
		if (replay.stats.summarized || replay.stats.omitted > 0) {
			// A compaction entry stands for what was left out; a session replayed in full only gets the banner.
			sm.appendCompaction(replay.summary, null, replay.tokensBefore, { source: "claude-code", sessionId: session.id, transcript: session.path }, true);
		} else {
			sm.appendCustomMessageEntry(IMPORT_TYPE, replay.summary, true);
		}
		for (const { message } of replay.messages) sm.appendMessage(message);
		// pi writes the file once the session holds a user or assistant message.
		if (replay.messages.length === 0) sm.appendMessage({ role: "user", content: "(Imported from Claude Code. The conversation so far is summarized above.)", timestamp: Date.now() });
		// Last, so they win over the imported assistant messages when pi restores the session's model.
		if (ctx.model) sm.appendModelChange(ctx.model.provider, ctx.model.id);
		if (ctx.thinkingLevel) sm.appendThinkingLevelChange(ctx.thinkingLevel);
		sm.appendSessionInfo(`cc: ${name}`);
		sm.appendCustomEntry(IMPORT_TYPE, { sessionId: session.id, transcript: session.path, importedAt: new Date().toISOString(), lastActivity: replay.lastTs, memoryDir: replay.memoryDir, ...replay.stats });
		await chmod(sm.getSessionFile()!, 0o600);
		return sm.getSessionFile()!;
	} catch (error) {
		const file = sm.getSessionFile();
		if (file) await rm(file, { force: true });
		throw error;
	}
}

/** Opens the newest pi copy instead of importing again, unless Claude Code moved on since. Returns true when handled. */
async function reuse(ctx: ExtensionCommandContext, session: SessionInfo, copy: Copy, name: string, active: () => boolean): Promise<boolean> {
	const newer = behind(session, copy);
	const fresh = `/cc resume ${session.id.slice(0, 8)} --fresh`;
	if (copy.path === ctx.sessionManager.getSessionFile()) {
		say(ctx, newer ? `This session is the pi copy of "${name}". Claude Code has continued since; ${fresh} imports its current state.` : `This session is already the pi copy of "${name}".`, "info");
		return true;
	}
	// An untouched copy that Claude Code has moved past is replaced by a new import.
	if (newer && !copy.touched) return false;
	if (newer && ctx.hasUI) {
		const open = `Open the pi copy (imported ${copy.importedAt.slice(0, 16).replace("T", " ")}, continued in pi)`;
		const picked = await ctx.ui.select(`"${name}" has moved on in both Claude Code and pi`, [open, "Import Claude Code's current state as another copy"]);
		if (picked === undefined || !active()) return true;
		if (picked !== open) return false;
	}
	const note = `Opened the pi copy of "${name}".${newer ? ` Claude Code has continued since; ${fresh} imports its current state.` : ""}`;
	const result = await ctx.switchSession(copy.path, { withSession: async (next) => say(next, note, "info") });
	if (result.cancelled && active()) say(ctx, "Opening the pi copy was cancelled.", "warning");
	return true;
}

async function resume(pi: ExtensionAPI, ctx: ExtensionCommandContext, args: Args, active: () => boolean) {
	if (!ctx.sessionManager.getSessionFile()) {
		say(ctx, "pi is running without saved sessions (--no-session), so an import has nowhere to go. Start pi without that flag to use /cc.", "error");
		return;
	}
	if (!ctx.isIdle()) {
		say(ctx, "Wait for the current response to finish first.", "warning");
		return;
	}
	const dirs = await sessionDirs(ctx);
	const session = await choose(pi, ctx, args, await findCopies(dirs));
	if (!session || !active()) return;
	const name = session.title ?? session.id.slice(0, 8);
	const copies = (await findCopies(dirs, session.id)).get(session.id) ?? [];
	if (copies[0] && !args.fresh && (await reuse(ctx, session, copies[0], name, active))) return;

	// The replay plus the prompt must fit the model; half its window leaves room to work.
	const model = ctx.model;
	const limit = model?.contextWindow ? Math.min(args.budget, Math.floor(model.contextWindow / 2)) : args.budget;
	let replay: Replay | undefined;
	let counted: number | undefined;
	ctx.ui.setStatus("claude-code", `Reading Claude Code session ${session.id.slice(0, 8)}…`);
	try {
		const loaded = await loadTranscript(session.path);
		const build = (ratio?: number) => buildReplay(loaded, { budget: limit, id: session.id, path: session.path, title: session.title, project: session.project, fallbackCwd: ctx.cwd, ratio });
		replay = build();
		const count = counterFor(ctx, model, args.exact);
		if (replay && replay.messages.length > 0 && count && active()) {
			ctx.ui.setStatus("claude-code", "Counting tokens…");
			const first = await count(replay.messages.map((msg) => msg.message));
			if (first) {
				// Rescale the estimate by what the first count measured, choose the window again, and count that.
				replay = build(first / replay.stats.tokens) ?? replay;
				counted = await count(replay.messages.map((msg) => msg.message));
			}
		}
	} finally {
		if (active()) ctx.ui.setStatus("claude-code", undefined);
	}
	if (!active()) return; // the session was replaced while the transcript was read
	if (!replay || (replay.messages.length === 0 && !replay.stats.summarized)) {
		say(ctx, "That Claude Code session has no conversation to import.", "error");
		return;
	}
	const n = Math.max(0, ...copies.map((copy) => copy.n)) + 1;
	const file = await writeSession(ctx, session, replay, name, copyId(session.id, n));
	const { stats } = replay;
	const memory = await loadMemory(pi, replay.cwd, replay.memoryDir);
	const size = counted ? `${counted.toLocaleString("en-US")} tokens, counted` : `~${Math.round(stats.tokens / 1000)}k tokens, estimated`;
	const note = [
		`Imported "${name}": ${stats.replayed} messages (${size})${stats.summarized ? " after Claude Code's summary" : ""}${stats.omitted ? `; ${stats.omitted} older messages are represented by their prompts only` : ""}${limit < args.budget ? ` (budget capped at ${Math.round(limit / 1000)}k, half the model's context window)` : ""}.`,
		`Working directory ${replay.cwd}${replay.lostCwd ? ` (Claude Code's ${replay.lostCwd} no longer exists)` : ""}.`,
		memory ? `Memory: ${memory.dir}.` : "",
		session.live ? `The session is still open in Claude Code (pid ${session.live.pid}); later changes there are not synced.` : "",
		copies.some((copy) => copy.touched) ? `Earlier pi copies you continued are kept; /resume lists them as "cc: ${name}".` : "",
	]
		.filter(Boolean)
		.join(" ");
	if (!active() || !ctx.isIdle()) {
		if (active()) say(ctx, `Saved the import as "cc: ${name}" without opening it, because a response started meanwhile. Open it with /resume.`, "warning");
		return;
	}
	// ctx is stale once the session is replaced, so only the replacement context is used afterwards.
	const result = await ctx.switchSession(file, { withSession: async (next) => say(next, note, "info") });
	if (result.cancelled) {
		if (active()) say(ctx, `The imported session was saved but not opened: ${file}`, "warning");
		return;
	}
	// Copies nobody continued hold only an older state of this transcript.
	for (const copy of copies) if (!copy.touched) await rm(copy.path, { force: true });
}

export function registerImport(pi: ExtensionAPI) {
	// Cleared when this session is replaced, so a slow import never acts on a stale context.
	let live = true;
	pi.on("session_shutdown", () => {
		live = false;
	});
	pi.registerCommand("cc", {
		description: `Continue a Claude Code session here: ${USAGE}`,
		getArgumentCompletions: (prefix): AutocompleteItem[] | null => {
			const items = [...SUBCOMMANDS, "latest", "--fresh", "--budget", "--exact", "--all"].filter((word) => word.startsWith(prefix)).map((word) => ({ value: word, label: word }));
			return prefix.includes(" ") || items.length === 0 ? null : items;
		},
		handler: async (args, ctx) => {
			try {
				const parsed = parseArgs(args);
				if (parsed.sub === "list") {
					const [{ sessions, scope }, copies] = await Promise.all([candidates(pi, ctx, parsed.all), sessionDirs(ctx).then((dirs) => findCopies(dirs))]);
					say(ctx, sessions.length ? `Claude Code sessions (${scope}), newest first:\n${sessions.map((session, i) => `${i + 1}. ${label(session, copies)}`).join("\n")}` : "No Claude Code sessions found.", "info");
				} else if (parsed.sub === "memory") {
					const memory = await loadMemory(pi, ctx.cwd, importedMemoryDir(ctx));
					if (!memory) {
						say(ctx, `Claude Code is not installed here: ${claudeDir()} does not exist.`, "warning");
						return;
					}
					const index = !memory.exists ? "no MEMORY.md yet" : `MEMORY.md has ${memory.index ? memory.index.split("\n").length : 0} lines in the prompt${memory.truncated ? " (cut at the Claude Code limit)" : ""}`;
					say(ctx, `Claude Code memory for this project: ${memory.dir}\n${index}, ${memory.topics} topic files. The index is added to the system prompt when a session starts.`, "info");
				} else {
					await resume(pi, ctx, parsed, () => live);
				}
			} catch (error) {
				if (live) say(ctx, errorText(error), "error");
			}
		},
	});
}
