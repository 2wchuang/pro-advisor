/**
 * Vendored test fixtures — reduced from rpiv-mono/packages/test-utils (MIT,
 * Copyright (c) 2026 juicesharp). Only the fixtures this package's tests use are
 * kept. The upstream package is `private: true` and unpublished, so a fork
 * cannot resolve it as a dependency.
 *
 * Do not extend this file beyond what the test suite actually imports; prefer
 * adding a local fixture in the test that needs it.
 */

import type { Api, Model } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
	ExtensionUIContext,
	RegisteredCommand,
	SessionEntry,
	ToolDefinition,
	ToolInfo,
} from "@earendil-works/pi-coding-agent";
import { vi } from "vitest";

export interface CapturedPi {
	tools: Map<string, ToolDefinition>;
	commands: Map<string, Omit<RegisteredCommand, "name" | "sourceInfo">>;
	flags: Map<string, unknown>;
	events: Map<string, Array<(...args: unknown[]) => unknown>>;
	activeTools: string[];
	allTools: ToolInfo[];
}

export interface MockPi {
	pi: ExtensionAPI;
	captured: CapturedPi;
}

export interface CreateMockPiOptions extends Partial<ExtensionAPI> {
	skills?: readonly string[];
}

export function createMockPi(options: CreateMockPiOptions = {}): MockPi {
	const captured: CapturedPi = {
		tools: new Map(),
		commands: new Map(),
		flags: new Map(),
		events: new Map(),
		activeTools: [],
		allTools: [],
	};

	const { skills, ...overrides } = options;
	const skillCommands: RegisteredCommand[] = (skills ?? []).map(
		(name) =>
			({
				name: `skill:${name}`,
				source: "skill",
				sourceInfo: { path: `/mock/skills/${name}/SKILL.md`, baseDir: `/mock/skills/${name}` },
			}) as unknown as RegisteredCommand,
	);

	const pi = {
		registerTool: vi.fn((tool: ToolDefinition) => {
			captured.tools.set(tool.name, tool);
			if (!captured.activeTools.includes(tool.name)) captured.activeTools.push(tool.name);
		}),
		registerCommand: vi.fn((name: string, cmd: Omit<RegisteredCommand, "name" | "sourceInfo">) => {
			captured.commands.set(name, cmd);
		}),
		registerShortcut: vi.fn(),
		registerFlag: vi.fn((name: string, value: unknown) => {
			captured.flags.set(name, value);
		}),
		getFlag: vi.fn((name: string) => captured.flags.get(name)),
		on: vi.fn((event: string, handler: (...args: unknown[]) => unknown) => {
			const list = captured.events.get(event) ?? [];
			list.push(handler);
			captured.events.set(event, list);
		}),
		sendMessage: vi.fn(async () => {}),
		sendUserMessage: vi.fn(),
		exec: vi.fn(async () => ({ stdout: "", stderr: "", code: 0, killed: false })),
		getActiveTools: vi.fn(() => [...captured.activeTools]),
		setActiveTools: vi.fn((names: string[]) => {
			captured.activeTools = [...names];
		}),
		getAllTools: vi.fn(() => [...captured.allTools]),
		getThinkingLevel: vi.fn(() => "medium" as unknown as string),
		events: {
			emit: vi.fn(),
			on: vi.fn(() => () => {}),
		},
		getCommands: vi.fn(() => skillCommands),
		...overrides,
	} as unknown as ExtensionAPI;

	return { pi, captured };
}

export interface MockUI {
	notify: ReturnType<typeof vi.fn>;
	confirm: ReturnType<typeof vi.fn>;
	input: ReturnType<typeof vi.fn>;
	select: ReturnType<typeof vi.fn>;
	setWidget: ReturnType<typeof vi.fn>;
	setStatus: ReturnType<typeof vi.fn>;
	setWorkingMessage: ReturnType<typeof vi.fn>;
	setHiddenThinkingLabel: ReturnType<typeof vi.fn>;
	onTerminalInput: ReturnType<typeof vi.fn>;
	pasteToEditor: ReturnType<typeof vi.fn>;
	setEditorComponent: ReturnType<typeof vi.fn>;
}

