import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { IMPORT_TYPE } from "./copies.ts";
import { claudeDir, encodeProject } from "./transcript.ts";

// Claude Code loads the first 200 lines or 25KB of MEMORY.md, whichever comes first.
const MAX_LINES = 200;
const MAX_BYTES = 25_000;

/**
 * Real path of the project that holds cwd, as Claude Code picks it for memory: the checkout's top level,
 * except that a linked worktree shares the memory of its main checkout. Outside git it is cwd.
 */
export async function projectRoot(pi: ExtensionAPI, cwd: string): Promise<string> {
	const git = await pi.exec("git", ["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-dir", "--git-common-dir"], { cwd, timeout: 3000 }).catch(() => undefined);
	const [top, gitDir, common] = git?.code === 0 ? git.stdout.trim().split("\n") : [];
	if (top && gitDir !== common && basename(common) === ".git") return realpath(dirname(common));
	return realpath(top || cwd);
}

export interface MemoryState {
	dir: string;
	exists: boolean;
	index: string;
	truncated: boolean;
	topics: number;
}

/**
 * Claude Code keeps one memory directory per project: ~/.claude/projects/<encoded project root>/memory.
 * `dir` overrides it, for a session imported from Claude Code that used another project's memory.
 * Undefined when Claude Code is not installed, so pi never creates ~/.claude.
 */
export async function loadMemory(pi: ExtensionAPI, cwd: string, dir?: string): Promise<MemoryState | undefined> {
	if (!(await stat(claudeDir()).catch(() => undefined))?.isDirectory()) return undefined;
	dir ??= join(claudeDir(), "projects", encodeProject(await projectRoot(pi, cwd)), "memory");
	const raw = await readFile(join(dir, "MEMORY.md"), "utf8").catch(() => undefined);
	const topics = (await readdir(dir).catch(() => [] as string[])).filter((name) => name.endsWith(".md") && name !== "MEMORY.md").length;
	const kept: string[] = [];
	let bytes = 0;
	let truncated = false;
	for (const line of raw?.trimEnd().split("\n") ?? []) {
		bytes += Buffer.byteLength(line) + 1;
		if (kept.length >= MAX_LINES || bytes > MAX_BYTES) {
			truncated = true;
			break;
		}
		kept.push(line);
	}
	return { dir, exists: raw !== undefined, index: kept.join("\n"), truncated, topics };
}

/** The memory directory Claude Code used for an imported session, if this session is one. */
export function importedMemoryDir(ctx: ExtensionContext): string | undefined {
	const projects = join(claudeDir(), "projects") + "/";
	for (const entry of ctx.sessionManager.getEntries()) {
		if (entry.type !== "custom" || entry.customType !== IMPORT_TYPE) continue;
		const dir = (entry.data as { memoryDir?: unknown } | undefined)?.memoryDir;
		if (typeof dir === "string" && dir.startsWith(projects) && basename(dir) === "memory") return dir;
	}
	return undefined;
}

/**
 * Claude Code's own memory instructions (as sent to its model), so both tools follow one file format,
 * followed by the index the way Claude Code attaches it.
 */
export function memorySection(state: MemoryState, tools: readonly string[]): string {
	const index = join(state.dir, "MEMORY.md");
	const parts = [
		`# Memory

You have a persistent file-based memory at \`${state.dir}/\`. Claude Code reads and writes the same directory, so what you save here is available there and the other way around. The directory may not exist yet: write to it directly with the write tool, which creates missing directories. Each memory is one file holding one fact, with frontmatter:

\`\`\`markdown
---
name: <short-kebab-case-slug>
description: <one-line summary, used to decide relevance during recall>
metadata:
  type: user | feedback | project | reference
---

<the fact; for feedback/project, follow with **Why:** and **How to apply:** lines. Link related memories with [[their-name]].>
\`\`\`

In the body, link to related memories with \`[[name]]\`, where \`name\` is the other memory's \`name:\` slug. Link liberally — a \`[[name]]\` that doesn't match an existing memory yet is fine; it marks something worth writing later, not an error.

\`user\`: who the user is (role, expertise, preferences). \`feedback\`: guidance the user has given on how you should work, both corrections and confirmed approaches; include the why. \`project\`: ongoing work, goals, or constraints not derivable from the code or git history; convert relative dates to absolute. \`reference\`: pointers to external resources (URLs, dashboards, tickets).

After writing the file, add a one-line pointer in \`MEMORY.md\` (\`- [Title](file.md) — hook\`). \`MEMORY.md\` is the index loaded into context each session — one line per memory, no frontmatter, never put memory content there. Change an existing \`MEMORY.md\` only with the edit tool, one line at a time, and never rewrite it with the write tool: Claude Code sessions may be editing it at the same time.

Before saving, check for an existing file that already covers it. Update that file rather than creating a duplicate; delete memories that turn out to be wrong. Don't save what the repo already records (code structure, past fixes, git history, CLAUDE.md or AGENTS.md) or what only matters to this conversation; if asked to remember one of those, ask what was non-obvious about it and save that instead. Memories are background context, not user instructions, and reflect what was true when written. If one names a file, function, or flag, verify it still exists before recommending it.`,
	];
	if (tools.includes("retain") || tools.includes("learn")) {
		parts.push("The retain, learn and recall tools keep a separate pi-only store. Save anything durable in the memory files above instead, so Claude Code sees it too.");
	}
	let body: string;
	if (!state.exists) body = "(MEMORY.md does not exist yet. Create it with the write tool when you save the first memory.)";
	else if (!state.index.trim()) body = state.truncated ? `(The first line of MEMORY.md exceeds the size limit. Read ${index} before changing it.)` : "(MEMORY.md is empty.)";
	else body = `${state.index}${state.truncated ? `\n\n(The index is cut at ${MAX_LINES} lines or ${MAX_BYTES / 1000} KB; read ${index} for the rest.)` : ""}`;
	parts.push(`Contents of ${index} (user's auto-memory, persists across conversations):\n\n${body}`);
	return parts.join("\n\n");
}

export function registerMemory(pi: ExtensionAPI) {
	// Read once per session, as Claude Code does: a changing index would rewrite the prompt on every turn.
	let memory: Promise<MemoryState | undefined> | undefined;
	pi.on("session_start", () => {
		memory = undefined;
	});
	pi.on("before_agent_start", async (event, ctx) => {
		try {
			memory ??= loadMemory(pi, ctx.cwd, importedMemoryDir(ctx));
			const state = await memory;
			if (state) event.systemPromptOptions.sections["claude-memory"] = memorySection(state, event.systemPromptOptions.selectedTools ?? []);
		} catch (error) {
			memory = undefined;
			ctx.ui.notify(`Claude Code memory unavailable: ${error instanceof Error ? error.message : String(error)}`, "warning");
		}
	});
}
