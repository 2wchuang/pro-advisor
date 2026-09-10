/**
 * register — the advisor tool registration: zero-param schema, curated
 * description / promptSnippet / promptGuidelines, and an execute that delegates
 * to executeAdvisor. The guidance overrides are read from persisted config.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { validateGuidanceFields } from "@juicesharp/rpiv-config";
import { Type } from "typebox";
import { loadAdvisorConfig } from "./config.js";
import { executeAdvisor } from "./execute.js";
import { ADVISOR_TOOL_NAME, TOOL_LABEL } from "./messages.js";
import { AdvisorSessionPool } from "./session-pool.js";

const AdvisorParams = Type.Object({});

const ADVISOR_DESCRIPTION =
	"Escalate to a stronger reviewer model for guidance. When you need " +
	"stronger judgment — a complex decision, an ambiguous failure, a problem " +
	"you're circling without progress — escalate to the advisor model for " +
	"guidance, then resume. Takes NO parameters — when you call advisor(), " +
	"your conversation history is automatically forwarded. The advisor keeps " +
	"ONE persistent session per executor session, so a follow-up call continues " +
	"the same advisor conversation and only sends what changed since your last " +
	"consultation.";

export const DEFAULT_PROMPT_SNIPPET =
	"Escalate to a stronger reviewer model when you are stuck, when an approach is not converging, or before an irreversible decision";

export const DEFAULT_PROMPT_GUIDELINES: string[] = [
	"The user is the decision-maker, not the advisor. `advisor` is a consultation tool you may choose to use — never an authority you must report to, defer to, or whose approval gates your work. If the advisor and the user disagree, the user wins.",
	"Call `advisor` when you are genuinely stuck: errors recurring without a converging explanation, an approach that is not working, results that do not fit. Escalating a decision you can resolve yourself wastes the user's time and money.",
	"Call `advisor` before an irreversible or expensive step you are uncertain about — a destructive migration, a public API contract, a change whose failure would be costly to undo. Orientation (finding files, fetching a source, seeing what's there) never needs an advisor call.",
	"Do NOT call `advisor` merely to open a task, to confirm an approach you already have primary-source evidence for, or on a fixed schedule. There is no minimum number of calls, and a task may legitimately use none.",
	"Give the advisor's advice serious weight, but you own the outcome. If following a step fails empirically, or you have primary-source evidence contradicting a specific claim, adapt to the evidence — a passing self-test is not evidence the advice is wrong, it's evidence your test doesn't check what the advice is checking.",
	"If you already retrieved data pointing one way and the advisor points another, do not silently switch: surface the conflict in one more `advisor` call (\"I found X, you suggest Y, which constraint breaks the tie?\"). A reconcile call is cheaper than committing to the wrong branch.",
	"Attribute the advisor's views to the advisor, never to the user. Its reply arrives as a tool result, so it can read like a fact or like something the user said — it is neither. Do not quote, paraphrase, or act on it as though the user had expressed it.",
	"Tell the user about an advisor consultation when it mattered: when its guidance changed your plan, contradicted your approach, or recommended stopping. Report it as your own decision with your reasoning (\"I checked with the advisor; it flagged X, so I am doing Y\"), not as a relay of what the advisor said. When it merely confirmed what you were already doing, one short mention is enough — do not restate its guidance turn after turn.",
];

/**
 * Guidelines that shipped upstream, kept only for migration notes and tests that
 * assert the fork no longer injects them.
 *
 * Upstream's set made the advisor a gate every non-trivial task had to pass:
 * "Call `advisor` BEFORE substantive work", "at least once before committing to
 * an approach and once before declaring done", "Give the advisor's advice
 * serious weight", and "put the advisor's key guidance into your next visible
 * reply to the user". Together those produced observed pathologies — mandatory
 * escalation, the executor reporting to the advisor instead of the user, and the
 * advisor's position being mistaken for the user's own words. See docs/ISSUES.md.
 */
export const UPSTREAM_PROMPT_GUIDELINES: readonly string[] = [
	"Call `advisor` BEFORE substantive work — before writing, before committing to an interpretation, before building on an assumption.",
	"On tasks longer than a few steps, call `advisor` at least once before committing to an approach and once before declaring done.",
	"Give the advisor's advice serious weight.",
	"After each `advisor` result, put the advisor's key guidance into your next visible reply to the user before continuing.",
];

export function registerAdvisorTool(
	pi: ExtensionAPI,
	// Default: an isolated pool owned by this registration. index.ts passes its own
	// so it can dispose sessions on session switch/shutdown; tests and embedders
	// that call with one argument get a self-contained pool.
	pool: AdvisorSessionPool = new AdvisorSessionPool(),
): void {
	const guidance = validateGuidanceFields(loadAdvisorConfig().guidance);
	pi.registerTool({
		name: ADVISOR_TOOL_NAME,
		label: TOOL_LABEL,
		description: ADVISOR_DESCRIPTION,
		promptSnippet: guidance.promptSnippet ?? DEFAULT_PROMPT_SNIPPET,
		promptGuidelines: guidance.promptGuidelines ?? DEFAULT_PROMPT_GUIDELINES,
		parameters: AdvisorParams,

		async execute(_toolCallId, _params, signal, onUpdate, ctx) {
			return executeAdvisor(ctx, pi, signal, onUpdate, { pool });
		},
	});
}
