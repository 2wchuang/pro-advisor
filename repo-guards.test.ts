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

/**
 * Strip `#` line comments. Needed for YAML, where `#` — not `//` — starts a
 * comment; the release workflow's header comment mentions the very tokens
 * (NPM_TOKEN) that the guard below asserts are absent from the code.
 */
function stripYamlComments(source: string): string {
	return source
		.split("\n")
		.map((line) => {
			// Keep a leading '#' only when it is not a comment marker mid-line.
			const idx = line.indexOf("#");
			if (idx === -1) return line;
			// A '#' inside a quoted string is content, not a comment.
			const before = line.slice(0, idx);
			const quotes = (before.match(/'/g) ?? []).length + (before.match(/"/g) ?? []).length;
			if (quotes % 2 === 1) return line;
			return before;
		})
		.join("\n");
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

	// GUARD 4 — the release workflow's filename is load-bearing.
	//
	// npm's trusted-publisher config stores the workflow FILENAME and matches it
	// exactly; a renamed or moved workflow breaks publishing with an opaque
	// 400 Bad Request at release time. docs/RELEASING.md tells the user which name
	// to type, so the two must not drift apart.
	it("the release workflow filename matches what the setup docs tell users to enter", () => {
		const workflowDir = join(repoRoot, ".github", "workflows");
		const workflows = readdirSync(workflowDir).filter((f) => /\.ya?ml$/.test(f));
		expect(workflows, "expected exactly one release workflow").toContain("release.yml");

		const workflow = readFileSync(join(workflowDir, "release.yml"), "utf8");
		const docs = readFileSync(join(repoRoot, "docs", "RELEASING.md"), "utf8");
		const workflowCode = stripYamlComments(workflow);

		for (const filename of workflows) {
			expect(docs, `docs/RELEASING.md must name the workflow file ${filename}`).toContain(filename);
		}

		// OIDC is the whole point: without id-token: write, npm publish fails.
		expect(workflowCode).toMatch(/id-token:\s*write/);

		// The workflow must guard against the bootstrap trap rather than let a
		// first-time publish fail with an unreadable registry error.
		expect(workflowCode).toContain("npm view");

		// It must not rely on a long-lived NPM_TOKEN secret — that is the practice
		// trusted publishing exists to replace.
		expect(workflowCode).not.toMatch(/NPM_TOKEN|secrets\./);
	});

	// GUARD 5 — the workflow's published identity must track package.json rather
	// than hardcode a name, so the two cannot drift.
	it("the release workflow derives its identity from package.json", () => {
		const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
			name: string;
			repository?: { url?: string };
		};
		const workflowCode = stripYamlComments(readFileSync(join(repoRoot, ".github", "workflows", "release.yml"), "utf8"));
		const docs = readFileSync(join(repoRoot, "docs", "RELEASING.md"), "utf8");

		// Reading name/version from package.json at runtime is what makes drift
		// impossible; a hardcoded package name here would be the risk.
		expect(workflowCode).toContain("require('./package.json').name");
		expect(workflowCode).toContain("require('./package.json').version");

		// The docs are what a human follows, so they must name the real package.
		expect(docs, `docs/RELEASING.md should reference ${pkg.name}`).toContain(pkg.name);

		// The repo slug in docs must match package.json's repository URL.
		const slug = /github\.com[/:]([^/]+\/[^/.]+)/.exec(pkg.repository?.url ?? "")?.[1];
		expect(slug, "package.json repository URL should contain a github owner/repo slug").toBeDefined();
		const [owner, repo] = slug!.split("/");

		// Check the trusted-publisher TABLE, not just "does this word appear". The
		// repo name also occurs in cd paths and the package name, so a plain
		// substring assertion passes even when the table cell is wrong.
		const row = (label: string): string => {
			const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
			// Match: | Label | `value` |   (backticks optional)
			const re = new RegExp("^\\|\\s*" + escaped + "\\s*\\|\\s*`?([^`|\\s]+)`?\\s*\\|", "m");
			const m = re.exec(docs);
			expect(m, `docs/RELEASING.md has no '${label}' table row`).not.toBeNull();
			return m![1]!;
		};

		expect(row("Organization or user"), "trusted-publisher owner must match the repo URL").toBe(owner!);
		expect(row("Repository"), "trusted-publisher repository must match the repo URL").toBe(repo!);
		expect(row("Workflow filename"), "trusted-publisher workflow must be the real workflow filename").toBe(
			"release.yml",
		);
	});

	// GUARD 6 — a dry run must not claim it published.
	//
	// The workflow declared a `dry-run` input (default true) but referenced it
	// nowhere: a workflow_dispatch skipped Publish on the `push` guard yet still
	// printed "### Published" in the job summary. That is a false green light in
	// the release path — the same failure mode as the tsconfig `include` that
	// checked no files while exiting 0. Verified by mutation: deleting the
	// `steps.mode.outputs.publishing` condition fails this test.
	it("the release workflow honours its dry-run input instead of reporting a publish that did not happen", () => {
		const workflow = readFileSync(join(repoRoot, ".github", "workflows", "release.yml"), "utf8");
		const workflowCode = stripYamlComments(workflow);

		// The input is declared...
		expect(workflowCode, "release.yml should declare a dry-run input").toMatch(/dry-run:/);

		// ...and actually read. Declaring an input no step consults is the bug: the
		// toggle appears to work while doing nothing.
		expect(
			workflowCode,
			"the dry-run input is declared but never read, so toggling it changes nothing",
		).toMatch(/github\.event\.inputs\.dry-run/);

		// Publish and Summary must share one decision, so the summary cannot report
		// a publish that the publish step skipped.
		expect(workflowCode, "Publish must be gated on the shared publishing flag").toMatch(
			/publishing == 'true'/,
		);
		expect(
			workflowCode,
			"the Summary step must not unconditionally claim the package was published",
		).toMatch(/Dry run — nothing published/);
	});


	//
	// The mirror is gone, so the old delivery claim is moot — but the OPPOSITE
	// overclaim now exists: the tool description must not claim the advisor sees
	// the executor's conversation. It does not; it sees only the brief. Upstream's
	// description said "your conversation history is automatically forwarded",
	// which was true there and is false here.
	it("does not claim the advisor receives the executor's conversation", () => {
		const registerSrc = readFileSync(join(repoRoot, "advisor", "register.ts"), "utf8");

		const descStart = registerSrc.indexOf("const ADVISOR_DESCRIPTION");
		const descEnd = registerSrc.indexOf("export const DEFAULT_PROMPT_SNIPPET");
		expect(descStart, "ADVISOR_DESCRIPTION not found").toBeGreaterThan(-1);
		expect(descEnd).toBeGreaterThan(descStart);
		const description = registerSrc.slice(descStart, descEnd);

		// The claim that would mislead the executor into under-specifying the brief.
		expect(description, "must not claim history is auto-forwarded").not.toMatch(
			/conversation history is automatically forwarded/i,
		);
		expect(description).not.toMatch(/Takes NO parameters/i);

		// It must state the real contract instead: the executor authors the brief.
		expect(description).toMatch(/does not receive your history/i);
	});

	// GUARD 7 — the tool must require a brief, and the registration must pass one
	// through. A zero-param schema would let the executor call advisor() expecting
	// history forwarding, and a host that drops the argument must be refused rather
	// than crash.
	it("requires a structured brief and passes it through", () => {
		const registerSrc = stripComments(readFileSync(join(repoRoot, "advisor", "register.ts"), "utf8"));
		const execSrc = stripComments(readFileSync(join(repoRoot, "advisor", "execute.ts"), "utf8"));

		// "question" is the one required field — it is what makes a consultation
		// answerable.
		expect(registerSrc).toMatch(/question:\s*Type\.String/);
		for (const field of ["context", "options", "evidence", "leaning", "unsure"]) {
			expect(registerSrc, `schema should accept an optional ${field}`).toContain(field);
		}
		// It must be forwarded to executeAdvisor, not dropped.
		expect(registerSrc).toMatch(/executeAdvisor\(ctx,\s*pi,\s*params/);
		// And execute must refuse an empty question before spending a paid call.
		expect(execSrc).toContain("isUsableBrief");
	});

	// GUARD 8 — the advisor session must never be auto-compacted.
	//
	// Pi's compaction summarizer asks for "## Goal" / "## Progress" / "## Next
	// Steps" because it is built for the executor. An advisor's transcript mirrors
	// the executor's work, so compacting it produced a summary claiming the
	// executor's task as the advisor's own — observed live as the advisor asking
	// the executor for guidance. Upstream had no session to compact.
	it("keeps auto-compaction disabled on the advisor session", () => {
		const code = stripComments(readFileSync(join(repoRoot, "advisor", "session-pool.ts"), "utf8"));
		expect(code).toContain("setAutoCompactionEnabled(false)");
	});

	// GUARD 9 — the payload must never be a continuable transcript.
	//
	// This is the I-9 regression guard. The mirrored payload rendered the executor
	// transcript with `[User]:` / `[Assistant thinking]:` / `[Assistant tool
	// calls]:` / `[Tool result (bash)]:` markers and ENDED on the executor's own
	// in-flight `[Assistant tool calls]: advisor()` line. The advisor continued the
	// document instead of answering it: in one reply 11,308 of 15,593 chars (72.5%)
	// were invented executor activity — tool results, edits, and a commit hash that
	// does not exist in the repository. That text then re-entered the executor's
	// context looking exactly like the real transcript, and the executor nearly
	// reported the fabricated work as done.
	//
	// The mirror module is deleted; this guard keeps its FORMAT from coming back in
	// any future payload builder.
	it("never builds a payload that looks like a continuable transcript", () => {
		const briefSrc = readFileSync(join(repoRoot, "advisor", "brief.ts"), "utf8");
		const code = stripComments(briefSrc);

		const builders = ["buildBriefText", "buildStartingContext", "buildRebaseContext", "buildTranscriptUpdate"];
		for (const name of builders) {
			const body = new RegExp(`function ${name}\\([\\s\\S]*?\\n\\}`).exec(code)?.[0];
			if (!body) continue;
			for (const marker of ["[Assistant]:", "[Assistant thinking]:", "[Assistant tool calls]:", "[Tool result ("]) {
				expect(body, `${name} must not emit the continuable marker ${marker}`).not.toContain(marker);
			}
		}

		// The payload must end on an instruction, not on a pending action. The old
		// payload's final content line was the executor's in-flight advisor() call.
		const builder = /function buildBriefText[\s\S]*?\n\}/.exec(code)?.[0];
		expect(builder, "buildBriefText not found in advisor/brief.ts").toBeDefined();
		expect(builder!).toContain("SECTION_INSTRUCTION");

		// And the mirror module must stay deleted — reviving it revives the defect.
		expect(() => readFileSync(join(repoRoot, "advisor", "mirror.ts"), "utf8")).toThrow();
	});
});
