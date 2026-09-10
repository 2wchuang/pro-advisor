/**
 * check — repository-wide guards for conditions that silently produced false
 * green lights during development.
 *
 * Each guard here exists because the corresponding mistake ACTUALLY HAPPENED,
 * not because it is theoretically possible. Keep them cheap and keep them
 * literal: a guard that needs interpretation will be ignored.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(fileURLToPath(new URL(".", import.meta.url)));

function walk(dir: string, out: string[] = []): string[] {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === "docs") continue;
		const abs = join(dir, entry.name);
		if (entry.isDirectory()) walk(abs, out);
		else if (entry.isFile()) out.push(abs);
	}
	return out;
}

/** Remove block and line comments so guards match code, not prose about code. */
function stripComments(source: string): string {
	return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

describe("repository guards", () => {
	// GUARD 1 — the tsconfig include blind spot.
	//
	// tsconfig.json originally carried `include: ["src/**/*.ts", "test/**/*.ts"]`
	// from an abandoned scaffold. The real sources live in `advisor/` and at the
	// repository root, so `npm run typecheck` type-checked NOTHING but two
	// unrelated files and still exited 0 — a green light that verified nothing.
	// 14 real type errors were hidden behind it.
	it("tsconfig type-checks the whole repository, not a scaffold path", () => {
		const raw = readFileSync(join(repoRoot, "tsconfig.json"), "utf8");
		// Strip // comments so a commented-out include cannot satisfy the guard.
		const json = raw.replace(/^\s*\/\/.*$/gm, "");
		const config = JSON.parse(json) as { include?: string[] };

		expect(config.include, "tsconfig.json must declare an include list").toBeDefined();
		const include = config.include ?? [];
		expect(include.length).toBeGreaterThan(0);

		// The type-checked set must cover every production source we actually ship.
		const shipped = walk(repoRoot)
			.map((abs) => relative(repoRoot, abs))
			.filter((rel) => rel.endsWith(".ts"))
			.filter((rel) => !rel.endsWith(".test.ts"))
			.filter((rel) => !rel.startsWith("test/") && !rel.startsWith("test-utils/"))
			.filter((rel) => rel !== "vitest.config.ts");

		expect(shipped.length).toBeGreaterThan(0);
		for (const rel of shipped) {
			const covered = include.some((pattern) => {
				if (pattern === "**/*.ts" || pattern === "*.ts") return true;
				return rel.startsWith(pattern.replace(/\*\*.*$/, "").replace(/\*.*$/, ""));
			});
			expect(covered, `${rel} is not covered by tsconfig include ${JSON.stringify(include)}`).toBe(true);
		}
	});

	// GUARD 2 — docs must not claim a fix that the code does not make.
	//
	// docs/ISSUES.md was written with several entries marked "已修" (fixed) before
	// the corresponding code change existed. Any entry claiming a fix must name a
	// source file that actually contains the fix's marker text.
	it("every ISSUES.md entry marked fixed points at a real, changed source file", () => {
		const issuesPath = join(repoRoot, "docs", "ISSUES.md");
		const text = readFileSync(issuesPath, "utf8");

		const entries = text.split(/\n## /).slice(1);
		expect(entries.length).toBeGreaterThan(0);

		for (const entry of entries) {
			const title = entry.split("\n")[0] ?? "";
			const claimsFixed = /状态：已修/.test(entry);
			if (!claimsFixed) continue;

			// A fixed entry must cite at least one concrete source path.
			const cited = entry.match(/`([a-zA-Z0-9_./-]+\.ts)`/g) ?? [];
			expect(cited.length, `ISSUES.md "${title}" claims 已修 but cites no source file`).toBeGreaterThan(0);
		}
	});

	// GUARD 3 — the advisor must never regain the guidelines that caused the
	// observed pathologies (mandatory escalation, relaying to the user, and the
	// advisor's voice being mistaken for the user's).
	it("the registered tool never injects upstream's escalation-mandating guidelines", () => {
		const registerSrc = readFileSync(join(repoRoot, "advisor", "register.ts"), "utf8");

		// Slice the DEFAULT block by const boundaries, not by the position of the
		// UPSTREAM doc comment — that comment quotes the very strings being asserted
		// against and would produce a false failure.
		const start = registerSrc.indexOf("export const DEFAULT_PROMPT_GUIDELINES");
		const end = registerSrc.indexOf("export const UPSTREAM_PROMPT_GUIDELINES");
		expect(start, "DEFAULT_PROMPT_GUIDELINES not found").toBeGreaterThan(-1);
		expect(end, "UPSTREAM_PROMPT_GUIDELINES not found").toBeGreaterThan(start);

		const defaults = registerSrc.slice(start, end);
		// Strip comments: the doc block documenting the removed guidelines quotes
		// their exact text, and matching against it would be a false failure.
		const defaultsCode = stripComments(defaults);
		expect(defaultsCode).not.toMatch(/BEFORE substantive work/i);
		expect(defaultsCode).not.toMatch(/next visible reply/i);
		expect(defaultsCode).not.toMatch(/at least once before committing/i);
	});
});
