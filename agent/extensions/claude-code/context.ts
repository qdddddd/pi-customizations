import { readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { launch, onDemand, render, type State } from "./instructions.ts";
import { projectRoot } from "./memory.ts";
import { claudeDir } from "./transcript.ts";

const MESSAGE_TYPE = "claude-instructions";

/** External @path imports approved for this project in Claude Code (~/.claude.json, or .claude.json in CLAUDE_CONFIG_DIR). */
async function approvedImports(pi: ExtensionAPI, cwd: string): Promise<boolean> {
	const file = process.env.CLAUDE_CONFIG_DIR ? join(process.env.CLAUDE_CONFIG_DIR, ".claude.json") : join(homedir(), ".claude.json");
	const projects = JSON.parse(await readFile(file, "utf8").catch(() => "{}"))?.projects ?? {};
	return [cwd, await projectRoot(pi, cwd)].some((key) => projects[key]?.hasClaudeMdExternalIncludesApproved === true);
}

/** Files a tool call touches: path arguments, and a Bash command that reads one file the way Claude Code counts it. */
function touched(toolName: string, input: Record<string, unknown>, cwd: string): string[] {
	const files = ["path", "file_path", "file"].map((key) => input[key]).filter((value): value is string => typeof value === "string");
	if (toolName === "bash" && typeof input.command === "string") {
		const read = /^\s*(?:cat|head|tail|less|more|bat|nl)\s+(?:-\w+(?:\s+\d+)?\s+)*(?:'([^']+)'|"([^"]+)"|([^\s'"|;&<>]+))\s*$/.exec(input.command);
		if (read) files.push(read[1] ?? read[2] ?? read[3]);
	}
	return files.map((file) => resolve(cwd, file.startsWith("~/") ? join(homedir(), file.slice(2)) : file));
}

/** On-demand files already sent in this session since its last compaction, so a reload does not send them again. */
async function alreadySent(ctx: ExtensionContext): Promise<string[]> {
	const branch = ctx.sessionManager.getBranch();
	const since = branch.findLastIndex((entry) => entry.type === "compaction") + 1;
	const files = branch.slice(since).flatMap((entry) => (entry.type === "custom_message" && entry.customType === MESSAGE_TYPE ? ((entry.details as { files?: string[] } | undefined)?.files ?? []) : []));
	return Promise.all(files.map((file) => realpath(file).catch(() => file)));
}

export function registerInstructions(pi: ExtensionAPI) {
	let ready: Promise<{ state: State; section: string }> | undefined;
	// Context files pi loaded, from the latest prompt; empty when discovery is off (--no-context-files).
	let loaded: string[] = [];
	pi.on("session_start", () => {
		ready = undefined;
		loaded = [];
	});
	// After compaction, files that loaded on demand load again when a tool touches them, as in Claude Code.
	pi.on("session_compact", () => {
		ready = undefined;
	});

	const prepare = (ctx: ExtensionContext) =>
		(ready ??= (async () => {
			const contextWindow = ctx.model?.contextWindow ?? 200_000;
			const { state, sources } = await launch(
				{
					cwd: await realpath(ctx.cwd),
					home: homedir(),
					claude: claudeDir(),
					agent: getAgentDir(),
					approved: await approvedImports(pi, ctx.cwd),
					demandCap: contextWindow > 200_000 ? 150_000 : 40_000,
				},
				loaded,
			);
			for (const file of await alreadySent(ctx)) state.seen.add(file);
			const section = sources.length ? `Claude Code also loads these instruction files, which pi's context loading skipped. Follow them like the other project instructions.\n\n${render(sources)}` : "";
			return { state, section };
		})());

	pi.on("before_agent_start", async (event, ctx) => {
		loaded = (event.systemPromptOptions.contextFiles ?? []).map((file) => file.path);
		if (!loaded.length) return;
		try {
			const { section } = await prepare(ctx);
			if (section) event.systemPromptOptions.sections["claude-instructions"] = section;
		} catch (error) {
			ready = undefined;
			ctx.ui.notify(`Claude Code instructions unavailable: ${error instanceof Error ? error.message : String(error)}`, "warning");
		}
	});

	pi.on("tool_call", async (event, ctx) => {
		const files = touched(event.toolName, event.input as Record<string, unknown>, ctx.cwd);
		if (!loaded.length || files.length === 0) return;
		const { state } = await prepare(ctx);
		const sources = (await Promise.all(files.map((file) => onDemand(state, file)))).flat();
		if (sources.length === 0) return;
		pi.sendMessage(
			{
				customType: MESSAGE_TYPE,
				content: `Claude Code loads these instruction files for ${files.join(", ")}. Follow them like the other project instructions.\n\n${render(sources)}`,
				display: true,
				details: { files: sources.map((source) => source.path) },
			},
			{ deliverAs: "steer" },
		);
	});

	pi.registerMessageRenderer<{ files?: string[] }>(MESSAGE_TYPE, (message, { expanded, outputPad }, theme) => {
		const files = (message.details?.files ?? []).map((file) => file.replace(homedir(), "~")).join(", ");
		const head = `${theme.fg("customMessageLabel", "Claude Code instructions")} ${theme.fg("dim", files)}`;
		const body = typeof message.content === "string" ? message.content : "";
		const box = new Box(outputPad, 1, (text) => theme.bg("customMessageBg", text));
		box.addChild(new Text(expanded ? `${head}\n\n${body}` : head, 0, 0));
		return box;
	});
}
