/**
 * mirror — incremental delivery and rebase planning.
 *
 * Replaces upstream's `advisor.strip.test.ts`, which tested the tail-massaging
 * helpers (`stripInflightAdvisorCall`, `ensureUserTailForAdvisor`) that existed
 * only to shape a per-call stateless payload. A persistent session owns its own
 * history, so that whole class of shaping is gone; what needs proving now is the
 * DELIVERY POLICY: what goes to the advisor on the first call, on later calls,
 * and after the executor invalidates the mirror.
 */

import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
	buildRebaseContext,
	buildStartingContext,
	buildTranscriptUpdate,
	planMirror,
	renderEntries,
	renderEntry,
	type MirrorSource,
} from "./advisor/mirror.js";
import {
	buildSessionEntries,
	makeAssistantMessage,
	makeToolResult,
	makeUserMessage,
} from "./test-utils/index.js";

/** A SessionManager-shaped source over a mutable linear branch. */
function source(entries: SessionEntry[]): MirrorSource & { entries: SessionEntry[] } {
	return {
		entries,
		getBranch: () => entries,
		getEntry: (id: string) => entries.find((e) => e.id === id),
	};
}

function compactionEntry(summary: string, parentId: string | null): SessionEntry {
	return {
		type: "compaction",
		id: `compact-${Math.random().toString(36).slice(2)}`,
		parentId,
		timestamp: new Date().toISOString(),
		summary,
		firstKeptEntryId: parentId ?? "",
		tokensBefore: 1000,
	} as unknown as SessionEntry;
}

describe("planMirror — delivery planning", () => {
	it("first delivery with no watermark is full", () => {
		const branch = buildSessionEntries([makeUserMessage("q")]);
		const plan = planMirror(source(branch), undefined);

		expect(plan).toMatchObject({ full: true, compacted: false, diverged: false });
		expect(plan.renderIds).toEqual(branch.map((e) => e.id));
	});

	it("watermark at the leaf delivers nothing new", () => {
		const branch = buildSessionEntries([makeUserMessage("q"), makeAssistantMessage({ text: "a" })]);
		const plan = planMirror(source(branch), branch[branch.length - 1]?.id);

		expect(plan.full).toBe(false);
		expect(plan.renderIds).toEqual([]);
	});

	it("watermark mid-branch delivers only the tail", () => {
		const branch = buildSessionEntries([
			makeUserMessage("first"),
			makeAssistantMessage({ text: "answer" }),
			makeUserMessage("second"),
		]);
		const plan = planMirror(source(branch), branch[0]?.id);

		expect(plan.full).toBe(false);
		expect(plan.renderIds).toEqual([branch[1]?.id, branch[2]?.id]);
	});

	it("a watermark absent from the branch is a divergence rebase", () => {
		const branch = buildSessionEntries([makeUserMessage("other branch")]);
		const plan = planMirror(source(branch), "entry-from-another-branch");

		expect(plan).toMatchObject({ full: true, diverged: true, compacted: false });
	});

	it("a compaction after the watermark forces a rebase", () => {
		const prefix = buildSessionEntries([makeUserMessage("old")]);
		const compaction = compactionEntry("EARLIER WORK SUMMARISED", prefix[0]?.id ?? null);
		const branch = [...prefix, compaction];
		const plan = planMirror(source(branch), prefix[0]?.id);

		expect(plan).toMatchObject({ full: true, compacted: true, diverged: false });
	});
});

