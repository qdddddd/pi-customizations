/**
 * Claude Code instruction files pi does not load by itself, read by Claude Code's rules
 * (https://code.claude.com/docs/en/memory):
 *  - CLAUDE.md where pi took AGENTS.md instead, .claude/CLAUDE.md and CLAUDE.local.md, in the working
 *    directory and every directory above it, and ~/.claude/CLAUDE.md;
 *  - rules in ~/.claude/rules and .claude/rules; a rule with `paths:` frontmatter applies to matching files;
 *  - @path imports, also inside the context files pi loaded, since pi does not expand them;
 *  - block-level HTML comments are dropped.
 * Files in subdirectories of the working directory and path-scoped rules load once a tool touches a file
 * they cover, as in Claude Code. No pi runtime dependencies, so it can be tested with plain node.
 */
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, matchesGlob, relative, resolve } from "node:path";

export interface Source {
	path: string;
	content: string;
	/** The file whose @path import brought this one in. */
	importedBy?: string;
}

interface Rule {
	path: string;
	real: string;
	/** Directory the patterns are relative to: the one holding the rule's .claude, or the working directory for user rules. */
	base: string;
	patterns: string[];
	user: boolean;
}

export interface Settings {
	/** Real path of the working directory. */
	cwd: string;
	home: string;
	/** Claude Code's configuration directory, normally ~/.claude. */
	claude: string;
	/** pi's agent directory, whose context files are the user's own like ~/.claude/CLAUDE.md. */
	agent: string;
	/** External @path imports in project files are approved in Claude Code for this project. */
	approved: boolean;
	/** Per-file cap for files loaded on demand. Claude Code allows 40,000 characters with a 200K context window, 150,000 above. */
	demandCap: number;
}

export interface State extends Settings {
	/** Real paths of every instruction file in context. */
	seen: Set<string>;
	/** Path-scoped rules found so far. */
	rules: Rule[];
	/** Directories under the working directory already checked for on-demand files. */
	scanned: Set<string>;
}

// Claude Code loads launch files up to 4 MiB; a smaller cap keeps a stray large file from flooding the prompt.
const LAUNCH_CAP = 100_000;
const IMPORT_HOPS = 4;

const inside = (dir: string, path: string) => {
	const rel = relative(dir, path);
	return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
};

async function readText(path: string, cap: number): Promise<string | undefined> {
	if (!(await stat(path).catch(() => undefined))?.isFile()) return undefined;
	const text = await readFile(path, "utf8").catch(() => undefined);
	if (text === undefined || text.length <= cap) return text;
	return `${text.slice(0, cap)}\n[… cut at ${cap} characters; read ${path} for the rest]`;
}

