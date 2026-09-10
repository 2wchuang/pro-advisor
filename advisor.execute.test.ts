/**
 * executeAdvisor — envelope contract.
 *
 * Upstream tested this module through `completeSimple`, because the stateless
 * implementation WAS a single completion call. The persistent implementation
 * owns a Pi AgentSession instead, so the transport assertions no longer describe
 * the code. What still matters — and is tested here — is the envelope contract
 * every caller depends on:
 *
 *   success, auth failure, abort, provider error, thrown error, and the bounded
 *   single empty-response retry.
 *
 * The seam is `AdvisorSessionDriver` (session-pool.ts): a mock driver carries
 * exactly the surface the module uses, so no credentials, network, or real Pi
 * session is needed.
 *
 * Transport-specific coverage that was REPLACED rather than dropped:
 *   - "uses Pi's auth-aware runtime completion" / "legacy completion path" —
 *     both described completeSimple resolution, which no longer exists; the
 *     equivalent concern (auth resolution) is covered by the preflight tests and
 *     by session-pool.test.ts's modelRuntime passthrough.
 *   - "uses compacted session context instead of raw branch messages" — that whole
 *     concern is gone: the payload is built from the tool's structured parameters,
 *     not from the session, so there is no branch or compaction to plan around.
 *     See advisor.brief.test.ts for payload construction.
 */

import {
	buildSessionEntries,
	createMockCtx,
	createMockPi,
	makeAssistantMessage,
	makeUserMessage,
} from "./test-utils/index.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@earendil-works/pi-ai", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@earendil-works/pi-ai")>();
	return {
		...actual,
		getSupportedThinkingLevels: vi.fn(() => ["off", "minimal", "low", "medium", "high"]),
	};
});

import { executeAdvisor } from "./advisor/execute.js";
import type { AdvisorSessionDriver, AdvisorReply } from "./advisor/session-pool.js";
import { AdvisorSessionPool } from "./advisor/session-pool.js";
import type { AdvisorBrief } from "./advisor/brief.js";

/** A minimal valid brief. Every executeAdvisor call now requires one. */
const brief: AdvisorBrief = { question: "Which constraint breaks the tie?" };
import { setAdvisorEffort, setAdvisorModel } from "./advisor/index.js";

const modelA = { provider: "a", id: "m", name: "Model A" } as never;

/**
 * Mock driver. Records every prompt so tests can assert delta delivery, and
 * scripts one reply per ask() call.
 */
class MockDriver implements AdvisorSessionDriver {
	readonly sessionId = "advisor-test-session";
	readonly prompts: string[] = [];
	readonly modelCalls: unknown[] = [];
	readonly effortCalls: Array<string | undefined> = [];
	disposed = false;
	private replies: AdvisorReply[];
	private completedTurns: number;
	private model: unknown = modelA;

	constructor(replies: AdvisorReply[] = [{ text: "advice" }], turns = 0) {
		this.replies = replies;
		this.completedTurns = turns;
	}

	get turns(): number {
		return this.completedTurns;
	}

	async ask(text: string, _signal: AbortSignal | undefined): Promise<AdvisorReply> {
		this.prompts.push(text);
		const reply = this.replies[this.prompts.length - 1] ?? { text: "" };
		if (!reply.stopReason || reply.stopReason === "stop") this.completedTurns += 1;
		return reply;
	}

	async setModel(model: never): Promise<void> {
		this.modelCalls.push(model);
		this.model = model;
	}

	setEffort(effort: string | undefined): void {
		this.effortCalls.push(effort);
	}

	currentModel(): never {
		return this.model as never;
	}

	activeToolNames(): string[] {
		return [];
	}

	dispose(): void {
		this.disposed = true;
	}
}

function poolWith(driver: MockDriver): AdvisorSessionPool {
	const pool = new AdvisorSessionPool();
	// Inject directly so the test never reaches createAdvisorDriver.
	(pool as unknown as { drivers: Map<string, AdvisorSessionDriver> }).drivers.set("test-session", driver);
	return pool;
}

function branch() {
	return buildSessionEntries([makeUserMessage("q"), makeAssistantMessage({ text: "a" })]);
}

beforeEach(() => {
	setAdvisorModel(modelA);
	setAdvisorEffort(undefined);
});

