import { unlink } from "node:fs/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerAdvisor } from "./advisor.ts";
import { registerAgents } from "./agents.ts";
import { registerAsk } from "./ask.ts";
import { registerDebug } from "./debug.ts";
import { registerHashline } from "./hashline.ts";
import { registerLsp } from "./lsp.ts";
import { registerMemory } from "./memory.ts";
import { errorText } from "./shared.ts";

export default function (pi: ExtensionAPI) {
	registerHashline(pi);
	registerAgents(pi);
	registerAsk(pi);
	registerAdvisor(pi);
	registerMemory(pi);
	registerLsp(pi);
	registerDebug(pi);
	pi.registerCommand("clear", {
		description: "Start a fresh session with the current name and delete the old transcript",
		async handler(args, ctx) {
			if (args.trim()) {
				ctx.ui.notify("Use /clear without arguments.", "warning");
				return;
			}
			await ctx.waitForIdle();
			const name = ctx.sessionManager.getSessionName();
			const oldFile = ctx.sessionManager.getSessionFile();
			await ctx.newSession({
				setup: async (session) => { if (name) session.appendSessionInfo(name); },
				withSession: async (next) => {
					if (oldFile && oldFile !== next.sessionManager.getSessionFile()) {
						try {
							await unlink(oldFile);
						} catch (error) {
							if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
								next.ui.notify(`Started a fresh session. Could not delete ${oldFile}. ${errorText(error)}`, "warning");
								return;
							}
						}
					}
					next.ui.notify("Session cleared.", "info");
				},
			});
		},
	});
}