export function createMockUI(overrides: Partial<ExtensionUIContext> = {}): MockUI {
	return {
		notify: vi.fn(),
		confirm: vi.fn(async () => true),
		input: vi.fn(async () => ""),
		select: vi.fn(async () => undefined),
		setWidget: vi.fn(),
		setStatus: vi.fn(),
		setWorkingMessage: vi.fn(),
		setHiddenThinkingLabel: vi.fn(),
		onTerminalInput: vi.fn(() => () => {}),
		pasteToEditor: vi.fn(),
		setEditorComponent: vi.fn(),
		...overrides,
	} as unknown as MockUI;
}

export function createMockSessionManager(branch: SessionEntry[] = [], sessionId = "test-session") {
	return {
		getBranch: vi.fn(() => branch),
		getEntry: vi.fn((id: string) => branch.find((entry) => entry.id === id) ?? undefined),
		getEntries: vi.fn(() => branch),
		getLeafId: vi.fn(() => branch[branch.length - 1]?.id ?? null),
		getSessionFile: vi.fn(() => "/tmp/test-session.jsonl"),
		getSessionId: vi.fn(() => sessionId),
	};
}

export function createMockModelRegistry(models: Model<Api>[] = []) {
	return {
		find: vi.fn((provider: string, id: string) => models.find((m) => m.provider === provider && m.id === id)),
		getAvailable: vi.fn(() => [...models]),
		getApiKeyAndHeaders: vi.fn(async () => ({ ok: true, apiKey: "test-key", headers: {} })),
	};
}

export interface MockCtxOptions {
	hasUI?: boolean;
	mode?: string;
	cwd?: string;
	model?: Model<Api>;
	branch?: SessionEntry[];
	models?: Model<Api>[];
	ui?: Partial<ExtensionUIContext>;
	sessionId?: string;
	/** Read-only session manager override, e.g. a real SessionManager. */
	sessionManager?: unknown;
}

export function createMockCtx(opts: MockCtxOptions = {}): ExtensionContext {
	return {
		hasUI: opts.hasUI ?? false,
		mode: opts.mode,
		cwd: opts.cwd ?? "/tmp/test-cwd",
		model: opts.model,
		ui: createMockUI(opts.ui),
		sessionManager: opts.sessionManager ?? createMockSessionManager(opts.branch ?? [], opts.sessionId),
		modelRegistry: createMockModelRegistry(opts.models ?? []),
		isIdle: vi.fn(() => true),
	} as unknown as ExtensionContext;
}

// ---------------------------------------------------------------------------
// Message + session-entry fixtures — kept signature-identical to upstream.
// ---------------------------------------------------------------------------

import type { AssistantMessage, Message, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";

export function makeUserMessage(text: string): UserMessage {
	return {
		role: "user",
		content: [{ type: "text", text }],
		timestamp: Date.now(),
	};
}

export interface AssistantMessageInput {
	text?: string;
	toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
}

export function makeAssistantMessage(input: AssistantMessageInput): AssistantMessage {
	const content: AssistantMessage["content"] = [];
	if (input.text) content.push({ type: "text", text: input.text });
	for (const tc of input.toolCalls ?? []) {
		content.push({ type: "toolCall", id: tc.id, name: tc.name, arguments: tc.arguments });
	}
	return { role: "assistant", content, timestamp: Date.now() } as unknown as AssistantMessage;
}

export interface ToolResultInput {
	toolCallId?: string;
	toolName: string;
	text?: string;
	details?: unknown;
	isError?: boolean;
}

export function makeToolResult(input: ToolResultInput): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: input.toolCallId ?? `call-${input.toolName}-${Date.now()}`,
		toolName: input.toolName,
		content: input.text ? [{ type: "text", text: input.text }] : [],
		details: input.details,
		isError: input.isError ?? false,
		timestamp: Date.now(),
	} as unknown as ToolResultMessage;
}

let entryIdCounter = 0;

/** Reset the session-entry id counter. Called from test/setup.ts between tests. */
export function __resetFixtureIds(): void {
	entryIdCounter = 0;
}

