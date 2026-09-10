import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, vi } from "vitest";

const TEST_HOME = mkdtempSync(join(tmpdir(), "pro-advisor-test-home-"));
process.env.HOME = TEST_HOME;
process.env.USERPROFILE = TEST_HOME;
delete process.env.PI_CODING_AGENT_DIR;
delete process.env.XDG_CONFIG_HOME;

vi.mock("@earendil-works/pi-ai", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@earendil-works/pi-ai")>();
	return {
		...actual,
		getSupportedThinkingLevels: vi.fn(() => ["off", "minimal", "low", "medium", "high"]),
	};
});

// Modules are imported dynamically inside beforeEach by deliberate design:
// static imports would hoist above the HOME override and let production
// homedir() captures leak into the developer's real ~/.config.
beforeEach(async () => {
	delete process.env.PI_CODING_AGENT_DIR;
	delete process.env.XDG_CONFIG_HOME;

	const advisor = await import("../advisor/index.js");
	advisor.setAdvisorModel(undefined);
	advisor.setAdvisorEffort(undefined);
	advisor.setDisabledForModels([]);
	advisor.__resetAdvisorAnnounced();
	const fixtures = await import("../test-utils/index.js");
	fixtures.__resetFixtureIds();

	delete (globalThis as Record<symbol, unknown>)[Symbol.for("rpiv-advisor")];

	const advisorConfig = join(process.env.HOME!, ".config", "rpiv-advisor", "advisor.json");
	const globalAgentDir = join(process.env.HOME!, ".pi", "agent");
	rmSync(advisorConfig, { force: true });
	rmSync(globalAgentDir, { recursive: true, force: true });
});
