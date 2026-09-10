/**
 * messages — advisor vocabulary: tool identity, selector sentinels, effort
 * levels, UI labels, and every user-facing string (static + parameterized).
 * Pure declarations, no logic; consumed across the advisor/ modules.
 */

import type { ThinkingLevel } from "@earendil-works/pi-ai";

// Tool identity
export const ADVISOR_TOOL_NAME = "advisor";
export const TOOL_LABEL = "Advisor";

// Selector sentinels — double-underscore form is collision-proof against real provider:id keys
export const NO_ADVISOR_VALUE = "__no_advisor__";
export const OFF_VALUE = "__off__";

// Effort levels. GradedEffort is the ordinal's domain: the graded levels only,
// never "off" — an "off" element would corrupt the indexOf ranking that
// minEffort thresholds compare against. Today pi-ai's ThinkingLevel already
// excludes "off" (the Exclude is a defensive no-op); the alias keeps that
// exclusion structural if the upstream universe ever re-widens.
export type GradedEffort = Exclude<ThinkingLevel, "off">;
export const EFFORT_ORDINAL: readonly GradedEffort[] = ["minimal", "low", "medium", "high", "xhigh", "max"];
export const DEFAULT_EFFORT: GradedEffort = "high";
export const RECOMMENDED_EFFORT_SUFFIX = "  (recommended)";

// UI — labels used by command flow; panel prose/titles live in advisor-ui.ts
export const CHECKMARK = " ✓";

// Messages (static)
export const MSG_ADVISOR_DISABLED = "Advisor disabled";
export const MSG_REQUIRES_INTERACTIVE = "/advisor requires interactive mode";

/**
 * Per-field cap for a structured brief. Generous enough for a real question with
 * cited evidence, small enough that a runaway field cannot reproduce the mirror's
 * failure mode of flooding the advisor with process noise.
 */
export const MAX_FIELD_CHARS = 6_000;

/**
 * Truncate a field, marking the cut so the advisor knows text is missing rather
 * than silently reading a clipped thought as complete.
 */
export function clip(text: string, limit: number): string {
	if (text.length <= limit) return text;
	return `${text.slice(0, limit)}\n…[truncated ${text.length - limit} chars]`;
}
/**
 * Sent as the single bounded retry when the advisor returns no text. A short
 * corrective turn in the SAME advisor session is what makes the retry useful —
 * resending an identical payload would just reproduce the empty reply.
 */
export const MSG_EMPTY_RETRY = "Your previous reply contained no guidance. Reply with your concrete guidance now — a plan, a correction, or a stop signal.";
export const ERR_SESSION_CREATE = (msg: string) => `Advisor session could not be created: ${msg}`;
export const MSG_EFFORT_NOT_SET = "Effort not set — advisor uses the model default";
export const MSG_PERSIST_FAILED = "Failed to save advisor selection — selection not persisted";

// Errors (static)
export const ERR_NO_MODEL = "No advisor model is configured. The user can enable one with the /advisor command.";
export const ERR_CALL_ABORTED = "Advisor call was cancelled before it completed.";
export const ERR_EMPTY_RESPONSE = "Advisor returned no text content.";
export const ERR_NO_MODEL_SELECTED = "no advisor model selected";
export const ERR_NO_QUESTION =
	"Advisor was called without a question. Pass at least { question } describing the decision you need judged.";
export const ERR_NO_QUESTION_DETAIL = "empty question";
export const ERR_EMPTY_RESPONSE_DETAIL = "empty response";
export const ERR_ABORTED_DETAIL = "aborted";
export const ERR_UNKNOWN = "unknown error";

// Errors/messages (parameterized)
export const errMisconfigured = (label: string, err: string) => `Advisor (${label}) is misconfigured: ${err}`;
export const errNoApiKey = (label: string) => `Advisor (${label}) has no API key available.`;
export const errNoApiKeyDetail = (provider: string) => `no API key for ${provider}`;
export const errCallFailed = (err: string | undefined) => `Advisor call failed: ${err ?? ERR_UNKNOWN}`;
export const errCallThrew = (msg: string) => `Advisor call threw: ${msg}`;
export const errSelectionNotFound = (choice: string) => `Advisor selection not found: ${choice}`;
export const errModelUnavailable = (key: string) => `Previously configured advisor model ${key} is no longer available`;
export const msgAdvisorEnabled = (label: string, effort: ThinkingLevel | undefined) =>
	`Advisor: ${label}${effort ? `, ${effort}` : ""}`;
export const msgAdvisorRestored = (label: string, effort: ThinkingLevel | undefined) =>
	`Advisor restored: ${label}${effort ? `, ${effort}` : ""}`;
export const msgAdvisorRestoredInactive = (label: string, effort: ThinkingLevel | undefined) =>
	`Advisor restored: ${label}${effort ? `, ${effort}` : ""} (inactive for current executor)`;
export const msgAdvisorEnabledInactive = (label: string, effort: ThinkingLevel | undefined) =>
	`Advisor: ${label}${effort ? `, ${effort}` : ""} (inactive for current executor)`;
export const msgConsulting = (label: string, effort: ThinkingLevel | undefined) =>
	`Consulting advisor (${label}${effort ? `, ${effort}` : ""})…`;
