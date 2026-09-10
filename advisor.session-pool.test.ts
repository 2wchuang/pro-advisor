/**
 * session-pool — the persistent advisor session.
 *
 * This is the module the fork exists for, so it carries the behaviour tests that
 * prove the redesign's actual claims:
 *
 *   - the advisor session id is STABLE across repeated calls in one executor session
 *   - advisor sessions are ISOLATED per executor session (/new, /fork)
 *   - the session path is derived deterministically so /resume reopens the same
 *     session file rather than minting a new one
 *   - the advisor session exposes ZERO tools
 *   - concurrent creations for one executor session share a single session
 *   - mirror bookkeeping is persisted into and recovered from the session file
 *
 * The real `createAdvisorDriver` is exercised against a temp agent dir: session
 * construction is local (no network, no credentials) once the model is injected,
 * so these are genuine integration tests of the pool, not mocks.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import {
	AdvisorSessionPool,
	advisorSessionId,
	advisorSessionPath,
	createAdvisorDriver,
	type AdvisorSessionDriver,
} from "./advisor/session-pool.js";

const model = {
	provider: "test-provider",
	id: "test-model",
	name: "Test Model",
	api: "anthropic-messages",
	reasoning: false,
} as never;

const agentDirs: string[] = [];
function tempAgentDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pro-advisor-agentdir-"));
	agentDirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of agentDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * Write a minimal persisted advisor session (one assistant message) to
 * `sessionFile`. Stands in for the file a completed consultation leaves behind,
 * which is what makes a later reopen reuse the same session id.
 */
function seedPersistedTurn(sessionFile: string, cwd: string): void {
	mkdirSync(dirname(sessionFile), { recursive: true });
	const sm = SessionManager.open(sessionFile, dirname(sessionFile), cwd);
	sm.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: "seed guidance" }],
		timestamp: Date.now(),
	} as never);
}

describe("advisorSessionId — deterministic, Pi-valid ids", () => {
	it("is stable for the same executor session", () => {
		expect(advisorSessionId("sess-1")).toBe(advisorSessionId("sess-1"));
	});

	it("differs across executor sessions", () => {
		expect(advisorSessionId("sess-1")).not.toBe(advisorSessionId("sess-2"));
	});

	it("sanitises characters Pi's session-id validator rejects", () => {
		const id = advisorSessionId("weird/id with spaces");
		expect(id).toMatch(/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/);
		expect(id).not.toContain("/");
		expect(id).not.toContain(" ");
	});
});

describe("advisorSessionPath — /resume reopens the same file", () => {
	it("derives one path per executor session", () => {
		const agentDir = "/tmp/agent";
		const first = advisorSessionPath(agentDir, "sess-1");
		const again = advisorSessionPath(agentDir, "sess-1");
		const other = advisorSessionPath(agentDir, "sess-2");

		expect(first).toBe(again);
		expect(first).not.toBe(other);
	});
});

