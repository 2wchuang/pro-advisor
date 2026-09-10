/**
 * mirror — the incremental executor-transcript mirror.
 *
 * The advisor session owns its own history. The first consultation for an
 * executor session delivers the executor's resolved context as the advisor's
 * STARTING context; every later consultation appends ONLY the entries the
 * executor produced since the previous one.
 *
 * Two events invalidate an incremental delivery, because the entry graph no
 * longer extends what was mirrored:
 *
 *   - compaction — the resolved context jumped (older entries collapsed into a
 *     summary), so the tail we would send no longer follows what the advisor read
 *   - divergence — the executor branched/forked away, so the watermark is not on
 *     the current leaf path at all
 *
 * Both trigger an explicit rebase: the transcript is re-stated in full and marked
 * as superseding earlier content. The advisor SESSION is retained — only the
 * mirrored transcript is reset — so the advisor keeps its own prior reasoning.
 */

import { type SessionEntry, sessionEntryToContextMessages } from "@earendil-works/pi-coding-agent";
import { EXECUTOR_MIRROR_MARKER } from "./messages.js";

/** Per-tool-result character cap so one huge read cannot flood the advisor. */
const MAX_TOOL_RESULT_CHARS = 8_000;
/** Per-message character cap for a single rendered entry. */
const MAX_ENTRY_CHARS = 12_000;

/**
 * Minimal structural view of a resolved LLM message. The mirror only reads
 * `role`, `content`, and `toolName`, so it does not need the full AgentMessage
 * union (which lives in pi-agent-core, not pi-ai).
 */
interface MirrorMessage {
	role?: string;
	content?: unknown;
	toolName?: string;
}

/**
 * Minimal structural view of the executor session the mirror needs. Matches both
 * `SessionManager` and the extension context's read-only session manager, so
 * callers never need a cast.
 */
export interface MirrorSource {
	getBranch(fromId?: string): SessionEntry[];
	getEntry(id: string): SessionEntry | undefined;
}

function clip(text: string, limit: number): string {
	if (text.length <= limit) return text;
	return `${text.slice(0, limit)}\n…[truncated ${text.length - limit} chars]`;
}

function textOfContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (
			typeof block === "object" &&
			block !== null &&
			(block as { type?: string }).type === "text" &&
			typeof (block as { text?: unknown }).text === "string"
		) {
			parts.push((block as { text: string }).text);
		}
	}
	return parts.join("\n");
}

function renderLlmMessage(message: MirrorMessage): string | undefined {
	const role = message.role;
	if (role === "user") {
		const text = textOfContent((message as { content?: unknown }).content).trim();
		return text ? `[User]: ${clip(text, MAX_ENTRY_CHARS)}` : undefined;
	}
	if (role === "assistant") {
		const content = (message as { content?: unknown }).content;
		if (!Array.isArray(content)) return undefined;
		const parts: string[] = [];
		const thinking: string[] = [];
		const toolCalls: string[] = [];
		let hasText = false;
		for (const block of content) {
			if (typeof block !== "object" || block === null) continue;
			const typed = block as { type?: string; thinking?: string; name?: string; arguments?: unknown };
			if (typed.type === "thinking" && typeof typed.thinking === "string") thinking.push(typed.thinking);
			else if (typed.type === "text") hasText = true;
			else if (typed.type === "toolCall") {
				const args = Object.entries((typed.arguments as Record<string, unknown>) ?? {})
					.map(([k, v]) => `${k}=${JSON.stringify(v)}`)
					.join(", ");
				toolCalls.push(`${typed.name}(${args})`);
			}
		}
		if (thinking.length > 0) parts.push(`[Assistant thinking]: ${clip(thinking.join("\n"), MAX_ENTRY_CHARS)}`);
		if (hasText) parts.push(`[Assistant]: ${clip(textOfContent(content), MAX_ENTRY_CHARS)}`);
		if (toolCalls.length > 0) parts.push(`[Assistant tool calls]: ${clip(toolCalls.join("; "), MAX_ENTRY_CHARS)}`);
		return parts.length > 0 ? parts.join("\n\n") : undefined;
	}
	if (role === "toolResult") {
		const text = textOfContent((message as { content?: unknown }).content).trim();
		if (!text) return undefined;
		const name = (message as { toolName?: string }).toolName;
		const label = name ? `Tool result (${name})` : "Tool result";
		return `[${label}]: ${clip(text, MAX_TOOL_RESULT_CHARS)}`;
	}
	return undefined;
}

