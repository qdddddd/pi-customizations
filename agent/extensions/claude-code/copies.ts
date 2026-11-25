/**
 * pi copies of Claude Code sessions. An import's pi session id is cc-<Claude Code session id>, with -2, -3, ...
 * for further copies, so copies are found by file name. No pi runtime dependencies.
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export const IMPORT_TYPE = "claude-code-import";

export interface Copy {
	path: string;
	/** 1 for cc-<id>, n for cc-<id>-n. */
	n: number;
	importedAt: string;
	/** Timestamp of the newest Claude Code entry the copy holds. */
	lastActivity: number;
	/** Something happened in pi after the import, so the copy holds work of its own. */
	touched: boolean;
}

const COPY_FILE = /_cc-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:-(\d+))?\.jsonl$/;
// Entries pi appends on its own when a session is opened, before the user does anything.
const QUIET = new Set(["model_change", "thinking_level_change", "usage", "custom"]);

export const copyId = (ccId: string, n: number) => (n > 1 ? `cc-${ccId}-${n}` : `cc-${ccId}`);

export async function readCopy(path: string, n: number): Promise<Copy | undefined> {
	const entries = (await readFile(path, "utf8").catch(() => ""))
		.split("\n")
		.flatMap((line) => {
			try {
				return line ? [JSON.parse(line)] : [];
			} catch {
				return [];
			}
		});
	const marker = entries.findLastIndex((entry) => entry.type === "custom" && entry.customType === IMPORT_TYPE);
	if (marker < 0) return undefined;
	const data = entries[marker].data ?? {};
	return {
		path,
		n,
		importedAt: String(data.importedAt ?? ""),
		lastActivity: Number(data.lastActivity) || 0,
		touched: entries.slice(marker + 1).some((entry) => !QUIET.has(entry.type)),
	};
}

/** Copies in the given session directories, keyed by Claude Code session id, newest import first. */
export async function findCopies(dirs: readonly string[], ccId?: string): Promise<Map<string, Copy[]>> {
	const found = new Map<string, Copy[]>();
	for (const dir of dirs) {
		for (const name of await readdir(dir).catch(() => [] as string[])) {
			const match = COPY_FILE.exec(name);
			if (!match || (ccId && match[1] !== ccId)) continue;
			const copy = await readCopy(join(dir, name), Number(match[2] ?? 1));
			if (copy) found.set(match[1], [...(found.get(match[1]) ?? []), copy]);
		}
	}
	for (const copies of found.values()) copies.sort((a, b) => b.importedAt.localeCompare(a.importedAt) || b.n - a.n);
	return found;
}