describe("createAdvisorDriver — session construction", () => {
	it("creates an advisor session with deterministic path and no tools", async () => {
		const agentDir = tempAgentDir();
		const driver = await createAdvisorDriver({
			executorSessionId: "exec-1",
			executorCwd: agentDir,
			model,
			effort: undefined,
			agentDir,
		});

		try {
			// The advisor must never be able to call a tool.
			expect(driver.activeToolNames()).toEqual([]);
			expect(driver.turns).toBe(0);
			// The session FILE path is deterministic per executor session. The
			// session id itself is minted by Pi on first write and read back from
			// the file thereafter, so it is asserted by the resume test below.
			expect(advisorSessionPath(agentDir, "exec-1")).toContain(advisorSessionId("exec-1"));
		} finally {
			driver.dispose();
		}
	});

	it("reopening the same executor session restores the SAME session id", async () => {
		const agentDir = tempAgentDir();
		const sessionFile = advisorSessionPath(agentDir, "exec-resume");
		const options = {
			executorSessionId: "exec-resume",
			executorCwd: agentDir,
			model,
			effort: undefined,
			agentDir,
		};

		// Seed a persisted advisor turn. A session file only materialises once it
		// holds an assistant message, so this is what a completed consultation
		// leaves behind — and it is what /resume actually reopens.
		seedPersistedTurn(sessionFile, agentDir);
		const firstId = SessionManager.open(sessionFile, agentDir, agentDir).getSessionId();

		// Second open stands in for an executor /resume: the SAME id and file must
		// come back rather than a freshly minted timestamped one.
		const resumed = await createAdvisorDriver(options);
		try {
			expect(resumed.sessionId).toBe(firstId);
			expect(existsSync(sessionFile)).toBe(true);
		} finally {
			resumed.dispose();
		}
	});

	it("distinct executor sessions get distinct advisor session files", async () => {
		const agentDir = tempAgentDir();
		const a = await createAdvisorDriver({
			executorSessionId: "exec-a",
			executorCwd: agentDir,
			model,
			effort: undefined,
			agentDir,
		});
		const b = await createAdvisorDriver({
			executorSessionId: "exec-b",
			executorCwd: agentDir,
			model,
			effort: undefined,
			agentDir,
		});

		try {
			expect(a.sessionId).not.toBe(b.sessionId);
			expect(advisorSessionPath(agentDir, "exec-a")).not.toBe(advisorSessionPath(agentDir, "exec-b"));
		} finally {
			a.dispose();
			b.dispose();
		}
	});
});

describe("mirror bookkeeping — persists into and survives the session file", () => {
	it("a fresh session reports no watermark", async () => {
		const agentDir = tempAgentDir();
		const driver = await createAdvisorDriver({
			executorSessionId: "exec-fresh",
			executorCwd: agentDir,
			model,
			effort: undefined,
			agentDir,
		});
		try {
			expect(driver.loadMirrorState()).toEqual({});
		} finally {
			driver.dispose();
		}
	});

	it("round-trips the watermark through a reopened session", async () => {
		const agentDir = tempAgentDir();
		const sessionFile = advisorSessionPath(agentDir, "exec-mirror");
		const options = {
			executorSessionId: "exec-mirror",
			executorCwd: agentDir,
			model,
			effort: undefined,
			agentDir,
		};

		// Seed the persisted turn that a completed consultation leaves behind. The
		// watermark is written by appendCustomEntry, which only reaches disk once the
		// session file exists — and in the real flow saveMirrorState always runs
		// AFTER the advisor's assistant message has been appended.
		seedPersistedTurn(sessionFile, agentDir);

		const first = await createAdvisorDriver(options);
		first.saveMirrorState({ watermarkId: "entry-7" });
		first.dispose();

		const reopened = await createAdvisorDriver(options);
		try {
			expect(reopened.loadMirrorState()).toEqual({ watermarkId: "entry-7" });
		} finally {
			reopened.dispose();
		}
	});

	it("ignores a legacy deliveredIds array instead of migrating state it never read", async () => {
		// An earlier revision persisted every delivered entry id. Nothing consumed
		// it and it was rewritten in full each turn, so it was removed; sessions
		// written before that still contain it and must not break the watermark.
		const agentDir = tempAgentDir();
		const sessionFile = advisorSessionPath(agentDir, "exec-legacy");
		const options = {
			executorSessionId: "exec-legacy",
			executorCwd: agentDir,
			model,
			effort: undefined,
			agentDir,
		};
		seedPersistedTurn(sessionFile, agentDir);

		const first = await createAdvisorDriver(options);
		first.saveMirrorState({
			watermarkId: "entry-7",
			// Simulate a pre-removal session file.
			...({ deliveredIds: ["entry-6", "entry-7"] } as unknown as Record<string, never>),
		});
		first.dispose();

		const reopened = await createAdvisorDriver(options);
		try {
			expect(reopened.loadMirrorState()).toEqual({ watermarkId: "entry-7" });
		} finally {
			reopened.dispose();
		}
	});

	it("a lost watermark on an unflushed session is harmless", async () => {
		// A session whose file never materialised also has zero advisor turns, so
		// planMirror necessarily plans a FULL delivery. Losing the watermark cannot
		// cause the executor's context to be silently skipped — only re-sent.
		const agentDir = tempAgentDir();
		const driver = await createAdvisorDriver({
			executorSessionId: "exec-unflushed",
			executorCwd: agentDir,
			model,
			effort: undefined,
			agentDir,
		});
		try {
			driver.saveMirrorState({ watermarkId: "entry-9" });
			expect(driver.turns).toBe(0);
			expect(driver.loadMirrorState().watermarkId).toBe("entry-9");
		} finally {
			driver.dispose();
		}
	});
});

