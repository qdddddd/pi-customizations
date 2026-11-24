import { SessionManager, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Input, matchesKey, replaceControlCharacters, stripTerminalSequences, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { Job } from "./agents.ts";
import { errorText, messageText } from "./shared.ts";

function transcript(job: Job) {
	const messages = job.session?.messages ?? (job.file ? SessionManager.open(job.file).buildSessionProjection().messages : []);
	return messages.filter((message) => ["user", "assistant", "toolResult"].includes(message.role))
		.slice(-32).map((message) => `${message.role}\n${messageText(message, 2000)}`);
}

function clean(value: string) {
	return replaceControlCharacters(stripTerminalSequences(value.replaceAll("\t", "    ")));
}

export async function showAgentHub(
	ctx: ExtensionContext,
	jobs: () => Job[],
	subscribe: (listener: () => void) => () => void,
	send: (job: Job, text: string) => Promise<void>,
	stop: (job: Job) => void,
) {
	await ctx.ui.custom<void>((tui, theme, _keys, done) => {
		const input = new Input();
		let selected = 0;
		let opened: Job | undefined;
		let scroll = 0;
		let editing = false;
		let busy = false;
		let status = "";
		let focused = false;
		let parkedRows: string[] | undefined;
		const unsubscribe = subscribe(() => tui.requestRender());
		return {
			get focused() { return focused; },
			set focused(value: boolean) { focused = value; input.focused = value && editing; },
			invalidate() { input.invalidate(); },
			dispose() { unsubscribe(); },
			render(width) {
				const inner = Math.max(1, width - 2);
				const height = Math.max(4, Math.min(26, tui.terminal.rows - 8));
				const roster = jobs();
				selected = Math.max(0, Math.min(selected, roster.length - 1));
				const current = opened ?? roster[selected];
				const lines = [theme.bold(theme.fg("accent", opened ? `Agent ${opened.id.slice(0, 8)} · ${opened.role}` : "Agent Hub"))];
				if (opened) {
					const stats = opened.session?.getSessionStats();
					lines.push(theme.fg("muted", `${opened.status} · ${opened.model}${stats ? ` · ${stats.tokens.total} tokens · $${stats.cost.toFixed(3)}` : ""}`));
					let entries: string[];
					try { entries = opened.session ? transcript(opened) : parkedRows ??= transcript(opened); }
					catch (error) { entries = [errorText(error)]; }
					if (opened.error) entries = [...entries, `Error: ${opened.error}`];
					if (opened.status === "running" && opened.preview) entries.push(`Live response\n${opened.preview}`);
					const body = entries.join("\n\n").split("\n").flatMap((line) => wrapTextWithAnsi(clean(line), inner));
					scroll = Math.min(scroll, Math.max(0, body.length - height));
					const end = body.length - scroll;
					lines.push(...body.slice(Math.max(0, end - height), end));
				} else {
					const first = Math.max(0, selected - height + 1);
					if (!roster.length) lines.push(theme.fg("muted", "No agents in this session."));
					for (const [index, job] of roster.slice(first, first + height).entries()) {
						const active = first + index === selected;
						const line = `${active ? "▸" : " "} ${job.id.slice(0, 8)}  ${job.role}  ${job.status}${job.activity ? ` · ${job.activity}` : ""}`;
						lines.push(theme.fg(active ? "accent" : "text", line));
					}
					if (current) {
						lines.push(theme.fg("muted", current.model));
						lines.push(clean(current.task.split("\n")[0]));
						if (current.worktree) lines.push(theme.fg("muted", clean(current.worktree)));
					}
				}
				if (status) lines.push(theme.fg("warning", clean(status)));
				if (editing) lines.push(...input.render(inner));
				lines.push(theme.fg("dim", editing ? "Enter send · Esc cancel" : opened ? "↑↓ scroll · PgUp/PgDn jump · s send or resume · x stop · Esc back" : "↑↓ select · Enter transcript · s send or resume · x stop · Esc close"));
				return lines.map((line) => ` ${truncateToWidth(line, inner)}`);
			},
			handleInput(data) {
				const roster = jobs();
				const current = opened ?? roster[selected];
				if (matchesKey(data, "alt+a")) { done(); return; }
				if (editing) {
					if (matchesKey(data, "enter") && current && !busy) {
						const value = input.getValue().trim();
						if (!value) return;
						busy = true;
						void send(current, value).then(() => {
							status = "Message sent.";
							editing = false;
							input.focused = false;
							input.setValue("");
						}, (error) => { status = errorText(error); }).finally(() => { busy = false; tui.requestRender(); });
					} else if (matchesKey(data, "escape")) {
						editing = false;
						input.focused = false;
					} else if (!busy) input.handleInput(data);
				} else if (matchesKey(data, "escape")) {
					if (!opened) { done(); return; }
					opened = undefined;
					parkedRows = undefined;
					status = "";
				} else if (matchesKey(data, "up") || matchesKey(data, "down")) {
					const direction = matchesKey(data, "up") ? -1 : 1;
					if (opened) scroll = Math.max(0, scroll - direction);
					else selected = Math.min(Math.max(0, selected + direction), Math.max(0, roster.length - 1));
					status = "";
				} else if (opened && (matchesKey(data, "pageUp") || matchesKey(data, "pageDown"))) {
					scroll = Math.max(0, scroll + (matchesKey(data, "pageUp") ? 15 : -15));
				} else if (current && matchesKey(data, "enter") && !opened) {
					opened = current;
					scroll = 0;
					status = "";
				} else if (current && data === "s") {
					editing = true;
					input.focused = focused;
					input.setValue("");
					status = `Message to ${current.id.slice(0, 8)}`;
				} else if (current && data === "x") {
					stop(current);
					status = current.status === "running" ? "Stopping agent…" : "Agent is idle.";
				}
				tui.requestRender();
			},
		};
	}, { overlay: true, overlayOptions: { width: "90%", maxHeight: "90%", anchor: "center" } });
}
