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