// ---------------------------------------------------------------------------
// I-8 — a rebase must REPLACE what a compaction summarised, not re-send it on
// top of the copy already in the advisor session.
//
// The live failure: an executor compaction triggered a 2,173,745-char rebase
// while the previous 2,015,715-char delivery was still in the session. The
// provider rejected the call — `1,387,946 tokens > 1,000,000 maximum`. Measured
// on the real session, resolving the context drops 1,049 of 1,231 entries and
// takes the payload from ~1,470,688 to ~214,231 tokens (85% smaller).
//
// These tests are the guard: a source that can resolve its context must never
// render superseded entries.
describe("I-8 — a compaction replaces, it does not accumulate", () => {
	/**
	 * A source that models Pi's `buildContextEntries()` semantics: a compaction
	 * drops every entry before its `firstKeptEntryId`, so the resolved context
	 * shrinks. The raw branch still contains all of them.
	 */
	function compactingSource(entries: SessionEntry[]): MirrorSource {
		const compactions = entries.filter((e) => e.type === "compaction");
		const latest = compactions[compactions.length - 1];
		return {
			getBranch: () => entries,
			getEntry: (id: string) => entries.find((e) => e.id === id),
			buildContextEntries: () => {
				if (!latest) return entries;
				const idx = entries.findIndex((e) => e.id === latest.id);
				const kept: SessionEntry[] = [];
				let found = false;
				for (let i = 0; i < idx; i++) {
					if (entries[i]!.id === (latest as { firstKeptEntryId?: string }).firstKeptEntryId) found = true;
					if (found) kept.push(entries[i]!);
				}
				return [latest, ...kept, ...entries.slice(idx + 1)];
			},
		};
	}

	it("renders the resolved context, so superseded entries are dropped from a rebase", () => {
		const prefix = buildSessionEntries([
			makeUserMessage("SUPERSEDED 1"),
			makeUserMessage("SUPERSEDED 2"),
		]);
		const keep = buildSessionEntries([makeUserMessage("KEPT AFTER SUMMARY")]);
		// The summary replaces everything up to and including `keep`, so the two
		// SUPERSEDED messages must not be rendered.
		const compaction = compactionEntry("SUMMARY OF THE OLD WORK", keep[0]!.id) as unknown as {
			firstKeptEntryId: string;
		};
		const branch = [...prefix, ...keep, compaction as unknown as SessionEntry];

		const plan = planMirror(compactingSource(branch), undefined);
		const text = renderEntries(compactingSource(branch), plan.renderIds).join("\n\n");

		expect(text).toContain("SUMMARY OF THE OLD WORK");
		expect(text).not.toContain("SUPERSEDED 1");
		expect(text).not.toContain("SUPERSEDED 2");
	});

	it("a rebase is not larger than the full context it restates", () => {
		// The failure mode was a rebase that DOUBLED the payload. A rebase renders
		// the resolved context, so it cannot exceed it.
		const prefix = buildSessionEntries([makeUserMessage(`OLD ${'x'.repeat(4000)}`)]);
		const keep = buildSessionEntries([makeUserMessage("RECENT")]);
		const compaction = compactionEntry("SUMMARY", keep[0]!.id);
		const branch = [...prefix, ...keep, compaction];
		const src = compactingSource(branch);

		const plan = planMirror(src, prefix[0]!.id);
		expect(plan).toMatchObject({ full: true, compacted: true });

		const rebase = renderEntries(src, plan.renderIds).join("\n\n");
		const fullContext = renderEntries(src, src.buildContextEntries!().map((e) => e.id)).join("\n\n");
		expect(rebase.length).toBeLessThanOrEqual(fullContext.length + 1);
		expect(rebase).not.toContain("OLD xxxx");
	});

	it("the watermark still walks the raw branch, so it cannot go missing", () => {
		// coveredIds must stay a RAW-branch id: the watermark is committed from it
		// and must remain findable next call. If it shrank with the summary, the
		// next call would see it as absent and rebase forever.
		const prefix = buildSessionEntries([makeUserMessage("a"), makeUserMessage("b")]);
		const keep = buildSessionEntries([makeUserMessage("c")]);
		const compaction = compactionEntry("SUMMARY", keep[0]!.id);
		const branch = [...prefix, ...keep, compaction];

		const plan = planMirror(compactingSource(branch), undefined);
		expect(plan.coveredIds).toEqual(branch.map((e) => e.id));
		// The committed watermark is the last covered id — must be on the branch.
		const watermark = plan.coveredIds[plan.coveredIds.length - 1];
		expect(branch.some((e) => e.id === watermark)).toBe(true);
	});

	it("falls back to the raw branch when the source cannot resolve a context", () => {
		// Correctness over size: a wrong-but-complete transcript beats an empty one.
		const branch = buildSessionEntries([makeUserMessage("only content")]);
		const plan = planMirror(source(branch), undefined);
		expect(plan.renderIds).toEqual(branch.map((e) => e.id));
	});
});

