import { join } from "node:path";
import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { type Anchor, type Cache, parseAmount, readAnchor, spentSince, writeAnchor } from "./ledger.ts";

const STATUS = "anthropic-credit";
const LOW = 20; // USD below which the footer turns yellow
const CRITICAL = 5; // USD below which it turns red

const usd = (value: number) => `$${value.toFixed(2)}`;

/**
 * Shows the Anthropic API credit left in the footer. Anthropic has no balance endpoint, so the number is an
 * estimate: the balance read from the Console and entered with /balance, minus what saved sessions spent since.
 */
export default function (pi: ExtensionAPI) {
	const agentDir = getAgentDir();
	const anchorFile = join(agentDir, "anthropic-credit.json");
	// Sessions, plus the ones omp-workflow subagents save: they run without extensions, so no hook sees their spend.
	const roots = [join(agentDir, "sessions"), join(agentDir, "omp-workflow", "agents")];
	const cache: Cache = new Map();

	async function estimate() {
		const anchor = await readAnchor(anchorFile);
		if (!anchor) return undefined;
		const spent = await spentSince(roots, Date.parse(anchor.at), cache);
		return { anchor, spent, left: Math.max(0, anchor.amount - spent.cost) };
	}

	async function show(ctx: ExtensionContext) {
		const { theme } = ctx.ui;
		const state = await estimate();
		if (!state) return ctx.ui.setStatus(STATUS, theme.fg("dim", "claude credit: /balance <usd>"));
		const value = `~${usd(state.left)}`;
		const color = state.left < CRITICAL ? "error" : state.left < LOW ? "warning" : undefined;
		ctx.ui.setStatus(STATUS, `${theme.fg("dim", "claude")} ${color ? theme.fg(color, value) : value}`);
	}

	// Refreshes never overlap; a request made during one reruns it once with the newest context.
	let running = false;
	let queued: ExtensionContext | undefined;
	async function refresh(ctx: ExtensionContext) {
		if (!ctx.hasUI) return;
		queued = ctx;
		if (running) return;
		running = true;
		while (queued) {
			const current = queued;
			queued = undefined;
			try {
				await show(current);
			} catch {
				// Best effort: a failed scan, or a context made stale by a session switch, must not break a turn.
				// /balance reports scan errors.
			}
		}
		running = false;
	}

	// Pi stores a message after its message_end handlers run, so the spend is read at turn_end.
	pi.on("session_start", (_event, ctx) => void refresh(ctx));
	pi.on("turn_end", (_event, ctx) => void refresh(ctx));
	pi.on("agent_end", (_event, ctx) => void refresh(ctx));

	pi.registerCommand("balance", {
		description: "Show the Anthropic API credit estimate, or set it from the Console: /balance [usd]",
		handler: async (args, ctx) => {
			const text = args.trim();
			if (text) {
				const amount = parseAmount(text);
				if (amount === undefined) return ctx.ui.notify("Usage: /balance [usd], with the credit balance from the Console Billing page.", "error");
				await writeAnchor(anchorFile, { amount, at: new Date().toISOString() });
			}
			const state = await estimate();
			ctx.ui.notify(state ? report(state) : "No balance set. Run /balance <usd> with the credit balance from the Console Billing page.", "info");
			await refresh(ctx);
		},
	});
}

function report({ anchor, spent, left }: { anchor: Anchor; spent: { cost: number; calls: number }; left: number }) {
	const at = new Date(anchor.at).toLocaleString("sv");
	return (
		`Anthropic credit ≈ ${usd(left)}: ${usd(anchor.amount)} on ${at}, less ${usd(spent.cost)} spent on the anthropic provider since ` +
		`(${spent.calls} calls in saved sessions). Run /balance <usd> again to correct any drift.`
	);
}