/**
 * Wrap a message as a session entry. Real entries always carry id/parentId, and
 * the mirror's watermark tracking is keyed on `id`, so the fixture must supply
 * one or incremental delivery cannot be exercised at all.
 */
export function makeMessageEntry(message: Message, parentId: string | null = null): SessionEntry {
	entryIdCounter += 1;
	return {
		type: "message",
		id: `entry-${entryIdCounter}`,
		parentId,
		timestamp: new Date().toISOString(),
		message,
	} as unknown as SessionEntry;
}

/** Build a linear branch of message entries with proper parent links. */
export function buildSessionEntries(messages: Message[]): SessionEntry[] {
	const out: SessionEntry[] = [];
	let parentId: string | null = null;
	for (const message of messages) {
		const entry = makeMessageEntry(message, parentId);
		out.push(entry);
		parentId = entry.id;
	}
	return out;
}

export function buildLlmMessages(messages: Message[]): Message[] {
	return messages.filter((m) => m.role === "user" || m.role === "assistant" || m.role === "toolResult");
}

export function makeTodoToolResult(details: unknown, text = "ok"): ToolResultMessage {
	return makeToolResult({ toolName: "todo", text, details });
}

export function makeInflightAdvisorAssistant(): AssistantMessage {
	return makeAssistantMessage({
		toolCalls: [{ id: "advisor-inflight", name: "advisor", arguments: {} }],
	});
}

// ---------------------------------------------------------------------------
// Ship-manifest verification — vendored from rpiv-mono/packages/test-utils
// (MIT). Proves a published tarball actually contains every production .ts
// module the package imports at runtime.
// ---------------------------------------------------------------------------

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Upstream (rpiv-mono) keeps `test/`, `test-utils/` and `vitest.config.ts` outside
// the package directory, so its walk never meets them. This fork is a standalone
// repo, so they sit alongside production sources and are skipped explicitly. The
// `files` array still excludes them from the published tarball.
const SHIP_SKIP_DIRS = new Set(["node_modules", "docs", "test", "test-utils"]);
const SHIP_SKIP_FILES = new Set(["test-fixtures.ts", "vitest.config.ts"]);

export interface ShipManifestResult {
	declared: readonly string[];
	onDisk: readonly string[];
	missing: readonly string[];
	stale: readonly string[];
}

export function verifyShipManifest(packageDirOrUrl: string): ShipManifestResult {
	const packageDir = packageDirOrUrl.startsWith("file:") ? dirname(fileURLToPath(packageDirOrUrl)) : packageDirOrUrl;
	const pkg = JSON.parse(readFileSync(resolve(packageDir, "package.json"), "utf8")) as { files?: string[] };
	const declared = pkg.files ?? [];
	const exactFiles = new Set<string>();
	const dirPrefixes: string[] = [];
	for (const entry of declared) {
		if (entry.startsWith("!")) continue;
		if (entry.endsWith("/")) dirPrefixes.push(entry);
		else if (shipIsDirOnDisk(packageDir, entry)) dirPrefixes.push(`${entry}/`);
		else exactFiles.add(entry);
	}

	const onDisk = shipWalkProductionTs(packageDir, packageDir);
	const missing = onDisk.filter((f) => {
		if (exactFiles.has(f)) return false;
		return !dirPrefixes.some((prefix) => f.startsWith(prefix));
	});
	const stale = declared.filter((entry) => !entry.startsWith("!") && !existsSync(resolve(packageDir, entry)));

	return { declared, onDisk, missing, stale };
}

function shipIsDirOnDisk(packageDir: string, entry: string): boolean {
	try {
		return statSync(resolve(packageDir, entry)).isDirectory();
	} catch {
		return false;
	}
}

function shipWalkProductionTs(root: string, dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.name.startsWith(".")) continue;
		if (entry.isDirectory() && SHIP_SKIP_DIRS.has(entry.name)) continue;
		const abs = resolve(dir, entry.name);
		if (entry.isDirectory()) {
			out.push(...shipWalkProductionTs(root, abs));
			continue;
		}
		if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
		if (entry.name.endsWith(".test.ts") || SHIP_SKIP_FILES.has(entry.name)) continue;
		out.push(relative(root, abs));
	}
	return out;
}
