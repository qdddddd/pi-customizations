import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Input, matchesKey, replaceControlCharacters, stripTerminalSequences, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { text } from "./shared.ts";

const option = Type.Object({ label: Type.String({ minLength: 1, maxLength: 200 }), value: Type.String({ minLength: 1, maxLength: 100 }) });
const base = { name: Type.String({ pattern: "^[a-zA-Z][a-zA-Z0-9_-]{0,63}$" }), label: Type.String({ minLength: 1, maxLength: 300 }) };
const options = Type.Array(option, { minItems: 2, maxItems: 8 });
const fieldSchema = Type.Union([
	Type.Object({ ...base, type: Type.Literal("text"), default: Type.Optional(Type.String({ maxLength: 1000 })) }),
	Type.Object({ ...base, type: Type.Literal("select"), options, default: Type.Optional(Type.String()) }),
	Type.Object({ ...base, type: Type.Literal("multiselect"), options, default: Type.Optional(Type.Array(Type.String(), { uniqueItems: true, maxItems: 8 })) }),
]);
const clean = (value: string) => replaceControlCharacters(stripTerminalSequences(value));
type Answers = Record<string, string | string[]>;

export function registerAsk(pi: ExtensionAPI) {
	pi.registerTool({
		name: "ask", label: "Ask the user",
		description: "Display a keyboard-driven form for decisions you need the user to make. Provide one to five named fields. The recommended defaults are preselected. In headless mode the form is unavailable and returns no answers.",
		parameters: Type.Object({
			title: Type.String({ minLength: 1, maxLength: 120 }),
			context: Type.Optional(Type.String({ maxLength: 1200 })),
			fields: Type.Array(fieldSchema, { minItems: 1, maxItems: 5 }),
		}),
		async execute(_id, params, signal, _update, ctx) {
			if (ctx.mode !== "tui") return { content: [text("The ask form requires a terminal UI.")], details: { status: "unavailable" } };
			signal?.throwIfAborted();
			const { title, context, fields } = params;
			if (new Set(fields.map((item) => item.name)).size !== fields.length) throw new Error("Ask field names must be unique.");
			const answers = new Map<string, string | string[]>();
			for (const field of fields) {
				if (field.type === "text") answers.set(field.name, field.default ?? "");
				else {
					const allowed = new Set(field.options.map((item) => item.value));
					if (allowed.size !== field.options.length) throw new Error(`Duplicate option value in ${field.name}.`);
					const defaults = typeof field.default === "string" ? [field.default] : field.default ?? [];
					if (defaults.some((value) => !allowed.has(value))) throw new Error(`Unknown default value in ${field.name}.`);
					if (field.type === "multiselect") answers.set(field.name, defaults);
					else if (defaults.length) answers.set(field.name, defaults[0]);
				}
			}
			const result = await ctx.ui.custom<Answers | undefined>((tui, theme, _keys, done) => {
				const input = new Input();
				let fieldIndex = 0;
				let selected = 0;
				let focused = false;
				const cancel = () => done(undefined);
				const current = () => fields[fieldIndex];
				const refreshField = () => {
					const field = current();
					input.focused = focused && field?.type === "text";
					if (field?.type === "text") input.setValue(String(answers.get(field.name) ?? ""));
					selected = field && field.type !== "text" ? Math.max(0, field.options.findIndex((item) => item.value === answers.get(field.name))) : 0;
				};
				const unanswered = () => fields.findIndex((field) => field.type === "select" && !answers.has(field.name));
				const navigate = (next: number) => {
					const field = current();
					if (field?.type === "text") answers.set(field.name, input.getValue().slice(0, 1000));
					fieldIndex = (next + fields.length + 1) % (fields.length + 1);
					refreshField();
				};
				refreshField();
				signal?.addEventListener("abort", cancel, { once: true });
				if (signal?.aborted) queueMicrotask(cancel);
				return {
					get focused() { return focused; },
					set focused(value: boolean) { focused = value; input.focused = value && current()?.type === "text"; },
					invalidate() { input.invalidate(); },
					dispose() { signal?.removeEventListener("abort", cancel); },
					render(width) {
						const inner = Math.max(1, width - 2);
						const field = current();
						const lines = [theme.bold(theme.fg("accent", clean(title)))];
						if (context && fieldIndex === 0) {
							const rows = context.split("\n").flatMap((line) => wrapTextWithAnsi(clean(line), inner));
							lines.push(...rows.slice(0, Math.max(1, tui.terminal.rows - 17)));
						}
						if (!field) {
							lines.push(theme.bold("Review answers"));
							for (const item of fields) {
								const value = answers.get(item.name);
								const values = typeof value === "string" ? [value] : value ?? [];
								const labels = item.type === "text" ? values : values.map((value) => item.options.find((choice) => choice.value === value)?.label ?? value);
								lines.push(clean(`${item.label}  ${labels.filter(Boolean).join(", ") || "(empty)"}`));
							}
							lines.push(theme.fg("dim", unanswered() >= 0 ? "Enter selects an unanswered field · Shift+Tab back · Esc cancel" : "Enter submit · Shift+Tab back · Esc cancel"));
						} else {
							lines.push(theme.bold(clean(field.label)), theme.fg("muted", `${fieldIndex + 1} of ${fields.length}`));
							if (field.type === "text") lines.push(...input.render(inner));
							else {
								const value = answers.get(field.name);
								const availableRows = Math.max(1, tui.terminal.rows - lines.length - 6);
								const start = Math.max(0, selected - availableRows + 1);
								for (const [offset, item] of field.options.slice(start, start + availableRows).entries()) {
									const checked = Array.isArray(value) ? value.includes(item.value) : item.value === value;
									const active = start + offset === selected;
									const mark = field.type === "multiselect" ? (checked ? "[x]" : "[ ]") : (checked ? "(•)" : "( )");
									lines.push(theme.fg(active ? "accent" : "text", `${active ? "▸" : " "} ${mark} ${clean(item.label)}`));
								}
							}
							lines.push(theme.fg("dim", field.type === "text" ? "Enter next · Tab/Shift+Tab navigate · Esc cancel" : "↑↓ move · Space select · Enter next · Tab/Shift+Tab navigate · Esc cancel"));
						}
						return lines.map((line) => ` ${truncateToWidth(line, inner)}`);
					},
					handleInput(data) {
						const field = current();
						if (matchesKey(data, "escape")) { cancel(); return; }
						if (matchesKey(data, "tab") || matchesKey(data, "shift+tab")) navigate(fieldIndex + (matchesKey(data, "tab") ? 1 : -1));
						else if (matchesKey(data, "enter")) {
							if (!field) {
								const missing = unanswered();
								if (missing < 0) { done(Object.fromEntries(answers)); return; }
								navigate(missing);
							} else {
								if (field.type === "select") answers.set(field.name, field.options[selected].value);
								navigate(fieldIndex + 1);
							}
						} else if (field?.type === "text") input.handleInput(data);
						else if (field && (matchesKey(data, "up") || matchesKey(data, "down"))) {
							selected = Math.max(0, Math.min(field.options.length - 1, selected + (matchesKey(data, "up") ? -1 : 1)));
						} else if (field && matchesKey(data, "space")) {
							const value = field.options[selected].value;
							if (field.type === "select") answers.set(field.name, value);
							else {
								const checked = new Set(answers.get(field.name) as string[]);
								if (!checked.delete(value)) checked.add(value);
								answers.set(field.name, [...checked]);
							}
						}
						tui.requestRender();
					},
				};
			}, { blocked: { kind: "question", message: clean(title) } });
			return result
				? { content: [text(JSON.stringify(result))], details: { status: "submitted" }, structuredContent: result }
				: { content: [text("The user dismissed the form.")], details: { status: "cancelled" } };
		},
	});
}
