import { readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { generateUnifiedPatch, truncateHead, type ExtensionAPI, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { atomicWrite, digest, text } from "./shared.ts";

const maxFileBytes = 4 * 1024 * 1024;
const encoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
type Line = { value: string; ending: string };
type Operation = { start: number; end: number; body: string[] };

function linesOf(value: string): Line[] {
	const lines: Line[] = [];
	for (const row of value.matchAll(/([^\r\n]*)(\r\n|\n|\r|$)/g)) {
		if (row[0]) lines.push({ value: row[1], ending: row[2] });
	}
	return lines;
}

function parsePatch(patch: string, count: number, seen: Set<number>): Operation[] {
	// Only a trailing newline is structural. Trailing whitespace on '+' rows is file content.
	const normalized = patch.replace(/\r\n/g, "\n");
	if (normalized.includes("\r") || normalized.includes("\0")) throw new Error("Hashline patches cannot contain bare carriage returns or NUL bytes.");
	const exactRows = normalized.replace(/\n$/, "").split("\n");
	const operations: Operation[] = [];
	for (let index = 0; index < exactRows.length; index++) {
		const row = exactRows[index];
		const range = /^(PUT|CUT) (\d+)\.=(\d+)(:)?$/.exec(row);
		const insertion = /^PUT ([<>])(\d+|\$):$/.exec(row);
		if (!insertion && (!range || (range[1] === "PUT") !== Boolean(range[4]))) {
			throw new Error(`Invalid hashline operation on patch row ${index + 1}.`);
		}
		const first = insertion?.[2] === "$" ? count : Number(insertion?.[2] ?? range?.[2]);
		const last = insertion ? first : Number(range?.[3]);
		const emptyHead = count === 0 && row === "PUT <1:";
		if (!emptyHead && (!Number.isSafeInteger(first) || first < 1 || last < first || last > count)) {
			throw new Error(`Anchor is outside the file on patch row ${index + 1}. Use PUT <1: for an empty file.`);
		}
		for (let line = first; !emptyHead && line <= last; line++) {
			if (!seen.has(line)) throw new Error(`Line ${line} has not been shown for this snapshot. Read it first.`);
		}
		const start = emptyHead ? 0 : insertion?.[1] === ">" ? first : first - 1;
		const body: string[] = [];
		if (insertion || range?.[1] === "PUT") {
			while (exactRows[index + 1]?.startsWith("+")) body.push(exactRows[++index].slice(1));
			if (!body.length) throw new Error("PUT requires one or more + lines. Use CUT to delete.");
		}
		operations.push({ start, end: insertion ? start : last, body });
	}
	operations.sort((left, right) => left.start - right.start);
	for (let index = 1; index < operations.length; index++) {
		const previous = operations[index - 1];
		const current = operations[index];
		if (current.start < previous.end || current.start === previous.start) {
			throw new Error("Hashline operations overlap or share an insertion point. Combine them into one PUT.");
		}
	}
	return operations;
}

function applyPatch(lines: Line[], operations: Operation[]): string {
	const ending = lines.find((line) => line.ending)?.ending ?? "\n";
	const lastEnding = lines.at(-1)?.ending ?? "\n";
	const output: Line[] = [];
	let cursor = 0;
	for (const operation of operations) {
		for (; cursor < operation.start; cursor++) output.push(lines[cursor]);
		for (let index = 0; index < operation.body.length; index++) {
			const previous = operation.start + index < operation.end ? lines[operation.start + index] : undefined;
			output.push({ value: operation.body[index], ending: previous?.ending || ending });
		}
		cursor = operation.end;
	}
	for (; cursor < lines.length; cursor++) output.push(lines[cursor]);
	return output.map((line, index) => line.value + (index === output.length - 1 ? lastEnding : line.ending || ending)).join("");
}

async function localPath(cwd: string, path: string) {
	return realpath(resolve(cwd, path.startsWith("~/") ? resolve(homedir(), path.slice(2)) : path));
}

async function snapshot(path: string, signal?: AbortSignal) {
	const info = await stat(path);
	if (!info.isFile() || info.size > maxFileBytes) throw new Error("Hashline requires a regular UTF-8 file of up to 4 MiB.");
	const bytes = await readFile(path, { signal });
	if (bytes.length > maxFileBytes || bytes.includes(0)) throw new Error("Hashline requires a UTF-8 text file of up to 4 MiB.");
	const value = encoder.decode(bytes);
	const bom = value.startsWith("\uFEFF") ? "\uFEFF" : "";
	return { info, hash: digest(bytes), lines: linesOf(value.slice(bom.length)), value, bom };
}

export function registerHashline(pi: ExtensionAPI) {
	const seen = new Map<string, { hash: string; lines: Set<number> }>();
	pi.on("session_start", () => { seen.clear(); });

	pi.registerTool({
		name: "hashline_read", label: "Hashline read",
		description: "Read local UTF-8 text as numbered lines with an exact-byte snapshot tag for hashline_edit.",
		parameters: Type.Object({
			path: Type.String(),
			offset: Type.Optional(Type.Integer({ minimum: 1 })),
			limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 2000 })),
		}),
		async execute(_id, input, signal, _update, ctx) {
			const path = await localPath(ctx.cwd, input.path);
			const { hash, lines } = await snapshot(path, signal);
			const anchors = seen.get(path)?.hash === hash ? seen.get(path)!.lines : new Set<number>();
			const tag = hash.slice(0, 16);
			const rows = [`[${input.path}#${tag}]`];
			const offset = input.offset ?? 1;
			if (offset > Math.max(1, lines.length)) throw new Error(`Offset ${offset} exceeds ${lines.length} lines.`);
			let displayedBytes = 0;
			let index = offset - 1;
			for (; index < Math.min(lines.length, offset - 1 + (input.limit ?? 250)); index++) {
				const row = `${index + 1}:${lines[index].value}`;
				const bytes = Buffer.byteLength(row) + 1;
				if (bytes > 45_000) {
					rows.push(`[Line ${index + 1} exceeds the output limit and cannot be used as an anchor]`);
					continue;
				}
				if (displayedBytes + bytes > 45_000) break;
				displayedBytes += bytes;
				rows.push(row);
				anchors.add(index + 1);
			}
			if (index < lines.length) rows.push(`[${lines.length} lines total. Continue with offset ${index + 1}.]`);
			if (lines.length === 0) rows.push("[Empty file. Insert using PUT <1:.]");
			seen.delete(path);
			seen.set(path, { hash, lines: anchors });
			if (seen.size > 128) seen.delete(seen.keys().next().value!);
			return { content: [text(rows.join("\n"))], details: { tag, lineCount: lines.length } };
		},
	});

	pi.registerTool({
		name: "hashline_edit", label: "Hashline edit",
		description: "Edit previously displayed lines of one existing file. Supply the tag from hashline_read and a patch with PUT N.=M: (inclusive replacement), PUT <N: or PUT >N: (insertion), or CUT N.=M (deletion). Each PUT body line starts with +, including + for a blank line. Use original line numbers throughout. Set preview=true for a dry-run diff. Re-read after each applied edit.",
		parameters: Type.Object({
			path: Type.String(),
			tag: Type.String({ pattern: "^[0-9a-fA-F]{16}$" }),
			patch: Type.String({ minLength: 1, maxLength: 250_000 }),
			preview: Type.Optional(Type.Boolean()),
		}),
		async execute(_id, input, signal, _update, ctx) {
			const path = await localPath(ctx.cwd, input.path);
			return withFileMutationQueue(path, async () => {
				const current = await snapshot(path, signal);
				const record = seen.get(path);
				if (record?.hash !== current.hash || current.hash.slice(0, 16) !== input.tag.toLowerCase()) {
					throw new Error(`Hashline snapshot is stale or unavailable. Re-read ${input.path} before editing.`);
				}
				if (current.info.nlink !== 1) throw new Error("Hashline cannot atomically replace a file with multiple hard links.");
				const operations = parsePatch(input.patch, current.lines.length, record.lines);
				const updated = current.bom + applyPatch(current.lines, operations);
				if (Buffer.byteLength(updated) > maxFileBytes) throw new Error("The patched file would exceed 4 MiB.");
				if (updated === current.value) return { content: [text("The patch leaves the file unchanged.")], details: { changed: false } };
				if (input.preview) {
					const diff = truncateHead(generateUnifiedPatch(input.path, current.value, updated), { maxBytes: 40_000, maxLines: 1000 });
					return { content: [text(`Preview only${diff.truncated ? " (truncated)" : ""}\n${diff.content}`)], details: { changed: false, preview: true } };
				}
				await atomicWrite(path, updated, current.info.mode & 0o777, async () => {
					const latest = await snapshot(path, signal);
					if (latest.hash !== current.hash || latest.info.ino !== current.info.ino || latest.info.mode !== current.info.mode || latest.info.nlink !== 1) {
						throw new Error("File changed while applying the hashline patch. Re-read it and retry.");
					}
					signal?.throwIfAborted();
				});
				seen.delete(path);
				return { content: [text(`Applied ${operations.length} hashline operation(s) to ${input.path}. Re-read before editing it again.`)], details: { changed: true } };
			});
		},
	});
}
