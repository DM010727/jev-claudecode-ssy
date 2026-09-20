---
name: review
description: 使用 Superpowers 风格的并行审查 Agent 与胜算云 Jev 批量决策，快速审查本地代码改动或 Pull Request。用户要求 code review、PR review、合并前检查、审查某个分支或判断是否可合并时使用。
license: MIT
---

# Jev 并行代码审查

目标是快速产出少而准、可验证、带精确位置的审查结论。Superpowers 工作流负责拆分问题域与隔离审查上下文；Jev 在一次 Decisions 请求中并行复核所有候选问题。

默认只读。除非用户明确要求，不修改代码、不提交 GitHub 评论、不 approve 或 request changes。

## 1. 确定审查范围

优先使用用户指定的 PR、提交范围或文件。未指定时：

- PR URL/编号：读取 PR 描述、关联需求、base/head SHA 和 diff。
- 当前分支：以与默认分支的 merge-base 为 base，以 `HEAD` 为 head。
- 未提交改动：审查 staged 与 unstaged diff，并说明未跟踪文件是否纳入。

开始前读取仓库级说明和与改动相关的测试。记录审查目标、明确需求、base、head、改动文件与可用验证命令。

## 2. 并行派遣审查

当存在两个以上互不依赖的审查面且环境支持子 Agent 时，并行派遣。每个 Agent 只读、范围互斥，不继承主会话的推理过程，只获得审查目标、需求、SHA 范围和负责的问题域。

建议按实际 diff 选择 2–5 个问题域，而不是固定全部派遣：

- 行为与正确性：控制流、状态变化、边界条件、错误处理。
- 安全与数据：认证授权、注入、敏感信息、并发和数据损坏。
- API 与兼容性：契约、迁移、平台和版本兼容。
- 测试与回归：缺失覆盖、伪测试、失败路径和需求偏差。
- 性能与资源：复杂度、I/O、查询、内存、资源释放。

若子 Agent 不可用，则按相同问题域顺序审查。不要因此跳过 Jev 批量复核。

派遣时使用 [reviewer-prompt.md](references/reviewer-prompt.md)。检测到 `superpowers-zh` 时，可复用其 `requesting-code-review`、`dispatching-parallel-agents` 和 `receiving-code-review` 方法；未安装时本 Skill 必须独立完成流程。

## 3. 候选问题门槛

审查 Agent 只返回能指向本次改动的具体问题。每条候选必须包含：

- 唯一 ID、标题和问题域。
- 精确 `file:line`；行号必须落在 diff 上或紧邻 diff 且被本次改动触发。
- 可复现的失败场景或明确受影响的输入。
- 来自代码、测试、类型、文档或运行结果的证据。
- 为什么属于本次改动，而不是无关旧问题。
- 建议优先级与最小修复方向。

过滤纯风格意见、无法解释影响的猜测、已被现有代码处理的情况以及与 diff 无关的问题。不要因为“可能有风险”就升级严重度。

## 4. 用 Jev 一次并行复核

先去重相同根因，再按 [jev-batch.md](references/jev-batch.md) 生成一个 JSON 请求。对每条候选同时创建三个问题：

1. `valid_<id>`：这是否是本次改动引入或暴露的真实缺陷。
2. `priority_<id>`：选择 `P0`、`P1`、`P2`、`P3` 或 `not_a_finding`。
3. `evidence_<id>`：现有证据是否足够直接发布审查意见。

把所有候选放入同一个请求，让 Jev 并行回答；请求过大时按每批最多 12 条候选分批。优先运行跨平台 Node 工具：

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/jev-decide.mjs" --input REQUEST.json --output RESPONSE.json
```

macOS 没有 Node.js 时运行：

```bash
bash "${CLAUDE_PLUGIN_ROOT}/bin/jev-decide.sh" --input REQUEST.json --output RESPONSE.json
```

请求和响应放在临时目录，不提交到仓库。工具自动读取一键安装时保存的胜算云 Key。

## 5. 解释 Jev 结果

Jev 是筛选器，不是证据来源。它不能补造代码事实或替代行号验证。

- `valid` 概率低于 `0.55`，或 priority 为 `not_a_finding`：丢弃。
- `evidence` 概率低于 `0.60`：回到代码补证据；无法补足则丢弃或列为未决问题，不发布为确定缺陷。
- priority 的 confidence 低于 `0.55`：人工按失败影响重新校准，不自动升级。
- P0/P1 默认阻断合并；P2 是否阻断取决于项目约定和失败范围；P3 不阻断。
- Jev 与明确代码证据冲突时，以可复现证据为准，并在报告中说明校准原因。

如 Jev 不可用，明确标记“Jev 复核未完成”，仍可输出人工审查结果，但不能伪称经过 Jev 决策。

## 6. 验证与汇总

针对保留下来的问题运行最小、相关的验证。不得覆盖用户未提交改动；若测试生成文件，检查并清理仅由本次测试产生的临时产物。

最终报告以问题为先，按 P0 → P3 排序。每条包括：

```text
[P1] 标题 — path/to/file.ts:42
失败场景：...
证据：...
影响：...
建议：...
Jev：valid 0.91；priority P1（confidence 0.84）；evidence 0.88
```

随后给出：

- 合并判断：可以合并 / 修完再合 / 不可合并。
- 已审查的问题域和实际运行的验证。
- 假设、未覆盖范围与需要作者回答的问题。
- 没有问题时，明确写“未发现可操作缺陷”，并列出审查覆盖面；不要只写 LGTM。

只有用户明确要求发布到 GitHub 时，才创建 review 或行内评论。发布前再次确认每条行号仍对应 PR diff，避免重复评论。

## 来源兼容

工作流兼容并借鉴 [jnMetaCode/superpowers-zh](https://github.com/jnMetaCode/superpowers-zh) 的代码审查、接收反馈和并行 Agent 方法；Jev 批量决策与胜算云接入由本插件提供。
