import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { getAgentDir, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";

export const dataDir = join(getAgentDir(), "omp-workflow");
export const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
export const text = (value: string) => ({ type: "text" as const, text: value });
export const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
export const modelName = (model: Model<Api>) => `${model.provider}/${model.id}`;

export function resolveModel(ctx: ExtensionContext, selector?: string): Model<Api> {
	if (!selector) {
		if (!ctx.model) throw new Error("Select a chat model first.");
		return ctx.model;
	}
	const models = ctx.modelRegistry.getAvailable();
	const exact = models.find((model) => modelName(model) === selector);
	const matches = models.filter((model) => model.id === selector);
	if (exact) return exact;
	if (matches.length === 1) return matches[0];
	throw new Error(`Use an available provider/model identifier. Could not resolve ${selector}.`);
}

export async function readOptional(path: string): Promise<string> {
	try {
		return await readFile(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
		throw error;
	}
}

export async function atomicWrite(path: string, value: string, mode = 0o600, beforeReplace?: () => Promise<void>) {
	const temp = join(dirname(path), `.omp-${randomUUID()}.tmp`);
	const handle = await open(temp, "wx", 0o600);
	try {
		try {
			await handle.writeFile(value, "utf8");
			await handle.chmod(mode);
		} finally {
			await handle.close();
		}
		await beforeReplace?.();
		await rename(temp, path);
	} finally {
		await unlink(temp).catch((error) => {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		});
	}
}

export async function privateDir(path: string) {
	await mkdir(path, { recursive: true, mode: 0o700 });
}

export function redact(value: string): string {
	return value
		.replace(/-----BEGIN [^-\n]*PRIVATE KEY-----[\s\S]*?-----END [^-\n]*PRIVATE KEY-----/g, "[redacted key]")
		.replace(/\b(?:sk-[\w-]{12,}|gh[pousr]_[\w]{20,}|github_pat_[\w_]+|AKIA[A-Z0-9]{16})\b/g, "[redacted token]")
		.replace(/(\bBearer\s+)[\w.+/=-]+/gi, "$1[redacted]")
		.replace(/(\b[\w-]*(?:password|passwd|secret|token|api[_-]?key)[\w-]*["']?\s*[:=]\s*)["']?[^\s"',;}]+["']?/gi, "$1[redacted]");
}

export function messageText(message: object, cap = 4000): string {
	if (!("content" in message)) return "";
	if (typeof message.content === "string") return redact(message.content).slice(0, cap);
	if (!Array.isArray(message.content)) return "";
	return redact(message.content.map((block) => {
		if (block.type === "text") return block.text;
		if (block.type === "toolCall") return `${block.name} ${JSON.stringify(block.arguments)}`;
		return "";
	}).filter(Boolean).join("\n")).slice(0, cap);
}

export async function modelText(ctx: ExtensionContext, model: Model<Api>, systemPrompt: string, prompt: string, signal: AbortSignal, maxTokens: number) {
	const stream = ctx.modelRegistry.streamSimple(model, {
		systemPrompt,
		messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
	}, { signal, maxTokens });
	const output = await stream.result();
	if (output.stopReason !== "stop") throw new Error(output.errorMessage || `Model stopped with ${output.stopReason}.`);
	return output.content.filter((block) => block.type === "text").map((block) => block.text).join("\n").trim();
}

export function parseModelJson(value: string): unknown {
	return JSON.parse(value.replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i, "$1"));
}
