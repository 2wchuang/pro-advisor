# 已知问题

本文件记录开发过程中实测暴露的缺陷。每条都带证据与出处，避免只留结论。

状态：`未修` / `已修` / `待定`

---

## I-1 调用时机过激：把"先问顾问"变成默认动作

**状态：已修** — `advisor/register.ts` `DEFAULT_PROMPT_GUIDELINES` 已重写；删除了"before substantive work"与"至少 2 次"的下限。`advisor.guidance.test.ts` 反向断言，`repo-guards.test.ts` 防回归。

上游注入 executor system prompt 的 `promptGuidelines` 原文：

> - Call `advisor` **BEFORE substantive work** — before writing, before committing to an interpretation, before building on an assumption.
> - Also call `advisor` **when you believe the task is complete.**
> - **On tasks longer than a few steps, call `advisor` at least once before committing to an approach and once before declaring done.**

**证据**：在一次普通开发任务中，executor 触发 3 次 advisor 调用——任务起始 1 次、方向调整 1 次、自认为收尾 1 次。没有任何一次是因为"卡住"。

**问题**：第 4 条把"至少 2 次"写成硬性下限，与第 1 条叠加后，任何非平凡任务都必须先请示。advisor 从"卡住时的兜底"变成"每次决策的关卡"。

**成因**：guideline 是命令句，不是建议句。executor 会照做。

---

## I-2 强制转述：要求把 advisor 的话搬进每个用户可见回复

**状态：已修** — `advisor/register.ts` 中原"put the advisor's key guidance into your next visible reply to the user"已删除，替换为"仅在指导意见实质改变计划时报告，且报告为自己的决策"。保留其合理动机（用户看不到折叠的 tool result）。

同文件原文：

> - After each `advisor` result, put the advisor's key guidance into your **next visible reply to the user** before continuing — quote or paraphrase the plan, correction, or stop signal.

**证据**：用户直接观察到"我觉得你在对 advisor 汇报"。

**问题**：这条字面要求 executor 在每个用户可见回合里转述 advisor。它**制造**了汇报感——用户看到的不是 executor 的判断，而是 advisor 意见的二手转达。

**注意**：这条 guideline 的**动机是合理的**（用户看不到折叠的 tool result，不能让指导意见烂在 tool 上下文里）。缺陷在于它被写成了**无条件、每次**，而不是**仅在指导意见实质改变了计划时**。

---

## I-3 权威倒置：advisor 被描述成需要服从的对象

**状态：已修** — `advisor/register.ts` guidelines 首条已明确 "The user is the decision-maker, not the advisor... If the advisor and the user disagree, the user wins."

> - Give the advisor's advice **serious weight**.

**问题**：整组 guideline 里，没有任何一条说明**用户**才是决策者。叠加 I-1/I-2 后，advisor 成了 executor 要请示、要服从、要汇报的对象，而用户退成旁听。

**证据**：executor 出现"核心要点我记下了""这戳中了我的实质缺陷""它确认了计划"这类对 advisor 表忠心的措辞。

---

## I-4 声音混淆：advisor 的立场可被误当作用户的话

**状态：已修** — `advisor/register.ts` 新增 guideline："Attribute the advisor's views to the advisor, never to the user."

**证据**：executor 在回复中写出"但你的'准确吗'值得分开回答"——用户从未说过这三个字，那是 advisor 的质疑被冒充成用户的话。

**问题**：advisor 的输出以 tool result 形式到达 executor，与"事实"在形式上无区别。没有任何约束阻止 executor 把 advisor 的立场归给用户。

**归因**：这是 executor（模型）的错，**不能推给 prompt**——但 prompt 也没有任何防线。修复方式是在 guideline 里显式禁止。

---

## I-5 默认偏好重档，成本不可见

**状态：不改（已决策）** — 用户决定保持 `high`。记录理由：这是产品取向而非缺陷，且上游默认值一致性有价值。此处保留记录，供日后重新评估。

**证据**：
- `/advisor` 选择器把 `high` 标为 `(recommended)`（`DEFAULT_EFFORT`）
- 本机实际配置：`modelKey: cliproxyapi/gpt-5.6-sol, effort: high`

**问题**：默认值与推荐值都指向最贵档位。对一个每次任务触发 2–3 次的工具，这个默认值直接放大了 I-1 的成本后果。

**待定原因**：改默认 effort 是产品取向，不是缺陷修复。需要用户决策。

---

## I-6 无成本与状态可观测性

