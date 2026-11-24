import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerAdvisor } from "./advisor.ts";
import { registerAgents } from "./agents.ts";
import { registerAsk } from "./ask.ts";
import { registerHashline } from "./hashline.ts";
import { registerMemory } from "./memory.ts";

export default function (pi: ExtensionAPI) {
	registerHashline(pi);
	registerAgents(pi);
	registerAsk(pi);
	registerAdvisor(pi);
	registerMemory(pi);
}
