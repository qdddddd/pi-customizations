import { realpath, stat } from "node:fs/promises";
import { createConnection } from "node:net";
import { basename, extname, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { findExecutable, StdioProtocol, toolResult } from "./protocol.ts";
import { errorText } from "./shared.ts";

const adapters = {
	"lldb-dap": { command: "lldb-dap", args: [] },
	gdb: { command: "gdb", args: ["-i", "dap"] },
	debugpy: { command: "debugpy-adapter", args: [] },
};
const moves = { continue: "continue", step_over: "next", step_in: "stepIn", step_out: "stepOut", pause: "pause" };
const actions = ["launch", "attach", "sessions", "terminate", "output", "set_breakpoint", "remove_breakpoint", "continue", "step_over",
	"step_in", "step_out", "pause", "threads", "stack_trace", "scopes", "variables", "evaluate"] as const;
const int = Type.Integer({ minimum: 1 });
const string = Type.String({ minLength: 1 });
const parameters = Type.Object({
	action: Type.Enum(actions),
	adapter: Type.Optional(Type.Enum(["lldb-dap", "gdb", "debugpy"] as const)),
	program: Type.Optional(string), args: Type.Optional(Type.Array(Type.String(), { maxItems: 100 })), cwd: Type.Optional(string),
	pid: Type.Optional(int), port: Type.Optional(Type.Integer({ minimum: 1, maximum: 65535, description: "Local debugpy attach port." })),
	stop_on_entry: Type.Optional(Type.Boolean()),
	python: Type.Optional(Type.String({ description: "Python executable for debugpy launch. Defaults to the workspace or PATH python3." })),
	file: Type.Optional(string), line: Type.Optional(int), function: Type.Optional(string), condition: Type.Optional(string),
	thread_id: Type.Optional(int), frame_id: Type.Optional(Type.Integer({ minimum: 0 })), levels: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
	variable_ref: Type.Optional(int), scope_id: Type.Optional(int), expression: Type.Optional(string),
	context: Type.Optional(Type.Enum(["watch", "hover", "repl"] as const)),
	timeout: Type.Optional(Type.Number({ minimum: 1, maximum: 120, description: "Seconds to wait. Default 15." })),
});
type Input = Static<typeof parameters>;
type Breakpoint = { line?: number; name?: string; condition?: string };
type Stop = { reason: string; description?: string; threadId?: number };

function required<T>(value: T | undefined, description: string) {
	if (value === undefined) throw new Error(`Provide ${description}.`);
	return value;
}

class DebugSession {
	state: "starting" | "running" | "stopped" | "exited" = "starting";
	stop?: Stop;
	exitCode?: number;
	output = "";
	capabilities: { supportsConfigurationDoneRequest?: boolean; supportsFunctionBreakpoints?: boolean } = {};
	breakpoints = new Map<string, Breakpoint[]>();
	functions = new Map<string, Breakpoint>();
	private initialized = false;
	private observers = new Set<() => void>();

	constructor(readonly adapter: keyof typeof adapters, readonly cwd: string, readonly transport: StdioProtocol, readonly attached: boolean) {
		transport.onMessage((message) => {
			if (message.type !== "event") return;
			const body = message.body ?? {};
			switch (message.event) {
				case "initialized": this.initialized = true; break;
				case "stopped": this.state = "stopped"; this.stop = body; break;
				case "continued": this.state = "running"; this.stop = undefined; break;
				case "exited": this.exitCode = body.exitCode; this.state = "exited"; this.stop = undefined; break;
				case "terminated": this.state = "exited"; this.stop = undefined; break;
				case "output": if (typeof body.output === "string") this.output = (this.output + body.output).slice(-48_000); break;
			}
			for (const observer of this.observers) observer();
		});
	}

	snapshot() {
		return { adapter: this.adapter, cwd: this.cwd, state: this.transport.closed ? "disconnected" : this.state, stop: this.stop, exitCode: this.exitCode };
	}

	async start(action: "launch" | "attach", config: unknown, signal: AbortSignal) {
		this.capabilities = await this.transport.request("initialize", {
			clientID: "pi", clientName: "Pi", adapterID: this.adapter, pathFormat: "path", linesStartAt1: true, columnsStartAt1: true,
			supportsVariableType: true, supportsVariablePaging: true, supportsRunInTerminalRequest: false,
		}, signal) ?? {};
		if (this.capabilities.supportsConfigurationDoneRequest) {
			const launch = this.transport.request(action, config, signal);
			const earlyFailure = launch.then(() => new Promise<never>(() => {}));
			await Promise.race([this.wait(() => this.initialized, signal), earlyFailure]);
			await this.transport.request("configurationDone", {}, signal);
			await launch;
		} else {
			await this.transport.request(action, config, signal);
		}
		if (this.state === "starting") this.state = "running";
	}

	private wait(predicate: () => boolean, signal: AbortSignal) {
		return new Promise<void>((resolve, reject) => {
			if (predicate()) { resolve(); return; }
			if (this.transport.closed) { reject(new Error("Debugger is disconnected.")); return; }
			if (signal.aborted) { reject(signal.reason); return; }
			const cleanup = () => { this.observers.delete(check); unsubscribe(); signal.removeEventListener("abort", abort); };
			const abort = () => { cleanup(); reject(signal.reason); };
			const check = () => { if (predicate()) { cleanup(); resolve(); } };
			const unsubscribe = this.transport.onClose(() => {
				if (predicate()) check();
				else { cleanup(); reject(new Error("Debugger disconnected during setup.")); }
			});
			this.observers.add(check);
			signal.addEventListener("abort", abort, { once: true });
		});
	}

	async waitForStop(signal: AbortSignal) {
		try {
			await this.wait(() => this.state === "exited" || this.state === "stopped" || this.transport.closed, signal);
		} catch {
			return { ...this.snapshot(), waitExpired: true };
		}
		return this.snapshot();
	}

	async thread(input: Input, signal: AbortSignal) {
		const id = input.thread_id ?? this.stop?.threadId;
		if (id !== undefined) return id;
		const { threads } = await this.transport.request<{ threads: { id: number }[] }>("threads", {}, signal);
		return required(threads?.[0]?.id, "a valid thread_id");
	}

	async frame(input: Input, signal: AbortSignal) {
		if (input.frame_id !== undefined) return input.frame_id;
		const { stackFrames } = await this.transport.request<{ stackFrames: { id: number }[] }>("stackTrace", {
			threadId: await this.thread(input, signal), levels: 1,
		}, signal);
		return required(stackFrames?.[0]?.id, "a valid frame_id while paused");
	}

	async breakpoint(input: Input, signal: AbortSignal) {
		const add = input.action === "set_breakpoint";
		if (input.function) {
			if (!this.capabilities.supportsFunctionBreakpoints) throw new Error("This adapter does not support function breakpoints.");
			const desired = new Map(this.functions);
			if (add) desired.set(input.function, { name: input.function, condition: input.condition });
			else desired.delete(input.function);
			const result = await this.transport.request("setFunctionBreakpoints", { breakpoints: [...desired.values()] }, signal);
			this.functions = desired;
			return result;
		}
		const file = await realpath(resolve(this.cwd, required(input.file, "file or function")));
		const line = required(input.line, "line");
		const desired = (this.breakpoints.get(file) ?? []).filter((entry) => entry.line !== line);
		if (add) desired.push({ line, condition: input.condition });
		desired.sort((left, right) => left.line! - right.line!);
		const result = await this.transport.request("setBreakpoints", { source: { path: file, name: basename(file) }, breakpoints: desired }, signal);
		if (desired.length) this.breakpoints.set(file, desired);
		else this.breakpoints.delete(file);
		return result;
	}

	async close() {
		try {
			if (!this.transport.closed) await this.transport.request("disconnect", { terminateDebuggee: !this.attached }, AbortSignal.timeout(1500));
		} catch { /* A crashed adapter or ended program can close first. */ }
		finally { this.transport.close(); }
	}
}

async function startDebug(input: Input, ctx: ExtensionContext, signal: AbortSignal) {
	const action = input.action === "attach" ? "attach" : "launch";
	const cwd = await realpath(resolve(ctx.cwd, input.cwd ?? "."));
	const program = input.program && await realpath(resolve(cwd, input.program));
	if (action === "launch" && (input.pid || input.port)) throw new Error("Use attach with a pid or port.");
	if (action === "launch" && (!program || !(await stat(program)).isFile())) throw new Error("Provide the source script or compiled executable in program.");
	if (action === "attach" && (!input.pid && !input.port || input.pid && input.port)) throw new Error("Provide one local pid or debugpy port to attach.");
	const choice = input.adapter ?? (input.port || program && extname(program) === ".py" ? "debugpy" : undefined);
	if (input.port && choice !== "debugpy") throw new Error("Port attach requires debugpy.");
	const candidates = choice ? [choice] : ["lldb-dap", "gdb"] as const;
	for (const adapter of candidates) {
		const definition = adapters[adapter];
		const command = input.port ? undefined : await findExecutable(definition.command, cwd);
		if (!command && !input.port) continue;
		const python = action === "launch" && adapter === "debugpy" ? await findExecutable(input.python ?? "python3", cwd) : undefined;
		if (input.python && !python) throw new Error(`Python executable unavailable: ${input.python}.`);
		signal.throwIfAborted();
		const stopOnEntry = input.stop_on_entry ?? true;
		const args = action === "launch" ? {
			program, cwd, args: input.args ?? [], stopOnEntry,
			...(adapter === "debugpy" ? { console: "internalConsole", justMyCode: false, redirectOutput: true, ...(python ? { python: [python] } : {}) } : {}),
			...(adapter === "lldb-dap" ? { disableASLR: false } : {}),
			...(adapter === "gdb" ? { stopAtBeginningOfMainSubprogram: stopOnEntry } : {}),
		} : input.port ? { connect: { host: "127.0.0.1", port: input.port }, justMyCode: false }
			: { pid: input.pid, processId: input.pid, program, cwd };
		const endpoint = input.port ? createConnection({ host: "127.0.0.1", port: input.port }) : command!;
		const session = new DebugSession(adapter, cwd, new StdioProtocol(endpoint, definition.args, cwd, "dap"), action === "attach");
		try {
			await session.start(action, args, signal);
			const stop = action === "launch" && stopOnEntry ? await session.waitForStop(signal)
				: action === "attach" ? await session.waitForStop(AbortSignal.any([signal, AbortSignal.timeout(1000)])) : undefined;
			if (signal.aborted && (!stop || "waitExpired" in stop)) signal.throwIfAborted();
			return session;
		} catch (error) {
			await session.close();
			if (adapter === "lldb-dap" && process.platform === "darwin" && (error as Error).name === "TimeoutError") {
				throw new Error("LLDB timed out. Check whether macOS is waiting for Developer Tools authorization.", { cause: error });
			}
			throw error;
		}
	}
	throw new Error(`No DAP adapter found. Install ${candidates.join(" or ")} and put it on PATH.`);
}

export function registerDebug(pi: ExtensionAPI) {
	let session: DebugSession | undefined;
	let starting: Promise<DebugSession> | undefined;
	let lifetime = new AbortController();
	const cleanup = async () => {
		const active = session;
		session = undefined;
		await active?.close();
	};
	pi.on("session_start", () => { if (lifetime.signal.aborted) lifetime = new AbortController(); });
	pi.on("session_shutdown", async () => {
		lifetime.abort();
		await starting?.catch(() => undefined);
		await cleanup();
	});
	pi.registerTool({
		name: "debug", label: "Debugger",
		description: "Debug a local program with DAP. Launch an executable built with debug information or a Python script, set source/function breakpoints, continue or step, and inspect threads, stack, scopes, variables, or expressions. Use output and terminate to finish. One active session per Pi session.",
		promptSnippet: "Debug local programs interactively through DAP breakpoints and stack inspection",
		parameters, executionMode: "sequential",
		async execute(_id, input, cancelled, _update, ctx) {
			const timeout = AbortSignal.timeout(Math.round((input.timeout ?? 15) * 1000));
			const signal = AbortSignal.any([lifetime.signal, timeout, ...(cancelled ? [cancelled] : [])]);
			if (input.action === "sessions") return toolResult(session ? session.snapshot() : "No active debug session.");
			if (input.action === "terminate") { await cleanup(); return toolResult("Debug session closed."); }
			if (input.action === "launch" || input.action === "attach") {
				if (!ctx.isProjectTrusted()) throw new Error("Starting a debugger requires a trusted project.");
				if (session && !session.transport.closed && session.state !== "exited") throw new Error("Terminate the current debug session before starting another.");
				await cleanup();
				try {
					starting = startDebug(input, ctx, signal);
					session = await starting;
					return toolResult(session.snapshot());
				} finally { starting = undefined; }
			}
			const active = required(session, "an active debug session (launch or attach first)");
			if (input.action === "output") return toolResult(active.output || "No debugger output.", 48_000);
			const call = (action: string, args: unknown = {}) => active.transport.request(action, args, signal);
			try {
				switch (input.action) {
					case "set_breakpoint": case "remove_breakpoint": return toolResult(await active.breakpoint(input, signal));
					case "threads": return toolResult(await call("threads"));
					case "stack_trace": return toolResult(await call("stackTrace", { threadId: await active.thread(input, signal), levels: input.levels ?? 20 }));
					case "scopes": return toolResult(await call("scopes", { frameId: await active.frame(input, signal) }));
					case "variables": return toolResult(await call("variables", { variablesReference: required(input.variable_ref ?? input.scope_id, "variable_ref or scope_id"), start: 0, count: 100 }));
					case "evaluate": return toolResult(await call("evaluate", { expression: required(input.expression, "expression"), frameId: await active.frame(input, signal), context: input.context ?? "watch" }));
					default: {
						if (input.action === "pause" && active.state === "stopped") return toolResult(active.snapshot());
						const threadId = await active.thread(input, signal);
						const previous = active.snapshot();
						active.state = "running";
						active.stop = undefined;
						try { await call(moves[input.action], { threadId }); }
						catch (error) {
							if (active.state === "running" && !signal.aborted && previous.state === "stopped") { active.state = "stopped"; active.stop = previous.stop; }
							throw error;
						}
						const result = await active.waitForStop(signal);
						cancelled?.throwIfAborted();
						return toolResult(result);
					}
				}
			} catch (error) { throw new Error(`Debugger ${input.action}: ${errorText(error)}`); }
		},
	});
}
