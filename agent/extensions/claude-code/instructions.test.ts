// Run with: node --test agent/extensions/claude-code/
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { launch, onDemand, parseRule, ruleMatches, type Settings } from "./instructions.ts";

let root: string;
const files: Record<string, string> = {
	"home/.claude/CLAUDE.md": "user rules @~/notes/user.md",
	"home/.claude/rules/pref.md": "user pref",
	"home/notes/user.md": "user note",
	"home/notes/agent.md": "agent note",
	"agent/AGENTS.md": "global @~/notes/agent.md",
	"proj/AGENTS.md": "policy, see @docs/a.md",
	"proj/CLAUDE.md": [
		"guide <!-- maintainer note -->",
		"@docs/b.md and `@docs/span.md` and @\"docs/quoted.md\" and @docs/with\\ space.md",
		"```",
		"@docs/fenced.md",
		"```",
		"@AGENTS.md @../outside.md",
	].join("\n"),
	"proj/CLAUDE.local.md": "local notes",
	"proj/docs/a.md": "A",
	"proj/docs/b.md": "B @h2.md",
	"proj/docs/h2.md": "H2 @h3.md",
	"proj/docs/h3.md": "H3 @h4.md",
	"proj/docs/h4.md": "H4 @h5.md",
	"proj/docs/h5.md": "too deep",
	"proj/docs/span.md": "never",
	"proj/docs/quoted.md": "never",
	"proj/docs/fenced.md": "never",
	"proj/docs/with space.md": "spaced",
	"proj/.claude/rules/always.md": "always rule",
	"proj/.claude/rules/api.md": '---\npaths:\n  - "src/api/**/*.ts"\n---\napi rule',
	"proj/sub/CLAUDE.md": "sub guide",
	"outside.md": "outside",
};

before(async () => {
	root = await realpath(await mkdtemp(join(tmpdir(), "cc-instr-")));
	for (const [path, content] of Object.entries(files)) {
		await mkdir(dirname(join(root, path)), { recursive: true });
		await writeFile(join(root, path), content);
	}
});
after(() => rm(root, { recursive: true }));

const settings = (approved: boolean): Settings => ({ cwd: join(root, "proj"), home: join(root, "home"), claude: join(root, "home/.claude"), agent: join(root, "agent"), approved, demandCap: 40_000 });
const loaded = () => [join(root, "agent/AGENTS.md"), join(root, "proj/AGENTS.md")];
const names = (sources: { path: string }[]) => sources.map((source) => source.path.slice(root.length + 1));

test("adds the instruction files pi skips, with their @path imports, as Claude Code reads them", async () => {
	const { sources } = await launch(settings(false), loaded());
	assert.deepEqual(names(sources), [
		"home/notes/agent.md", // imported by pi's own global file, which pi does not expand
		"proj/docs/a.md", // imported by the AGENTS.md pi loaded
		"home/.claude/CLAUDE.md",
		"home/notes/user.md",
		"home/.claude/rules/pref.md",
		"proj/CLAUDE.md",
		"proj/docs/b.md",
		"proj/docs/h2.md",
		"proj/docs/h3.md",
		"proj/docs/h4.md", // the fourth hop; h5 is one too far
		"proj/docs/with space.md",
		"proj/.claude/rules/always.md",
		"proj/CLAUDE.local.md",
	]);
	assert.doesNotMatch(sources.find((source) => source.path.endsWith("proj/CLAUDE.md"))!.content, /maintainer note/);
	// With the project's external imports approved, a project file may import from outside the working directory.
	assert.ok(names((await launch(settings(true), loaded())).sources).includes("outside.md"));
});

test("subdirectory files and path-scoped rules load once, when a tool touches a file they cover", async () => {
	const { state } = await launch(settings(false), loaded());
	assert.deepEqual(names(await onDemand(state, "sub/x.ts")), ["proj/sub/CLAUDE.md"]);
	assert.deepEqual(names(await onDemand(state, "sub/y.ts")), []);
	assert.deepEqual(names(await onDemand(state, "src/web/page.ts")), []);
	assert.deepEqual(names(await onDemand(state, "src/api/v1/routes.ts")), ["proj/.claude/rules/api.md"]);
	assert.deepEqual(names(await onDemand(state, "src/api/v1/other.ts")), []);
});

test("rule frontmatter and patterns follow Claude Code", () => {
	assert.deepEqual(parseRule('---\npaths: "*.md, src/**/*.{ts,tsx}"\n---\nbody').patterns, ["*.md", "src/**/*.{ts,tsx}"]);
	assert.deepEqual(parseRule('---\npaths: ["a/*.{ts,tsx}", lib/*.ts]\n---\n').patterns, ["a/*.{ts,tsx}", "lib/*.ts"]);
	assert.equal(parseRule('---\npaths:\n  - "x/**"\n---\nkept').body, "kept");
	const base = "/repo";
	assert.ok(ruleMatches(["*.md"], base, "/repo/a/b/notes.md")); // no slash: any depth
	assert.ok(ruleMatches(["/top.md"], base, "/repo/top.md"));
	assert.ok(!ruleMatches(["/top.md"], base, "/repo/a/top.md")); // leading slash: base directory only
	assert.ok(ruleMatches(["src/*.{ts,tsx}"], base, "/repo/src/view.tsx"));
	assert.ok(!ruleMatches(["photos [2024/**"], base, "/repo/photos [2024/a.png")); // a stray [ matches nothing
	assert.ok(!ruleMatches(["**/*.md"], base, "/elsewhere/a.md"));
});
