import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseAmount, readAnchor, spentSince, writeAnchor } from "./ledger.ts";

const T0 = Date.parse("2026-11-24T12:00:00Z");
const at = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString();

function message(minutes: number, cost: number, extra: { id?: string; provider?: string; role?: string } = {}) {
	const { id, provider = "anthropic", role = "assistant" } = extra;
	const body = { role, provider, model: "claude-x", responseId: id, timestamp: T0 + minutes * 60_000, usage: { cost: { total: cost } } };
	return `${JSON.stringify({ type: "message", timestamp: at(minutes), message: body })}\n`;
}

async function sandbox(files: Record<string, string>) {
	const root = await mkdtemp(join(tmpdir(), "credit-"));
	for (const [name, text] of Object.entries(files)) {
		await mkdir(join(root, name, ".."), { recursive: true });
		await writeFile(join(root, name), text);
	}
	return root;
}

test("sums the anthropic assistant messages stored after the anchor", async () => {
	const root = await sandbox({
		"a/s.jsonl": message(-5, 1, { id: "old" }) + message(5, 2, { id: "x" }) + message(6, 3, { id: "y" }) + message(7, 100, { id: "z", provider: "magpie" }) + message(8, 50, { id: "u", role: "user" }),
	});
	try {
		assert.deepEqual(await spentSince([root], T0), { cost: 5, calls: 2 });
	} finally {
		await rm(root, { recursive: true });
	}
});

test("a response held by several files counts once; responses without an id are told apart by time", async () => {
	const root = await sandbox({
		"a/original.jsonl": message(1, 2, { id: "msg_1" }) + message(2, 4) + message(3, 4),
		"b/fork.jsonl": message(1, 2, { id: "msg_1" }),
	});
	try {
		assert.deepEqual(await spentSince([root, join(root, "missing")], T0), { cost: 10, calls: 3 });
	} finally {
		await rm(root, { recursive: true });
	}
});

test("a session file that grew is read again", async () => {
	const root = await sandbox({ "s.jsonl": message(1, 1, { id: "a" }) });
	const cache = new Map();
	try {
		assert.deepEqual(await spentSince([root], T0, cache), { cost: 1, calls: 1 });
		await appendFile(join(root, "s.jsonl"), message(2, 2, { id: "b" }));
		assert.deepEqual(await spentSince([root], T0, cache), { cost: 3, calls: 2 });
	} finally {
		await rm(root, { recursive: true });
	}
});

test("amounts and the stored anchor", async () => {
	assert.deepEqual(["142.3", "$142.30", " 1,234.50 ", "0"].map(parseAmount), [142.3, 142.3, 1234.5, 0]);
	assert.deepEqual(["", "abc", "-5", "1e3", "12,34", "$"].map(parseAmount), Array(6).fill(undefined));

	const root = await sandbox({ "bad.json": "{not json" });
	try {
		assert.equal(await readAnchor(join(root, "bad.json")), undefined);
		assert.equal(await readAnchor(join(root, "none.json")), undefined);
		await writeAnchor(join(root, "sub/anchor.json"), { amount: 12.5, at: at(0) });
		assert.deepEqual(await readAnchor(join(root, "sub/anchor.json")), { amount: 12.5, at: at(0) });
	} finally {
		await rm(root, { recursive: true });
	}
});