describe("renderEntry — what the advisor sees", () => {
	it("renders user and assistant text with role labels", () => {
		const [userEntry] = buildSessionEntries([makeUserMessage("hello")]);
		expect(renderEntry(userEntry!)).toBe("[User]: hello");
	});

	it("renders assistant tool calls with arguments", () => {
		const entries = buildSessionEntries([
			makeAssistantMessage({
				text: "checking",
				toolCalls: [{ id: "t1", name: "read", arguments: { path: "/a.ts" } }],
			}),
		]);
		const rendered = renderEntry(entries[0]!);

		expect(rendered).toContain("[Assistant]: checking");
		expect(rendered).toContain('read(path="/a.ts")');
	});

	it("renders tool results with the tool name", () => {
		const entries = buildSessionEntries([makeToolResult({ toolName: "bash", text: "ok" })]);
		expect(renderEntry(entries[0]!)).toBe("[Tool result (bash)]: ok");
	});

	it("renders a compaction entry as an explicit context marker", () => {
		const entry = compactionEntry("SUMMARISED CONTENT", null);
		expect(renderEntry(entry)).toBe("[Context compaction summary]: SUMMARISED CONTENT");
	});

	it("returns undefined for entries with no renderable content", () => {
		const entry = {
			type: "model_change",
			id: "m1",
			parentId: null,
			timestamp: new Date().toISOString(),
			provider: "a",
			modelId: "m",
		} as unknown as SessionEntry;
		expect(renderEntry(entry)).toBeUndefined();
	});

	it("truncates an oversized tool result instead of flooding the advisor", () => {
		const huge = "x".repeat(20_000);
		const entries = buildSessionEntries([makeToolResult({ toolName: "read", text: huge })]);
		const rendered = renderEntry(entries[0]!)!;

		expect(rendered.length).toBeLessThan(huge.length);
		expect(rendered).toContain("truncated");
	});
});

describe("prompt builders — delivery framing", () => {
	it("the starting context carries the tool inventory and the transcript", () => {
		const text = buildStartingContext("### read\nReads a file", ["[User]: hi"]);

		expect(text).toContain("Tool inventory available to the executor");
		expect(text).toContain("### read");
		expect(text).toContain("EXECUTOR TRANSCRIPT");
		expect(text).toContain("[User]: hi");
	});

	it("an update frames the transcript as new activity", () => {
		const text = buildTranscriptUpdate(["[User]: later"]);

		expect(text).toContain("EXECUTOR TRANSCRIPT UPDATE");
		expect(text).toContain("continued since you last advised");
		expect(text).toContain("[User]: later");
	});

	it("a rebase marks itself as superseding earlier transcript content", () => {
		const onCompaction = buildRebaseContext(["[User]: x"], "compaction");
		const onDivergence = buildRebaseContext(["[User]: x"], "divergence");

		expect(onCompaction).toContain("supersedes all earlier transcript content");
		expect(onCompaction).toContain("compacted its context");
		expect(onDivergence).toContain("moved to a different branch");
	});
});

describe("renderEntries", () => {
	it("renders only the requested ids and skips unrenderable entries", () => {
		const branch = buildSessionEntries([makeUserMessage("one"), makeUserMessage("two")]);
		const bookkeeping = {
			type: "thinking_level_change",
			id: "tlc",
			parentId: branch[1]?.id ?? null,
			timestamp: new Date().toISOString(),
			thinkingLevel: "high",
		} as unknown as SessionEntry;
		const src = source([...branch, bookkeeping]);

		expect(renderEntries(src, [branch[0]!.id, "tlc"])).toEqual(["[User]: one"]);
	});
});
