import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createMockPi } from "./test-utils/index.js";
import { describe, expect, it } from "vitest";
import {
	ADVISOR_TOOL_NAME,
	DEFAULT_PROMPT_GUIDELINES,
	DEFAULT_PROMPT_SNIPPET,
	UPSTREAM_PROMPT_GUIDELINES,
	loadAdvisorConfig,
	registerAdvisorTool,
	saveAdvisorConfig,
} from "./advisor/index.js";

const CONFIG_PATH = join(process.env.HOME!, ".config", "rpiv-advisor", "advisor.json");

function writeConfig(data: Record<string, unknown>): void {
	mkdirSync(dirname(CONFIG_PATH), { recursive: true });
	writeFileSync(CONFIG_PATH, JSON.stringify(data, null, 2), "utf-8");
}

describe("registerAdvisorTool — guidance overrides", () => {
	// Upstream asserted the OPPOSITE of these three: that the defaults require
	// restating advisor guidance in every visible reply. That requirement is the
	// documented cause of the executor reporting to the advisor instead of the
	// user (docs/ISSUES.md I-2/I-4), so the assertion is inverted deliberately.
	it("defaults make the user, not the advisor, the decision-maker", () => {
		expect(DEFAULT_PROMPT_GUIDELINES.some((g) => g.includes("decision-maker"))).toBe(true);
		expect(DEFAULT_PROMPT_GUIDELINES.some((g) => g.includes("the user wins"))).toBe(true);
	});

	it("defaults forbid attributing the advisor's views to the user", () => {
		expect(
			DEFAULT_PROMPT_GUIDELINES.some(
				(g) => g.includes("never to the user") || g.includes("Attribution"),
			),
		).toBe(true);
	});

	it("defaults do NOT mandate calling the advisor before substantive work", () => {
		const joined = DEFAULT_PROMPT_GUIDELINES.join("\n");
		expect(joined).not.toMatch(/BEFORE substantive work/i);
		expect(joined).not.toMatch(/at least once before committing/i);
		// A task may legitimately use none.
		expect(joined).toContain("no minimum number of calls");
	});

	it("defaults do NOT require restating advisor guidance in every visible reply", () => {
		const joined = DEFAULT_PROMPT_GUIDELINES.join("\n");
		expect(joined).not.toContain("next visible reply");
		expect(joined).not.toContain("collapsed tool results");
	});

	it("upstream guidelines are retained for migration reference", () => {
		// Kept so the removed behaviour stays inspectable rather than erased.
		expect(UPSTREAM_PROMPT_GUIDELINES.length).toBeGreaterThan(0);
		expect(DEFAULT_PROMPT_GUIDELINES).not.toEqual(UPSTREAM_PROMPT_GUIDELINES);
	});

	it("uses built-in defaults when no config file exists", () => {
		const { pi, captured } = createMockPi();
		registerAdvisorTool(pi);
		const tool = captured.tools.get(ADVISOR_TOOL_NAME)!;
		expect(tool.promptSnippet).toBe(DEFAULT_PROMPT_SNIPPET);
		expect(tool.promptGuidelines).toBe(DEFAULT_PROMPT_GUIDELINES);
	});

	it("uses built-in defaults when config has no guidance field", () => {
		writeConfig({ modelKey: "anthropic:opus" });
		const { pi, captured } = createMockPi();
		registerAdvisorTool(pi);
		const tool = captured.tools.get(ADVISOR_TOOL_NAME)!;
		expect(tool.promptSnippet).toBe(DEFAULT_PROMPT_SNIPPET);
		expect(tool.promptGuidelines).toBe(DEFAULT_PROMPT_GUIDELINES);
	});

	it("overrides promptSnippet with valid value", () => {
		writeConfig({ guidance: { promptSnippet: "Custom advisor snippet" } });
		const { pi, captured } = createMockPi();
		registerAdvisorTool(pi);
		const tool = captured.tools.get(ADVISOR_TOOL_NAME)!;
		expect(tool.promptSnippet).toBe("Custom advisor snippet");
		expect(tool.promptGuidelines).toBe(DEFAULT_PROMPT_GUIDELINES);
	});

	it("overrides promptGuidelines with valid value", () => {
		writeConfig({ guidance: { promptGuidelines: ["Rule one", "Rule two"] } });
		const { pi, captured } = createMockPi();
		registerAdvisorTool(pi);
		const tool = captured.tools.get(ADVISOR_TOOL_NAME)!;
		expect(tool.promptSnippet).toBe(DEFAULT_PROMPT_SNIPPET);
		expect(tool.promptGuidelines).toEqual(["Rule one", "Rule two"]);
	});

	it("overrides both promptSnippet and promptGuidelines", () => {
		writeConfig({ guidance: { promptSnippet: "Custom", promptGuidelines: ["Rule"] } });
		const { pi, captured } = createMockPi();
		registerAdvisorTool(pi);
		const tool = captured.tools.get(ADVISOR_TOOL_NAME)!;
		expect(tool.promptSnippet).toBe("Custom");
		expect(tool.promptGuidelines).toEqual(["Rule"]);
	});

	it("falls back to defaults on empty promptSnippet", () => {
		writeConfig({ guidance: { promptSnippet: "" } });
		const { pi, captured } = createMockPi();
		registerAdvisorTool(pi);
		const tool = captured.tools.get(ADVISOR_TOOL_NAME)!;
		expect(tool.promptSnippet).toBe(DEFAULT_PROMPT_SNIPPET);
	});

	it("falls back to defaults on empty promptGuidelines array", () => {
		writeConfig({ guidance: { promptGuidelines: [] } });
		const { pi, captured } = createMockPi();
		registerAdvisorTool(pi);
		const tool = captured.tools.get(ADVISOR_TOOL_NAME)!;
		expect(tool.promptGuidelines).toBe(DEFAULT_PROMPT_GUIDELINES);
	});

	it("falls back to defaults on wrong types", () => {
		writeConfig({ guidance: { promptSnippet: 123, promptGuidelines: "not-array" } });
		const { pi, captured } = createMockPi();
		registerAdvisorTool(pi);
		const tool = captured.tools.get(ADVISOR_TOOL_NAME)!;
		expect(tool.promptSnippet).toBe(DEFAULT_PROMPT_SNIPPET);
		expect(tool.promptGuidelines).toBe(DEFAULT_PROMPT_GUIDELINES);
	});

	it("falls back to defaults on promptGuidelines with empty string item", () => {
		writeConfig({ guidance: { promptGuidelines: ["valid", ""] } });
		const { pi, captured } = createMockPi();
		registerAdvisorTool(pi);
		const tool = captured.tools.get(ADVISOR_TOOL_NAME)!;
		expect(tool.promptGuidelines).toBe(DEFAULT_PROMPT_GUIDELINES);
	});
});