**状态：已修** — 新增 `advisor/status.ts` + `/advisor-status` 命令，报告每个 advisor 会话的轮数、工具数与落盘体积。明确把体积标为"历史规模，不是 token 或成本数字"。

**证据**：本次 fork 之前，`/advisor` 只能配置模型；executor 无法看到、用户也无法查询：advisor 会话累积了多少轮、已投递哪些内容、请求体量有多大。

**问题**：持久会话让历史持续增长，但**没有任何界面能看出它长到多大了**。README 里"不保证省 token"的免责声明因此无法被验证，用户只能盲信。

**补充**：这里的实测数据目前**仍是空白**——单测断言的是投递策略（`driver.prompts[1]` 不含已投递内容），不是真实 API 的 payload 字节数。真实端到端尚未跑通（环境未配 API key）。**不要把单测结论当作成本结论。**

---

## I-7 自动 compaction 反转了 advisor 的身份

**状态：已修** — `advisor/session-pool.ts` 在构造 driver 时调用 `setAutoCompactionEnabled(false)`；回归测试 + `repo-guards.test.ts` GUARD 8 锁定。

**证据（实测，非推断）**：在一个长到越过 Pi 压缩阈值的会话上（`tokensBefore: 510091`），advisor 不再给建议，转而**向执行器请示**：

> I need your guidance on where we stand. Here's the situation: 1. We successfully published @2wchuang/pro-advisor@0.2.2 ...

并把**执行器的**发布里程碑列成**自己的**成就。

**成因**：advisor 会话是真正的 Pi `AgentSession`，所以 Pi 的自动 compaction 也作用于它。而压缩摘要的模板是为**执行器**写的 —— 它要求产出 `## Goal`、`## Constraints & Preferences`、`## Progress`、`## Next Steps`。advisor 的 transcript 是**执行器工作的镜像**，于是压缩把执行器的任务总结成了 advisor 自己的任务，advisor 就接受了这个身份。

**这是 fork 引入的新缺陷，上游不可能发生** —— 无状态侧调用没有会话可压缩。这也是本次开发中第一个「有状态设计反而更差」的缺陷。

**代价**：禁用压缩意味着超长 advisor 会话会持续增长。这是本 fork 已在 README 中声明并标注为"不是 token 节省"的取舍 —— 比静默的身份反转可接受。

**同时实测确认的两件事**：

- `deliveredIds` 移除在生产中生效：新 mirror-state 条目 **27 字节**，对比 0.2.1 写的 **10,077 / 10,173 字节**（同一会话）。
- 向后兼容成立：0.2.2 读取含旧 `deliveredIds` 数组的 0.2.1 会话文件，忽略该字段并继续增量投递。

**记录但不修**：两次 provider 失败（配额限制下的 `WebSocket error`）各在 advisor 会话里留下 4 条空 assistant 消息（`usage input=0 out=0`）。水位线不变量在两次失败中都正确保持（未推进），下一次成功调用也未受这些空消息影响。**没有证据表明空消息本身造成危害**，因此不做修改。

但进一步的实测揭示了同一失败路径上另一个更值得记录的行为：

**失败的投递会持久化并被重发。** 逐条比对投递文本的公共前缀：

| 调用 | 投递文本长度 | 结果 |
| --- | --- | --- |
| call 3 | 77,988 字符 | ❌ 失败 |
| call 4 | 97,752 字符 | ❌ 失败 |
| call 5 | 115,240 字符 | ✅ 成功（水位线推进） |

call 3 与 call 4 的公共前缀为 **77,938 / 77,988 = 99.94%** —— 失败的投递几乎原封不动被重发，只在尾部追加新增量。

成因：`session.prompt()` 先持久化 user 消息再请求 provider，provider 失败时 `runTurn()` 的 catch 只能返回 `{stopReason:"error"}`，**无法回滚已写入的内容**。而水位线按设计不推进（重复投递比静默跳过安全），于是下次调用重发同样的内容。

**这是一个正反馈，不是一个「有界」的退化**：每次失败都让 advisor 会话变大，而更大的上下文使下次失败更可能。实测中两次失败后即恢复（第三次成功），**未观察到失控螺旋**，所以不称为已证实的缺陷；但它的形状是自我强化的，值得记录而不是当作已解决。

**缓解手段**：`/new` 会换掉执行器 session id，从而创建全新的 advisor 文件（文件名由 `advisorSessionId(executorSessionId)` 决定）。这是当前唯一的恢复路径。