describe("AdvisorSessionPool — one session per executor session", () => {
	it("returns the same driver for a repeated executor session id", async () => {
		const pool = new AdvisorSessionPool();
		let created = 0;
		const factory = async (): Promise<AdvisorSessionDriver> => {
			created += 1;
			return { sessionId: `s-${created}` } as unknown as AdvisorSessionDriver;
		};

		const first = await pool.getOrCreate("exec-1", factory);
		const second = await pool.getOrCreate("exec-1", factory);

		expect(first).toBe(second);
		expect(created).toBe(1);
	});

	it("isolates advisor sessions across executor sessions", async () => {
		const pool = new AdvisorSessionPool();
		let created = 0;
		const factory = async (): Promise<AdvisorSessionDriver> => {
			created += 1;
			return { sessionId: `s-${created}` } as unknown as AdvisorSessionDriver;
		};

		const a = await pool.getOrCreate("exec-a", factory);
		const b = await pool.getOrCreate("exec-b", factory);

		expect(a).not.toBe(b);
		expect(created).toBe(2);
		expect(pool.ids().sort()).toEqual(["exec-a", "exec-b"]);
	});

	it("shares ONE creation when concurrent calls race for the same session", async () => {
		const pool = new AdvisorSessionPool();
		let created = 0;
		const factory = async (): Promise<AdvisorSessionDriver> => {
			created += 1;
			await new Promise((resolve) => setTimeout(resolve, 5));
			return { sessionId: "racing" } as unknown as AdvisorSessionDriver;
		};

		const results = await Promise.all([
			pool.getOrCreate("exec-race", factory),
			pool.getOrCreate("exec-race", factory),
			pool.getOrCreate("exec-race", factory),
		]);

		expect(created).toBe(1);
		expect(new Set(results).size).toBe(1);
	});

	it("does not cache a failed creation", async () => {
		const pool = new AdvisorSessionPool();
		let attempts = 0;
		const failing = async (): Promise<AdvisorSessionDriver> => {
			attempts += 1;
			throw new Error("no credentials");
		};

		await expect(pool.getOrCreate("exec-fail", failing)).rejects.toThrow("no credentials");
		await expect(pool.getOrCreate("exec-fail", failing)).rejects.toThrow("no credentials");
		// A transient creation failure must not poison the key forever.
		expect(attempts).toBe(2);
	});

	it("disposeEntry disposes and forgets one session", async () => {
		const pool = new AdvisorSessionPool();
		let disposed = false;
		const driver = {
			sessionId: "s",
			dispose: () => {
				disposed = true;
			},
		} as unknown as AdvisorSessionDriver;

		await pool.getOrCreate("exec-1", async () => driver);
		pool.disposeEntry("exec-1");

		expect(disposed).toBe(true);
		expect(pool.has("exec-1")).toBe(false);
		expect(pool.size()).toBe(0);
	});

	it("disposeAll releases every pooled session", async () => {
		const pool = new AdvisorSessionPool();
		const disposed: string[] = [];
		const make = (id: string) =>
			({
				sessionId: id,
				dispose: () => disposed.push(id),
			}) as unknown as AdvisorSessionDriver;

		await pool.getOrCreate("a", async () => make("a"));
		await pool.getOrCreate("b", async () => make("b"));
		pool.disposeAll();

		expect(disposed.sort()).toEqual(["a", "b"]);
		expect(pool.size()).toBe(0);
	});
});
