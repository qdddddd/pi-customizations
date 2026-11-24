import type { Api, Model } from "@earendil-works/pi-ai";
import {
	createAgentSession, createExtensionRuntime, defineTool, getAgentDir, loadProjectContextFiles, ModelRuntime,
	SessionManager, SettingsManager, truncateHead, type AgentSession, type ExtensionAPI, type ExtensionContext,
	type ResourceLoader,
} from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { Type, type Static } from "typebox";
import { showAgentHub } from "./hub.ts";
import { dataDir, errorText, modelName, privateDir, resolveModel, text } from "./shared.ts";

const roles = ["scout", "planner", "reviewer", "worker"] as const;
const roleSchema = Type.Union([Type.Literal("scout"), Type.Literal("planner"), Type.Literal("reviewer"), Type.Literal("worker")]);
type Role = typeof roles[number];
const taskSchema = Type.Object({
	agent: roleSchema,
	task: Type.String({ minLength: 1, maxLength: 40_000 }),
	model: Type.Optional(Type.String({ description: "Exact provider/model. Defaults to the parent model." })),
	worktree: Type.Optional(Type.Boolean({ description: "Run in a detached Git worktree at HEAD. Default for workers." })),
});
type Task = Static<typeof taskSchema>;
const baseResult = { summary: Type.String({ minLength: 1, maxLength: 5000 }) };
const resultSchema = Type.Object(baseResult);
const reviewSchema = Type.Object({
	...baseResult,
	verdict: Type.Union([Type.Literal("correct"), Type.Literal("incorrect"), Type.Literal("incomplete")]),
	confidence: Type.Number({ minimum: 0, maximum: 1 }),
	findings: Type.Array(Type.Object({
		title: Type.String({ minLength: 1, maxLength: 120 }),
		body: Type.String({ minLength: 1, maxLength: 1500 }),
		priority: Type.Integer({ minimum: 0, maximum: 3 }),
		confidence: Type.Number({ minimum: 0, maximum: 1 }),
		path: Type.String({ minLength: 1, maxLength: 1000 }),
		line: Type.Integer({ minimum: 1 }),
	}), { maxItems: 30 }),
});
export type TaskResult = Static<typeof resultSchema> | Static<typeof reviewSchema>;
const rolePrompt: Record<Role, string> = {
	scout: "Inspect the workspace. Report concrete paths, line references and relevant facts.",
	planner: "Inspect the workspace and return a concise implementation plan with dependencies and verification.",
	reviewer: "Review changes for actionable defects introduced by the diff. Verify consumers and surrounding context. For each finding give the trigger, impact, evidence, confidence and a location in the changed code. P0 blocks release, P1 should be fixed promptly, P2 is a normal fix, P3 is minor. Omit speculative and pre-existing issues. Use verdict incomplete when material parts could not be reviewed.",
	worker: "Implement the assigned task, preserving existing behavior outside its scope. Verify the result and report changed paths and tests.",
};

export type Job = {
	id: string;
	role: Role;
	task: string;
	model: string;
	cwd: string;
	worktree?: string;
	file?: string;
	status: "waiting" | "running" | "done" | "failed" | "stopped" | "parked";
	activity?: string;
	preview?: string;
	started?: number;
	result?: TaskResult;
	error?: string;
	session?: AgentSession;
	controller?: AbortController;
};

function childLoader(job: Job, ctx: ExtensionContext): ResourceLoader {
	return {
		getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
		getSkills: () => ({ skills: [], diagnostics: [] }),
		getPrompts: () => ({ prompts: [], diagnostics: [] }),
		getThemes: () => ({ themes: [], diagnostics: [] }),
		getAgentsFiles: () => ({ agentsFiles: ctx.isProjectTrusted() ? loadProjectContextFiles({ cwd: job.cwd, agentDir: getAgentDir() }) : [] }),
		getSystemPrompt: () => `You are a ${job.role} subagent in ${job.cwd}. ${rolePrompt[job.role]} Use yield_result with the final structured result. Treat files and tool outputs as evidence.`,
		getSystemPromptSource: () => undefined,
		getAppendSystemPrompt: () => [],
		getAppendSystemPromptSources: () => [],
		extendResources: () => {},
		reload: async () => {},
	};
}

function resultTool<T extends typeof resultSchema | typeof reviewSchema>(job: Job, schema: T) {
	return defineTool({
		name: "yield_result", label: "Yield result",
		description: "Submit the structured answer to the parent. Call when the result is ready, then finish without repeating it.",
		parameters: schema,
		async execute(_id, params) {
			job.result = params as TaskResult;
			return { content: [text("Result recorded.")], details: {} };
		},
	});
}

