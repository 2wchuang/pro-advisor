/**
 * session-pool — one persistent advisor session per executor session.
 *
 * A stateless advisor side-call replays the executor's entire branch on every
 * consultation. This pool replaces that with a real Pi `AgentSession` that keeps
 * its OWN history: the first consultation delivers the executor's branch as the
 * advisor's starting context, and later ones append only what changed.
 *
 * What this deliberately does NOT claim: provider-side prompt caching, or a
 * guaranteed token saving. The advisor's own history still grows, so a
 * long-running advisor session eventually costs more per turn than a stateless
 * one. What it buys is continuity — and a stable, append-only prefix.
 *
 * ## Stability
 *
 * The advisor session file path is derived deterministically from the executor
 * session id, so `/resume` reopens the SAME session (same `sessionId`, same
 * history, same mirror watermark) rather than starting over.
 *
 * ## Isolation
 *
 * The advisor must never inherit the executor's extensions, skills, prompt
 * templates, themes, context files, or tools. Loading extensions recursively
 * would re-register this very extension inside the advisor and hand the reviewer
 * tools it is forbidden to call.
 */

import type { Api, Model } from "@earendil-works/pi-ai";
import {
	DefaultResourceLoader,
	SessionManager,
	SettingsManager,
	createAgentSession,
	getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import type { GradedEffort } from "./messages.js";
import { ADVISOR_SYSTEM_PROMPT } from "./prompt.js";

/** Directory under the agent dir holding advisor session files. */
const ADVISOR_SESSION_SUBDIR = "pro-advisor";
/**
 * Custom-entry type carrying mirror bookkeeping inside the advisor session file.
 * Custom entries never enter LLM context, so the watermark rides the session's
 * own persistence and survives /resume with no side-channel file.
 */
export const MIRROR_STATE_CUSTOM_TYPE = "pro-advisor-mirror-state";

export interface MirrorState {
	/**
	 * Newest executor entry already delivered to the advisor.
	 *
	 * This is the whole state. `planMirror()` derives divergence from this id
	 * alone: if it is absent, or no longer present on the current branch, the
	 * next delivery rebases. An earlier revision also persisted the full list of
	 * delivered ids "for divergence detection", but nothing ever read it — it was
	 * rewritten in full on every single call, so its custom entry grew with the
	 * square of the session length. Measured live: 9,381 bytes at 836 ids,
	 * 9,469 bytes at 844 ids, every turn. Removed rather than kept for a use
	 * that does not exist.
	 */
	watermarkId?: string;
}

/**
 * The seam between `execute.ts` and a concrete advisor session.
 *
 * Tests drive this interface directly: it carries exactly the surface the
 * advisor call needs, so envelope behaviour (success, abort, provider error,
 * empty response, thrown error) is testable without credentials or a network.
 */
export interface AdvisorSessionDriver {
	/** Stable across every consultation in one executor session. */
	readonly sessionId: string;
	/** Advisor turns completed so far. */
	readonly turns: number;
	/** Deliver one prompt and collect the advisor's reply. */
	ask(text: string, signal: AbortSignal | undefined): Promise<AdvisorReply>;
	/** Swap the reviewer model without replacing the session identity. */
	setModel(model: Model<Api>): Promise<void>;
	/** Change reasoning effort without replacing the session identity. */
	setEffort(effort: GradedEffort | undefined): void;
	/** The model the underlying session is currently configured with. */
	currentModel(): Model<Api> | undefined;
	/** Whether the advisor session exposes any tool it could call. */
	activeToolNames(): string[];
	/** Recover mirror bookkeeping persisted in the advisor session. */
	loadMirrorState(): MirrorState;
	/** Persist mirror bookkeeping into the advisor session. */
	saveMirrorState(state: MirrorState): void;
	/** Release the session. */
	dispose(): void;
}

export interface AdvisorReply {
	text: string;
	stopReason?: string;
	errorMessage?: string;
	usage?: unknown;
}

/** Session ids must match Pi's `assertValidSessionId` charset. */
export function advisorSessionId(executorSessionId: string): string {
	const safe = executorSessionId.replace(/[^A-Za-z0-9._-]/g, "-");
	return `advisor-${safe}`;
}

/** Deterministic session file path for an executor session. */
export function advisorSessionPath(agentDir: string, executorSessionId: string): string {
	return join(agentDir, ADVISOR_SESSION_SUBDIR, `${advisorSessionId(executorSessionId)}.jsonl`);
}

/**
 * Concatenate the assistant text of one message, ignoring thinking/toolCall
 * parts. Pure, so the empty-response retry shares one extraction path.
 */
function textOfMessage(message: { content: unknown }): string {
	const content = message.content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((c): c is { type: "text"; text: string } => {
			return (
				typeof c === "object" && c !== null && (c as { type?: string }).type === "text" &&
				typeof (c as { text?: unknown }).text === "string"
			);
		})
		.map((c) => c.text)
		.join("\n")
		.trim();
}

/** Concrete driver over a real Pi `AgentSession`. */
class PiAdvisorSessionDriver implements AdvisorSessionDriver {
	private readonly session: Awaited<ReturnType<typeof createAgentSession>>["session"];
	private readonly sessionManager: SessionManager;
	private completedTurns: number;
	private queue: Promise<unknown> = Promise.resolve();

	constructor(
		session: Awaited<ReturnType<typeof createAgentSession>>["session"],
		sessionManager: SessionManager,
	) {
		this.session = session;
		this.sessionManager = sessionManager;
		this.completedTurns = countAssistantTurns(sessionManager);

		// Auto-compaction must never run on an advisor session.
		//
		// Pi's compaction summarizer is written for the executor: its template asks
		// for "## Goal", "## Constraints & Preferences", "## Progress", "## Next
		// Steps". Applied to an advisor session — whose transcript is a *mirror of
		// the executor's* work — it produces a summary that describes the EXECUTOR's
		// task as the advisor's own. Observed live: after compaction the advisor
		// replied "I need your guidance on where we stand" and enumerated the
		// executor's publishing milestones as its own achievements, inverting the
		// roles the system prompt establishes. The upstream stateless design could
		// not hit this because it had no session to compact.
		//
		// Refusing to compact keeps the advisor's identity and its own prior replies
		// intact. The cost is that a very long-lived advisor session keeps growing;
		// that is the trade this fork already documents, and it is preferable to
		// silent role inversion.
		try {
			this.session.setAutoCompactionEnabled(false);
		} catch {
			// Older Pi versions may not expose the toggle. Losing it degrades to the
			// previous behaviour rather than failing the consultation.
		}
	}

	get sessionId(): string {
		return this.session.sessionId;
	}

	get turns(): number {
		return this.completedTurns;
	}

	/**
	 * Deliver one prompt, serialized behind any in-flight turn.
	 *
	 * Serialization is required, not optional: two concurrent advisor() calls in
	 * one executor session would otherwise interleave prompts on the same
	 * streaming session.
	 */
	async ask(text: string, signal: AbortSignal | undefined): Promise<AdvisorReply> {
		const run = this.queue.then(
			() => this.runTurn(text, signal),
			() => this.runTurn(text, signal),
		);
		// Keep the chain alive across rejections without surfacing them twice.
		this.queue = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	private async runTurn(text: string, signal: AbortSignal | undefined): Promise<AdvisorReply> {
		await this.session.waitForIdle();

		const replies: AdvisorReply[] = [];
		const unsubscribe = this.session.subscribe((event) => {
			if (event.type !== "message_end") return;
			const message = event.message;
			if (message.role !== "assistant") return;
			const assistant = message as {
				content: unknown;
				stopReason?: string;
				errorMessage?: string;
				usage?: unknown;
			};
			replies.push({
				text: textOfMessage(assistant),
				stopReason: assistant.stopReason,
				errorMessage: assistant.errorMessage,
				usage: assistant.usage,
			});
		});

		const onAbort = (): void => {
			void this.session.abort();
		};
		signal?.addEventListener("abort", onAbort, { once: true });

		try {
			await this.session.prompt(text, { expandPromptTemplates: false });
			await this.session.waitForIdle();

			const last = replies[replies.length - 1];
			if (!last) {
				return { text: "", stopReason: signal?.aborted ? "aborted" : undefined };
			}
			if (last.stopReason === "stop" || last.stopReason === "done") {
				this.completedTurns += 1;
			}
			return last;
		} catch (err) {
			return {
				text: "",
				stopReason: signal?.aborted ? "aborted" : "error",
				errorMessage: err instanceof Error ? err.message : String(err),
			};
		} finally {
			signal?.removeEventListener("abort", onAbort);
			unsubscribe();
		}
	}

	async setModel(model: Model<Api>): Promise<void> {
		await this.session.setModel(model);
	}

	setEffort(effort: GradedEffort | undefined): void {
		if (effort === undefined) return;
		if (this.session.thinkingLevel === effort) return;
		this.session.setThinkingLevel(effort);
	}

	currentModel(): Model<Api> | undefined {
		return this.session.model;
	}

	activeToolNames(): string[] {
		return this.session.getActiveToolNames();
	}

	loadMirrorState(): MirrorState {
		let state: MirrorState = {};
		for (const entry of this.sessionManager.getEntries()) {
			if (entry.type !== "custom") continue;
			if ((entry as { customType?: string }).customType !== MIRROR_STATE_CUSTOM_TYPE) continue;
			const data = (entry as { data?: MirrorState }).data;
			if (!data) continue;
			// Only watermarkId is read. Older session files may carry a
			// `deliveredIds` array from a prior revision; it is ignored rather than
			// migrated, because it was never consumed.
			if (typeof data.watermarkId === "string") state = { watermarkId: data.watermarkId };
		}
		return state;
	}

	saveMirrorState(state: MirrorState): void {
		this.sessionManager.appendCustomEntry(MIRROR_STATE_CUSTOM_TYPE, state);
	}

	dispose(): void {
		this.session.dispose();
	}
}

/** Count completed advisor turns already in a session file (for /resume). */
function countAssistantTurns(sessionManager: SessionManager): number {
	let count = 0;
	for (const entry of sessionManager.getEntries()) {
		if (entry.type !== "message") continue;
		const message = (entry as { message?: { role?: string; stopReason?: string } }).message;
		if (message?.role !== "assistant") continue;
		if (message.stopReason === "stop" || message.stopReason === "done") count += 1;
	}
	return count;
}

export interface CreateAdvisorDriverOptions {
	executorSessionId: string;
	executorCwd: string;
	model: Model<Api>;
	effort: GradedEffort | undefined;
	agentDir?: string;
	/**
	 * Host `ModelRuntime`-compatible object. Passed through so credential-derived
	 * request fields (e.g. an OAuth baseUrl from a runtime-registered provider)
	 * resolve the same way the executor session resolves them. Omitted in tests.
	 */
	modelRuntime?: unknown;
}

/**
 * Open (or create) the persistent advisor session for an executor session.
 *
 * `SessionManager.open` on a deterministic path is what makes /resume reuse the
 * same advisor session; `SessionManager.create` with a fixed id would mint a
 * NEW timestamped file on every open, leaving stale files behind and losing the
 * pre-resume history.
 */
export async function createAdvisorDriver(options: CreateAdvisorDriverOptions): Promise<AdvisorSessionDriver> {
	const agentDir = options.agentDir ?? getAgentDir();
	const settingsManager = SettingsManager.inMemory({});

	const resourceLoader = new DefaultResourceLoader({
		cwd: options.executorCwd,
		agentDir,
		settingsManager,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		systemPrompt: ADVISOR_SYSTEM_PROMPT,
	});
	await resourceLoader.reload();

	const sessionDir = join(agentDir, ADVISOR_SESSION_SUBDIR);
	const sessionPath = advisorSessionPath(agentDir, options.executorSessionId);
	const sessionManager = SessionManager.open(sessionPath, sessionDir, options.executorCwd);

	const { session } = await createAgentSession({
		cwd: options.executorCwd,
		agentDir,
		model: options.model,
		thinkingLevel: options.effort,
		...(options.modelRuntime ? { modelRuntime: options.modelRuntime as never } : {}),
		resourceLoader,
		settingsManager,
		sessionManager,
		// The advisor never calls tools. Suppressing the registry at construction
		// time also keeps tool-schema text out of its system prompt.
		noTools: "all",
	});

	return new PiAdvisorSessionDriver(session, sessionManager);
}

/**
 * The advisor driver pool, keyed by executor session id.
 *
 * A `/new` or `/fork` mints a new executor session id and therefore a new
 * advisor session; a `/resume` keeps the id and reopens the existing one. This
 * is why the key is the session id and not the session file path.
 */
export class AdvisorSessionPool {
	private readonly drivers = new Map<string, AdvisorSessionDriver>();
	private readonly pending = new Map<string, Promise<AdvisorSessionDriver>>();

	has(executorSessionId: string): boolean {
		return this.drivers.has(executorSessionId);
	}

	get(executorSessionId: string): AdvisorSessionDriver | undefined {
		return this.drivers.get(executorSessionId);
	}

	/**
	 * Get or create the driver for an executor session. Concurrent callers for
	 * the same id share one creation, so two parallel advisor() calls cannot each
	 * open the same session file.
	 */
	async getOrCreate(
		executorSessionId: string,
		create: () => Promise<AdvisorSessionDriver>,
	): Promise<AdvisorSessionDriver> {
		const existing = this.drivers.get(executorSessionId);
		if (existing) return existing;

		const inFlight = this.pending.get(executorSessionId);
		if (inFlight) return inFlight;

		const creation = create().then(
			(driver) => {
				this.pending.delete(executorSessionId);
				this.drivers.set(executorSessionId, driver);
				return driver;
			},
			(err: unknown) => {
				this.pending.delete(executorSessionId);
				throw err;
			},
		);
		this.pending.set(executorSessionId, creation);
		return creation;
	}

	/** Dispose one executor session's advisor session. */
	disposeEntry(executorSessionId: string): void {
		const driver = this.drivers.get(executorSessionId);
		if (!driver) return;
		driver.dispose();
		this.drivers.delete(executorSessionId);
	}

	disposeAll(): void {
		for (const id of [...this.drivers.keys()]) this.disposeEntry(id);
	}

	size(): number {
		return this.drivers.size;
	}

	ids(): string[] {
		return [...this.drivers.keys()];
	}
}
