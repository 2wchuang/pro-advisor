# @2wchuang/pro-advisor

Pi extension. A second opinion from a stronger reviewer model — kept in **one
persistent session per executor session**.

Forked from [`@juicesharp/rpiv-advisor`](https://pi.dev/packages/@juicesharp/rpiv-advisor)
(MIT). The tool surface, `/advisor` command, config file, and picker are
unchanged; the advisor session layer is replaced. See
[What changed from upstream](#what-changed-from-upstream).

## Install

From npm:

```bash
pi install npm:@2wchuang/pro-advisor
```

Or from git — no npm account or registry involved:

```bash
pi install git:github.com/2wchuang/pro-advisor@v0.2.1
```

Restart your Pi session. Run `/advisor` to pick the reviewer model — nothing
happens until you do.

> If you were running upstream `@juicesharp/rpiv-advisor`, **replace** that entry
> in `~/.pi/agent/settings.json` rather than adding this one: both register a tool
> named `advisor`, and they share the same config file and session directory.
> See [docs/RELEASING.md](docs/RELEASING.md) for the publisher-side setup.

## What this does and does not claim

The upstream advisor is a **stateless side-call**: every `advisor()` call
re-serialises the executor's whole conversation branch and sends it as a fresh
single request. The reviewer sees continuous context because the executor's
history is replayed each time, but the advisor itself remembers nothing between
calls, and its own replies are not part of any continuing conversation.

This fork makes the advisor a **real, persistent Pi `AgentSession`**, one per
executor session:

- the first consultation delivers the executor's resolved context once, as the
  advisor's *starting context*
- later consultations append **only the executor entries produced since the
  previous one**
- the advisor's own prior turns stay in its session, so a follow-up is a
  genuine continuation rather than a cold restart

**What is claimed:** session continuity, a stable append-only prefix, and no
re-transmission of already-delivered executor context **into the advisor's
session**.

**Measured, not assumed.** Two live consultations in one executor session, with a
~1.8 MB executor branch:

| | executor context handed over (JSONL) | provider `usage.input` | provider `cacheRead` |
| --- | --- | --- | --- |
| 1st call | 1,859,126 B | 456,675 | 0 |
| 2nd call | **19,239 B** | **7,440** | **456,448** |

So the incremental delivery is real — the second call handed over 19 KB instead of
1.86 MB. But it is a statement about *what the plugin writes into the advisor
session*, not about what the provider receives.

**What is NOT claimed:**

- **No provider-side cache guarantee.** `cacheRead: 456,448` on the second call
  shows the advisor's history is re-serialised and re-sent to its provider in
  full, exactly like any other chat session; the executor delta is a small
  addition to an unchanged prefix. Whether that prefix is billed or served from
  cache is the provider's decision, and this package cannot promise it.
- **Not a guaranteed token saving.** On a long-lived advisor session the
  accumulated advisor history can cost more per turn than a stateless call would.
- **Not faster by construction.** Continuity is the goal; speed is a side
effect, not a contract.

## Session identity

The advisor session is keyed by the executor session id, so:

| Executor action | Advisor behaviour |
| --- | --- |
| Repeated `advisor()` calls | same advisor session, incremental delivery |
| `/new` | new advisor session |
| `/fork` | new advisor session (no cross-branch contamination) |
| `/resume` | reopens the **same** advisor session — same id, same history, same mirror watermark |
| `/advisor` → different model | `setModel()` on the same session; identity survives the switch |
| `/advisor` → No advisor | sessions disposed; a later re-enable starts fresh |

### Known risk: stale bias in a long-lived advisor session

The advisor's session accumulates its own prior conclusions. If an early
consultation reasoned from a premise that later turned out to be wrong, that
reasoning stays in its history and can keep colouring later advice. The
stateless upstream design re-read the current branch every call and so carried no
such residue.

`planMirror()` rebases when the watermark is gone or a compaction intervened, and
`buildRebaseContext()` tells the advisor that earlier transcript content is
superseded. **That is prompt wording, not demonstrated forgetting** — no test yet
shows that the advisor actually withdraws a stale conclusion after a rebase. Until
one does, treat this as an open risk rather than a solved problem, and prefer
`/new` when a line of reasoning has gone definitively wrong.

### Fixed: compaction inverted the advisor's identity

Observed live, on the first session long enough to cross Pi's auto-compaction
threshold (`tokensBefore: 510,091`): the advisor stopped advising and asked the
executor for instructions — *"I need your guidance on where we stand"* — then
listed the executor's publishing milestones as its own achievements.

Cause: an advisor session is a real Pi `AgentSession`, so Pi's auto-compaction
applied to it too. Its summarizer is written for the **executor** — the template
asks for `## Goal`, `## Constraints & Preferences`, `## Progress`, `## Next Steps`.
The advisor's transcript is a *mirror of the executor's work*, so summarising it
produced a document describing the executor's task as the advisor's own, and the
advisor adopted that identity.

Upstream could not hit this: a stateless side-call keeps no session, so there was
nothing to compact. It is a hazard the persistent design introduced.

Fixed by disabling auto-compaction on the advisor session
(`session-pool.ts`). The trade-off is that a very long advisor session keeps
growing, which this fork already documents — preferable to silent role inversion.

Sessions are stored under `~/.pi/agent/pro-advisor/`. Mirror bookkeeping (the
"already delivered" watermark) is written into the advisor session file itself
as a custom entry, so it survives `/resume` with no side-channel file.

## Safety

The advisor session is constructed with extensions, skills, prompt templates,
themes, context files, and **all tools disabled**. It cannot call a tool, cannot
write to your transcript, and cannot recursively load this extension.

Failure handling is conservative: a failed, aborted, or empty consultation does
**not** advance the watermark, so the next call re-delivers the same entries.
Duplicating context is deliberate — skipping it could silently hide executor
work from the reviewer.

An empty response is retried **exactly once**, with a short corrective prompt in
the same advisor session. Aborted and provider-error replies are never retried.

## Context rebase

An incremental delivery assumes the executor's entry graph still extends what the
advisor already read. Two events break that, and both trigger an explicit rebase
that re-states the transcript in full and marks it as superseding earlier
content:

- **compaction** — the resolved context collapsed older entries into a summary
- **divergence** — the executor branched or forked away, so the watermark is no
  longer on the current leaf path

A rebase resets only the *mirrored transcript*. The advisor keeps its own prior
reasoning, so it is told its earlier reading is superseded rather than being
cold-started.

## Configuration

Unchanged from upstream: `~/.config/rpiv-advisor/advisor.json` (shared on
purpose, so an existing selection carries over).

```json
{
  "modelKey": "anthropic/claude-opus-4-5",
  "effort": "high",
  "disabledForModels": [
    "anthropic/claude-opus-4-5",
    { "model": "openai/gpt-5.2", "minEffort": "high" }
  ]
}
```

| Key | What it does | Default |
| --- | --- | --- |
| `modelKey` | Reviewer model as `"provider/modelId"`. Written by `/advisor`. | absent — advisor off |
| `effort` | Reviewer reasoning effort. Written by `/advisor`. | absent — model default |
| `disabledForModels` | Executor models the advisor is stripped for. Plain strings block at any effort; `{ model, minEffort }` blocks at or above that effort. | `[]` |
| `guidance` | Overrides for the tool's `promptSnippet` / `promptGuidelines`. | built-in |

The tool is stripped from the active set — so none of its prompt text enters the
system prompt — when no model is selected, the configured model is unavailable,
or the executor matches `disabledForModels`.

## What changed from upstream

Most files are retained verbatim. The session layer is new:

| File | Status |
| --- | --- |
| `advisor/session-pool.ts` | **new** — persistent advisor session + pool |
| `advisor/mirror.ts` | **new** — incremental delivery + rebase planning |
| `advisor/status.ts` | **new** — `/advisor-status`: sessions, turns, on-disk history size |
| `advisor/execute.ts` | **rewritten** — drives the session instead of a stateless completion |
| `advisor/register.ts` | **changed** — `DEFAULT_PROMPT_GUIDELINES` rewritten; see *Advisor voice* below |
| `index.ts`, `advisor/handlers.ts`, `advisor/restore.ts`, `advisor/command.ts` | **minimally wired** — pool injection, dispose on session switch/shutdown |
| `advisor/context.ts`, `advisor/pi-compat.ts` | **removed** — both existed only to shape a per-call payload and resolve a global completion for it |
| everything else incl. `advisor/config.ts`, `messages.ts`, `policy.ts`, `state.ts`, `inventory.ts`, `advisor-ui.ts`, `fuzzy.ts` | **unchanged** |

### Advisor voice

Upstream's injected guidelines made the advisor a gate every non-trivial task had
to pass — "Call `advisor` BEFORE substantive work", "at least once before
committing to an approach and once before declaring done", "Give the advisor's
advice serious weight", "put the advisor's key guidance into your next visible
reply to the user". Observed consequences: mandatory escalation, the executor
reporting *to* the advisor rather than to the user, and the advisor's position
being restated as though the user had said it.

The rewritten defaults invert each of those: the **user** is named the
decision-maker ("if the advisor and the user disagree, the user wins"), there is
explicitly **no minimum number of calls**, and the advisor's views must be
attributed to the advisor and never to the user. Reporting a consultation is
limited to cases where it actually changed the plan, and framed as the executor's
own decision. The original strings are retained as
`UPSTREAM_PROMPT_GUIDELINES` for reference and regression-testing.

See `docs/ISSUES.md` for each finding with its evidence, and `repo-guards.test.ts`
for the guards that keep these regressions from returning.

### Test coverage

232 tests. Upstream's 205 are retained where they still describe the code, and
transport-specific tests were **replaced** rather than dropped:

- `advisor/pi-compat.test.ts` and `advisor.strip.test.ts` tested the removed
  completion resolution and tail-massaging; they are replaced by
  `advisor.mirror.test.ts` (delivery policy, rebase, rendering) and
  `advisor.session-pool.test.ts` (session identity, isolation, resume,
  concurrency, zero tools, watermark round-trip).
- `advisor.execute.test.ts` was rewritten against an injectable
  `AdvisorSessionDriver` seam. The envelope contract is preserved — success,
  auth failure, abort, provider error, thrown error, bounded empty-response
  retry — while the `completeSimple` transport assertions are gone with the
  transport.

## Commands

| Command | Purpose |
| --- | --- |
| `/advisor` | Pick the reviewer model and reasoning effort |
| `/advisor-status` | Show advisor sessions, accumulated turns, and on-disk history size |

`/advisor-status` exists because a persistent advisor session grows its history on
every consultation and nothing previously surfaced how large it had become. It
reports file bytes as a **proxy for history size — not tokens, not cost**, so the
"no guaranteed token saving" disclaimer above stays checkable rather than a
matter of faith.

## Development

```bash
npm install
npm run check        # typecheck + tests
npm run pack:check   # verify the published tarball contains every runtime module
```

## License

MIT. Derivative of `@juicesharp/rpiv-advisor` (MIT, Copyright (c) 2026
juicesharp); see [LICENSE](./LICENSE) for the retained original notice.
