import assert from "node:assert/strict";
import test from "node:test";
import { statsOnly } from "./footer.ts";

const dim = (text: string) => `\x1b[38;2;102;92;84m${text}\x1b[39m`;

test("hides the four token totals and model while preserving the remaining stats and their colours", () => {
	const warn = "\x1b[38;2;157;55;0m71.0%/872k (auto)\x1b[39m";
	const line = dim(`↑16k ↓40 R1.2M W9.4k CH86.3% $0.032 (sub) ${warn}`) + dim("                    (magpie) codex/gpt-6.2-sol • medium");
	assert.equal(statsOnly(line), dim(`🖫86.3% $0.032 (sub) ${warn}`) + "\x1b[38;2;102;92;84m" + "\x1b[39m");
});

test("preserves later metrics when token totals are absent and there is no model text", () => {
	const remaining = dim("$0.032 1.8%/872k (auto)");
	assert.equal(statsOnly(dim("↓40 $0.032 1.8%/872k (auto)")), remaining);
	assert.equal(statsOnly(remaining), remaining);
	assert.equal(statsOnly(""), "");
});
