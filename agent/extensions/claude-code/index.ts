import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerInstructions } from "./context.ts";
import { registerImport } from "./import.ts";
import { registerMemory } from "./memory.ts";

/**
 * Bridge to Claude Code: its per-project auto-memory and the instruction files pi skips are added to the
 * system prompt (memory is written back in the same format), and /cc continues one of its sessions in pi.
 */
export default function (pi: ExtensionAPI) {
	registerMemory(pi);
	registerInstructions(pi);
	registerImport(pi);
}