describe("saveAdvisorConfig — preserves guidance field", () => {
	it("preserves guidance when saving model selection", () => {
		writeConfig({ guidance: { promptSnippet: "Custom" } });
		saveAdvisorConfig("anthropic:opus", "high");
		const config = loadAdvisorConfig();
		expect(config.modelKey).toBe("anthropic:opus");
		expect(config.effort).toBe("high");
		expect(config.guidance).toEqual({ promptSnippet: "Custom" });
	});

	it("preserves guidance when resetting advisor", () => {
		writeConfig({ modelKey: "anthropic:opus", guidance: { promptSnippet: "Custom" } });
		saveAdvisorConfig(undefined, undefined);
		const config = loadAdvisorConfig();
		expect(config.modelKey).toBeUndefined();
		expect(config.guidance).toEqual({ promptSnippet: "Custom" });
	});
});

describe("saveAdvisorConfig — preserves disabledForModels field", () => {
	it("preserves disabledForModels when saving model selection", () => {
		writeConfig({ disabledForModels: ["anthropic:claude-opus-4-7"] });
		saveAdvisorConfig("anthropic:sonnet", "high");
		const config = loadAdvisorConfig();
		expect(config.modelKey).toBe("anthropic:sonnet");
		expect(config.effort).toBe("high");
		expect(config.disabledForModels).toEqual(["anthropic:claude-opus-4-7"]);
	});

	it("preserves disabledForModels when resetting advisor", () => {
		writeConfig({
			modelKey: "anthropic:sonnet",
			disabledForModels: ["anthropic:claude-opus-4-7", "openai:o3"],
		});
		saveAdvisorConfig(undefined, undefined);
		const config = loadAdvisorConfig();
		expect(config.modelKey).toBeUndefined();
		expect(config.disabledForModels).toEqual(["anthropic:claude-opus-4-7", "openai:o3"]);
	});
});

describe("saveAdvisorConfig — preserves disabledForModels with object entries", () => {
	it("preserves object entries with minEffort when saving model selection", () => {
		writeConfig({
			disabledForModels: ["anthropic:haiku", { model: "anthropic:sonnet", minEffort: "high" }],
		});
		saveAdvisorConfig("anthropic:opus", "high");
		const config = loadAdvisorConfig();
		expect(config.disabledForModels).toEqual(["anthropic:haiku", { model: "anthropic:sonnet", minEffort: "high" }]);
	});

	it("preserves object entries without minEffort when resetting advisor", () => {
		writeConfig({
			modelKey: "anthropic:opus",
			disabledForModels: [{ model: "anthropic:sonnet" }],
		});
		saveAdvisorConfig(undefined, undefined);
		const config = loadAdvisorConfig();
		expect(config.modelKey).toBeUndefined();
		expect(config.disabledForModels).toEqual([{ model: "anthropic:sonnet" }]);
	});
});
