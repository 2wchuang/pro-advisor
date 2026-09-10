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

**状态：待定**

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

## 上游未改动的相关缺陷（记录备查，非本 fork 引入）

- `inventory.ts` 的 globalThis 单槽缓存按**工具名集合**失效，不按会话区分。多会话共用一个进程时，工具清单文本共享——这是有意的（进程级注册表），但意味着工具描述变化会反映到所有会话。
- `advisor/messages.ts` 的 `ERR_NO_MODEL` 等错误文案在无 UI 的 RPC 模式下依赖 `ctx.ui.notify`，非交互场景只能从 tool result 读取。
