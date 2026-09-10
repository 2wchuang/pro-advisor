/**
 * advisor — Advisor-strategy pattern: a zero-param `advisor` tool + `/advisor`
 * command that forward the serialized conversation branch to a separately-
 * configured reviewer model. Advisor has no tools, never emits user-facing
 * output, and returns guidance the executor resumes with.
 *
 * The implementation is one concern per file under this directory; this barrel
 * re-exports the package's public surface (consumed by ../index.ts, the repo-
 * root test/setup.ts, and the advisor.*.test.ts suite via "./advisor/index.js").
 *
 * Module map:
 *   messages     — tool identity, sentinels, effort vocabulary, all strings
 *   config       — persisted config + provider:id key codec
 *   state        — in-memory model/effort selection
 *   policy       — disabledForModels blocklist + blocked predicates
 *   inventory    — globalThis tool-inventory cache + serializer
 *   mirror       — incremental executor-transcript mirror + rebase planning
 *   session-pool — persistent advisor AgentSession per executor session
 *   execute      — one advisor consultation, end to end
 *   register     — advisor tool registration
 *   handlers     — mid-session lifecycle handlers
 *   restore      — session_start restoration + pool disposal
 *   command      — /advisor slash command
 *
 * Removed from the upstream stateless implementation: context.ts and
 * pi-compat.ts. Both existed only to curate a per-call payload and to resolve a
 * global `completeSimple` for it; a persistent session owns its own history and
 * resolves auth through the host runtime, so neither has a caller left.
 */

export { registerAdvisorCommand } from "./command.js";
export { loadAdvisorConfig, saveAdvisorConfig } from "./config.js";
export {
	registerAdvisorBeforeAgentStart,
	registerModelSelectHandler,
	registerThinkingLevelSelectHandler,
} from "./handlers.js";
export { getInventoryMessage, stableStringify } from "./inventory.js";
export { ADVISOR_TOOL_NAME } from "./messages.js";
export {
	buildRebaseContext,
	buildStartingContext,
	buildTranscriptUpdate,
	planMirror,
	renderEntries,
	renderEntry,
} from "./mirror.js";
export { setDisabledForModels } from "./policy.js";
export {
	DEFAULT_PROMPT_GUIDELINES,
	DEFAULT_PROMPT_SNIPPET,
	registerAdvisorTool,
	UPSTREAM_PROMPT_GUIDELINES,
} from "./register.js";
export { __resetAdvisorAnnounced, registerAdvisorSessionStart, restoreAdvisorState } from "./restore.js";
export {
	type AdvisorReply,
	type AdvisorSessionDriver,
	AdvisorSessionPool,
	advisorSessionId,
	advisorSessionPath,
	createAdvisorDriver,
	MIRROR_STATE_CUSTOM_TYPE,
	type MirrorState,
} from "./session-pool.js";
export {
	type AdvisorStatus,
	collectAdvisorStatus,
	formatAdvisorStatus,
	registerAdvisorStatusCommand,
} from "./status.js";
export { getAdvisorEffort, getAdvisorModel, setAdvisorEffort, setAdvisorModel } from "./state.js";
