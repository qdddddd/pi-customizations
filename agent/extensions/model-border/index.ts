import { CustomEditor, type ExtensionAPI, FooterComponent, type KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { type EditorTheme, type TUI, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { statsOnly } from "./footer.ts";

const MIN_BORDER = 12; // columns of border kept to the left of the name, for the "Working" status

// Pi replaces the editor with a fresh one on every reload and session switch, and the default editor never sees
// the prompts typed into this one. They are kept on globalThis, which outlives a reload, and replayed into each
// new editor so that the up arrow still recalls them.
const history: string[] = ((globalThis as Record<symbol, string[]>)[Symbol.for("model-border.history")] ??= []);

// The footer's own render is kept on the class, so that a reload never wraps a wrapper.
const PRISTINE = Symbol.for("model-border.footer");
const footer = FooterComponent.prototype as FooterComponent & { [PRISTINE]?: FooterComponent["render"] };
const pristine = (footer[PRISTINE] ??= footer.render);

/**
 * Moves the model from the footer to the prompt: its id is shown at the right end of the prompt's top border,
 * where pi embeds the "Working" status at the left end. The footer hides the model and cumulative token counts.
 * Unloading the extension restores the footer.
 */
export default function (pi: ExtensionAPI) {
	let model = "";
	let screen: TUI | undefined;

	class ModelBorderEditor extends CustomEditor {
		constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) {
			super(tui, theme, keybindings, { embedWorkingStatus: true });
			for (const text of history) super.addToHistory(text);
			screen = tui;
		}

		addToHistory(text: string) {
			super.addToHistory(text);
			history.push(text);
			if (history.length > 100) history.shift();
		}

		protected renderTopBorder(width: number, hiddenLineCount: number): string {
			const room = width - MIN_BORDER - 4; // the name sits in " name ──"
			if (!model || room < 1) return super.renderTopBorder(width, hiddenLineCount);
			const tail = ` ${truncateToWidth(model, room, "…")} ──`;
			return super.renderTopBorder(width - visibleWidth(tail), hiddenLineCount) + this.borderColor(tail);
		}
	}

	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI) return;
		model = ctx.model?.id ?? "";
		ctx.ui.setEditorComponent((tui, theme, keybindings) => new ModelBorderEditor(tui, theme, keybindings));
		footer.render = function (width) {
			const lines = pristine.call(this, width);
			if (lines.length > 1) {
				// Give Pi room to render all the stats before removing the counts on narrow terminals.
				const statsLine = width < 80 ? pristine.call(this, 80)[1] : lines[1];
				const stats = statsOnly(statsLine);
				// Pi keeps the keyed statuses on the footer's data provider.
				const { footerData } = this as unknown as {
					footerData: ConstructorParameters<typeof FooterComponent>[1];
				};
				const statuses = footerData.getExtensionStatuses();
				const balance = statuses.get("anthropic-credit");
				lines[1] = truncateToWidth(stats, width, "...");
				if (balance) {
					const right = truncateToWidth(balance, width, "...");
					const room = width - visibleWidth(right);
					const left = room > 1 ? truncateToWidth(stats, room - 1, "...") : "";
					lines[1] = left + " ".repeat(room - visibleWidth(left)) + right;
					const remaining = [...statuses]
						.filter(([key]) => key !== "anthropic-credit")
						.sort(([a], [b]) => a.localeCompare(b))
						.map(([, text]) => text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim());
					if (remaining.length) {
						lines[2] = truncateToWidth(remaining.join(" "), width, ctx.ui.theme.fg("dim", "..."));
					} else {
						lines.splice(2, 1);
					}
				}
			}
			return lines;
		};
	});

	pi.on("session_shutdown", () => {
		footer.render = pristine;
	});

	pi.on("model_select", (event) => {
		model = event.model.id;
		screen?.requestRender();
	});
}
