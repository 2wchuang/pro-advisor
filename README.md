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
pi install git:github.com/2wchuang/pro-advisor@v0.3.0
```

Restart your Pi session. Run `/advisor` to pick the reviewer model — nothing
happens until you do.

> If you were running upstream `@juicesharp/rpiv-advisor`, **replace** that entry
> in `~/.pi/agent/settings.json` rather than adding this one: both register a tool
> named `advisor`, and they share the same config file and session directory.
> See [docs/RELEASING.md](docs/RELEASING.md) for the publisher-side setup.

## What this does and does not claim

The upstream advisor is a **stateless side-call**: every `advisor()` call takes no
parameters, re-serialises the executor's whole conversation branch, and sends it
as a fresh single request. The reviewer sees continuous context because the
executor's history is replayed each time, but the advisor itself remembers nothing
between calls.

This fork makes two changes:

1. the advisor is a **real, persistent Pi `AgentSession`**, one per executor
   session, so a follow-up is a genuine continuation rather than a cold restart;
2. the advisor receives **a brief the executor writes**, not the conversation.

### Why the brief replaced the transcript

The first iteration of this fork *did* forward the transcript, incrementally. It
was measured, and removed — see [docs/ISSUES.md](docs/ISSUES.md) I-9. A real
667,925-character delivery broke down as:

| Content | Share |
| --- | --- |
| executor thinking | 36.2% |
| tool inventory (the advisor calls no tools) | 21.5% |
| raw tool output | 21.1% |
| tool-call signatures | 17.2% |
| executor prose | 3.5% |
| **the user's own words** | **0.5%** |

And it produced a fabrication failure: the payload rendered the transcript with
`[Assistant tool calls]:` / `[Tool result (x)]:` markers and **ended on the
executor's own in-flight `advisor()` call**, so the document's next natural line
was a tool result. The advisor continued the document instead of answering it. In
one reply **11,308 of 15,593 characters (72.5%) were invented executor activity** —
including a commit hash that does not exist in the repository. That text re-entered
the executor's context looking exactly like the real transcript.

**What is claimed:** session continuity, and that the advisor sees only what the
executor chose to send it.

**What the executor must now do:** author the brief. The advisor has no tools, no
conversation access, and no ability to inspect anything. It can only judge what it
is told — so cite primary sources (`file:line`, measured numbers) in `evidence`,
or the advisor can only take the reasoning on trust.

**What is NOT claimed:**

- **Not a token saving relative to the upstream stateless design.** Continuity is
  the goal. The advisor also keeps its own history, which is re-sent to its
  provider each turn like any other chat session — that prefix is the provider's
  to cache or bill, and this package does not promise either.
- **Not faster by construction.** Speed is a side effect, not a contract.
- **No independent verification.** The advisor cannot check a claim you did not
  state. It challenges your reasoning, not your facts.

## Session identity

The advisor session is keyed by the executor session id, so:

| Executor action | Advisor behaviour |
| --- | --- |
| Repeated `advisor()` calls | same advisor session; each call carries its own brief |
| `/new` | new advisor session |
| `/fork` | new advisor session (no cross-branch contamination) |
| `/resume` | reopens the **same** advisor session — same id, same history |
| `/advisor` → different model | `setModel()` on the same session; identity survives the switch |
| `/advisor` → No advisor | sessions disposed; a later re-enable starts fresh |

### Known risk: stale bias in a long-lived advisor session

The advisor's session accumulates its own prior conclusions. If an early
consultation reasoned from a premise that later turned out to be wrong, that
reasoning stays in its history and can keep colouring later advice. The stateless
upstream design read the current branch every call and so carried no such residue.

Nothing in this package demonstrates that the advisor *withdraws* a stale
conclusion. Treat stale bias as an **open risk**, and prefer `/new` when a line of
reasoning has gone definitively wrong. (The pre-I-9 design attempted a "rebase"
that re-stated the transcript and told the advisor its earlier reading was
superseded; that mechanism is gone with the mirror, so this risk is now
unmitigated by wording as well.)

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
(`session-pool.ts`) — belt and braces now that the payload is a brief: a summary
of a brief cannot describe the executor's task as the advisor's own, but the
inversion is too costly to leave to that argument alone.

Sessions are stored under `~/.pi/agent/pro-advisor/`.

## Safety

The advisor session is constructed with extensions, skills, prompt templates,
themes, context files, and **all tools disabled**. It cannot call a tool, cannot
write to your transcript, and cannot recursively load this extension.

Failure handling is conservative: a failed, aborted, or empty consultation never
claims success. An empty response is retried **exactly once**, with a short
corrective prompt in the same advisor session. Aborted and provider-error replies
are never retried.

A call with no `question` is refused **before** a session is created or a paid
call is made.

## Payload shape is load-bearing

The consultation payload is built by `advisor/brief.ts` and is deliberately **not**
a continuable transcript. That is a correctness property, not a style preference —
see [docs/ISSUES.md](docs/ISSUES.md) I-9. Two rules are enforced by tests:

- the payload never emits `[Assistant]:` / `[Assistant thinking]:` /
  `[Assistant tool calls]:` / `[Tool result (x)]:` markers;
- it always **ends on an instruction**, never on a pending action.

Fields are capped at 6,000 characters each and truncation is marked inline, so a
clipped thought is not silently read as complete.

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
| `advisor/brief.ts` | **new** — structured-payload construction (replaced the transcript mirror) |
| `advisor/status.ts` | **new** — `/advisor-status`: sessions, turns, on-disk history size |
| `advisor/execute.ts` | **rewritten** — drives the session with a brief instead of a stateless completion |
| `advisor/register.ts` | **changed** — structured schema; `DEFAULT_PROMPT_GUIDELINES` rewritten; see *Advisor voice* below |
| `index.ts`, `advisor/handlers.ts`, `advisor/restore.ts`, `advisor/command.ts` | **minimally wired** — pool injection, dispose on session switch/shutdown |
| `advisor/context.ts`, `advisor/pi-compat.ts` | **removed** — both existed only to shape a per-call payload and resolve a global completion for it |
| `advisor/mirror.ts` | **removed** — forwarded the executor transcript; measured 99.5% process noise and induced payload fabrication (I-9) |
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

236 tests. Upstream's are retained where they still describe the code, and
transport-specific tests were **replaced** rather than dropped:

- `advisor/pi-compat.test.ts` and `advisor.strip.test.ts` tested the removed
  completion resolution and tail-massaging; they are replaced by
  `advisor.brief.test.ts` (payload construction + I-9 shape guards) and
  `advisor.session-pool.test.ts` (session identity, isolation, resume,
  concurrency, zero tools).
- `advisor.mirror.test.ts` covered incremental delivery and rebase planning for
  the mirror; it was deleted with the mirror. The equivalent concern — what the
  advisor actually receives — now lives in `advisor.brief.test.ts`.
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