/**
 * Render one executor session entry into mirror text.
 *
 * Milestones (compaction, branch summary) render as explicit context markers so
 * the advisor knows part of the transcript is summarised rather than verbatim.
 * Bookkeeping entries render to undefined and are skipped.
 */
export function renderEntry(entry: SessionEntry): string | undefined {
	if (entry.type === "compaction") {
		return `[Context compaction summary]: ${clip(entry.summary, MAX_ENTRY_CHARS)}`;
	}
	if (entry.type === "branch_summary") {
		return `[Branch summary]: ${clip(entry.summary, MAX_ENTRY_CHARS)}`;
	}
	const rendered = sessionEntryToContextMessages(entry)
		.map((m) => renderLlmMessage(m))
		.filter((t): t is string => t !== undefined && t.length > 0);
	return rendered.length > 0 ? rendered.join("\n\n") : undefined;
}

export interface MirrorPlan {
	/** True when this is a first delivery or an explicit rebase. */
	full: boolean;
	/** True when a compaction sits between the watermark and the current leaf. */
	compacted: boolean;
	/** True when the watermark is no longer on the current leaf path. */
	diverged: boolean;
	/** Entry ids this delivery covers — becomes the new watermark set. */
	coveredIds: string[];
	/** Entry ids to render into mirror text, in order. */
	renderIds: string[];
}

/**
 * Decide what to deliver.
 *
 * A missing watermark, a watermark absent from the current branch, or a
 * compaction after the watermark all rebase. Otherwise only the tail is sent.
 */
export function planMirror(sessionManager: MirrorSource, watermarkId: string | undefined): MirrorPlan {
	const branch = sessionManager.getBranch();
	const coveredIds = branch.map((e) => e.id);

	if (!watermarkId) {
		return { full: true, compacted: false, diverged: false, coveredIds, renderIds: coveredIds };
	}

	const watermarkIndex = branch.findIndex((e) => e.id === watermarkId);
	if (watermarkIndex < 0) {
		return { full: true, compacted: false, diverged: true, coveredIds, renderIds: coveredIds };
	}

	const tail = branch.slice(watermarkIndex + 1);
	if (tail.some((e) => e.type === "compaction")) {
		return { full: true, compacted: true, diverged: false, coveredIds, renderIds: coveredIds };
	}

	return {
		full: false,
		compacted: false,
		diverged: false,
		coveredIds,
		renderIds: tail.map((e) => e.id),
	};
}

/** Render entry ids into mirror text, dropping non-semantic entries. */
export function renderEntries(sessionManager: MirrorSource, ids: string[]): string[] {
	const out: string[] = [];
	for (const id of ids) {
		const entry = sessionManager.getEntry(id);
		if (!entry) continue;
		const text = renderEntry(entry);
		if (text) out.push(text);
	}
	return out;
}

/** The advisor's starting context: tool inventory plus the full executor branch. */
export function buildStartingContext(inventoryText: string | undefined, transcript: string[]): string {
	const sections: string[] = [];
	if (inventoryText) {
		sections.push(`## Tool inventory available to the executor\n\n${inventoryText}`);
	}
	sections.push(
		`## ${EXECUTOR_MIRROR_MARKER} (complete, as of this call)\n\n${transcript.join("\n\n") || "(no prior activity)"}`,
	);
	sections.push("Please advise on the executor's situation above.");
	return sections.join("\n\n");
}

/** An incremental delivery: only what the executor produced since the last call. */
export function buildTranscriptUpdate(transcript: string[]): string {
	return [
		`## ${EXECUTOR_MIRROR_MARKER} UPDATE`,
		"The executor has continued since you last advised. New activity:",
		transcript.join("\n\n") || "(no new activity)",
		"Please advise on the executor's current situation.",
	].join("\n\n");
}

/** A rebase delivery: the transcript is superseded, so it is re-stated in full. */
export function buildRebaseContext(transcript: string[], reason: "compaction" | "divergence"): string {
	const why =
		reason === "compaction"
			? "The executor compacted its context, so the transcript below is re-stated in full and supersedes what you read earlier."
			: "The executor moved to a different branch, so the transcript below is re-stated in full and supersedes what you read earlier.";
	return [
		`## ${EXECUTOR_MIRROR_MARKER} (REBASED — supersedes all earlier transcript content)`,
		why,
		transcript.join("\n\n") || "(no prior activity)",
		"Please advise on the executor's situation above.",
	].join("\n\n");
}
