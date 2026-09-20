# Jev 批量复核请求

把候选问题作为 `state.findings`，把 PR 目标、需求和 diff 摘要作为状态上下文。不要把 API Key 写入请求文件。

```json
{
  "model": "jev-latest",
  "state": {
    "context": "You are calibrating candidate findings from a code review. Judge only from the supplied evidence. Do not invent missing code facts.",
    "review_target": {
      "description": "改动目标",
      "requirements": "需求摘要",
      "base": "BASE_SHA",
      "head": "HEAD_SHA"
    },
    "findings": [
      {
        "id": "COR-1",
        "title": "候选标题",
        "file": "src/example.ts",
        "line": 42,
        "failure_scenario": "具体触发条件",
        "evidence": "可验证证据",
        "introduced_by_change": "与 diff 的关系",
        "suggested_priority": "P1"
      }
    ]
  },
  "questions": {
    "valid_COR_1": {
      "type": "noul",
      "instructions": "Finding COR-1 is a concrete, actionable defect introduced or exposed by this change, and its claimed failure follows from the supplied evidence.",
      "criteria": {
        "true": "The evidence demonstrates a realistic failure and the finding is attributable to the reviewed change.",
        "false": "It is speculative, already handled, unrelated to the diff, style-only, or lacks a realistic failure."
      }
    },
    "priority_COR_1": {
      "type": "choice",
      "instructions": "Choose the calibrated review priority for COR-1 from the supplied evidence only.",
      "criteria": {
        "P0": "Immediate catastrophic impact, broad outage, critical compromise, or irreversible data loss.",
        "P1": "High-impact correctness or security defect that should block merge.",
        "P2": "Real bounded defect that should be fixed, but is not broadly catastrophic.",
        "P3": "Low-impact, narrow, non-blocking defect.",
        "not_a_finding": "Not a concrete actionable defect in this change."
      }
    },
    "evidence_COR_1": {
      "type": "noul",
      "instructions": "The supplied evidence for COR-1 is specific and sufficient to publish this finding without further code inspection.",
      "criteria": {
        "true": "File, line, trigger, impact, and causal link are directly supported.",
        "false": "A key fact is assumed or more code/test evidence is needed."
      }
    }
  }
}
```

JSON key 中不能稳定使用的字符统一替换为下划线，但 `state.findings[].id` 保留原始 ID。每批最多 12 条候选，即最多 36 个并行问题，避免状态过大。

响应读取方式：

- `answers.valid_<id>.noul`
- `answers.priority_<id>.choice`
- `answers.priority_<id>.confidence`
- `answers.evidence_<id>.noul`

若需要补证据，只为不确定的候选创建第二批请求，不要重复复核已经稳定的结论。
