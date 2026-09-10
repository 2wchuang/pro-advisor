/**
 * register — the advisor tool registration: structured-parameter schema, curated
 * description / promptSnippet / promptGuidelines, and an execute that delegates
 * to executeAdvisor. The guidance overrides are read from persisted config.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { validateGuidanceFields } from "@juicesharp/rpiv-config";
import { Type } from "typebox";
import { loadAdvisorConfig } from "./config.js";
import type { AdvisorBrief } from "./brief.js";
import { executeAdvisor } from "./execute.js";
import { ADVISOR_TOOL_NAME, TOOL_LABEL } from "./messages.js";
import { AdvisorSessionPool } from "./session-pool.js";

const AdvisorParams = Type.Object({
	question: Type.String({
		description:
			"The decision you need judged, stated plainly. Required.",
	}),
	context: Type.Optional(
		Type.String({
			description:
				"Background the advisor needs to judge it: what the task is, where things stand, what you have already tried.",
		}),
	),
	options: Type.Optional(
		Type.Array(Type.String(), {
			description: "Alternatives under consideration, one per entry.",
		}),
	),
	evidence: Type.Optional(
		Type.Array(Type.String(), {
			description:
				"Primary-source evidence you are relying on (file:line references, measured numbers, citations). The advisor can check your reasoning only against what you cite here.",
		}),
	),
	leaning: Type.Optional(
		Type.String({ description: "What you currently lean toward, and why." }),
	),
	unsure: Type.Optional(
		Type.String({ description: "The specific thing you cannot resolve." }),
	),
});

const ADVISOR_DESCRIPTION =
	"Escalate to a stronger reviewer model for guidance. When you need " +
	"stronger judgment — a complex decision, an ambiguous failure, a problem " +
	"you're circling without progress — write a brief and escalate to the advisor " +
	"model, then resume. YOU decide what goes in the brief: the advisor does not " +
	"see your conversation, so state the decision, the options, the evidence you " +
	"are relying on, and what you cannot resolve. Cite primary sources " +
	"(file:line, measured numbers) so it can challenge your reasoning rather than " +
	"guess at it. The advisor keeps ONE persistent session per executor session, " +
	"so follow-ups continue the same conversation. It has no tools and cannot " +
	"inspect anything itself, and it does not receive your history automatically.";

export const DEFAULT_PROMPT_SNIPPET =
	"Escalate to a stronger reviewer model when you are stuck, when an approach is not converging, or before an irreversible decision";

export const DEFAULT_PROMPT_GUIDELINES: string[] = [
	"The user is the decision-maker, not the advisor. `advisor` is a consultation tool you may choose to use — never an authority you must report to, defer to, or whose approval gates your work. If the advisor and the user disagree, the user wins.",
	"`advisor` receives ONLY the brief you write — not your conversation. State the decision, the options you see, the evidence you are relying on, and what you cannot resolve. An under-specified brief returns generic advice; the quality of the answer is bounded by what you put in.",
	"Cite primary sources in `evidence` (file:line, measured numbers, command output). The advisor has no tools and cannot inspect anything, so unstated evidence cannot be checked — it can only be taken on trust.",
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

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			return executeAdvisor(ctx, pi, params as AdvisorBrief, signal, onUpdate, { pool });
		},
	});
}