describe("executeAdvisor — envelope contract", () => {
	it("happy path returns the advisor text and reports the session id", async () => {
		const driver = new MockDriver([{ text: "advice" }]);
		const ctx = createMockCtx({ branch: branch() });
		const { pi } = createMockPi();

		const r = await executeAdvisor(ctx, pi, brief, undefined, undefined, { pool: poolWith(driver) });

		expect(r.content[0]).toMatchObject({ type: "text", text: "advice" });
		expect(r.details).toMatchObject({
			advisorModel: "a:m",
			advisorSessionId: "advisor-test-session",
			stopReason: "stop",
		});
		// The delivery concept is gone with the mirror: each call sends its own
		// brief, so there is no initial/incremental/rebase distinction.
		expect(r.details).not.toHaveProperty("delivery");
		// A non-empty first attempt must NOT retry.
		expect(driver.prompts).toHaveLength(1);
	});

	it("reuses the same advisor session across repeated calls", async () => {
		const driver = new MockDriver([{ text: "first" }, { text: "second" }]);
		const pool = poolWith(driver);
		const ctx = createMockCtx({ branch: branch() });
		const { pi } = createMockPi();

		const first = await executeAdvisor(ctx, pi, brief, undefined, undefined, { pool });
		const second = await executeAdvisor(ctx, pi, brief, undefined, undefined, { pool });

		expect(first.details?.advisorSessionId).toBe(second.details?.advisorSessionId);
		expect(first.content[0]).toMatchObject({ text: "first" });
		expect(second.content[0]).toMatchObject({ text: "second" });
	});

	it("sends the brief, and the payload is not a continuable transcript", async () => {
		const driver = new MockDriver([{ text: "first" }, { text: "second" }]);
		const pool = poolWith(driver);
		const { pi } = createMockPi();
		const ctx = createMockCtx({ branch: branch() });

		const payload: AdvisorBrief = {
			question: "Should a compaction rebase rotate the advisor session?",
			context: "The mirror was removed; briefs are now written by the executor.",
			options: ["Rotate on compaction", "Keep appending"],
			evidence: ["advisor/brief.ts:1 — payload construction"],
			leaning: "Rotate, but not without evidence",
			unsure: "What counts as enough evidence?",
		};

		await executeAdvisor(ctx, pi, payload, undefined, undefined, { pool });
		const sent = driver.prompts[0]!;

		// The brief reaches the advisor, including the required question.
		expect(sent).toContain("Should a compaction rebase rotate the advisor session?");
		expect(sent).toContain("Rotate on compaction");
		expect(sent).toContain("advisor/brief.ts:1");

		// I-9 regression guard: the payload must never look like the mirrored
		// transcript that the advisor continued instead of answering. These are the
		// exact markers it used to fabricate tool results and commits.
		for (const marker of ["[Assistant]:", "[Assistant thinking]:", "[Assistant tool calls]:", "[Tool result ("]) {
			expect(sent, `payload must not contain the continuable marker ${marker}`).not.toContain(marker);
		}
		// And it must not END on a pending action (the old payload ended on the
		// executor's own in-flight `advisor()` call, inviting completion).
		expect(sent.trimEnd().endsWith("advisor()")).toBe(false);
		expect(sent).toMatch(/Reply with your guidance only/);
	});

	it("each call sends its own brief; no transcript state is delivered or persisted", async () => {
		const driver = new MockDriver([{ text: "first" }, { text: "second" }]);
		const pool = poolWith(driver);
		const { pi } = createMockPi();
		const ctx = createMockCtx({ branch: branch() });

		await executeAdvisor(ctx, pi, { question: "FIRST" }, undefined, undefined, { pool });
		await executeAdvisor(ctx, pi, { question: "SECOND" }, undefined, undefined, { pool });

		// Self-contained payloads: the second does not restate the first, and the
		// session is still reused (persistent session, per-call payload).
		expect(driver.prompts[0]).toContain("FIRST");
		expect(driver.prompts[1]).toContain("SECOND");
		expect(driver.prompts[1]).not.toContain("FIRST");
	});

	it("refuses an empty question before creating a session or calling the model", async () => {
		const driver = new MockDriver([{ text: "should not be reached" }]);
		const ctx = createMockCtx({ branch: branch() });
		const { pi } = createMockPi();

		const r = await executeAdvisor(ctx, pi, { question: "   " }, undefined, undefined, {
			pool: poolWith(driver),
		});

		expect(r.content[0]).toMatchObject({ type: "text" });
		expect(String((r.content[0] as { text: string }).text)).toMatch(/without a question/i);
		expect(driver.prompts).toHaveLength(0);
	});

	it("aborted reply returns the cancel envelope", async () => {
		const driver = new MockDriver([{ text: "", stopReason: "aborted" }]);
		const ctx = createMockCtx({ branch: branch() });
		const { pi } = createMockPi();

		const r = await executeAdvisor(ctx, pi, brief, undefined, undefined, { pool: poolWith(driver) });

		expect(r.details).toMatchObject({ stopReason: "aborted", errorMessage: "aborted" });
		expect(r.content[0]).toMatchObject({ text: "Advisor call was cancelled before it completed." });
	});

	it("error stopReason returns a wrapped errorMessage and does NOT retry", async () => {
		const driver = new MockDriver([{ text: "", stopReason: "error", errorMessage: "502" }]);
		const ctx = createMockCtx({ branch: branch() });
		const { pi } = createMockPi();

		const r = await executeAdvisor(ctx, pi, brief, undefined, undefined, { pool: poolWith(driver) });

		expect(r.content[0]).toMatchObject({ text: expect.stringContaining("502") });
		expect(r.details).toMatchObject({ stopReason: "error", errorMessage: "502" });
		expect(driver.prompts).toHaveLength(1);
	});

	it("empty reply retries exactly once, then surfaces ERR_EMPTY_RESPONSE", async () => {
		const driver = new MockDriver([{ text: "  " }, { text: "" }]);
		const ctx = createMockCtx({ branch: branch() });
		const { pi } = createMockPi();

		const r = await executeAdvisor(ctx, pi, brief, undefined, undefined, { pool: poolWith(driver) });

		expect(driver.prompts).toHaveLength(2);
		expect(r.details).toMatchObject({ errorMessage: "empty response" });
		// The retry must be a corrective nudge, not a replay of the same payload.
		expect(driver.prompts[1]).not.toBe(driver.prompts[0]);
	});

	it("retry succeeds when the second attempt returns advice", async () => {
		const driver = new MockDriver([{ text: "   " }, { text: "recovered advice" }]);
		const ctx = createMockCtx({ branch: branch() });
		const { pi } = createMockPi();

		const r = await executeAdvisor(ctx, pi, brief, undefined, undefined, { pool: poolWith(driver) });

		expect(r.content[0]).toMatchObject({ text: "recovered advice" });
		expect(driver.prompts).toHaveLength(2);
	});

	it("thrown error from the driver is caught and wrapped", async () => {
		const driver = new MockDriver();
		driver.ask = vi.fn(async () => {
			throw new Error("boom");
		});
		const ctx = createMockCtx({ branch: branch() });
		const { pi } = createMockPi();

		const r = await executeAdvisor(ctx, pi, brief, undefined, undefined, { pool: poolWith(driver) });

		expect(r.content[0]).toMatchObject({ text: expect.stringContaining("boom") });
		expect(r.details).toMatchObject({ errorMessage: "boom" });
	});

	it("applies a reviewer model change onto the same advisor session", async () => {
		const driver = new MockDriver([{ text: "advice" }]);
		(driver as unknown as { model: unknown }).model = { provider: "other", id: "x" };
		const ctx = createMockCtx({ branch: branch() });
		const { pi } = createMockPi();

		const r = await executeAdvisor(ctx, pi, brief, undefined, undefined, { pool: poolWith(driver) });

		expect(driver.modelCalls).toEqual([modelA]);
		// The session identity must survive a model switch.
		expect(r.details?.advisorSessionId).toBe("advisor-test-session");
	});
});

