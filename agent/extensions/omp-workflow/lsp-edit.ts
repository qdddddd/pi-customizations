import { constants, type Stats } from "node:fs";
import { link, lstat, open, realpath, unlink } from "node:fs/promises";
import { dirname, isAbsolute, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { generateUnifiedPatch, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { atomicWrite, errorText } from "./shared.ts";

const maxBytes = 4 * 1024 * 1024;
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export type Position = { line: number; character: number };
export type Document = { text: string; version: number };
export type Snapshot = { text: string; info: Stats };
type TextEdit = { range: { start: Position; end: Position }; newText: string; annotationId?: string };
type FileEdit = { path: string; before: Snapshot; after: string };
export type WorkspacePlan = { files: FileEdit[]; unsupported: string[] };
export type FileMove = { from: string; to: string; before: Snapshot };
export type WorkspaceResponse = { edit: unknown; documents: ReadonlyMap<string, Document> };

export function record(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function inside(root: string, file: string) {
	const path = relative(root, file);
	return path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

export function fileUri(path: string) {
	return pathToFileURL(path).href;
}

export async function readSnapshot(path: string, signal?: AbortSignal): Promise<Snapshot> {
	signal?.throwIfAborted();
	const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	try {
		const info = await handle.stat();
		if (!info.isFile() || info.size > maxBytes) throw new Error(`Expected a regular UTF-8 file of up to 4 MiB at ${path}.`);
		const bytes = Buffer.alloc(info.size + 1);
		let length = 0;
		while (length < bytes.length) {
			signal?.throwIfAborted();
			const { bytesRead } = await handle.read(bytes, length, bytes.length - length, length);
			if (!bytesRead) break;
			length += bytesRead;
		}
		const latest = await handle.stat();
		if (length !== info.size || latest.mtimeMs !== info.mtimeMs || latest.ctimeMs !== info.ctimeMs) {
			throw new Error(`File changed while reading ${path}.`);
		}
		const value = bytes.subarray(0, length);
		if (value.includes(0)) throw new Error(`Expected a UTF-8 text file at ${path}.`);
		return { text: decoder.decode(value), info };
	} finally {
		await handle.close();
	}
}

async function checkPath(root: string, file: string, destination = false) {
	if (!inside(root, file) || file === root || relative(root, file).split(sep).some((part) => /^\.(git|hg|svn|pi)$/i.test(part))) {
		throw new Error(`Workspace mutation is outside the allowed paths at ${file}.`);
	}
	const path = destination ? dirname(file) : file;
	if (await realpath(path) !== path) throw new Error(`Workspace mutation through a symbolic link or path alias at ${path}.`);
	if (destination) {
		const target = await lstat(file).catch((error: NodeJS.ErrnoException) => {
			if (error.code !== "ENOENT") throw error;
		});
		if (target) throw new Error(`Rename destination already exists at ${file}.`);
	}
}

export async function prepareFileMove(root: string, from: string, to: string, signal: AbortSignal): Promise<FileMove> {
	await checkPath(root, from);
	await checkPath(root, to, true);
	const before = await readSnapshot(from, signal);
	if (before.info.nlink !== 1) throw new Error(`Cannot move a file with multiple hard links at ${from}.`);
	return { from, to, before };
}

function editText(text: string, edits: TextEdit[]) {
	const lines = text.split(/\r\n|\n|\r/);
	const starts = [0, ...Array.from(text.matchAll(/\r\n|\n|\r/g), (match) => match.index + match[0].length)];
	function offset(position: Position) {
		const { line, character } = position;
		if (!Number.isSafeInteger(line) || !Number.isSafeInteger(character) || line < 0 || line >= lines.length || character < 0 || character > lines[line].length) {
			throw new Error("Workspace edit contains a position outside the document.");
		}
		if (/[\uD800-\uDBFF]/.test(lines[line][character - 1] ?? "") && /[\uDC00-\uDFFF]/.test(lines[line][character] ?? "")) {
			throw new Error("Workspace edit splits a UTF-16 surrogate pair.");
		}
		return starts[line] + character;
	}
	const ranges = edits.map((edit) => ({ start: offset(edit.range.start), end: offset(edit.range.end), value: edit.newText }));
	ranges.sort((a, b) => a.start - b.start);
	let cursor = 0;
	const chunks: string[] = [];
	for (const { start, end, value } of ranges) {
		if (start < cursor || end < start) throw new Error("Workspace edits overlap or contain a reversed range.");
		chunks.push(text.slice(cursor, start), value);
		cursor = end;
	}
	const result = chunks.join("") + text.slice(cursor);
	if (Buffer.byteLength(result) > maxBytes) throw new Error("Workspace edit would produce a file larger than 4 MiB.");
	return result;
}

export async function prepareWorkspaceEdit(root: string, responses: WorkspaceResponse[], signal: AbortSignal): Promise<WorkspacePlan> {
	const buckets = new Map<string, { edits: TextEdit[]; seen: Set<string>; before: Snapshot }>();
	const unsupported: string[] = [];
	for (const { edit, documents } of responses) {
		if (edit == null) continue;
		if (!record(edit)) throw new Error("Invalid WorkspaceEdit from the language server.");
		const annotations = record(edit.changeAnnotations) ? edit.changeAnnotations : {};
		const seen = new Set<string>();
		async function add(uri: unknown, edits: unknown, version?: unknown) {
			if (typeof uri !== "string" || !Array.isArray(edits)) throw new Error("Invalid document change in WorkspaceEdit.");
			const file = fileURLToPath(uri);
			if (seen.has(file)) throw new Error(`Workspace edit contains multiple change sets for ${file}.`);
			seen.add(file);
			await checkPath(root, file);
			const document = documents.get(fileUri(file));
			if (version != null && (!Number.isSafeInteger(version) || document?.version !== version)) {
				throw new Error(`Workspace edit targets a stale or unknown document version at ${file}.`);
			}
			let bucket = buckets.get(file);
			if (!bucket) {
				if (buckets.size >= 100) throw new Error("Workspace edit exceeds the limit of 100 files.");
				const before = await readSnapshot(file, signal);
				if (before.info.nlink !== 1) throw new Error(`Cannot edit a file with multiple hard links at ${file}.`);
				bucket = { edits: [], seen: new Set(), before };
				buckets.set(file, bucket);
			}
			if (document && document.text !== bucket.before.text) throw new Error(`File changed during the language server request at ${file}.`);
			const responseEdits = new Set<string>();
			for (const change of edits) {
				if (typeof change?.newText !== "string" || change.newText.includes("\0") || !record(change.range?.start) || !record(change.range?.end)) {
					throw new Error(`Invalid text edit at ${file}.`);
				}
				if (change.annotationId !== undefined) {
					const annotation = typeof change.annotationId === "string" && Object.hasOwn(annotations, change.annotationId) ? annotations[change.annotationId] : undefined;
					if (!record(annotation) || annotation.needsConfirmation) unsupported.push(`Text edit requiring separate confirmation at ${relative(root, file)}`);
				}
				const { start, end } = change.range;
				const key = JSON.stringify([start.line, start.character, end.line, end.character, change.newText]);
				if (!bucket.seen.has(key)) bucket.edits.push(change);
				responseEdits.add(key);
			}
			for (const key of responseEdits) bucket.seen.add(key);
		}
		if (edit.documentChanges !== undefined) {
			if (!Array.isArray(edit.documentChanges)) throw new Error("Invalid documentChanges in WorkspaceEdit.");
			for (const change of edit.documentChanges) {
				if (!record(change)) throw new Error("Invalid change in WorkspaceEdit.");
				if (change.kind !== undefined) {
					unsupported.push(`Resource operation ${JSON.stringify({ kind: change.kind, uri: change.uri, oldUri: change.oldUri, newUri: change.newUri })}`);
					continue;
				}
				if (!record(change.textDocument)) throw new Error("Invalid textDocument in WorkspaceEdit.");
				await add(change.textDocument.uri, change.edits, change.textDocument.version);
			}
		} else if (edit.changes !== undefined) {
			if (!record(edit.changes)) throw new Error("Invalid changes in WorkspaceEdit.");
			for (const [uri, edits] of Object.entries(edit.changes)) await add(uri, edits);
		}
	}
	const files: FileEdit[] = [];
	for (const [path, { before, edits }] of buckets) {
		const after = editText(before.text, edits);
		if (after !== before.text) files.push({ path, before, after });
	}
	return { files, unsupported: [...new Set(unsupported)] };
}

export function previewWorkspaceEdit(root: string, plan: WorkspacePlan) {
	const changes = plan.files.map(({ path, before, after }) => generateUnifiedPatch(relative(root, path), before.text, after));
	return [...changes, ...plan.unsupported.map((change) => `Cannot apply automatically: ${change}`)].join("\n") || "No workspace edits.";
}

async function assertSnapshot(root: string, path: string, before: Snapshot, signal?: AbortSignal) {
	await checkPath(root, path);
	const current = await readSnapshot(path, signal);
	const { info } = current;
	if (info.dev !== before.info.dev || info.ino !== before.info.ino || info.mode !== before.info.mode || info.nlink !== 1 || current.text !== before.text) {
		throw new Error(`File changed before mutation at ${path}.`);
	}
	return current;
}

export async function applyWorkspacePlan(root: string, plan: WorkspacePlan, signal: AbortSignal, move?: FileMove) {
	if (plan.unsupported.length) throw new Error(`Cannot apply this WorkspaceEdit. ${plan.unsupported.join("; ")}`);
	const paths = [...new Set([...plan.files.map((edit) => edit.path), ...(move ? [move.from, move.to] : [])])].sort();
	const committed: FileEdit[] = [];
	async function commit() {
		for (const { path, before } of plan.files) await assertSnapshot(root, path, before, signal);
		if (move) {
			await assertSnapshot(root, move.from, move.before, signal);
			await checkPath(root, move.to, true);
		}
		try {
			for (const edit of plan.files) {
				await atomicWrite(edit.path, edit.after, edit.before.info.mode & 0o777, async () => {
					await assertSnapshot(root, edit.path, edit.before, signal);
					signal.throwIfAborted();
				});
				committed.push(edit);
			}
			if (move) {
				const changed = committed.find((edit) => edit.path === move.from);
				const expected = changed ? await readSnapshot(move.from, signal) : move.before;
				if (changed && expected.text !== changed.after) throw new Error(`File changed before rename at ${move.from}.`);
				await assertSnapshot(root, move.from, expected, signal);
				await checkPath(root, move.to, true);
				signal.throwIfAborted();
				// A hard link provides a no-clobber move for regular files on one filesystem.
				await link(move.from, move.to);
				try {
					const current = await lstat(move.from);
					if (current.dev !== expected.info.dev || current.ino !== expected.info.ino) throw new Error(`Rename source changed at ${move.from}.`);
					await unlink(move.from);
				} catch (error) {
					try {
						const linked = await lstat(move.to);
						if (linked.dev !== expected.info.dev || linked.ino !== expected.info.ino) throw new Error(`Rename destination changed at ${move.to}.`);
						await unlink(move.to);
					} catch (rollback) {
						throw new Error(`${errorText(error)} Rename rollback failed: ${errorText(rollback)}`);
					}
					throw error;
				}
			}
		} catch (error) {
			const failures: string[] = [];
			for (const { path, before, after } of committed.reverse()) {
				try {
					const current = await readSnapshot(path);
					if (current.text !== after) throw new Error(`File changed after application at ${path}.`);
					await atomicWrite(path, before.text, before.info.mode & 0o777, async () => { await assertSnapshot(root, path, current); });
				} catch (rollback) {
					failures.push(errorText(rollback));
				}
			}
			if (failures.length) throw new Error(`${errorText(error)} Workspace edit rollback failed: ${failures.join("; ")}`);
			throw error;
		}
	}
	function lock(index: number): Promise<void> {
		return index === paths.length ? commit() : withFileMutationQueue(paths[index], () => lock(index + 1));
	}
	await lock(0);
}