/** Markdown split into fenced code blocks and the text between them. */
function segments(text: string): { text: string; code: boolean }[] {
	const out: { text: string; code: boolean }[] = [];
	let lines: string[] = [];
	let fence: string | undefined;
	const flush = (code: boolean) => {
		if (lines.length) out.push({ text: lines.join("\n"), code });
		lines = [];
	};
	for (const line of text.split("\n")) {
		const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
		if (!fence && marker) {
			flush(false);
			fence = marker;
			lines.push(line);
		} else if (fence && marker?.[0] === fence[0] && marker.length >= fence.length && /^ {0,3}[`~]+\s*$/.test(line)) {
			lines.push(line);
			flush(true);
			fence = undefined;
		} else {
			lines.push(line);
		}
	}
	flush(fence !== undefined);
	return out;
}

/** Drops HTML comments outside code blocks, as Claude Code does before loading a file. */
export function stripComments(text: string): string {
	return segments(text)
		.map((segment) => (segment.code ? segment.text : segment.text.replace(/<!--[\s\S]*?-->/g, "")))
		.join("\n");
}

/** @path imports outside code spans and fenced blocks. A backslash escapes a space; a quoted path is not an import. */
export function importPaths(text: string): string[] {
	const paths: string[] = [];
	for (const segment of segments(text)) {
		if (segment.code) continue;
		const prose = segment.text.replace(/(`+)[\s\S]*?\1/g, (span) => " ".repeat(span.length));
		for (const match of prose.matchAll(/(?<=^|\s)@((?:\\ |[^\s"'`\\])+)/g)) paths.push(match[1].replace(/\\ /g, " "));
	}
	return paths;
}

interface Scope {
	state: State;
	user: boolean;
	cap: number;
}

/** Files a source imports, each once, up to Claude Code's four hops. */
async function imports(path: string, text: string, scope: Scope, hops = 0): Promise<Source[]> {
	if (hops >= IMPORT_HOPS) return [];
	const { state } = scope;
	const out: Source[] = [];
	for (const target of importPaths(text)) {
		const file = target.startsWith("~/") ? join(state.home, target.slice(2)) : isAbsolute(target) ? target : resolve(dirname(path), target);
		const real = await realpath(file).catch(() => undefined);
		if (!real || state.seen.has(real)) continue;
		// Outside the working directory, a project file's import needs approval in Claude Code; the user's own files need none.
		if (!scope.user && !state.approved && !inside(state.cwd, real)) continue;
		const raw = await readText(real, scope.cap);
		if (raw === undefined) continue;
		state.seen.add(real);
		const content = stripComments(raw);
		out.push({ path: file, content, importedBy: path }, ...(await imports(file, content, scope, hops + 1)));
	}
	return out;
}

async function load(path: string, state: State, user: boolean, cap: number): Promise<Source[]> {
	const real = await realpath(path).catch(() => undefined);
	if (!real || state.seen.has(real)) return [];
	const raw = await readText(real, cap);
	if (raw === undefined) return [];
	state.seen.add(real);
	const content = stripComments(raw);
	return [{ path, content }, ...(await imports(path, content, { state, user, cap }))];
}

const unquote = (text: string) => /^(['"])(.*)\1$/.exec(text)?.[2] ?? text;

/** Splits on commas outside quotes, braces and brackets. */
function splitList(text: string): string[] {
	const parts: string[] = [];
	let current = "";
	let depth = 0;
	let quote = "";
	for (const char of text) {
		if (quote) {
			if (char === quote) quote = "";
		} else if (char === '"' || char === "'") {
			quote = char;
		} else if (char === "{" || char === "[") {
			depth++;
		} else if (char === "}" || char === "]") {
			depth--;
		} else if (char === "," && depth === 0) {
			parts.push(current);
			current = "";
			continue;
		}
		current += char;
	}
	parts.push(current);
	return parts.map((part) => unquote(part.trim())).filter(Boolean);
}

/** A rule's `paths` frontmatter (a YAML list, a flow list or a comma-separated string) and its body without the frontmatter. */
export function parseRule(text: string): { patterns: string[]; body: string } {
	const front = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
	if (!front) return { patterns: [], body: text };
	const lines = front[1].split(/\r?\n/);
	const at = lines.findIndex((line) => /^paths\s*:/.test(line));
	let patterns: string[] = [];
	if (at >= 0) {
		const inline = lines[at].replace(/^paths\s*:\s*/, "").trim();
		if (inline) {
			const flow = /^\[(.*)\]$/.exec(inline);
			patterns = flow ? splitList(flow[1]) : splitList(unquote(inline));
		} else {
			for (const line of lines.slice(at + 1)) {
				const item = /^\s*-\s+(.*)$/.exec(line);
				if (!item) {
					if (line.trim()) break;
					continue;
				}
				patterns.push(unquote(item[1].trim()));
			}
		}
	}
	return { patterns, body: text.slice(front[0].length) };
}

/**
 * Claude Code's pattern rules: a pattern without a slash matches at any depth, a leading slash anchors it to
 * the base directory, and a `[` that opens no bracket expression makes the pattern match nothing.
 */
export function ruleMatches(patterns: readonly string[], base: string, file: string): boolean {
	const rel = relative(base, file);
	if (!rel || rel.startsWith("..") || isAbsolute(rel)) return false;
	return patterns.some((pattern) => {
		if (/(?:^|[^\\])\[[^\]/]*(?:\/|$)/.test(pattern)) return false;
		const glob = pattern.startsWith("/") ? pattern.slice(1) : pattern.includes("/") ? pattern : `**/${pattern}`;
		try {
			return matchesGlob(rel, glob);
		} catch {
			return false;
		}
	});
}

/** Markdown files under a rules directory, recursively, following symlinks without looping. */
async function ruleFiles(dir: string, visited = new Set<string>()): Promise<string[]> {
	const real = await realpath(dir).catch(() => undefined);
	if (!real || visited.has(real)) return [];
	visited.add(real);
	const files: string[] = [];
	for (const name of (await readdir(dir).catch(() => [] as string[])).sort()) {
		const path = join(dir, name);
		const info = await stat(path).catch(() => undefined);
		if (info?.isDirectory()) files.push(...(await ruleFiles(path, visited)));
		else if (info?.isFile() && name.endsWith(".md")) files.push(path);
	}
	return files;
}

/** Rules without `paths` load now; path-scoped ones wait in state.rules for a matching file. */
async function loadRules(dir: string, base: string, state: State, user: boolean, cap: number): Promise<Source[]> {
	const out: Source[] = [];
	for (const path of await ruleFiles(dir)) {
		const real = await realpath(path).catch(() => undefined);
		if (!real || state.seen.has(real) || state.rules.some((rule) => rule.real === real)) continue;
		// A project rule that links outside the working directory counts as an external import.
		if (!user && !state.approved && real !== path && !inside(state.cwd, real)) continue;
		const raw = await readText(real, cap);
		if (raw === undefined) continue;
		const { patterns, body } = parseRule(raw);
		if (patterns.length) {
			state.rules.push({ path, real, base, patterns, user });
			continue;
		}
		state.seen.add(real);
		const content = stripComments(body);
		out.push({ path, content }, ...(await imports(path, content, { state, user, cap })));
	}
	return out;
}

/** Instruction files for the start of a session. `loaded` lists the context files pi loaded itself. */
export async function launch(settings: Settings, loaded: readonly string[]): Promise<{ state: State; sources: Source[] }> {
	const state: State = { ...settings, seen: new Set(), rules: [], scanned: new Set() };
	const piFiles = await Promise.all(loaded.map(async (path) => ({ path, real: await realpath(path).catch(() => path) })));
	for (const file of piFiles) state.seen.add(file.real);
	const userFile = join(settings.claude, "CLAUDE.md");
	const userReal = await realpath(userFile).catch(() => undefined);
	const sources: Source[] = [];
	// pi loads these without expanding their imports.
	for (const file of piFiles) {
		const raw = await readText(file.real, LAUNCH_CAP);
		const user = file.real === userReal || inside(settings.agent, file.path);
		if (raw) sources.push(...(await imports(file.path, stripComments(raw), { state, user, cap: LAUNCH_CAP })));
	}
	// User instructions, then the project's from the filesystem root down to the working directory.
	sources.push(...(await load(userFile, state, true, LAUNCH_CAP)));
	sources.push(...(await loadRules(join(settings.claude, "rules"), settings.cwd, state, true, LAUNCH_CAP)));
	const dirs: string[] = [];
	for (let dir = settings.cwd; ; dir = dirname(dir)) {
		dirs.unshift(dir);
		if (dirname(dir) === dir) break;
	}
	for (const dir of dirs) {
		sources.push(...(await load(join(dir, "CLAUDE.md"), state, false, LAUNCH_CAP)));
		// ~/.claude holds the user's own files, read above.
		if (join(dir, ".claude") !== settings.claude) {
			sources.push(...(await load(join(dir, ".claude", "CLAUDE.md"), state, false, LAUNCH_CAP)));
			sources.push(...(await loadRules(join(dir, ".claude", "rules"), dir, state, false, LAUNCH_CAP)));
		}
		sources.push(...(await load(join(dir, "CLAUDE.local.md"), state, false, LAUNCH_CAP)));
	}
	return { state, sources };
}

/** Instruction files that apply once a tool touches `file` and are not in context yet. */
export async function onDemand(state: State, file: string): Promise<Source[]> {
	const target = resolve(state.cwd, file);
	const real = await realpath(target).catch(() => target);
	const out: Source[] = [];
	// Subdirectories between the working directory and the file, outermost first.
	const dirs: string[] = [];
	for (let dir = dirname(real); inside(state.cwd, dir); dir = dirname(dir)) dirs.unshift(dir);
	for (const dir of dirs) {
		if (state.scanned.has(dir)) continue;
		state.scanned.add(dir);
		out.push(...(await load(join(dir, "CLAUDE.md"), state, false, state.demandCap)));
		out.push(...(await load(join(dir, ".claude", "CLAUDE.md"), state, false, state.demandCap)));
		out.push(...(await loadRules(join(dir, ".claude", "rules"), dir, state, false, state.demandCap)));
		out.push(...(await load(join(dir, "CLAUDE.local.md"), state, false, state.demandCap)));
	}
	for (const rule of state.rules) {
		if (state.seen.has(rule.real) || !(ruleMatches(rule.patterns, rule.base, real) || ruleMatches(rule.patterns, rule.base, target))) continue;
		const raw = await readText(rule.real, state.demandCap);
		if (raw === undefined) continue;
		state.seen.add(rule.real);
		const content = stripComments(parseRule(raw).body);
		out.push({ path: rule.path, content }, ...(await imports(rule.path, content, { state, user: rule.user, cap: state.demandCap })));
	}
	return out;
}

export function render(sources: readonly Source[]): string {
	return sources.map((source) => `Contents of ${source.path}${source.importedBy ? ` (imported by ${source.importedBy})` : ""}:\n\n${source.content.trim()}`).join("\n\n");
}
