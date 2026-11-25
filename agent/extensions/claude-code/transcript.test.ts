// Run with: node --test agent/extensions/claude-code/
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildReplay, fit, loadTranscript, redact, type Msg } from "./transcript.ts";

type Row = Record<string, unknown>;
const base = { isSidechain: false, cwd: "/work/repo", gitBranch: "main", sessionId: "s" };
let clock = Date.parse("2026-01-01T00:00:00Z");
const at = () => new Date((clock += 1000)).toISOString();
const user = (uuid: string, parentUuid: string | null, content: unknown, extra: Row = {}): Row => ({ ...base, type: "user", uuid, parentUuid, timestamp: at(), message: { role: "user", content }, origin: { kind: "human" }, ...extra });
const assistant = (uuid: string, parentUuid: string, mid: string, block: Row): Row => ({ ...base, type: "assistant", uuid, parentUuid, timestamp: at(), message: { id: mid, model: "claude-x", role: "assistant", content: [block] } });
const toolUse = (id: string, name: string, input: Row) => ({ type: "tool_use", id, name, input });
const toolResult = (uuid: string, parentUuid: string, id: string, content: string): Row => user(uuid, parentUuid, [{ type: "tool_result", tool_use_id: id, content }], { origin: undefined });
const text = (value: string) => ({ type: "text", text: value });

async function replayOf(rows: (Row | string)[], budget = 100_000) {
	const dir = await mkdtemp(join(tmpdir(), "cc-test-"));
	try {
		const path = join(dir, "session.jsonl");
		// Metadata lines Claude Code interleaves with the conversation must be ignored.
		await writeFile(path, [{ type: "custom-title", customTitle: "t", sessionId: "s" }, ...rows, "{not json"].map((row) => (typeof row === "string" ? row : JSON.stringify(row))).join("\n") + "\n");
		return buildReplay(await loadTranscript(path), { budget, id: "s", path, fallbackCwd: "/fallback" });
	} finally {
		await rm(dir, { recursive: true });
	}
}
const messagesOf = async (rows: (Row | string)[], budget?: number) => (await replayOf(rows, budget))!.messages.map((msg) => msg.message) as any[];

const compacted: Row[] = [
	user("a0", null, "old prompt"),
	assistant("a1", "a0", "M0", text("old answer")),
	user("p1", "a1", "preserved question"),
	assistant("p2", "p1", "M1", text("preserved answer")),
	{ ...base, type: "system", subtype: "compact_boundary", uuid: "b0", parentUuid: null, logicalParentUuid: "p2", timestamp: at(), compactMetadata: { preTokens: 1234, preservedSegment: { headUuid: "p1", anchorUuid: "s0", tailUuid: "p2" } } },
	user("s0", "b0", "This session is being continued from a previous conversation that ran out of context.\n\n<system-reminder>tools</system-reminder>\nSummary:\nthe summary body\n\nContinue the conversation from where it left off without asking the user any further questions.", { isCompactSummary: true, origin: undefined }),
	user("n1", "s0", "new prompt"),
	assistant("n2", "n1", "M2", toolUse("T1", "Bash", { command: "echo 1", timeout: 5000 })),
	// The result of the first parallel call hangs off a sibling branch, not off the chain.
	toolResult("r1", "n2", "T1", "1\n"),
	assistant("n3", "n2", "M2", toolUse("T2", "Read", { file_path: "/work/repo/a.txt" })),
	toolResult("r2", "n3", "T2", "file content"),
	assistant("n4", "r2", "M3", text("all done")),
	{ ...base, type: "system", subtype: "turn_duration", uuid: "n5", parentUuid: "n4", timestamp: at() },
];

test("rebuilds the chain after a compaction: preserved segment, merged assistant message, off-chain result", async () => {
	const replay = await replayOf(compacted);
	assert.ok(replay);
	const [question, answer, prompt, calls, first, second, done] = replay.messages.map((msg) => msg.message) as any[];
	assert.deepEqual(replay.messages.map((msg) => msg.message.role), ["user", "assistant", "user", "assistant", "toolResult", "toolResult", "assistant"]);
	assert.equal(question.content, "preserved question");
	assert.equal(answer.content[0].text, "preserved answer");
	assert.equal(prompt.content, "new prompt");
	// Both calls of one API response share a message; Bash and Read appear under pi's tool names.
	assert.deepEqual(calls.content.map((block: any) => [block.name, block.arguments]), [["bash", { command: "echo 1", timeout: 5 }], ["read", { path: "/work/repo/a.txt" }]]);
	assert.deepEqual([first.toolCallId, first.content[0].text, second.toolCallId, second.content[0].text], ["T1", "1\n", "T2", "file content"]);
	assert.equal(done.content[0].text, "all done");
	assert.equal(replay.tokensBefore, 1234);
	assert.match(replay.summary, /the summary body/);
	assert.doesNotMatch(replay.summary, /without asking the user|<system-reminder>/);
});