**未做的修改**：不为此增加主动的上下文窗口守卫或回滚机制。理由与前面一致 —— 在拿到危害证据（而非形状推测）之前不引入复杂度；且回滚需要 Pi `SessionManager` 层面的截断能力，代价超出「最小改动」约束。

---

## I-8 rebase 把压缩摘要当作追加，导致 advisor 彻底失效

**状态：已修** — `advisor/mirror.ts` 的 `fullTranscriptEntries()` 改用 `sessionManager.buildContextEntries()` 渲染全量投递；`coveredIds` 仍走原始分支。回归测试 4 个 + 变异验证。

**这是 I-7 修复的直接后果**，必须一起看：I-7 禁用了 advisor 会话的自动压缩（防止身份反转），而那**同时移除了唯一的自动收缩机制**。没有压缩，下面的翻倍无处消解 —— 两个修复不能分开评估。

**证据（实测，非推断）**：本会话中一次 advisor 调用**直接失败**：

```
Codex error: prompt is too long: 1,387,946 tokens > 1,000,000 maximum
request_id: req_vrtx_011CeuZvMAzgQg8zbUVsNzqb
```

逐行核算 advisor 会话文件，确认 provider 收到的是**两份投递的叠加**：

| 假设 | 估算 tokens | 对照实测 1,387,946 |
| --- | --- | --- |
| 只发 line 7（rebase 全量） | ≈ 720,130 | ✗ |
| line 4 + line 7 都发 | ≈ 1,383,871 | ✓ **99.7% 吻合** |

```
line  4: user      2,203,618 B   ← 首次投递（初始全量）2,015,715 字符
line  5: assistant    10,626 B
line  6: custom          169 B   ← 水位线
line  7: user      2,390,833 B   ← rebase 全量重述 2,173,745 字符
line  8: assistant        648 B   ← 失败（stop=error），仍写入
```

**根因（两层）**：

1. **`buildRebaseContext()` 说 `supersedes all earlier transcript content`，但这只对 advisor 的「理解」成立，对 provider 的「输入」不成立。** 旧投递仍在会话历史里，每轮都重发。计划里 rebase 是「替代」，传输上是「叠加」。

2. **`planMirror` 用 `getBranch()` 渲染全量，而 `getBranch()` 返回从根到叶的全部条目**（`session-manager.js:958`），**包含已被压缩摘要取代的原始消息**。于是压缩摘要在本 fork 里是**追加**，不是**替代** —— 内容只增不减。

对照上游：`buildContextEntries()` 在压缩点**丢弃** `firstKeptEntryId` 之前的原始条目（`session-manager.js:220-222`）。**上游的载荷随压缩变小；带这个缺陷的 fork 只会变大。**

**为什么这不是罕见路径**：执行器压缩是**必然发生**的（255K 阈值，本会话已触发 2 次）。每次压缩 → `planMirror` 判 `full=true` → rebase 重发全量。所以这个缺陷**必然走到**，只是时间问题。

**修复效果（用失败现场的执行器会话离线核算）**：

| 方案 | 载荷 | 估算 tokens |
| --- | --- | --- |
| `getBranch()` 全量（缺陷） | 4,882,683 B | ≈ 1,470,688 ❌ 超限 |
| `buildContextEntries()`（修复） | 711,247 B | ≈ 214,231 ✅ |
| | **缩小 85.4%** | 丢弃 1,049 / 1,231 条 |

**水位线仍走原始分支**：`coveredIds` 必须是原始分支上的 id，因为水位线从它提交，下次必须仍能在叶路径上找到。若让它随摘要缩小，下次会判定水位线缺失而**永远 rebase**。这是修复中最容易搞错的一点，已单独加测试。

**降级路径**：源不提供 `buildContextEntries` 时回退到 `getBranch()`（正确但会累积）。错误但完整的转录胜过空转录。

**未做的修改**：没有加主动的上下文窗口守卫（在超限前就拒绝调用）。理由同前 —— 先让正确的解析语义生效，观察是否还有余量问题；在拿到新证据前不加复杂度。

---

## 上游未改动的相关缺陷（记录备查，非本 fork 引入）

- `inventory.ts` 的 globalThis 单槽缓存按**工具名集合**失效，不按会话区分。多会话共用一个进程时，工具清单文本共享——这是有意的（进程级注册表），但意味着工具描述变化会反映到所有会话。
- `advisor/messages.ts` 的 `ERR_NO_MODEL` 等错误文案在无 UI 的 RPC 模式下依赖 `ctx.ui.notify`，非交互场景只能从 tool result 读取。