describe("executeAdvisor — failure envelopes", () => {
	it("returns the no-model envelope when the advisor is not configured", async () => {
		setAdvisorModel(undefined);
		const ctx = createMockCtx({ branch: branch() });
		const { pi } = createMockPi();

		const r = await executeAdvisor(ctx, pi, brief, undefined, undefined, { pool: new AdvisorSessionPool() });

		expect(r.details).toMatchObject({ errorMessage: "no advisor model selected" });
	});

	it("wraps a misconfigured auth result before any session work", async () => {
		const ctx = createMockCtx({ branch: branch() });
		const { pi } = createMockPi();
		(ctx.modelRegistry.getApiKeyAndHeaders as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
			ok: false,
			error: "bad config",
		});
		const pool = new AdvisorSessionPool();

		const r = await executeAdvisor(ctx, pi, brief, undefined, undefined, { pool });

		expect(r.content[0]).toMatchObject({ text: expect.stringContaining("bad config") });
		expect(r.details).toMatchObject({ errorMessage: "bad config", advisorModel: "a:m" });
		// The preflight must short-circuit before a session is ever created.
		expect(pool.size()).toBe(0);
	});

	it("returns the no-api-key envelope when the provider is not authenticated", async () => {
		const ctx = createMockCtx({ branch: branch() });
		const { pi } = createMockPi();
		(ctx.modelRegistry.getApiKeyAndHeaders as ReturnType<typeof vi.fn>).mockResolvedValue({
			ok: true,
			apiKey: undefined,
			headers: {},
		});
		// No configured auth and no runtime facade ⇒ genuinely unauthenticated.
		(ctx.modelRegistry as unknown as { hasConfiguredAuth: () => boolean }).hasConfiguredAuth = () => false;
		const pool = poolWith(new MockDriver());

		const r = await executeAdvisor(ctx, pi, brief, undefined, undefined, { pool });

		expect(r.content[0]).toMatchObject({ text: expect.stringContaining("no API key") });
		expect(r.details).toMatchObject({ errorMessage: "no API key for a" });
	});

	it("proceeds when OAuth-style auth resolves ok without a literal apiKey", async () => {
		const driver = new MockDriver([{ text: "oauth advice" }]);
		const ctx = createMockCtx({ branch: branch() });
		const { pi } = createMockPi();
		(ctx.modelRegistry.getApiKeyAndHeaders as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true });
		(ctx.modelRegistry as unknown as { hasConfiguredAuth: () => boolean }).hasConfiguredAuth = () => true;

		const r = await executeAdvisor(ctx, pi, brief, undefined, undefined, { pool: poolWith(driver) });

		expect(r.content[0]).toMatchObject({ text: "oauth advice" });
	});
});