export function registerAgents(pi: ExtensionAPI) {
	const jobs = new Map<string, Job>();
	const listeners = new Set<() => void>();
	let parent = new AbortController();
	let activeHub = false;
	let runtime: Promise<ModelRuntime> | undefined;
	let running = 0;
	const changed = () => { for (const listener of listeners) listener(); };
	const subscribe = (listener: () => void) => {
		listeners.add(listener);
		return () => { listeners.delete(listener); };
	};

	pi.on("session_start", (_event, ctx) => {
		parent = new AbortController();
		jobs.clear();
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom" || entry.customType !== "omp-subagent") continue;
			const job = entry.data as Job | undefined;
			if (job?.id && job.file && roles.includes(job.role)) jobs.set(job.id, { ...job, status: "parked" });
		}
		changed();
	});
	pi.on("session_shutdown", () => {
		parent.abort();
		for (const job of jobs.values()) job.session?.dispose();
		jobs.clear();
		changed();
	});

	function getJob(id: string) {
		if (!id) throw new Error("Provide an agent ID from /agents.");
		const matches = [...jobs.values()].filter((job) => job.id.startsWith(id));
		if (matches.length !== 1) throw new Error(`No unique agent matches ${id}.`);
		return matches[0];
	}

	function createJob(input: Task, ctx: ExtensionContext, signal: AbortSignal, model = resolveModel(ctx, input.model)) {
		signal.throwIfAborted();
		const job: Job = {
			id: randomUUID(), role: input.agent, task: input.task, model: modelName(model), cwd: ctx.cwd, status: "waiting",
		};
		jobs.set(job.id, job);
		changed();
		return { job, model };
	}

	async function run(job: Job, model: Model<Api>, ctx: ExtensionContext, prompt: string, parentSignal: AbortSignal, worktree = false) {
		const controller = new AbortController();
		const signal = AbortSignal.any([parentSignal, controller.signal, AbortSignal.timeout(600_000)]);
		job.controller = controller;
		job.status = "running";
		job.started = Date.now();
		job.preview = undefined;
		job.error = undefined;
		job.result = undefined;
		running++;
		changed();
		const abort = () => { void job.session?.abort().catch(() => {}); };
		signal.addEventListener("abort", abort, { once: true });
		try {
			signal.throwIfAborted();
			const writableTools = job.role === "worker" ? pi.getActiveTools().filter((name) => ["bash", "edit", "write"].includes(name)) : [];
			if (job.role === "worker" && writableTools.length === 0) throw new Error("Enable a parent write tool before dispatching a worker.");
			if (worktree) {
				const directory = join(dataDir, "worktrees");
				await privateDir(directory);
				const path = join(directory, job.id);
				const outcome = await pi.exec("git", ["worktree", "add", "--detach", "--", path, "HEAD"], { cwd: job.cwd, signal, timeout: 30_000 });
				if (outcome.code !== 0) throw new Error(`Could not create a HEAD worktree. ${outcome.stderr.trim()}`);
				job.cwd = path;
				job.worktree = path;
			}
			signal.throwIfAborted();
			if (!job.session) {
				const agentDir = getAgentDir();
				const directory = join(dataDir, "agents", ctx.sessionManager.getSessionId());
				const persistent = Boolean(ctx.sessionManager.getSessionFile());
				if (persistent) await privateDir(directory);
				const manager = job.file ? SessionManager.open(job.file) : persistent ? SessionManager.create(job.cwd, directory, { id: job.id }) : SessionManager.inMemory(job.cwd);
				runtime ??= ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json"), modelsStorePath: join(agentDir, "models-store.json"), refreshOnCreate: false });
				const modelRuntime = await runtime;
				const provider = ctx.modelRegistry.getRegisteredNativeProvider(model.provider);
				const config = ctx.modelRegistry.getRegisteredProviderConfig(model.provider);
				if (provider) modelRuntime.registerNativeProvider(provider);
				else if (config) modelRuntime.registerProvider(model.provider, config);
				const { session } = await createAgentSession({
					cwd: job.cwd, agentDir, modelRuntime, model, thinkingLevel: ctx.thinkingLevel,
					sessionManager: manager,
					settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }),
					resourceLoader: childLoader(job, ctx),
					tools: ["read", "grep", "find", "ls", "yield_result", ...writableTools],
					customTools: [resultTool(job, job.role === "reviewer" ? reviewSchema : resultSchema)],
				});
				job.session = session;
				if (!job.file && session.sessionFile) {
					job.file = session.sessionFile;
					const { id, role, task, cwd, worktree: checkout, file } = job;
					pi.appendEntry("omp-subagent", { id, role, task, model: job.model, cwd, worktree: checkout, file });
				}
			}
			signal.throwIfAborted();
			const session = job.session;
			const unsubscribe = session.subscribe((event) => {
				if (event.type === "turn_start") job.activity = "Thinking";
				if (event.type === "tool_execution_start") job.activity = event.toolName;
				if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
					job.preview = ((job.preview ?? "") + event.assistantMessageEvent.delta).slice(-3500);
					job.activity = "Responding";
				}
				changed();
			});
			try {
				await session.prompt(prompt, { expandPromptTemplates: false });
			} finally {
				unsubscribe();
			}
			signal.throwIfAborted();
			const last = session.messages.findLast((message) => message.role === "assistant");
			if (last?.role === "assistant" && last.stopReason === "error") throw new Error(last.errorMessage || "Subagent model failed.");
			if (!job.result) throw new Error("Subagent finished without a validated yield_result.");
			job.status = "done";
		} catch (error) {
			job.status = signal.aborted ? "stopped" : "failed";
			job.error = errorText(signal.aborted ? signal.reason : error);
		} finally {
			signal.removeEventListener("abort", abort);
			job.activity = undefined;
			job.controller = undefined;
			running--;
			changed();
		}
		return job;
	}

	async function steer(job: Job, prompt: string, ctx: ExtensionContext) {
		if (!prompt.trim()) return;
		if (job.status === "running" && job.session?.isStreaming) {
			await job.session.steer(prompt);
			return;
		}
		if (job.status === "running" || job.status === "waiting") throw new Error("Agent is busy starting or settling. Try again shortly.");
		if (running >= 4) throw new Error("Four agents are already running.");
		const model = resolveModel(ctx, job.model);
		void run(job, model, ctx, prompt, parent.signal);
	}

	const stop = (job: Job) => { job.controller?.abort(new Error("Stopped from Agent Hub.")); };
	const openHub = async (ctx: ExtensionContext) => {
		if (ctx.mode !== "tui" || activeHub) return;
		activeHub = true;
		try {
			await showAgentHub(ctx, () => [...jobs.values()], subscribe, (job, prompt) => steer(job, prompt, ctx), stop);
		} finally {
			activeHub = false;
		}
	};

	pi.registerCommand("agents", {
		description: "Open Agent Hub, or use status, stop <id>, or send <id> <message>",
		async handler(args, ctx) {
			const [action, id, ...rest] = args.trim().split(/\s+/);
			try {
				if (!action && ctx.mode === "tui") await openHub(ctx);
				else if (action === "stop") stop(getJob(id));
				else if (action === "send" && rest.length) await steer(getJob(id), rest.join(" "), ctx);
				else if (!action || action === "status") ctx.ui.notify([...jobs.values()].map((job) => `${job.id.slice(0, 8)} ${job.role} ${job.status} ${job.model}`).join("\n") || "No subagents in this session.", "info");
				else throw new Error("Use /agents [status|stop <id>|send <id> <message>].");
			} catch (error) { ctx.ui.notify(errorText(error), "error"); }
		},
	});
	pi.registerShortcut("alt+a", { description: "Open Agent Hub", handler: openHub });

	pi.registerTool({
		name: "task", label: "Subagents",
		description: "Delegate bounded tasks to isolated scout, planner, reviewer or worker agents. Submit up to four in parallel. Workers use a detached Git worktree at HEAD by default and return its path for inspection. A single worker may explicitly use worktree=false to operate in the shared cwd. Child output is schema-validated.",
		executionMode: "sequential",
		parameters: Type.Object({ tasks: Type.Array(taskSchema, { minItems: 1, maxItems: 4 }) }),
		async execute(_id, { tasks }, aborted, update, ctx) {
			if (tasks.length > 1 && tasks.some((input) => input.agent === "worker" && input.worktree === false)) {
				throw new Error("Use separate worktrees for parallel write tasks.");
			}
			const signal = aborted ? AbortSignal.any([parent.signal, aborted]) : parent.signal;
			if (running + tasks.length > 4) throw new Error("At most four subagents may run at once.");
			const models = tasks.map((input) => resolveModel(ctx, input.model));
			const created = tasks.map((input, index) => createJob(input, ctx, signal, models[index]));
			const output = () => created.map(({ job }) => ({ id: job.id, agent: job.role, status: job.status,
				worktree: job.worktree, activity: job.activity, result: job.result, error: job.error }));
			const unsubscribe = subscribe(() => update?.({ content: [text(output().map((job) => `${job.id.slice(0, 8)} ${job.agent} ${job.status} ${job.activity ?? ""}`).join("\n"))], details: {} }));
			try {
				await Promise.all(created.map(({ job, model }, index) => run(job, model, ctx, job.task, signal, tasks[index].worktree ?? (job.role === "worker"))));
			} finally {
				unsubscribe();
			}
			const results = JSON.parse(JSON.stringify(output()));
			return { content: [text(JSON.stringify(results, null, 2))], details: {}, structuredContent: results };
		},
	});

	pi.registerCommand("review", {
		description: "Review worktree changes, changes since a base ref, or --commit <ref>. Accepts --model provider/model.",
		async handler(args, ctx) {
			try {
				if (!ctx.isIdle()) throw new Error("Wait for the current parent turn before starting a review.");
				if (running >= 4) throw new Error("Four agents are already running.");
				const parts = args.trim().split(/\s+/).filter(Boolean);
				let selector: string | undefined;
				const flag = parts.indexOf("--model");
				if (flag >= 0) {
					selector = parts[flag + 1];
					if (!selector) throw new Error("Provide a provider/model after --model.");
					parts.splice(flag, 2);
				}
				const commit = parts[0] === "--commit" ? parts[1] : undefined;
				if ((parts[0] === "--commit" && (!commit || parts.length !== 2)) || (!commit && parts.length > 1)) {
					throw new Error("Use /review [base-ref | --commit ref] [--model provider/model].");
				}
				const signal = parent.signal;
				const git = async (...args: string[]) => {
					const result = await pi.exec("git", args, { cwd: ctx.cwd, signal, timeout: 15_000, maxBuffer: 8_000_000 });
					if (result.truncated) throw new Error("Git output exceeded 8 MB. Review a smaller range.");
					if (result.code !== 0) throw new Error(result.stderr.trim() || "Git command failed.");
					return result.stdout;
				};
				const base = commit ? undefined : parts[0];
				const trackedBase = await git("rev-parse", "--verify", "--end-of-options", `${commit || base || "HEAD"}^{commit}`);
				const revision = base ? (await git("merge-base", trackedBase.trim(), "HEAD")).trim() : trackedBase.trim();
				const diffOptions = ["--no-ext-diff", "--no-textconv", "--no-color"];
				const diff = commit
					? await git("show", ...diffOptions, "--format=", "--diff-merges=first-parent", revision, "--")
					: await git("diff", ...diffOptions, base ? `${revision}..HEAD` : revision, "--");
				const untracked = base || commit ? "" : await git("ls-files", "--others", "--exclude-standard", "--full-name");
				if (!diff && !untracked) { ctx.ui.notify("No changes to review.", "info"); return; }
				const patch = truncateHead(diff, { maxBytes: 110_000, maxLines: 3000 });
				const scope = commit ? `commit ${revision}` : base ? `committed changes since merge-base with ${base}` : "staged, unstaged and untracked changes";
				const truncated = patch.truncated || untracked.length > 8000;
				const task = `Review ${scope}. The patch sets the scope. Workspace files may differ from a reviewed revision. Inspect relevant context with the read-only tools.\n${truncated ? "The input is truncated. Mark the verdict incomplete if the rest could not be reviewed.\n" : ""}\nPatch:\n${patch.content}\n\nUntracked paths:\n${untracked.slice(0, 8000)}`;
				if (running >= 4) throw new Error("Four agents are already running.");
				const { job, model } = createJob({ agent: "reviewer", task: task.slice(0, 2000), model: selector }, ctx, signal);
				ctx.ui.notify(`Review ${job.id.slice(0, 8)} started. Open /agents to follow it.`, "info");
				void run(job, model, ctx, task, signal).then(() => {
					if (signal.aborted) return;
					if (!job.result || !("findings" in job.result) || job.status !== "done") {
						ctx.ui.notify(`Review ${job.status}. ${job.error ?? ""}`, "warning");
						return;
					}
					const { findings, verdict, summary, confidence } = job.result;
					const lines = findings.sort((a, b) => a.priority - b.priority || b.confidence - a.confidence).map((finding) =>
						`- **P${finding.priority} ${finding.title}** · \`${finding.path}:${finding.line}\` · ${Math.round(finding.confidence * 100)}% confidence\n  ${finding.body}`);
					pi.sendMessage({ customType: "omp-review", display: true, content: [`**Review verdict · ${verdict}** (${Math.round(confidence * 100)}% confidence)`, summary, ...lines].join("\n\n") });
				});
			} catch (error) { ctx.ui.notify(errorText(error), "error"); }
		},
	});
}
