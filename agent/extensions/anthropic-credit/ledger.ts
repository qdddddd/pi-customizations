// Anthropic has no balance endpoint: the Console Billing page is the only place the credit shows, and the cost
// report needs an organization-scoped key and reports spend before credits. So the credit is an estimate: a
// balance read from the Console, minus what saved pi sessions spent on the `anthropic` provider since.
import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/** A balance read from the Console, and when it was read. */
export interface Anchor {
	amount: number; // USD
	at: string; // ISO time
}

interface Row {
	time: number; // when pi stored the message, ms
	key: string; // provider response id: copies of a session (fork, clone) hold the same ones
	cost: number; // USD, as priced by pi
}

interface Scanned {
	size: number;
	mtimeMs: number;
	rows: Row[];
}

/** Parsed session files by path. Passing the same cache again re-reads only the files that changed. */
export type Cache = Map<string, Scanned>;

// A file last written before the anchor cannot hold a later message; the slack covers coarse mtimes.
const MTIME_SLACK_MS = 2000;

const gone = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";

/** "142.3", "$142.30" and "1,234.50" are amounts; anything else, including negatives, is not. */
export function parseAmount(text: string): number | undefined {
	const match = /^\$?\s*(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?$/.exec(text.trim());
	return match ? Number(match[1].replace(/,/g, "") + (match[2] ?? "")) : undefined;
}

export async function readAnchor(file: string): Promise<Anchor | undefined> {
	try {
		const data = JSON.parse(await readFile(file, "utf8"));
		return Number.isFinite(data?.amount) && !Number.isNaN(Date.parse(data.at)) ? { amount: data.amount, at: data.at } : undefined;
	} catch (error) {
		if (gone(error) || error instanceof SyntaxError) return undefined;
		throw error;
	}
}

export async function writeAnchor(file: string, anchor: Anchor) {
	await mkdir(dirname(file), { recursive: true });
	const temp = `${file}.${process.pid}`;
	await writeFile(temp, `${JSON.stringify(anchor)}\n`, { mode: 0o600 });
	await rename(temp, file);
}

function rowsOf(text: string): Row[] {
	const rows: Row[] = [];
	for (const line of text.split("\n")) {
		if (!line.includes('"provider":"anthropic"')) continue;
		let entry;
		try {
			entry = JSON.parse(line);
		} catch {
			continue; // a line still being written
		}
		const message = entry?.message;
		const cost = message?.usage?.cost?.total;
		const time = Date.parse(entry?.timestamp);
		if (entry.type !== "message" || message?.role !== "assistant" || message.provider !== "anthropic") continue;
		if (!(cost > 0) || Number.isNaN(time)) continue;
		rows.push({ time, key: message.responseId ?? `${message.timestamp}:${message.model}`, cost });
	}
	return rows;
}

async function jsonlFiles(root: string): Promise<string[]> {
	try {
		return (await readdir(root, { recursive: true })).filter((name) => name.endsWith(".jsonl"));
	} catch (error) {
		if (gone(error)) return [];
		throw error;
	}
}

/**
 * What the `anthropic` provider billed, per pi's prices, for assistant messages stored after `since` (ms) in the
 * session files under `roots`. A response counts once however many files hold a copy of it.
 */
// shortcut: a changed file is re-read whole; read only the appended bytes if sessions grow past ~50 MB
export async function spentSince(roots: string[], since: number, cache: Cache = new Map()) {
	const responses = new Map<string, number>();
	for (const root of roots) {
		for (const name of await jsonlFiles(root)) {
			const path = join(root, name);
			try {
				const info = await stat(path);
				if (info.mtimeMs < since - MTIME_SLACK_MS) continue;
				let scanned = cache.get(path);
				if (scanned?.size !== info.size || scanned.mtimeMs !== info.mtimeMs) {
					scanned = { size: info.size, mtimeMs: info.mtimeMs, rows: rowsOf(await readFile(path, "utf8")) };
					cache.set(path, scanned);
				}
				for (const row of scanned.rows) if (row.time > since) responses.set(row.key, row.cost);
			} catch (error) {
				if (!gone(error)) throw error; // a session deleted during the scan
			}
		}
	}
	return { cost: [...responses.values()].reduce((sum, cost) => sum + cost, 0), calls: responses.size };
}
