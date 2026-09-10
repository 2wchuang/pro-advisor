/**
 * brief — build the consultation payload from STRUCTURED parameters.
 *
 * This replaced the executor-transcript mirror. The mirror forwarded the
 * executor's resolved conversation verbatim, rendered as labelled text
 * (`[User]: …`, `[Assistant thinking]: …`, `[Tool result (bash)]: …`). Two things
 * went wrong with it, both measured — see docs/ISSUES.md I-9:
 *
 *   1. SIGNAL-TO-NOISE. A real 667,925-char delivery broke down as 36.2% executor
 *      thinking, 21.5% tool inventory the advisor never uses (it cannot call
 *      tools), 21.1% raw tool output, 17.2% tool-call signatures, 3.5% executor
 *      prose — and 0.5% the user's own words. The advisor was asked to judge a
 *      decision from mostly process noise.
 *
 *   2. FABRICATION. The payload ended with the executor's own in-flight call —
 *      `[Assistant tool calls]: advisor()` — so the document's next natural line
 *      was `[Tool result (advisor)]:`. The model continued the document instead of
 *      answering it, fabricating tool results, edits and commits. In one reply,
 *      11,308 of 15,593 chars (72.5%) were invented executor activity, including a
 *      commit hash that does not exist. The fabricated tail entered the executor's
 *      context looking exactly like the real transcript.
 *
 * Hence two hard rules for anything built here:
 *
 *   - No continuable-transcript formatting. Do not emit `[Assistant]:` /
 *     `[Tool result (x)]:` style markers, and never end on a pending action.
 *     The payload is a BRIEF — a complete document the advisor reads and answers.
 *   - End on an explicit instruction, so the last thing the model sees is what to
 *     do rather than a slot to fill.
 *
 * The executor curates what goes in, which is the point: it knows what it is
 * uncertain about, and it can cite the evidence it is relying on so the advisor
 * can disagree with the reasoning rather than guess at it.
 */

import { clip, MAX_FIELD_CHARS } from "./messages.js";

/** What the advisor is asked to judge. `question` is the only required field. */
export interface AdvisorBrief {
	/** The decision point, stated plainly. Required — an empty brief is an error. */
	question: string;
	/** Background the advisor needs to judge: what the task is, where things stand. */
	context?: string;
	/** Alternatives under consideration, in the executor's own words. */
	options?: string[];
	/** Primary-source evidence the executor relies on (paths, measurements, citations). */
	evidence?: string[];
	/** What the executor currently leans toward, and why. */
	leaning?: string;
	/** The specific thing the executor cannot resolve. */
	unsure?: string;
}

const SECTION_INSTRUCTION =
	"Reply with your guidance only: a plan, a correction, or a stop signal. " +
	"The brief above is complete — nothing follows it, and it is a summary the executor wrote for you, " +
	"not a conversation to continue. Do not extend it, do not invent executor activity, " +
	"and do not restate it back.";

/**
 * Render a brief into the delivered text.
 *
 * Sections are omitted when absent rather than emitted empty, so a short
 * consultation stays short. The result always ends on SECTION_INSTRUCTION — never
 * on a pending action.
 */
export function buildBriefText(brief: AdvisorBrief): string {
	const sections: string[] = ["## Question", clip(brief.question.trim(), MAX_FIELD_CHARS)];

	if (brief.context?.trim()) {
		sections.push("## Context", clip(brief.context.trim(), MAX_FIELD_CHARS));
	}
	if (brief.options?.length) {
		const items = brief.options
			.map((o) => o.trim())
			.filter((o) => o.length > 0)
			.map((o) => `- ${clip(o, MAX_FIELD_CHARS)}`);
		if (items.length > 0) sections.push("## Options considered", items.join("\n"));
	}
	if (brief.evidence?.length) {
		const items = brief.evidence
			.map((e) => e.trim())
			.filter((e) => e.length > 0)
			.map((e) => `- ${clip(e, MAX_FIELD_CHARS)}`);
		if (items.length > 0) {
			sections.push("## Evidence the executor is relying on", items.join("\n"));
		}
	}
	if (brief.leaning?.trim()) {
		sections.push("## Executor's current leaning", clip(brief.leaning.trim(), MAX_FIELD_CHARS));
	}
	if (brief.unsure?.trim()) {
		sections.push("## What the executor is unsure about", clip(brief.unsure.trim(), MAX_FIELD_CHARS));
	}

	sections.push("---", SECTION_INSTRUCTION);
	return sections.join("\n\n");
}

/**
 * Whether a brief carries a decision worth escalating. Only `question` is
 * required, so this rejects the case that would otherwise send an empty payload
 * to a paid model — a consultation with no stated question cannot be answered.
 */
export function isUsableBrief(brief: AdvisorBrief | undefined): boolean {
	// Defensive: a caller that omits the argument entirely (or a host that passes
	// undefined) must be refused with the same error, not crash the tool.
	return (brief?.question ?? "").trim().length > 0;
}
