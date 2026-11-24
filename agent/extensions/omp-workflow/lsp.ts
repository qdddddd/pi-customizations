import { setTimeout as delay } from "node:timers/promises";
import { glob, readdir, realpath } from "node:fs/promises";
import { basename, extname, join, matchesGlob, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { findExecutable, StdioProtocol, toolResult } from "./protocol.ts";
import { errorText } from "./shared.ts";
import {
	applyWorkspacePlan, fileUri, inside, prepareFileMove, prepareWorkspaceEdit, previewWorkspaceEdit, readSnapshot, record,
	type Document, type Position, type WorkspaceResponse,
} from "./lsp-edit.ts";

const navigation = {
	definition: "textDocument/definition", declaration: "textDocument/declaration", type_definition: "textDocument/typeDefinition",
	implementation: "textDocument/implementation", references: "textDocument/references",
};
const actions = ["status", "reload", "diagnostics", "definition", "declaration", "type_definition", "implementation", "references",
	"hover", "symbols", "capabilities", "rename", "rename_file", "code_actions"] as const;
const parameters = Type.Object({
	action: Type.Enum(actions, { type: "string" }),
	file: Type.Optional(Type.String({ description: "Workspace-relative or absolute path. Use * for workspace symbols/diagnostics or reload." })),
	line: Type.Optional(Type.Integer({ minimum: 1, description: "1-based line number, default 1." })),
	symbol: Type.Optional(Type.String({ minLength: 1, description: "Text on the selected line. Use name#N for the Nth occurrence." })),
	query: Type.Optional(Type.String({ description: "Workspace symbol search or code action index/title selector." })),
	new_name: Type.Optional(Type.String({ minLength: 1, description: "New symbol name or workspace-relative destination file path." })),
	apply: Type.Optional(Type.Boolean({ description: "Apply a validated workspace edit. Rename and code actions preview by default." })),
	timeout: Type.Optional(Type.Number({ minimum: 5, maximum: 300, description: "Timeout in seconds, default 20." })),
});
type Input = Static<typeof parameters>;
type ServerConfig = {
	command: string;
	args?: string[];
	fileTypes: string[];
	rootMarkers: string[];
	languageId?: string;
	settings?: Record<string, unknown>;
	initOptions?: Record<string, unknown>;
	isLinter?: boolean;
	disabled?: boolean;
};
type Server = ServerConfig & { name: string; executable: string };
const js = ["js", "jsx", "ts", "tsx", "mjs", "cjs", "mts", "cts"];
const python = ["pyproject.toml", "pyrightconfig.json", "setup.py", "setup.cfg", "requirements.txt", "Pipfile"];
const defaults: Record<string, ServerConfig> = {
	denols: { command: "deno", args: ["lsp"], fileTypes: js, rootMarkers: ["deno.json", "deno.jsonc"] },
	"typescript-language-server": { command: "typescript-language-server", args: ["--stdio"], fileTypes: js, rootMarkers: ["package.json", "tsconfig.json", "jsconfig.json"], initOptions: { hostInfo: "pi" } },
	biome: { command: "biome", args: ["lsp-proxy"], fileTypes: [...js, "json", "jsonc", "css"], rootMarkers: ["biome.json", "biome.jsonc"], isLinter: true },
	eslint: { command: "vscode-eslint-language-server", args: ["--stdio"], fileTypes: [...js, "vue", "svelte"], rootMarkers: [".eslintrc*", "eslint.config.*"], isLinter: true },
	pyright: { command: "pyright-langserver", args: ["--stdio"], fileTypes: ["py", "pyi"], rootMarkers: python },
	basedpyright: { command: "basedpyright-langserver", args: ["--stdio"], fileTypes: ["py", "pyi"], rootMarkers: python },
	pylsp: { command: "pylsp", fileTypes: ["py", "pyi"], rootMarkers: python },
	ty: { command: "ty", args: ["server"], fileTypes: ["py", "pyi"], rootMarkers: python },
	ruff: { command: "ruff", args: ["server"], fileTypes: ["py", "pyi"], rootMarkers: [...python, "ruff.toml", ".ruff.toml"], isLinter: true },
	"rust-analyzer": { command: "rust-analyzer", fileTypes: ["rs"], rootMarkers: ["Cargo.toml", "rust-analyzer.toml"] },
	gopls: { command: "gopls", args: ["serve"], fileTypes: ["go", "go.mod", "go.sum", "go.work"], rootMarkers: ["go.mod", "go.work"] },
	clangd: { command: "clangd", fileTypes: ["c", "cc", "cpp", "cxx", "h", "hpp", "hh", "hxx", "m", "mm"], rootMarkers: ["compile_commands.json", "CMakeLists.txt", ".clangd", "Makefile"] },
	zls: { command: "zls", fileTypes: ["zig"], rootMarkers: ["build.zig", "build.zig.zon", "zls.json"] },
	jdtls: { command: "jdtls", fileTypes: ["java"], rootMarkers: ["pom.xml", "build.gradle", "build.gradle.kts"] },
	"lua-language-server": { command: "lua-language-server", fileTypes: ["lua"], rootMarkers: [".luarc.json", ".luarc.jsonc", ".stylua.toml"] },
	"bash-language-server": { command: "bash-language-server", args: ["start"], fileTypes: ["sh", "bash"], rootMarkers: [".git"] },
	"julia-lsp": { command: "julia-lsp", fileTypes: ["jl"], rootMarkers: ["Project.toml", "JuliaProject.toml"] },
};
const languageIds: Record<string, string> = {
	ts: "typescript", mts: "typescript", cts: "typescript", tsx: "typescriptreact", js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascriptreact",
	py: "python", pyi: "python", rs: "rust", sh: "shellscript", bash: "shellscript", jl: "julia", h: "c", cc: "cpp", cxx: "cpp", hpp: "cpp", hh: "cpp", hxx: "cpp",
	m: "objective-c", mm: "objective-cpp", md: "markdown", yml: "yaml",
};

function stringList(value: unknown, empty = false): value is string[] {
	return Array.isArray(value) && (empty || value.length > 0) && value.every((item) => typeof item === "string" && item.length > 0);
}

async function discover(root: string, signal: AbortSignal) {
	const definitions = new Map<string, ServerConfig>(Object.entries(defaults));
	let diagnosticsOnWrite = false;
	const warnings: string[] = [];
	const projectDir = join(root, ".pi");
	for (const directory of [getAgentDir(), projectDir]) {
		const path = join(directory, "lsp.json");
		try {
			if (directory === projectDir && await realpath(directory) !== directory) throw new Error("Project configuration directory is a symbolic link.");
			const configFile = directory === projectDir ? path : await realpath(path);
			const value: unknown = JSON.parse((await readSnapshot(configFile, signal)).text.replace(/^\uFEFF/, ""));
			if (!record(value) || (value.servers !== undefined && !record(value.servers))) throw new Error("Expected an object of server definitions.");
			if (typeof value.diagnosticsOnWrite === "boolean") diagnosticsOnWrite = value.diagnosticsOnWrite;
			for (const [name, config] of Object.entries(record(value.servers) ? value.servers : value)) {
				if (name === "idleTimeoutMs" || name === "diagnosticsOnWrite") continue;
				if (!record(config)) {
					warnings.push(`Invalid server ${name} in ${path}.`);
					continue;
				}
				const parsed = { ...definitions.get(name), ...config };
				if (parsed.disabled === true) {
					if (definitions.has(name)) definitions.set(name, { ...definitions.get(name)!, disabled: true });
					continue;
				}
				if (typeof parsed.command !== "string" || !parsed.command.trim() || !stringList(parsed.fileTypes) || !stringList(parsed.rootMarkers) ||
					(parsed.args !== undefined && !stringList(parsed.args, true)) || (parsed.languageId !== undefined && typeof parsed.languageId !== "string") ||
					(parsed.settings !== undefined && !record(parsed.settings)) || (parsed.initOptions !== undefined && !record(parsed.initOptions))) {
					warnings.push(`Invalid server ${name} in ${path}.`);
					continue;
				}
				definitions.set(name, parsed as ServerConfig);
			}
		} catch (error) {
			signal.throwIfAborted();
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") warnings.push(`Could not read ${path}. ${errorText(error)}`);
		}
	}
	const entries = await readdir(root);
	const servers: Server[] = [];
	const unavailable: string[] = [];
	for (const [name, config] of definitions) {
		signal.throwIfAborted();
		if (config.disabled || !config.rootMarkers.some((marker) => marker === "." || entries.some((entry) => entry === marker || matchesGlob(entry, marker)))) continue;
		const executable = await findExecutable(config.command, root);
		if (executable) servers.push({ ...config, name, executable });
		else unavailable.push(`${name} (executable ${config.command} unavailable)`);
	}
	servers.sort((a, b) => Number(Boolean(a.isLinter)) - Number(Boolean(b.isLinter)));
	return { servers, unavailable, warnings, diagnosticsOnWrite };
}

function matchesFile(server: Server, path: string) {
	const name = basename(path).toLowerCase();
	const extension = extname(name).slice(1);
	return server.fileTypes.some((type) => type.toLowerCase() === name || type.toLowerCase().replace(/^\./, "") === extension);
}

function positionAt(text: string, line: number, symbol?: string): Position {
	const row = text.split(/\r\n|\n|\r/)[line - 1];
	if (row === undefined || !Number.isSafeInteger(line) || line < 1) throw new Error(`Line ${line} is outside the document.`);
	if (!symbol) return { line: line - 1, character: Math.max(0, row.search(/\S/)) };
	const selector = /^(.*)#([1-9]\d*)$/s.exec(symbol);
	const word = selector?.[1] ?? symbol;
	const occurrence = Number(selector?.[2] ?? 1);
	if (!word || !Number.isSafeInteger(occurrence)) throw new Error(`Invalid symbol selector ${symbol}.`);
	const identifier = /^[\p{L}\p{N}\p{M}_$]+$/u.test(word);
	const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const pattern = identifier ? `(?<![\\p{L}\\p{N}\\p{M}_$])${escaped}(?![\\p{L}\\p{N}\\p{M}_$])` : escaped;
	for (const flags of ["gu", "giu"]) {
		let count = 0;
		for (const match of row.matchAll(new RegExp(pattern, flags))) {
			if (++count === occurrence) return { line: line - 1, character: match.index };
		}
	}
	throw new Error(`Could not find ${JSON.stringify(symbol)} on line ${line}.`);
}

function location(root: string, value: any) {
	const uri = value?.targetUri ?? value?.uri;
	const start = (value?.targetSelectionRange ?? value?.targetRange ?? value?.range)?.start;
	if (typeof uri !== "string") return "unknown location";
	let file = uri;
	try {
		const path = fileURLToPath(uri);
		file = inside(root, path) ? relative(root, path) : path;
	} catch { /* Keep non-file URIs as supplied by LSP. */ }
	return start && Number.isInteger(start.line) && Number.isInteger(start.character) ? `${file}:${start.line + 1}:${start.character + 1}` : file;
}

function symbolRows(root: string, values: any[], uri?: string, depth = 0): string[] {
	if (depth > 20) return [];
	return values.flatMap((value) => {
		if (typeof value?.name !== "string") return [];
		const loc = value.location ?? { uri, range: value.selectionRange ?? value.range };
		const row = `${"  ".repeat(depth)}${value.name}${value.detail ? ` (${value.detail})` : ""} — ${location(root, loc)}`;
		return [row, ...(Array.isArray(value.children) ? symbolRows(root, value.children, uri, depth + 1) : [])];
	});
}

function hoverText(contents: any): string {
	if (typeof contents === "string") return contents;
	if (Array.isArray(contents)) return contents.map(hoverText).filter(Boolean).join("\n\n");
	if (typeof contents?.value !== "string") return "";
	return typeof contents.language === "string" ? `\`\`\`${contents.language}\n${contents.value}\n\`\`\`` : contents.value;
}

type Diagnostic = { range: { start: Position }; message: string; severity?: number; source?: string; code?: string | number };
type Publish = { items: Diagnostic[]; version?: number; received: number };
type FilePair = { oldUri: string; newUri: string };

class Client {
	readonly documents = new Map<string, Document>();
	readonly transport: StdioProtocol;
	private readonly diagnostics = new Map<string, Publish>();
	private readonly registrations = new Map<string, { method: string; registerOptions?: any }>();
	private version = 0;
	capabilities: any = {};
	private initialized = false;

	constructor(readonly root: string, readonly server: Server) {
		this.transport = new StdioProtocol(server.executable, server.args ?? [], root, "lsp");
		this.transport.onMessage((message) => {
			const params = message.params;
			if (message.method !== "textDocument/publishDiagnostics" || typeof params?.uri !== "string" || !Array.isArray(params.diagnostics)) return;
			const current = this.documents.get(params.uri);
			if (!current || (params.version != null && params.version !== current.version)) return;
			this.diagnostics.set(params.uri, { items: params.diagnostics, version: params.version, received: Date.now() });
		});
		this.transport.onRequest((method, params) => {
			switch (method) {
				case "workspace/configuration":
					return Array.isArray(params?.items) ? params.items.map(({ section }: { section?: string }) => {
						const settings = server.settings ?? {};
						if (!section) return settings;
						if (Object.hasOwn(settings, section)) return settings[section];
						return section.split(".").reduce<unknown>((value, key) => record(value) && Object.hasOwn(value, key) ? value[key] : null, settings) ?? null;
					}) : [];
				case "workspace/workspaceFolders": return this.folders();
				case "workspace/applyEdit": return { applied: false, failureReason: "Use an explicit LSP tool edit application." };
				case "client/registerCapability":
					for (const registration of params?.registrations ?? []) this.registrations.set(registration.id, registration);
					return null;
				case "client/unregisterCapability":
					for (const registration of params?.unregisterations ?? params?.unregistrations ?? []) this.registrations.delete(registration.id);
					return null;
				case "workspace/diagnostic/refresh":
					this.diagnostics.clear();
					return null;
				case "window/workDoneProgress/create":
				case "window/showMessageRequest": return null;
				default: throw new Error(`Unsupported LSP client request ${method}.`);
			}
		});
	}

	private folders() { return [{ uri: fileUri(this.root), name: basename(this.root) }]; }

	async initialize(signal: AbortSignal) {
		const result = await this.transport.request("initialize", {
			processId: process.pid, rootUri: fileUri(this.root), rootPath: this.root, workspaceFolders: this.folders(),
			clientInfo: { name: "pi omp-workflow" }, initializationOptions: this.server.initOptions,
			capabilities: {
				general: { positionEncodings: ["utf-16"] },
				workspace: {
					configuration: true, workspaceFolders: true, workspaceEdit: { documentChanges: true, failureHandling: "textOnlyTransactional" },
					fileOperations: { dynamicRegistration: true, willRename: true, didRename: true },
				},
				textDocument: {
					publishDiagnostics: { versionSupport: true }, diagnostic: { dynamicRegistration: true },
					definition: { linkSupport: true }, declaration: { linkSupport: true }, typeDefinition: { linkSupport: true }, implementation: { linkSupport: true },
					hover: { contentFormat: ["markdown", "plaintext"] }, documentSymbol: { hierarchicalDocumentSymbolSupport: true },
					codeAction: { codeActionLiteralSupport: { codeActionKind: { valueSet: ["", "quickfix", "refactor", "source"] } }, resolveSupport: { properties: ["edit"] }, disabledSupport: true },
				},
				window: { workDoneProgress: true },
			},
		}, signal);
		this.capabilities = result?.capabilities ?? {};
		if (this.capabilities.positionEncoding && this.capabilities.positionEncoding !== "utf-16") throw new Error("The server did not select UTF-16 positions.");
		this.initialized = true;
		this.transport.notify("initialized", {});
		if (this.server.settings) this.transport.notify("workspace/didChangeConfiguration", { settings: this.server.settings });
	}

	async stop() {
		try {
			if (this.initialized && !this.transport.closed) {
				await this.transport.request("shutdown", null, AbortSignal.timeout(800));
				this.transport.notify("exit", null);
			}
		} catch { /* Close the transport even when the server fails to acknowledge shutdown. */ }
		finally { this.transport.close(); }
	}

	private closeDocument(uri: string) {
		this.documents.delete(uri);
		this.diagnostics.delete(uri);
		this.transport.notify("textDocument/didClose", { textDocument: { uri } });
	}

	async sync(path: string, signal: AbortSignal) {
		const uri = fileUri(path);
		const { text } = await readSnapshot(path, signal);
		const previous = this.documents.get(uri);
		if (previous?.text === text) return previous;
		const doc = { text, version: ++this.version };
		this.documents.set(uri, doc);
		this.diagnostics.delete(uri);
		const sync = this.capabilities.textDocumentSync;
		const kind = typeof sync === "number" ? sync : sync?.change;
		const ext = extname(path).slice(1).toLowerCase();
		if (!previous || kind === 0) {
			if (previous) this.transport.notify("textDocument/didClose", { textDocument: { uri } });
			const languageId = this.server.languageId ?? languageIds[ext] ?? (ext || basename(path).toLowerCase());
			this.transport.notify("textDocument/didOpen", { textDocument: { uri, languageId, ...doc } });
		} else {
			const oldLines = previous.text.split(/\r\n|\n|\r/);
			const range = { start: { line: 0, character: 0 }, end: { line: oldLines.length - 1, character: oldLines.at(-1)!.length } };
			this.transport.notify("textDocument/didChange", { textDocument: { uri, version: doc.version }, contentChanges: [kind === 2 ? { range, text } : { text }] });
			if (sync?.save) this.transport.notify("textDocument/didSave", { textDocument: { uri }, ...(sync.save.includeText ? { text } : {}) });
		}
		return doc;
	}

	async reconcile(signal: AbortSignal, strict = false) {
		for (const uri of this.documents.keys()) {
			try {
				const path = fileURLToPath(uri);
				if (await realpath(path) !== path) throw new Error(`Open document path changed at ${path}.`);
				await this.sync(path, signal);
			} catch (error) {
				signal.throwIfAborted();
				if (strict) throw error;
				this.closeDocument(uri);
			}
		}
	}

	cachedDiagnostics(uri: string) { return this.diagnostics.get(uri)?.items ?? []; }

	private providers(method: string, advertised: any) {
		return [advertised, ...[...this.registrations.values()].filter((entry) => entry.method === method).map(({ registerOptions }) => registerOptions)].filter(Boolean);
	}

	async documentDiagnostics(uri: string, signal: AbortSignal, wait: number): Promise<Diagnostic[]> {
		const [provider] = this.providers("textDocument/diagnostic", this.capabilities.diagnosticProvider);
		const budget = AbortSignal.any([signal, AbortSignal.timeout(wait)]);
		let pullFailure: unknown;
		if (provider) {
			try {
				const result = await this.transport.request("textDocument/diagnostic", { textDocument: { uri }, identifier: provider.identifier }, budget);
				if (result?.kind === "full" && Array.isArray(result.items)) return result.items;
				throw new Error("The server did not return a full diagnostics report.");
			} catch (error) {
				signal.throwIfAborted();
				pullFailure = error;
			}
		}
		while (true) {
			signal.throwIfAborted();
			const latest = this.diagnostics.get(uri);
			if (latest && (latest.version != null || Date.now() - latest.received >= 125 || budget.aborted)) return latest.items;
			if (budget.aborted) break;
			await delay(40, undefined, { signal: budget }).catch(() => undefined);
		}
		throw new Error(pullFailure ? errorText(pullFailure) : "No diagnostics were published for this document before the wait elapsed.");
	}

	async workspaceDiagnostics(signal: AbortSignal) {
		const provider = this.providers("textDocument/diagnostic", this.capabilities.diagnosticProvider).find((option) => option.workspaceDiagnostics);
		if (!provider) throw new Error("Workspace diagnostics are unavailable. Use a concrete file or a glob.");
		const result = await this.transport.request("workspace/diagnostic", { identifier: provider.identifier, previousResultIds: [] }, signal);
		if (!Array.isArray(result?.items) || result.items.some((item: any) => item?.kind !== "full" || !Array.isArray(item.items))) {
			throw new Error("The server did not return a full workspace diagnostics report.");
		}
		return result.items as { uri: string; items: Diagnostic[] }[];
	}

	fileOperation(method: "willRename" | "didRename", pair: FilePair) {
		const operations = this.capabilities.workspace?.fileOperations;
		const options = this.providers(`workspace/${method}Files`, operations?.[method]);
		return options.flatMap((option) => Array.isArray(option.filters) ? option.filters : []).some((filter: any) => {
			if ((filter.scheme && filter.scheme !== "file") || filter.pattern?.matches === "folder" || typeof filter.pattern?.glob !== "string") return false;
			const ignoreCase = filter.pattern.options?.ignoreCase;
			const pattern = ignoreCase ? filter.pattern.glob.toLowerCase() : filter.pattern.glob;
			return [pair.oldUri, pair.newUri].some((uri) => {
				const path = fileURLToPath(uri);
				return [path, relative(this.root, path)].some((part) => matchesGlob(ignoreCase ? part.toLowerCase() : part, pattern));
			});
		});
	}

	didMove(pair: FilePair) {
		if (this.documents.has(pair.oldUri)) this.closeDocument(pair.oldUri);
		if (this.fileOperation("didRename", pair)) this.transport.notify("workspace/didRenameFiles", { files: [pair] });
	}
}

function diagnosticRows(root: string, reports: { uri: string; items: Diagnostic[] }[]) {
	const rows = new Map<string, number>();
	const severity = ["", "error", "warning", "information", "hint"];
	for (const { uri, items } of reports) {
		for (const item of items) {
			if (typeof item?.message !== "string") throw new Error("The server sent a malformed diagnostic.");
			const rank = item.severity ?? 0;
			const kind = severity[rank] ?? "";
			const source = [item.source, item.code].filter((part) => part !== undefined && part !== "").join("/");
			const row = `${location(root, { uri, range: item.range })} ${[kind, source].filter(Boolean).join(" ")} ${item.message}`;
			rows.set(row, rank || 5);
		}
	}
	return [...rows.entries()].sort((a, b) => a[1] - b[1]).map(([row]) => row);
}

async function editResult(root: string, responses: WorkspaceResponse[], apply: boolean | undefined, signal: AbortSignal) {
	const plan = await prepareWorkspaceEdit(root, responses, signal);
	if (!apply) return `Preview only\n${previewWorkspaceEdit(root, plan)}`;
	await applyWorkspacePlan(root, plan, signal);
	return plan.files.length ? `Applied edits to ${plan.files.map(({ path }) => relative(root, path)).join(", ")}.` : "No workspace edits to apply.";
}

async function codeActions(client: Client, input: Input, uri: string, position: Position, signal: AbortSignal) {
	const query = input.query?.trim();
	let diagnostics = client.cachedDiagnostics(uri);
	if (!diagnostics.length) {
		try { diagnostics = await client.documentDiagnostics(uri, signal, 450); }
		catch { signal.throwIfAborted(); }
	}
	const response = await client.transport.request("textDocument/codeAction", {
		textDocument: { uri }, range: { start: position, end: position }, context: { diagnostics },
	}, signal);
	const available: any[] = Array.isArray(response) ? response.filter((item) => typeof item?.title === "string") : [];
	if (!available.length) return "No code actions found.";
	const list = available.map((action, index) => `${index}  ${action.title}${action.kind ? ` [${action.kind}]` : ""}${action.disabled ? ` (disabled: ${action.disabled.reason})` : ""}`).join("\n");
	if (!query) {
		if (input.apply) throw new Error(`Select a code action with query.\n${list}`);
		return `Select an action by index or unambiguous title to preview its edit.\n${list}`;
	}
	const found = /^\d+$/.test(query) ? [available[Number(query)]].filter(Boolean) : available.filter((action) => action.title.toLowerCase() === query.toLowerCase());
	const candidates = found.length || /^\d+$/.test(query) ? found : available.filter((action) => action.title.toLowerCase().includes(query.toLowerCase()));
	if (candidates.length !== 1) throw new Error(`${candidates.length ? "Ambiguous query" : "No matching code action"}.\n${list}`);
	let action = candidates[0];
	if (action.disabled) throw new Error(`Code action is disabled. ${action.disabled.reason}`);
	if (!action.edit && client.capabilities.codeActionProvider?.resolveProvider && action.data !== undefined) {
		action = await client.transport.request("codeAction/resolve", action, signal);
		if (!action || action.disabled) throw new Error(`Could not resolve an enabled code action. ${action?.disabled?.reason ?? ""}`);
	}
	if (input.apply && action.command) throw new Error(`"${action.title}" requires a server command. Choose an edit-only action.`);
	return `${action.title}\n${action.command ? "Includes a server command.\n" : ""}${await editResult(client.root, [{ edit: action.edit, documents: client.documents }], input.apply, signal)}`;
}

class Workspace {
	private config?: Awaited<ReturnType<typeof discover>>;
	private readonly clients = new Map<string, Client>();

	constructor(readonly root: string) {}

	async stop() {
		const clients = [...this.clients.values()];
		this.clients.clear();
		await Promise.all(clients.map((client) => client.stop()));
	}

	private async start(server: Server, signal: AbortSignal) {
		signal.throwIfAborted();
		const running = this.clients.get(server.name);
		if (running && !running.transport.closed) return running;
		const client = new Client(this.root, server);
		try {
			await client.initialize(signal);
			this.clients.set(server.name, client);
			return client;
		} catch (error) {
			client.transport.close();
			throw error;
		}
	}

	private async diagnostics(target: string, wait: number, signal: AbortSignal) {
		const { root } = this;
		const servers = this.config!.servers;
		const reports: { uri: string; items: Diagnostic[] }[] = [];
		const notes: string[] = [];
		let verified = 0;
		let truncated = false;
		if (target === "*") {
			for (const server of servers) {
				try {
					const client = await this.start(server, signal);
					await client.reconcile(signal);
					reports.push(...await client.workspaceDiagnostics(signal));
					verified++;
				} catch (error) {
					signal.throwIfAborted();
					notes.push(`${server.name} — ${errorText(error)}`);
				}
			}
		} else {
			const paths: string[] = [];
			const requested = resolve(root, target);
			const literal = await realpath(requested).catch((error: NodeJS.ErrnoException) => {
				if (error.code !== "ENOENT") throw error;
			});
			if (!literal && /[*?\[\]{}]/.test(target)) {
				const pattern = relative(root, requested);
				if (!inside(root, requested)) throw new Error("Diagnostics globs must stay inside the workspace.");
				for await (const entry of glob(pattern, { cwd: root, withFileTypes: true, exclude: ["**/node_modules", "**/.git", "**/.pi"] })) {
					signal.throwIfAborted();
					if (!entry.isFile()) continue;
					if (paths.length === 20) { truncated = true; break; }
					paths.push(join(entry.parentPath, entry.name));
				}
			} else paths.push(literal ?? requested);
			if (!paths.length) throw new Error(`No files match ${target}.`);
			for (const path of paths) {
				const file = await this.localFile(path);
				const uri = fileUri(file);
				const matching = servers.filter((server) => matchesFile(server, file));
				if (!matching.length) notes.push(`${relative(root, file)} — no matching language server.`);
				for (const server of matching) {
					try {
						const client = await this.start(server, signal);
						await client.reconcile(signal);
						await client.sync(file, signal);
						reports.push({ uri, items: await client.documentDiagnostics(uri, signal, paths.length > 1 ? Math.min(wait, 800) : wait) });
						verified++;
					} catch (error) {
						signal.throwIfAborted();
						notes.push(`${server.name} (${relative(root, file)}) — ${errorText(error)}`);
					}
				}
			}
		}
		if (truncated) notes.unshift("Checked the first 20 matching files.");
		if (!verified) throw new Error(["No diagnostic report was available.", ...notes].join("\n"));
		const rows = diagnosticRows(root, reports);
		return [...(rows.length ? rows : ["No diagnostics reported by responding servers."]), ...notes].join("\n");
	}

	private async localFile(path: string) {
		const file = await realpath(resolve(this.root, path));
		if (!inside(this.root, file)) throw new Error(`File is outside the workspace at ${file}.`);
		return file;
	}

	async afterWrite(path: string, signal: AbortSignal) {
		const { diagnosticsOnWrite, servers } = this.config ??= await discover(this.root, signal);
		if (!diagnosticsOnWrite) return;
		const file = await this.localFile(path);
		const server = servers.find((candidate) => matchesFile(candidate, file));
		if (!server) return;
		const client = await this.start(server, signal);
		await client.sync(file, signal);
		const uri = fileUri(file);
		const items = (await client.documentDiagnostics(uri, signal, 1200)).filter((item) => (item.severity ?? 1) <= 2);
		const rows = diagnosticRows(this.root, [{ uri, items }]);
		return rows.length ? toolResult(`LSP diagnostics after writing ${relative(this.root, file)}\n${rows.join("\n")}`, 5000).content : undefined;
	}

	async run(input: Input, signal: AbortSignal) {
		const { root } = this;
		const workspace = !input.file || input.file === "*";
		if (input.action === "reload" && workspace) {
			await this.stop();
			this.config = undefined;
		}
		const { servers, unavailable, warnings } = this.config ??= await discover(root, signal);
		if (input.action === "status") {
			const active = servers.map(({ name, executable }) => `${name} (${this.clients.get(name)?.transport.closed === false ? "running" : "available"}) — ${executable}`);
			return [...(active.length ? active : ["No language servers available for this workspace."]), ...unavailable, ...warnings].join("\n");
		}
		if (input.action === "reload" && workspace) return [`Reloaded configuration. ${servers.length} server(s) available.`, ...unavailable, ...warnings].join("\n");
		if (!servers.length && input.action !== "rename_file") throw new Error(["No language servers available for this workspace.", ...unavailable, ...warnings].join("\n"));
		if (input.action === "diagnostics") {
			if (!input.file) throw new Error("Specify a diagnostics file, glob, or *.");
			return this.diagnostics(input.file, Math.min(8_000, (input.timeout ?? 20) * 1000 - 250), signal);
		}
		if (input.action === "rename_file") {
			if (workspace || !input.file || !input.new_name?.trim()) throw new Error("Specify both file and new_name.");
			const move = await prepareFileMove(root, resolve(root, input.file), resolve(root, input.new_name), signal);
			const pair = { oldUri: fileUri(move.from), newUri: fileUri(move.to) };
			const responses: WorkspaceResponse[] = [];
			const clients: Client[] = [];
			for (const server of servers) {
				if (!matchesFile(server, move.from) && !matchesFile(server, move.to) && !this.clients.has(server.name)) continue;
				const client = await this.start(server, signal);
				clients.push(client);
				await client.reconcile(signal, input.apply === true);
				if (client.fileOperation("willRename", pair)) {
					const edit = await client.transport.request("workspace/willRenameFiles", { files: [pair] }, signal);
					responses.push({ edit, documents: new Map(client.documents) });
				}
			}
			const plan = await prepareWorkspaceEdit(root, responses, signal);
			const names = `${relative(root, move.from)} → ${relative(root, move.to)}`;
			if (!input.apply) return `File rename preview\n${names}\n${previewWorkspaceEdit(root, plan)}`;
			await applyWorkspacePlan(root, plan, signal, move);
			const syncFailures: string[] = [];
			for (const client of clients) {
				try { client.didMove(pair); }
				catch (error) { syncFailures.push(`${client.server.name} didRenameFiles: ${errorText(error)}`); }
			}
			return [`Renamed ${names}. Applied reference edits to ${plan.files.length} file(s).`, ...syncFailures].join("\n");
		}
		if (input.action === "capabilities" || (input.action === "symbols" && input.file === "*")) {
			const file = workspace ? undefined : await this.localFile(input.file!);
			const matching = file ? servers.filter((server) => matchesFile(server, file)) : servers;
			if (!matching.length) throw new Error(`No language server matches ${input.file}.`);
			const rows: string[] = [];
			const notes: string[] = [];
			let responded = false;
			for (const server of matching) {
				try {
					const client = await this.start(server, signal);
					if (input.action === "capabilities") rows.push(`${server.name}\n${JSON.stringify(client.capabilities, null, 2)}`);
					else {
						await client.reconcile(signal);
						const result = await client.transport.request("workspace/symbol", { query: input.query ?? "" }, signal);
						if (Array.isArray(result)) rows.push(...symbolRows(root, result.slice(0, 200)));
					}
					responded = true;
				} catch (error) {
					signal.throwIfAborted();
					notes.push(`${server.name} — ${errorText(error)}`);
				}
			}
			if (!responded) throw new Error(notes.join("\n"));
			const unique = [...new Set(rows)];
			return [...(unique.length ? unique.slice(0, 200) : ["No symbols found."]), ...notes].join("\n");
		}
		if (workspace || !input.file) throw new Error(`Specify a file for ${input.action}.`);
		const file = await this.localFile(input.file);
		const server = servers.find((candidate) => matchesFile(candidate, file));
		if (!server) throw new Error(`No language server matches ${input.file}.`);
		if (input.action === "reload") {
			await this.clients.get(server.name)?.stop();
			this.clients.delete(server.name);
			return `Reloaded ${server.name}. It will start on the next request.`;
		}
		const client = await this.start(server, signal);
		await client.reconcile(signal, input.apply === true && (input.action === "rename" || input.action === "code_actions"));
		const document = await client.sync(file, signal);
		const uri = fileUri(file);
		const textDocument = { uri };
		if (input.action === "symbols") {
			const result = await client.transport.request("textDocument/documentSymbol", { textDocument }, signal);
			return Array.isArray(result) && result.length ? symbolRows(root, result, uri).slice(0, 200).join("\n") : "No document symbols found.";
		}
		const position = positionAt(document.text, input.line ?? 1, input.symbol);
		const params = { textDocument, position };
		if (input.action === "hover") {
			const result = await client.transport.request("textDocument/hover", params, signal);
			return hoverText(result?.contents) || "No hover information.";
		}
		if (input.action === "rename") {
			if (!input.new_name?.trim()) throw new Error("Specify new_name for the symbol rename.");
			const edit = await client.transport.request("textDocument/rename", { ...params, newName: input.new_name }, signal);
			return editResult(root, [{ edit, documents: client.documents }], input.apply, signal);
		}
		if (input.action === "code_actions") return codeActions(client, input, uri, position, signal);
		const result = await client.transport.request(navigation[input.action], input.action === "references" ? { ...params, context: { includeDeclaration: true } } : params, signal);
		const list = result == null ? [] : Array.isArray(result) ? result : [result];
		const label = input.action.replaceAll("_", " ");
		return list.length ? [`${label} — ${list.length} location(s)`, ...list.slice(0, 200).map((value) => location(root, value)),
			...(list.length > 200 ? [`${list.length - 200} more location(s) omitted.`] : [])].join("\n") : `No ${label} found.`;
	}
}

export function registerLsp(pi: ExtensionAPI) {
	let workspace: Workspace | undefined;
	let lifetime = new AbortController();
	let queue: Promise<unknown> = Promise.resolve();
	pi.on("session_start", () => { if (lifetime.signal.aborted) lifetime = new AbortController(); });
	pi.on("session_shutdown", async () => {
		lifetime.abort();
		await queue;
		await workspace?.stop();
		workspace = undefined;
	});
	async function getWorkspace(cwd: string) {
		const root = await realpath(cwd);
		if (workspace?.root !== root) {
			await workspace?.stop();
			workspace = new Workspace(root);
		}
		return workspace;
	}
	pi.on("tool_result", async (event, ctx) => {
		const { path } = event.input;
		if (event.isError || !ctx.isProjectTrusted() || typeof path !== "string" || !["write", "edit", "hashline_edit"].includes(event.toolName)) return;
		if (event.toolName === "hashline_edit" && record(event.details) && event.details.changed !== true) return;
		const signal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(2500), ...(ctx.signal ? [ctx.signal] : [])]);
		const pending = queue.then(async () => {
			signal.throwIfAborted();
			return (await getWorkspace(ctx.cwd)).afterWrite(path, signal);
		}).catch(() => undefined);
		queue = pending;
		const content = await pending;
		if (content) return { content: [...event.content, ...content] };
	});
	pi.registerTool({
		name: "lsp", label: "Language server", executionMode: "sequential",
		description: "Query workspace language servers for diagnostics, definitions, references, hover, symbols, and code actions. Rename, file rename, and code actions preview by default. Set apply=true to apply a validated edit. Configure servers in the agent directory or trusted workspace .pi/lsp.json.",
		promptSnippet: "Use language servers for diagnostics, navigation and workspace refactors",
		parameters,
		execute(_id, input, signal, _update, ctx) {
			const requestSignal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(Math.round((input.timeout ?? 20) * 1000)), ...(signal ? [signal] : [])]);
			const task = queue.then(async () => {
				requestSignal.throwIfAborted();
				if (!ctx.isProjectTrusted()) {
					if (input.action === "status") return toolResult("Language servers are disabled until this project is trusted.");
					throw new Error("Language servers require a trusted project.");
				}
				return toolResult(await (await getWorkspace(ctx.cwd)).run(input, requestSignal));
			});
			queue = task.catch(() => undefined);
			return task;
		},
	});
}
