// Run with: node --test agent/extensions/claude-code/
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { findCopies } from "./copies.ts";
import { liveSessions } from "./transcript.ts";

const id = "6b7cfbaf-b8f5-4631-ba89-5f1cbb4d6051";
const line = (entry: object) => JSON.stringify(entry);
const marker = (importedAt: string) => line({ type: "custom", customType: "claude-code-import", data: { importedAt, lastActivity: 1000 } });

test("a pi copy counts as continued only when something happened in pi after the import", async () => {
	const dir = await mkdtemp(join(tmpdir(), "cc-copies-"));
	try {
		const opened = [line({ type: "session" }), line({ type: "session_info", name: "cc: x" }), marker("2026-01-01T00:00:00Z"), line({ type: "model_change" })];
		const used = [line({ type: "session" }), marker("2026-01-02T00:00:00Z"), line({ type: "message", message: { role: "user", content: "go on" } })];
		await writeFile(join(dir, `2026-01-01T00-00-00-000Z_cc-${id}.jsonl`), opened.join("\n") + "\n");
		await writeFile(join(dir, `2026-01-02T00-00-00-000Z_cc-${id}-2.jsonl`), used.join("\n") + "\n");
		await writeFile(join(dir, "2026-01-03T00-00-00-000Z_01a20d13-9f6f-72cf-8e37-50a5deab1110.jsonl"), line({ type: "session" }) + "\n");
		const copies = (await findCopies([dir])).get(id)!;
		assert.deepEqual(copies.map((copy) => [copy.n, copy.touched, copy.lastActivity]), [[2, true, 1000], [1, false, 1000]]);
	} finally {
		await rm(dir, { recursive: true });
	}
});

test("a session record whose pid now belongs to a later process is not live", async () => {
	const dir = await mkdtemp(join(tmpdir(), "cc-live-"));
	const saved = process.env.CLAUDE_CONFIG_DIR;
	try {
		await mkdir(join(dir, "sessions"));
		await writeFile(join(dir, "sessions", "a.json"), line({ pid: process.pid, sessionId: "current", startedAt: Date.now() }));
		// Started a day before this process did: the pid has since been reused.
		await writeFile(join(dir, "sessions", "b.json"), line({ pid: process.pid, sessionId: "reused", startedAt: Date.now() - 86_400_000 }));
		process.env.CLAUDE_CONFIG_DIR = dir;
		assert.deepEqual([...(await liveSessions()).keys()], ["current"]);
	} finally {
		if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
		else process.env.CLAUDE_CONFIG_DIR = saved;
		await rm(dir, { recursive: true });
	}
});
