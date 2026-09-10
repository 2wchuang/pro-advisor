/**
 * brief — payload construction from structured parameters.
 *
 * This file exists because the payload SHAPE is load-bearing, not cosmetic. The
 * mirror it replaced produced a payload the advisor continued instead of
 * answering (docs/ISSUES.md I-9): 72.5% of one reply was invented executor
 * activity, including a commit hash that does not exist. The advisor read the
 * document's next natural line as its job.
 *
 * So these tests assert two things beyond "the fields appear":
 *   - every section the executor supplies reaches the advisor, because the
 *     advisor has no other way to see the evidence it is judging;
 *   - the payload never adopts a continuable-transcript shape.
 */

import { describe, expect, it } from "vitest";
import { buildBriefText, isUsableBrief, type AdvisorBrief } from "./advisor/brief.js";
import { MAX_FIELD_CHARS } from "./advisor/messages.js";

describe("buildBriefText — what the advisor receives", () => {
	it("includes every supplied section", () => {
		const text = buildBriefText({
			question: "Should the rebase rotate the session?",
			context: "The mirror was removed; briefs are authored by the executor.",
			options: ["Rotate on compaction", "Keep appending"],
			evidence: ["advisor/brief.ts:1 — payload construction", "measured: 1,387,946 tokens rejected"],
			leaning: "Rotate, but only with evidence",
			unsure: "What counts as sufficient evidence?",
		});

		expect(text).toContain("## Question");
		expect(text).toContain("Should the rebase rotate the session?");
		expect(text).toContain("## Context");
		expect(text).toContain("## Options considered");
		expect(text).toContain("- Rotate on compaction");
		expect(text).toContain("- Keep appending");
		expect(text).toContain("## Evidence the executor is relying on");
		expect(text).toContain("- advisor/brief.ts:1 — payload construction");
		expect(text).toContain("## Executor's current leaning");
		expect(text).toContain("## What the executor is unsure about");
	});

	it("omits absent sections rather than emitting them empty", () => {
		const text = buildBriefText({ question: "Only a question" });

		expect(text).toContain("## Question");
		expect(text).not.toContain("## Context");
		expect(text).not.toContain("## Options considered");
		expect(text).not.toContain("## Evidence");
		expect(text).not.toContain("## Executor's current leaning");
		expect(text).not.toContain("## What the executor is unsure about");
	});

	it("drops blank entries inside a list instead of emitting empty bullets", () => {
		const text = buildBriefText({ question: "q", options: ["  ", "real", ""] });
		expect(text).toContain("- real");
		expect(text).not.toMatch(/^- *$/m);
	});

	it("clips a runaway field and marks the cut, so a partial thought is not read as complete", () => {
		const huge = "x".repeat(MAX_FIELD_CHARS + 500);
		const text = buildBriefText({ question: huge });

		expect(text).toContain("[truncated 500 chars]");
		expect(text.length).toBeLessThan(huge.length);
	});

	// ---------------------------------------------------------------------
	// I-9 shape guards. These are the ones that would have caught the defect.
	// ---------------------------------------------------------------------
	it("never adopts the continuable-transcript markers the advisor extended", () => {
		const text = buildBriefText({
			question: "q",
			context: "c",
			options: ["a"],
			evidence: ["e"],
			leaning: "l",
			unsure: "u",
		});

		// These are the exact markers from the mirrored payload. Their presence
		// invited the model to continue the document with fabricated content.
		for (const marker of ["[Assistant]:", "[Assistant thinking]:", "[Assistant tool calls]:", "[Tool result ("]) {
			expect(text, `payload must not contain ${marker}`).not.toContain(marker);
		}
		// The old payload's role labels.
		expect(text).not.toContain("[User]:");
		// And the old marker name.
		expect(text).not.toContain("EXECUTOR TRANSCRIPT");
	});

	it("ends on an instruction, never on a pending action", () => {
		const text = buildBriefText({ question: "q", unsure: "u" });
		const last = text.trimEnd().split("\n").pop() ?? "";

		// The mirror ended on `[Assistant tool calls]: advisor()` — an action slot
		// the model filled with a fabricated tool result.
		expect(last).not.toMatch(/advisor\(\)\s*$/);
		expect(last).not.toMatch(/\[.*\]:\s*$/);
		// The final content must be the instruction.
		expect(text.trimEnd().endsWith("do not restate it back.")).toBe(true);
	});

	it("states that the brief is complete, addressing the observed failure directly", () => {
		const text = buildBriefText({ question: "q" });
		expect(text).toMatch(/nothing follows it/i);
		expect(text).toMatch(/not a conversation to continue/i);
		expect(text).toMatch(/do not invent executor activity/i);
	});
});

describe("isUsableBrief", () => {
	it("accepts a question-only brief", () => {
		expect(isUsableBrief({ question: "why?" })).toBe(true);
	});

	it("rejects a blank or whitespace-only question", () => {
		expect(isUsableBrief({ question: "" })).toBe(false);
		expect(isUsableBrief({ question: "   \n\t " })).toBe(false);
	});

	it("rejects a missing brief rather than throwing", () => {
		// A host that forwards no argument must produce the refusal error, not a
		// crash inside the tool.
		expect(isUsableBrief(undefined as unknown as AdvisorBrief)).toBe(false);
	});
});
