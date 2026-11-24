import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { Socket } from "node:net";
import type { Writable } from "node:stream";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { truncateHead } from "@earendil-works/pi-coding-agent";
import { errorText, text } from "./shared.ts";

const maxFrameSize = 32 * 1024 * 1024;
type Pending = { resolve(value: any): void; reject(error: unknown): void };

export async function findExecutable(command: string, cwd: string) {
	const roots = [join(cwd, "node_modules", ".bin"), join(cwd, ".venv", "bin"), join(cwd, "venv", "bin"),
		join(cwd, "bin"), ...(process.env.PATH ?? "").split(delimiter).filter(Boolean), join(homedir(), ".local", "bin"), join(homedir(), ".venv", "bin")];
	const explicit = isAbsolute(command) || command.includes("/");
	const path = command.startsWith("~/") ? join(homedir(), command.slice(2)) : resolve(cwd, command);
	for (const candidate of explicit ? [path] : roots.map((dir) => resolve(cwd, dir, command))) {
		try {
			await access(candidate, constants.X_OK);
			if ((await stat(candidate)).isFile()) return candidate;
		} catch { /* Try the next executable location. */ }
	}
}

export function toolResult(value: unknown, maxBytes = 32_000) {
	const raw = typeof value === "string" ? value : JSON.stringify(value ?? null, null, 2);
	const result = truncateHead(raw, { maxBytes, maxLines: 1000 });
	return { content: [text(result.content + (result.truncated ? "\n[Result truncated. Narrow the request for more detail.]" : ""))], details: {} };
}

export class StdioProtocol {
	private readonly child?: ChildProcessWithoutNullStreams;
	private readonly input: Writable;
	private readonly closeListeners = new Set<() => void>();
	private readonly pending = new Map<number, Pending>();
	private readonly listeners = new Set<(message: any) => void>();
	private handler?: (method: string, params: any) => unknown | Promise<unknown>;
	private chunks: Buffer<ArrayBufferLike>[] = [];
	private size = 0;
	private frameSize?: number;
	private seq = 0;
	private stderr = "";
	private failure?: Error;

	constructor(command: string | Socket, args: string[], cwd: string, private readonly kind: "lsp" | "dap") {
		const receive = (chunk: Buffer) => {
			try { this.receive(chunk); } catch (error) { this.fail(new Error(`Invalid ${kind.toUpperCase()} stream. ${errorText(error)}`)); }
		};
		if (typeof command !== "string") {
			this.input = command;
			command.on("data", receive);
			command.on("error", (error) => this.fail(error));
			command.on("close", () => this.fail(new Error("Debugger connection closed.")));
			return;
		}
		const child = this.child = spawn(command, args, { cwd, stdio: "pipe", windowsHide: true });
		this.input = child.stdin;
		child.stdout.on("data", receive);
		child.stderr.on("data", (chunk: Buffer) => { this.stderr = (this.stderr + chunk.toString()).slice(-3000); });
		child.stdin.on("error", (error) => this.fail(error));
		child.on("error", (error) => this.fail(error));
		child.on("close", (code, signal) => this.fail(new Error(`${command} exited (${signal ?? code}). ${this.stderr.trim()}`)));
	}

	get closed() { return Boolean(this.failure); }
	onMessage(listener: (message: any) => void) {
		this.listeners.add(listener);
		return () => { this.listeners.delete(listener); };
	}
	onRequest(handler: (method: string, params: any) => unknown | Promise<unknown>) { this.handler = handler; }
	onClose(listener: () => void) {
		this.closeListeners.add(listener);
		return () => { this.closeListeners.delete(listener); };
	}
	close() { this.fail(new Error(`${this.kind.toUpperCase()} transport closed.`)); }

	request<T = any>(method: string, params: unknown, signal: AbortSignal): Promise<T> {
		return new Promise((resolve, reject) => {
			if (this.failure || signal.aborted) { reject(this.failure ?? signal.reason); return; }
			const id = ++this.seq;
			const cleanup = () => {
				this.pending.delete(id);
				signal.removeEventListener("abort", aborted);
			};
			const aborted = () => {
				cleanup();
				reject(signal.reason);
				if (this.kind === "lsp" && !this.closed) {
					try { this.notify("$/cancelRequest", { id }); } catch { /* The server has already disconnected. */ }
				}
			};
			this.pending.set(id, { resolve: (value) => { cleanup(); resolve(value); }, reject: (error) => { cleanup(); reject(error); } });
			signal.addEventListener("abort", aborted, { once: true });
			try {
				this.send(this.kind === "lsp" ? { jsonrpc: "2.0", id, method, params } : { seq: id, type: "request", command: method, arguments: params });
			} catch (error) { cleanup(); reject(error); }
		});
	}

