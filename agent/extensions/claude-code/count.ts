import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Api, ImageContent, Model, TextContent } from "@earendil-works/pi-ai";
import type { PiMessage } from "./transcript.ts";

type Counter = (messages: PiMessage[]) => Promise<number | undefined>;

/** Anthropic Messages form of pi messages: tool results become user turns, and consecutive turns of one role merge. */
function anthropicMessages(messages: readonly PiMessage[]) {
	const out: { role: "user" | "assistant"; content: unknown[] }[] = [];
	const add = (role: "user" | "assistant", blocks: unknown[]) => {
		const last = out.at(-1);
		if (last?.role === role) last.content.push(...blocks);
		else out.push({ role, content: blocks });
	};
	for (const message of messages) {
		if (message.role === "user") {
			const blocks: (TextContent | ImageContent)[] = typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content;
			add("user", blocks.map((block) => (block.type === "image" ? { type: "image", source: { type: "base64", media_type: block.mimeType, data: block.data } } : { type: "text", text: block.text })));
		} else if (message.role === "assistant") {
			add("assistant", message.content.flatMap((block): unknown[] => (block.type === "text" ? [{ type: "text", text: block.text }] : block.type === "toolCall" ? [{ type: "tool_use", id: block.id, name: block.name, input: block.arguments }] : [])));
		} else {
			add("user", [{ type: "tool_result", tool_use_id: message.toolCallId, content: message.content.map((block) => (block.type === "text" ? block.text : "")).join(""), is_error: message.isError }]);
		}
	}
	return out;
}

/** Anthropic's count_tokens, which is free and exact, serves Claude models on the Anthropic API. Proxies only approximate. */
export const countsForFree = (model: Model<Api>) => model.api === "anthropic-messages" && /^https:\/\/api\.anthropic\.com(?:\/|$)/.test(model.baseUrl);

function anthropicCounter(ctx: ExtensionContext, model: Model<Api>, signal?: AbortSignal): Counter {
	return async (messages) => {
		try {
			const auth = (await ctx.modelRegistry.getProviderAuth(model.provider))?.auth;
			const headers: Record<string, string> = { "content-type": "application/json", "anthropic-version": "2023-06-01" };
			for (const [name, value] of Object.entries(auth?.headers ?? {})) if (typeof value === "string") headers[name] = value;
			if (auth?.apiKey?.includes("sk-ant-oat")) {
				headers.authorization = `Bearer ${auth.apiKey}`;
				headers["anthropic-beta"] = "oauth-2025-04-20";
			} else if (auth?.apiKey) {
				headers["x-api-key"] = auth.apiKey;
			}
			const base = (auth?.baseUrl ?? model.baseUrl).replace(/\/+$/, "").replace(/\/v1$/, "");
			const response = await fetch(`${base}/v1/messages/count_tokens`, { method: "POST", headers, body: JSON.stringify({ model: model.id, messages: anthropicMessages(messages) }), signal });
			const tokens = response.ok ? ((await response.json()) as { input_tokens?: unknown } | null)?.input_tokens : undefined;
			return typeof tokens === "number" ? tokens : undefined;
		} catch {
			return undefined;
		}
	};
}

/**
 * Exact for any model, at the price of real requests: the input tokens of a short request after the messages,
 * less those of the same request alone. The second figure is measured once per counter.
 */
function requestCounter(ctx: ExtensionContext, model: Model<Api>, signal?: AbortSignal): Counter {
	const input = async (history: PiMessage[]) => {
		try {
			const reply = await ctx.modelRegistry.complete(model, { messages: [...history, { role: "user", content: "Reply with OK.", timestamp: Date.now() }] }, { maxTokens: 16, signal });
			const { usage } = reply;
			return reply.stopReason === "error" || reply.stopReason === "aborted" ? undefined : usage.input + usage.cacheRead + usage.cacheWrite;
		} catch {
			return undefined;
		}
	};
	let baseline: Promise<number | undefined> | undefined;
	return async (messages) => {
		const [alone, full] = await Promise.all([(baseline ??= input([])), input(messages)]);
		return alone !== undefined && full !== undefined && full > alone ? full - alone : undefined;
	};
}

/** A token counter for the model: free and exact for Claude on the Anthropic API, by request when `paid` allows it. */
export function counterFor(ctx: ExtensionContext, model: Model<Api> | undefined, paid: boolean, signal?: AbortSignal): Counter | undefined {
	if (!model) return undefined;
	if (countsForFree(model)) return anthropicCounter(ctx, model, signal);
	return paid ? requestCounter(ctx, model, signal) : undefined;
}
