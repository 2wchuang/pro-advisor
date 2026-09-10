/**
 * status — `/advisor-status` observability.
 *
 * Covers docs/ISSUES.md I-6: the persistent-session design grows advisor history
 * on every consultation, so the state must be inspectable. These tests pin the
 * reporting contract AND the honesty of its wording — session bytes are declared
 * a proxy, never presented as tokens or cost.
 */

import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	AdvisorSessionPool,
	advisorSessionPath,
	type AdvisorSessionDriver,
} from "./advisor/session-pool.js";
import { collectAdvisorStatus, formatAdvisorStatus } from "./advisor/status.js";
import { setAdvisorEffort, setAdvisorModel } from "./advisor/state.js";

function driver(id: string, turns: number, tools: string[] = []): AdvisorSessionDriver {
	return {
		sessionId: id,
		turns,
		activeToolNames: () => tools,
	} as unknown as AdvisorSessionDriver;
}

async function poolWith(entries: Array<[string, AdvisorSessionDriver]>): Promise<AdvisorSessionPool> {
	const pool = new AdvisorSessionPool();
	for (const [executorId, d] of entries) {
		await pool.getOrCreate(executorId, async () => d);
	}
	return pool;
}

describe("collectAdvisorStatus", () => {
	it("reports no sessions before the first consultation", async () => {
		const pool = new AdvisorSessionPool();
		const status = collectAdvisorStatus(pool, "/tmp/nonexistent-agent-dir");

		expect(status.sessions).toEqual([]);
		expect(status.totalBytes).toBe(0);
	});

	it("reports the configured model and effort", async () => {
		setAdvisorModel({ provider: "anthropic", id: "claude-opus-4-5" } as never);
		setAdvisorEffort("high" as never);
		const status = collectAdvisorStatus(new AdvisorSessionPool(), "/tmp/nonexistent");

		expect(status.model).toBe("anthropic/claude-opus-4-5");
		expect(status.effort).toBe("high");
	});

	it("reports one entry per executor session with its turn count", async () => {
		const pool = await poolWith([
			["exec-a", driver("advisor-a", 3)],
			["exec-b", driver("advisor-b", 7)],
		]);
		const status = collectAdvisorStatus(pool, "/tmp/nonexistent");

		expect(status.sessions).toHaveLength(2);
		expect(status.sessions.map((s) => s.turns).sort()).toEqual([3, 7]);
		expect(status.sessions.map((s) => s.advisorSessionId).sort()).toEqual(["advisor-a", "advisor-b"]);
	});

	it("reports the advisor's tool count so a regression to non-zero tools is visible", async () => {
		const pool = await poolWith([["exec-a", driver("advisor-a", 1, [])]]);
		const status = collectAdvisorStatus(pool, "/tmp/nonexistent");

		expect(status.sessions[0]?.activeTools).toBe(0);
	});

	it("marks an unflushed session as having no file rather than 0 bytes", async () => {
		const pool = await poolWith([["exec-a", driver("advisor-a", 0)]]);
		const status = collectAdvisorStatus(pool, "/tmp/definitely-not-a-real-dir-xyz");

		// A session with no completed turn has no file; reporting 0 B would imply a
		// file that exists and is empty.
		expect(status.sessions[0]?.sessionBytes).toBeUndefined();
		expect(status.totalBytes).toBe(0);
	});

	it("sums real session-file sizes when they exist", async () => {
		const agentDir = process.env.HOME!;
		const pool = await poolWith([["exec-size", driver("advisor-size", 2)]]);
		const path = advisorSessionPath(agentDir, "exec-size");

		// Write a file where the pool expects the session to live.
		const { mkdirSync } = await import("node:fs");
		const { dirname } = await import("node:path");
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, "x".repeat(2048));

		const status = collectAdvisorStatus(pool, agentDir);
		expect(status.sessions[0]?.sessionBytes).toBe(2048);
		expect(status.totalBytes).toBe(2048);
	});
});

describe("formatAdvisorStatus — honesty of the rendering", () => {
	it("says the advisor is unconfigured when no model is set", () => {
		setAdvisorModel(undefined);
		const lines = formatAdvisorStatus({ sessions: [], totalBytes: 0 });
		expect(lines[0]).toContain("not configured");
	});

	it("explains why compaction is disabled next to the size it explains", () => {
		// The growing file size reads like a leak on its own. It is deliberate: see
		// docs/ISSUES.md I-7. The status output must say so, and must name the escape.
		const lines = formatAdvisorStatus({
			model: "a/m",
			sessions: [{ executorSessionId: "e", advisorSessionId: "a", turns: 2, activeTools: 0, sessionBytes: 4096 }],
			totalBytes: 4096,
		});
		const joined = lines.join("\n");

		expect(joined).toMatch(/Compaction: disabled/);
		expect(joined).toContain("/new");
		// It must also warn that failures enlarge the session, since that is the
		// non-obvious half of the growth.
		expect(joined).toMatch(/failed delivery is persisted/i);
		// The disclaimer must still hold after adding lines.
		for (const line of lines) {
			if (/\btokens?\b|\bcost\b/i.test(line)) expect(line).toContain("not a token or cost figure");
		}
	});

	it("omits the compaction note when there are no sessions", () => {
		const lines = formatAdvisorStatus({ sessions: [], totalBytes: 0 });
		expect(lines.join("\n")).not.toContain("Compaction:");
	});

	it("never presents session bytes as a token or cost figure", () => {
		const lines = formatAdvisorStatus({
			model: "a/m",
			sessions: [{ executorSessionId: "e", advisorSessionId: "a", turns: 2, activeTools: 0, sessionBytes: 4096 }],
			totalBytes: 4096,
		});

		// Any line that mentions tokens or cost must BE the disclaimer. This allows
		// the honest "not a token or cost figure" wording while rejecting a real
		// claim like "tokens used: 1234".
		for (const line of lines) {
			if (/\btokens?\b|\bcost\b/i.test(line)) {
				expect(line, `cost/token claim without disclaimer: ${line}`).toContain("not a token or cost figure");
			}
		}

		// The rendering must state the disclaimer exactly once, on the total line.
		const disclaimerLines = lines.filter((l) => l.includes("not a token or cost figure"));
		expect(disclaimerLines).toHaveLength(1);
		expect(disclaimerLines[0]).toContain("Total on disk");
	});
});
