/**
 * status — `/advisor-status`: make the advisor's cost and state observable.
 *
 * I-6 in docs/ISSUES.md: a persistent advisor session grows its history on every
 * consultation, but nothing surfaced how large it had become. The README says
 * "not a guaranteed token saving" — without this command that disclaimer is
 * unverifiable, and the user has to take it on faith.
 *
 * This reports what is actually knowable from the session files: how many advisor
 * sessions exist, how many turns each has accumulated, and how large each
 * session file has grown. It deliberately does NOT claim to measure tokens or
 * money — session-file bytes are a proxy, and reporting them as cost would be the
 * same kind of overclaim this whole exercise is correcting.
 */

import { statSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { modelKey } from "@juicesharp/rpiv-config";
import { advisorSessionPath } from "./session-pool.js";
import type { AdvisorSessionPool } from "./session-pool.js";
import { getAdvisorEffort, getAdvisorModel } from "./state.js";

const MSG_REQUIRES_INTERACTIVE = "/advisor-status requires interactive mode";

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export interface AdvisorStatus {
	model?: string;
	effort?: string;
	sessions: Array<{
		executorSessionId: string;
		advisorSessionId: string;
		turns: number;
		activeTools: number;
		/** Bytes of the advisor session file, or undefined if never flushed. */
		sessionBytes?: number;
	}>;
	/** Sum of known session-file sizes. A proxy for history size, not a cost. */
	totalBytes: number;
}

/**
 * Collect the status. Reads only in-memory pool state plus filesystem sizes, so
 * it is cheap and safe to call at any time — it never prompts the advisor.
 */
export function collectAdvisorStatus(pool: AdvisorSessionPool, agentDir: string): AdvisorStatus {
	const model = getAdvisorModel();
	const effort = getAdvisorEffort();
	const sessions: AdvisorStatus["sessions"] = [];
	let totalBytes = 0;

	for (const executorSessionId of pool.ids()) {
		const driver = pool.get(executorSessionId);
		if (!driver) continue;
		let sessionBytes: number | undefined;
		try {
			sessionBytes = statSync(advisorSessionPath(agentDir, executorSessionId)).size;
			totalBytes += sessionBytes;
		} catch {
			// Not yet flushed: a session file only materialises after the first
			// advisor turn. Absence is reported as undefined rather than 0 B.
			sessionBytes = undefined;
		}
		sessions.push({
			executorSessionId,
			advisorSessionId: driver.sessionId,
			turns: driver.turns,
			activeTools: driver.activeToolNames().length,
			sessionBytes,
		});
	}

	const status: AdvisorStatus = { sessions, totalBytes };
	if (model) status.model = modelKey(model);
	if (effort) status.effort = effort;
	return status;
}

/** Render the status as the lines shown by `/advisor-status`. */
export function formatAdvisorStatus(status: AdvisorStatus): string[] {
	const lines: string[] = [];
	lines.push(
		status.model
			? `Advisor: ${status.model}${status.effort ? `, ${status.effort}` : ""}`
			: "Advisor: not configured (run /advisor)",
	);

	if (status.sessions.length === 0) {
		lines.push("Sessions: none yet — the first advisor() call creates one.");
		return lines;
	}

	lines.push(`Sessions: ${status.sessions.length} (one per executor session)`);
	for (const session of status.sessions) {
		const bytes = session.sessionBytes === undefined ? "not yet written" : formatBytes(session.sessionBytes);
		lines.push(
			`  • executor ${session.executorSessionId}\n` +
				`      advisor ${session.advisorSessionId}\n` +
				`      turns ${session.turns}, tools ${session.activeTools}, file ${bytes}`,
		);
	}
	lines.push(`Total on disk: ${formatBytes(status.totalBytes)} (history size, not a token or cost figure)`);
	return lines;
}

export function registerAdvisorStatusCommand(pi: ExtensionAPI, pool: AdvisorSessionPool): void {
	pi.registerCommand("advisor-status", {
		description: "Show advisor sessions, accumulated turns, and on-disk history size",
		handler: async (_args: string, ctx: ExtensionContext) => {
			if (!ctx.hasUI) {
				ctx.ui.notify(MSG_REQUIRES_INTERACTIVE, "error");
				return;
			}
			const { getAgentDir } = await import("@earendil-works/pi-coding-agent");
			const status = collectAdvisorStatus(pool, getAgentDir());
			for (const line of formatAdvisorStatus(status)) ctx.ui.notify(line, "info");
		},
	});
}
