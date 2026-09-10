/**
 * execute — one advisor consultation, end to end.
 *
 * The advisor is a PERSISTENT Pi session (see session-pool.ts), not a stateless
 * side-call. This module owns the sequence:
 *
 *   resolve model → get-or-create the executor's advisor session → plan the
 *   incremental transcript delivery → ask the advisor (serialized per session)
 *   → commit the watermark → build the tool-result envelope
 *
 * The mirror watermark is committed ONLY after a turn produces usable text, so a
 * failed or aborted consultation leaves it untouched and the next call
 * re-delivers the same entries. Duplicating context is the safe failure: skipping
 * it would silently hide executor work from the reviewer.
 *
 * Every result branch funnels through buildAdvisorResult so the envelope is
 * constructed in exactly one place.
 */

import type { Api, Model, StopReason, ThinkingLevel, Usage } from "@earendil-works/pi-ai";
import type {
	AgentToolResult,
	AgentToolUpdateCallback,
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { GradedEffort } from "./messages.js";
import { getInventoryMessage } from "./inventory.js";
import {
	ERR_ABORTED_DETAIL,
	ERR_CALL_ABORTED,
	ERR_EMPTY_RESPONSE,
	ERR_EMPTY_RESPONSE_DETAIL,
	ERR_NO_MODEL,
	ERR_NO_MODEL_SELECTED,
	ERR_SESSION_CREATE,
	MSG_EMPTY_RETRY,
	errCallFailed,
	errCallThrew,
	errMisconfigured,
	errNoApiKey,
	errNoApiKeyDetail,
	msgConsulting,
} from "./messages.js";
import {
	buildRebaseContext,
	buildStartingContext,
	buildTranscriptUpdate,
	planMirror,
	renderEntries,
	type MirrorSource,
} from "./mirror.js";
import type { AdvisorReply, AdvisorSessionDriver, AdvisorSessionPool } from "./session-pool.js";
import { getAdvisorEffort, getAdvisorModel } from "./state.js";

interface AdvisorDetails {
	advisorModel?: string;
	effort?: ThinkingLevel;
	usage?: Usage;
	stopReason?: StopReason;
	errorMessage?: string;
	/** Stable across every consultation in one executor session. */
	advisorSessionId?: string;
	/** Advisor turns completed, including this one. */
	turn?: number;
	/** Whether this call delivered full context or only new activity. */
	delivery?: "initial" | "incremental" | "rebase";
}

// Single result-envelope builder — every branch and pre-call error path funnels
// through here. `effort` is snapshotted at entry and threaded through every call
// so details.effort always matches the level actually configured, even if
// module-level state is mutated during the await window.
function buildAdvisorResult(opts: {
	text: string;
	effort: ThinkingLevel | undefined;
	advisorLabel?: string;
	advisorSessionId?: string;
	turn?: number;
	delivery?: AdvisorDetails["delivery"];
	usage?: Usage;
	stopReason?: StopReason;
	errorMessage?: string;
}): AgentToolResult<AdvisorDetails> {
	const details: AdvisorDetails = { effort: opts.effort };
	if (opts.advisorLabel !== undefined) details.advisorModel = opts.advisorLabel;
	if (opts.advisorSessionId !== undefined) details.advisorSessionId = opts.advisorSessionId;
	if (opts.turn !== undefined) details.turn = opts.turn;
	if (opts.delivery !== undefined) details.delivery = opts.delivery;
	if (opts.usage !== undefined) details.usage = opts.usage;
	if (opts.stopReason !== undefined) details.stopReason = opts.stopReason;
	if (opts.errorMessage !== undefined) details.errorMessage = opts.errorMessage;
	return { content: [{ type: "text", text: opts.text }], details };
}

function buildErrorResult(
	advisorLabel: string | undefined,
	effort: ThinkingLevel | undefined,
	userText: string,
	errorMessage: string,
): AgentToolResult<AdvisorDetails> {
	return buildAdvisorResult({ text: userText, effort, advisorLabel, errorMessage });
}

/**
 * Build the prompt text for a consultation from its mirror plan.
 *
 * A rebase for an EXISTING advisor session keeps the advisor's own prior turn
 * history — only the mirrored executor transcript is reset — so the rebase text
 * marks itself as superseding earlier transcript content rather than pretending
 * the advisor has never seen this task.
 */
function buildPrompt(
	driver: AdvisorSessionDriver,
	plan: ReturnType<typeof planMirror>,
	sessionManager: MirrorSource,
	inventoryText: string | undefined,
): { text: string; delivery: AdvisorDetails["delivery"] } {
	const transcript = renderEntries(sessionManager, plan.renderIds);
	if (!plan.full) {
		return { text: buildTranscriptUpdate(transcript), delivery: "incremental" };
	}
	// "First ever delivery" is decided by the ADVISOR SESSION's own history, not
	// by the in-memory watermark: after /resume the watermark is recovered from
	// the session, and a session that already has turns must not be re-greeted
	// with a starting context that claims to be complete-as-of-now.
	if (driver.turns === 0) {
		return { text: buildStartingContext(inventoryText, transcript), delivery: "initial" };
	}
	return { text: buildRebaseContext(transcript, plan.compacted ? "compaction" : "divergence"), delivery: "rebase" };
}

export interface ExecuteDeps {
	pool: AdvisorSessionPool;
	agentDir?: string;
}

export async function executeAdvisor(
	ctx: ExtensionContext,
	pi: ExtensionAPI,
	signal: AbortSignal | undefined,
	onUpdate: AgentToolUpdateCallback<AdvisorDetails> | undefined,
	deps: ExecuteDeps,
): Promise<AgentToolResult<AdvisorDetails>> {
	// Snapshot once at entry — every envelope and the session configuration use
	// this same value, so a concurrent setAdvisorEffort() during the await window
	// cannot desync details.effort from what the advisor session actually used.
	const effort = getAdvisorEffort();
	const advisor: Model<Api> | undefined = getAdvisorModel();
	if (!advisor) {
		return buildErrorResult(undefined, effort, ERR_NO_MODEL, ERR_NO_MODEL_SELECTED);
	}
	const advisorLabel = `${advisor.provider}:${advisor.id}`;

	// Explicit credential preflight, kept from the stateless implementation so the
	// existing user-facing auth errors still fire before any session work.
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(advisor);
	if (!auth.ok) {
		return buildErrorResult(advisorLabel, effort, errMisconfigured(advisorLabel, auth.error), auth.error);
	}

	const executorSessionId = ctx.sessionManager.getSessionId();
	let driver: AdvisorSessionDriver;
	try {
		driver = await deps.pool.getOrCreate(executorSessionId, () =>
			createDriver(ctx, advisor, effort, deps),
		);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return buildErrorResult(advisorLabel, effort, ERR_SESSION_CREATE(message), message);
	}

	onUpdate?.({
		content: [{ type: "text", text: msgConsulting(advisorLabel, effort) }],
		details: { advisorModel: advisorLabel, effort, advisorSessionId: driver.sessionId },
	});

	// Re-read the selection inside the driver's own queue: another consultation may
	// have changed the reviewer while this call waited.
	return askWithDriver(ctx, pi, driver, signal);
}

async function askWithDriver(
	ctx: ExtensionContext,
	pi: ExtensionAPI,
	driver: AdvisorSessionDriver,
	signal: AbortSignal | undefined,
): Promise<AgentToolResult<AdvisorDetails>> {
	const effort = getAdvisorEffort();
	const advisor = getAdvisorModel();
	if (!advisor) {
		return buildErrorResult(undefined, effort, ERR_NO_MODEL, ERR_NO_MODEL_SELECTED);
	}
	const advisorLabel = `${advisor.provider}:${advisor.id}`;

	// Apply a reviewer model/effort change onto the SAME session so the advisor
	// conversation identity survives a switch.
	try {
		const current = driver.currentModel();
		if (!current || current.provider !== advisor.provider || current.id !== advisor.id) {
			await driver.setModel(advisor);
		}
		driver.setEffort(effort);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return buildErrorResult(advisorLabel, effort, errCallThrew(message), message);
	}

	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(advisor);
	if (!auth.ok) {
		return buildErrorResult(advisorLabel, effort, errMisconfigured(advisorLabel, auth.error), auth.error);
	}
	if (!auth.apiKey) {
		// OAuth-backed providers resolve ok with no literal key; the advisor
		// session resolves those through the runtime itself, so only a genuinely
		// unauthenticated provider is fatal here.
		const configured = ctx.modelRegistry.hasConfiguredAuth?.(advisor) ?? false;
		if (!configured) {
			return buildErrorResult(
				advisorLabel,
				effort,
				errNoApiKey(advisorLabel),
				errNoApiKeyDetail(advisor.provider),
			);
		}
	}

	const mirrorState = driver.loadMirrorState();
	const plan = planMirror(ctx.sessionManager, mirrorState.watermarkId);
	const inventoryMessage = getInventoryMessage(pi.getAllTools());
	const inventoryText = inventoryMessage ? inventoryTextOf(inventoryMessage) : undefined;
	const { text, delivery } = buildPrompt(driver, plan, ctx.sessionManager, inventoryText);

	let reply: AdvisorReply;
	try {
		reply = await driver.ask(text, signal);
	} catch (err) {
		// A driver that throws (transport failure, disposed session) must still
		// produce a tool result: the executor reads the text and keeps going
		// rather than crashing the turn.
		const message = err instanceof Error ? err.message : String(err);
		return buildErrorResult(advisorLabel, effort, errCallThrew(message), message);
	}

	// A transient empty reply (normal stop, no text) gets exactly ONE corrective
	// retry — never a loop — with a short prompt in the SAME advisor session.
	if (!hasUsableText(reply) && !isTerminal(reply.stopReason)) {
		try {
			reply = await driver.ask(MSG_EMPTY_RETRY, signal);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			return buildErrorResult(advisorLabel, effort, errCallThrew(message), message);
		}
	}

	const envelopeBase = {
		effort,
		advisorLabel,
		advisorSessionId: driver.sessionId,
		turn: driver.turns + 1,
		delivery,
	};

	if (reply.stopReason === "aborted") {
		// Do NOT commit the watermark: the next call must re-deliver these entries.
		return buildAdvisorResult({
			text: reply.text.length > 0 ? reply.text : ERR_CALL_ABORTED,
			...envelopeBase,
			usage: reply.usage as Usage | undefined,
			stopReason: "aborted",
			errorMessage: reply.errorMessage ?? ERR_ABORTED_DETAIL,
		});
	}

	if (reply.stopReason === "error") {
		return buildAdvisorResult({
			text: errCallFailed(reply.errorMessage),
			...envelopeBase,
			usage: reply.usage as Usage | undefined,
			stopReason: "error",
			errorMessage: reply.errorMessage ?? ERR_ABORTED_DETAIL,
		});
	}

	if (reply.errorMessage && !hasUsableText(reply)) {
		return buildErrorResult(advisorLabel, effort, errCallFailed(reply.errorMessage), reply.errorMessage);
	}

	if (!hasUsableText(reply)) {
		return buildErrorResult(advisorLabel, effort, ERR_EMPTY_RESPONSE, ERR_EMPTY_RESPONSE_DETAIL);
	}

	// Success: commit the watermark and persist it into the advisor session so an
	// executor /resume continues incrementally.
	try {
		driver.saveMirrorState({ watermarkId: plan.coveredIds[plan.coveredIds.length - 1], deliveredIds: plan.coveredIds });
	} catch {
		// Bookkeeping only — a persistence failure must not fail the consultation.
	}

	return buildAdvisorResult({
		text: reply.text,
		...envelopeBase,
		turn: driver.turns,
		usage: reply.usage as Usage | undefined,
		stopReason: "stop",
	});
}

/** Terminal stop reasons that must not trigger the empty-response retry. */
function isTerminal(stopReason: string | undefined): boolean {
	return stopReason === "aborted" || stopReason === "error";
}

/**
 * Whether a reply carries anything the executor can act on. Whitespace-only
 * text counts as empty — the upstream extraction trimmed, and a blank reply is
 * exactly the transient case the retry exists for.
 */
function hasUsableText(reply: AdvisorReply): boolean {
	return reply.text.trim().length > 0;
}

/** Extract the plain text of the inventory Message (a single text block). */
function inventoryTextOf(message: { content?: unknown }): string | undefined {
	const content = message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return undefined;
	const parts: string[] = [];
	for (const block of content) {
		if (typeof block === "string") {
			parts.push(block);
			continue;
		}
		if (
			typeof block === "object" &&
			block !== null &&
			(block as { type?: string }).type === "text" &&
			typeof (block as { text?: unknown }).text === "string"
		) {
			parts.push((block as { text: string }).text);
		}
	}
	return parts.length > 0 ? parts.join("\n") : undefined;
}

/**
 * Create the concrete driver for an executor session.
 *
 * Imported dynamically so this module's static graph stays free of the heavy
 * Pi SDK session construction path — tests inject a driver and never load it.
 */
async function createDriver(
	ctx: ExtensionContext,
	model: Model<Api>,
	effort: GradedEffort | undefined,
	deps: ExecuteDeps,
): Promise<AdvisorSessionDriver> {
	const { createAdvisorDriver } = await import("./session-pool.js");
	return createAdvisorDriver({
		executorSessionId: ctx.sessionManager.getSessionId(),
		executorCwd: ctx.cwd,
		model,
		effort,
		...(deps.agentDir ? { agentDir: deps.agentDir } : {}),
		// Pass the host registry's runtime through: it resolves credential-derived
		// request fields (e.g. an OAuth baseUrl) for runtime-registered providers.
		modelRuntime: hostRuntimeOf(ctx),
	});
}

/**
 * Reach the host `ModelRuntime` behind the registry's private slot.
 *
 * Pi keeps it non-public, so the read is structural and may legitimately come
 * back undefined on hosts whose shape differs — the advisor session then falls
 * back to its own default runtime.
 */
function hostRuntimeOf(ctx: ExtensionContext): unknown {
	try {
		const carrier = ctx.modelRegistry as unknown as { runtime?: unknown };
		return carrier.runtime;
	} catch {
		return undefined;
	}
}

export type { AdvisorDetails };
export { buildAdvisorResult, buildErrorResult };