	notify(method: string, params: unknown) { this.send({ jsonrpc: "2.0", method, params }); }

	private send(message: unknown) {
		if (this.failure) throw this.failure;
		const json = JSON.stringify(message);
		const bytes = Buffer.byteLength(json);
		if (bytes > maxFrameSize) throw new Error("Protocol request exceeded 32 MiB.");
		this.input.write(`Content-Length: ${bytes}\r\n\r\n${json}`);
	}

	private fail(error: Error) {
		if (this.failure) return;
		this.failure = error;
		for (const request of this.pending.values()) request.reject(error);
		this.listeners.clear();
		this.chunks = [];
		for (const listener of this.closeListeners) listener();
		this.closeListeners.clear();
		this.input.destroy();
		const child = this.child;
		if (child?.pid && child.exitCode === null && child.signalCode === null) {
			child.kill();
			const timer = setTimeout(() => {
				if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
			}, 1500);
			timer.unref();
			child.once("exit", () => clearTimeout(timer));
		}
	}

	private receive(chunk: Buffer) {
		if (this.closed) return;
		// Coalesce only short headers and complete bodies to avoid quadratic copies of large frames.
		if (this.frameSize !== undefined && this.size + chunk.length < this.frameSize) {
			this.chunks.push(chunk);
			this.size += chunk.length;
			return;
		}
		let buffer: Buffer<ArrayBufferLike> = this.size ? Buffer.concat([...this.chunks, chunk]) : chunk;
		this.chunks = [];
		this.size = 0;
		while (buffer.length) {
			if (this.frameSize === undefined) {
				const end = buffer.indexOf("\r\n\r\n");
				if (end < 0 && buffer.length <= 8192) break;
				const header = end >= 0 && end <= 8192 ? buffer.subarray(0, end).toString("ascii") : "";
				const size = /^Content-Length:\s*(\d+)\s*$/im.exec(header)?.[1];
				if (!size || +size <= 0 || +size > maxFrameSize) throw new Error("Invalid Content-Length header.");
				this.frameSize = +size;
				buffer = buffer.subarray(end + 4);
			}
			if (buffer.length < this.frameSize) break;
			const message = JSON.parse(buffer.subarray(0, this.frameSize).toString("utf8"));
			buffer = buffer.subarray(this.frameSize);
			this.frameSize = undefined;
			this.dispatch(message);
		}
		this.size = buffer.length;
		if (this.size) this.chunks = [buffer];
	}

	private dispatch(message: any) {
		if (!message || typeof message !== "object") throw new Error("Expected a protocol message object.");
		const reverse = this.kind === "lsp" ? message.method && message.id !== undefined : message.type === "request";
		if (reverse) { void this.reply(message); return; }
		const request = this.pending.get(this.kind === "lsp" ? message.id : message.request_seq);
		if (request && (this.kind === "lsp" || message.type === "response")) {
			if (message.error || message.success === false) request.reject(new Error(message.error?.message || message.message || "Protocol request failed."));
			else request.resolve(this.kind === "lsp" ? message.result : message.body);
			return;
		}
		for (const listener of this.listeners) listener(message);
	}

	private async reply(message: any) {
		let value: unknown;
		let error: string | undefined;
		try {
			if (!this.handler) throw new Error("Client does not support reverse requests.");
			value = await this.handler(message.method ?? message.command, message.params ?? message.arguments);
		} catch (cause) { error = errorText(cause); }
		if (this.closed) return;
		try {
			this.send(this.kind === "lsp"
				? { jsonrpc: "2.0", id: message.id, ...(error ? { error: { code: -32603, message: error } } : { result: value ?? null }) }
				: { seq: ++this.seq, type: "response", request_seq: message.seq, command: message.command, success: !error, body: value, message: error });
		} catch (cause) { this.fail(new Error(errorText(cause))); }
	}
}
