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
 *   - "uses compacted session context instead of raw branch messages" — that is
 *     now mirror.test.ts's rebase-planning coverage.
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
import type { AdvisorReply, AdvisorSessionDriver, MirrorState } from "./advisor/session-pool.js";
import { AdvisorSessionPool } from "./advisor/session-pool.js";
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
	mirrorState: MirrorState = {};
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

	loadMirrorState(): MirrorState {
		return this.mirrorState;
	}

	saveMirrorState(state: MirrorState): void {
		this.mirrorState = state;
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

		const r = await executeAdvisor(ctx, pi, undefined, undefined, { pool: poolWith(driver) });

		expect(r.content[0]).toMatchObject({ type: "text", text: "advice" });
		expect(r.details).toMatchObject({
			advisorModel: "a:m",
			advisorSessionId: "advisor-test-session",
			delivery: "initial",
			stopReason: "stop",
		});
		// A non-empty first attempt must NOT retry.
		expect(driver.prompts).toHaveLength(1);
	});

	it("reuses the same advisor session across repeated calls", async () => {
		const driver = new MockDriver([{ text: "first" }, { text: "second" }]);
		const pool = poolWith(driver);
		const ctx = createMockCtx({ branch: branch() });
		const { pi } = createMockPi();

		const first = await executeAdvisor(ctx, pi, undefined, undefined, { pool });
		const second = await executeAdvisor(ctx, pi, undefined, undefined, { pool });

		expect(first.details?.advisorSessionId).toBe(second.details?.advisorSessionId);
		expect(first.content[0]).toMatchObject({ text: "first" });
		expect(second.content[0]).toMatchObject({ text: "second" });
	});

	it("delivers only new activity on the second call", async () => {
		const driver = new MockDriver([{ text: "first" }, { text: "second" }]);
		const pool = poolWith(driver);
		const { pi } = createMockPi();

		// A SessionManager-like source whose branch grows between calls.
		const entries = branch();
		const source = {
			getBranch: () => entries,
			getEntry: (id: string) => entries.find((e) => e.id === id),
			getSessionId: () => "test-session",
		};
		const ctx = createMockCtx({ sessionManager: source });

		await executeAdvisor(ctx, pi, undefined, undefined, { pool });
		entries.push(...buildSessionEntries([makeUserMessage("follow up")]));
		const second = await executeAdvisor(ctx, pi, undefined, undefined, { pool });

		expect(second.details?.delivery).toBe("incremental");
		expect(driver.prompts[1]).toContain("follow up");
		// The already-delivered first message must not be re-sent.
		expect(driver.prompts[1]).not.toContain("[User]: q");
	});

	it("aborted reply returns the cancel envelope and does NOT commit the watermark", async () => {
		const driver = new MockDriver([{ text: "", stopReason: "aborted" }]);
		const ctx = createMockCtx({ branch: branch() });
		const { pi } = createMockPi();

		const r = await executeAdvisor(ctx, pi, undefined, undefined, { pool: poolWith(driver) });

		expect(r.details).toMatchObject({ stopReason: "aborted", errorMessage: "aborted" });
		expect(r.content[0]).toMatchObject({ text: "Advisor call was cancelled before it completed." });
		// Critical: an aborted consultation must leave the watermark untouched so
		// the next call re-delivers these entries instead of skipping them.
		expect(driver.mirrorState.watermarkId).toBeUndefined();
	});

	it("error stopReason returns a wrapped errorMessage and does NOT retry", async () => {
		const driver = new MockDriver([{ text: "", stopReason: "error", errorMessage: "502" }]);
		const ctx = createMockCtx({ branch: branch() });
		const { pi } = createMockPi();

		const r = await executeAdvisor(ctx, pi, undefined, undefined, { pool: poolWith(driver) });

		expect(r.content[0]).toMatchObject({ text: expect.stringContaining("502") });
		expect(r.details).toMatchObject({ stopReason: "error", errorMessage: "502" });
		expect(driver.prompts).toHaveLength(1);
	});

	it("empty reply retries exactly once, then surfaces ERR_EMPTY_RESPONSE", async () => {
		const driver = new MockDriver([{ text: "  " }, { text: "" }]);
		const ctx = createMockCtx({ branch: branch() });
		const { pi } = createMockPi();

		const r = await executeAdvisor(ctx, pi, undefined, undefined, { pool: poolWith(driver) });

		expect(driver.prompts).toHaveLength(2);
		expect(r.details).toMatchObject({ errorMessage: "empty response" });
		// The retry must be a corrective nudge, not a replay of the same payload.
		expect(driver.prompts[1]).not.toBe(driver.prompts[0]);
	});

	it("retry succeeds when the second attempt returns advice", async () => {
		const driver = new MockDriver([{ text: "   " }, { text: "recovered advice" }]);
		const ctx = createMockCtx({ branch: branch() });
		const { pi } = createMockPi();

		const r = await executeAdvisor(ctx, pi, undefined, undefined, { pool: poolWith(driver) });

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

		const r = await executeAdvisor(ctx, pi, undefined, undefined, { pool: poolWith(driver) });

		expect(r.content[0]).toMatchObject({ text: expect.stringContaining("boom") });
		expect(r.details).toMatchObject({ errorMessage: "boom" });
	});

	it("applies a reviewer model change onto the same advisor session", async () => {
		const driver = new MockDriver([{ text: "advice" }]);
		(driver as unknown as { model: unknown }).model = { provider: "other", id: "x" };
		const ctx = createMockCtx({ branch: branch() });
		const { pi } = createMockPi();

		const r = await executeAdvisor(ctx, pi, undefined, undefined, { pool: poolWith(driver) });

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

		const r = await executeAdvisor(ctx, pi, undefined, undefined, { pool: new AdvisorSessionPool() });

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

		const r = await executeAdvisor(ctx, pi, undefined, undefined, { pool });

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

		const r = await executeAdvisor(ctx, pi, undefined, undefined, { pool });

		expect(r.content[0]).toMatchObject({ text: expect.stringContaining("no API key") });
		expect(r.details).toMatchObject({ errorMessage: "no API key for a" });
	});

	it("proceeds when OAuth-style auth resolves ok without a literal apiKey", async () => {
		const driver = new MockDriver([{ text: "oauth advice" }]);
		const ctx = createMockCtx({ branch: branch() });
		const { pi } = createMockPi();
		(ctx.modelRegistry.getApiKeyAndHeaders as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true });
		(ctx.modelRegistry as unknown as { hasConfiguredAuth: () => boolean }).hasConfiguredAuth = () => true;

		const r = await executeAdvisor(ctx, pi, undefined, undefined, { pool: poolWith(driver) });

		expect(r.content[0]).toMatchObject({ text: "oauth advice" });
	});
});
