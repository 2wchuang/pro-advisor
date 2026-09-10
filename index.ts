/**
 * pro-advisor — Pi extension
 *
 * A second opinion the model can request from a stronger reviewer model before
 * it acts. Forked from @juicesharp/rpiv-advisor (MIT); see README for what
 * changed and LICENSE for the original copyright.
 *
 * The one behavioural change from upstream: the advisor is a PERSISTENT Pi
 * AgentSession keyed by executor session id, not a stateless side-call. The
 * first consultation delivers the executor's resolved context as the advisor's
 * starting context; later ones append only what changed.
 *
 * Registers the `advisor` tool, the `/advisor` command, and four lifecycle
 * hooks (session_start restore, before_agent_start strip, model_select
 * re-evaluation, thinking_level_select re-evaluation).
 *
 * Config persists at ~/.config/rpiv-advisor/advisor.json, unchanged from
 * upstream so an existing selection carries over.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	registerAdvisorBeforeAgentStart,
	registerAdvisorCommand,
	registerAdvisorSessionStart,
	registerAdvisorStatusCommand,
	registerAdvisorTool,
	registerModelSelectHandler,
	registerThinkingLevelSelectHandler,
} from "./advisor/index.js";
import { AdvisorSessionPool } from "./advisor/session-pool.js";

export default function (pi: ExtensionAPI) {
	const pool = new AdvisorSessionPool();

	registerAdvisorTool(pi, pool);
	registerAdvisorCommand(pi, pool);
	registerAdvisorStatusCommand(pi, pool);
	registerAdvisorBeforeAgentStart(pi);
	registerModelSelectHandler(pi);
	registerThinkingLevelSelectHandler(pi);
	registerAdvisorSessionStart(pi, pool);
}