test("keeps the blocks of a response that the chain bypasses through an earlier call's result", async () => {
	// Claude Code links the next turn to t1's result, leaving the response's second block (t2) on a side branch.
	const messages = await messagesOf([
		user("u", null, "run both"),
		assistant("a", "u", "m", toolUse("t1", "Bash", { command: "one" })),
		assistant("b", "a", "m", toolUse("t2", "Bash", { command: "two" })),
		toolResult("r2", "b", "t2", "second"),
		toolResult("r1", "a", "t1", "first"),
		assistant("f", "r1", "m2", text("both finished")),
	]);
	assert.deepEqual(messages[1].content.map((block: any) => block.id), ["t1", "t2"]);
	assert.deepEqual(messages.slice(2, 4).map((m) => [m.toolCallId, m.content[0].text]), [["t1", "first"], ["t2", "second"]]);
});

test("a call without a recorded result gets an error result so the history stays valid", async () => {
	const last = (await messagesOf([user("u", null, "go"), assistant("a", "u", "M", toolUse("X", "Bash", { command: "sleep 9" }))])).at(-1);
	assert.equal(last.role, "toolResult");
	assert.equal(last.isError, true);
});

test("replays images and background task results, and reads records containing U+2028", async () => {
	const gif = "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
	const notice = "<task-notification><status>completed</status><summary>Audit done</summary><result>The migration drops a table.</result></task-notification>";
	const [image, task, separated] = await messagesOf([
		user("u", null, [text("see"), { type: "image", source: { type: "base64", media_type: "image/gif", data: gif } }]),
		user("v", "u", notice, { origin: { kind: "task-notification" } }),
		user("w", "v", "line\u2028separator"),
	]);
	assert.deepEqual(image.content[1], { type: "image", data: gif, mimeType: "image/gif" });
	assert.match(task.content, /Audit done\nThe migration drops a table\./);
	assert.equal(separated.content, "line\u2028separator");
});

test("redacts secrets before clipping, so a cut cannot expose a key", async () => {
	const key = "-----BEGIN PRIVATE KEY-----\n" + "K".repeat(4000) + "\n-----END PRIVATE KEY-----";
	const [message] = await messagesOf([user("u", null, "x".repeat(6000) + key + "y".repeat(13000))]);
	assert.doesNotMatch(message.content, /KKKK/);
	assert.equal(redact("ghp_abcdefghijklmnopqrstuvwxyz0123 Bearer abcdefghijklmnop1234"), "[redacted token] Bearer [redacted]");
	assert.equal(redact("https://bot:s3cretpass@host/x MY_API_TOKEN=abcdef0123456789"), "https://bot:[redacted]@host/x MY_API_TOKEN=[redacted]");
	assert.equal(redact("max_tokens=128000 MAX_OUTPUT_TOKENS=128000 TOKEN=$TOKEN"), "max_tokens=128000 MAX_OUTPUT_TOKENS=128000 TOKEN=$TOKEN");
});

const msg = (role: string, tokens: number, ts = 0): Msg => ({ message: { role } as Msg["message"], tokens, ts });
const sum = (msgs: Msg[]) => msgs.reduce((total, m) => total + m.tokens, 0);

test("fit starts at a user message and never opens with a tool result", () => {
	const messages = [msg("user", 10), msg("assistant", 10), msg("toolResult", 10), msg("user", 10), msg("assistant", 10), msg("toolResult", 10), msg("toolResult", 10), msg("assistant", 10)];
	// 65 tokens reach back to the first run's tool result; the kept range moves forward to the next prompt.
	const { kept, dropped } = fit(messages, 65);
	assert.deepEqual(kept.map((m) => m.message.role), ["user", "assistant", "toolResult", "toolResult", "assistant"]);
	assert.equal(dropped.length, 3);
});

test("fit leaves a history that fits untouched, even when it opens with an assistant message", () => {
	const messages = [msg("assistant", 10), msg("user", 10), msg("assistant", 10)];
	assert.deepEqual(fit(messages, 100), { kept: messages, dropped: [] });
});

test("fit keeps the prompt of a run that alone exceeds the budget, within the budget", () => {
	const messages = [msg("user", 60), msg("assistant", 35), msg("toolResult", 20), msg("assistant", 30), msg("toolResult", 20)];
	const { kept } = fit(messages, 110);
	assert.deepEqual(kept, [messages[0], messages[3], messages[4]]);
	assert.ok(sum(kept) <= 110);
});
