# evals — Agent 评测（数据集 / 判分 / 回归门禁）

这里测的是 **Agent 行为**（任务做完没有、改对了没有、花了多少 token），
不是"代码行为是否正确" —— 后者在 `**/__tests__/` 里。

## 目录

```
evals/
├── coding/          评测用例（task + checks + tools + process），11 个
├── fixtures/        每个用例运行前会被拷成临时副本的项目
├── prompts/         提示词变体（*.txt），eval:prompt-ab 逐个当臂跑
├── baseline/        **冻结基线**（进版本控制；reports/ 与 candidates/ 是生成物、被忽略）
│   ├── coding.json
│   └── tool-schema.hash
├── candidates/      失败挖掘产出的候选用例（生成物，需人工审阅后提升）
└── reports/         每次运行与各臂的报告（生成物）
```

## 常用命令

```sh
npm run eval:agent:dry      # 只校验数据集可加载 + grader 有判别力（**不需要 Key**，CI 用）
npm run eval:agent          # 真实运行（需要 DEEPSEEK_API_KEY）；用例没过则退出码 1
npm run eval:diff           # 本次 vs 冻结基线（退出码 1 = 有回归，2 = 两份报告不可比）
npm run eval:prompt-ab      # 提示词变体 A/B（需要 Key；prompts/ 为空时会明确报错）
npm run eval:memory:dry     # 记忆召回的 hash 臂（不需要 Key）
```

## 口径（跨阶段只认这几个数）

| 数 | 来源 | 用途 |
|---|---|---|
| `passed/total` | 报告 `cases[].passed` | 质量 |
| `sum(cases[].tokensIn)` | 无头 CLI 的 `[用量] in=` | 成本 |
| `toolCount` / `toolTableHash` | CLI 的 `[工具集] n= hash=` | 注入了多少工具、前缀有没有换 |
| `verification.status` | `agent-eval/verifier.ts` | 任务级结论 |

**token 只在工具 schema 指纹一致时可比**：schema 是缓存前缀的一部分，变了就意味着
两次运行的输入量不是同一个东西。`eval-diff` 会在不可比时**跳过并说明原因**，
不会给出"没涨"的假信号。

## 回归门禁怎么用

```sh
# 1) 改完东西跑一次真实评测
npm run eval:agent

# 2) 与基线比（有回归 → 退出码 1，并逐项列出 kind/caseId/detail）
npm run eval:diff
```

`kind` 的含义见 `electron/agent-eval/regression.ts` 的联合类型：`case_failed`（整体退步）、
`check_flipped`（某项断言翻）、`process_gate_flipped`（行为类门槛翻）、
`verification_downgraded`、`tokens_increased`、`case_missing`。

### 冻结/刷新基线

基线只能**人工**重跑、人工提交 —— 让脚本自动改写基线，等于把"回归"洗掉。

```sh
npm run eval:agent -- --out=evals/baseline/coding.json
node scripts/eval-diff.cjs --write-meta    # 刷新工具 schema 指纹
git add evals/baseline && git commit -m "chore(eval): refresh coding baseline"
```

`--check-meta`（CI 里跑，不需要 Key）会比较当前内置工具的 schema 指纹与
`baseline/tool-schema.hash`：不一致就失败，提醒你 schema 变过、基线的 token 数字已过期。

## 新增维度（memory / security / workflow…）

`loadCases()` 读 `evals/<--dir= 指定的目录>`（默认 `coding`）。新增一个维度只需：
建目录、放用例、加一条 `--dir=<名字>` 的运行脚本。用例 schema 见
`scripts/agent-eval.cjs` 与现有用例（`checks` 是目标断言，`tools.process` 是过程门槛）。

## 失败 → 用例（闭环的后半段）

```
生产会话日志 ──┐
feedback ─────┼→ candidates/ ──（人工审阅 + eval-lint）──→ coding/
评测失败 ─────┘
```

候选**不会**自动提升：十几个用例分不清信号与噪声，提升必须经过人。
每个候选带 `source.evidence`（失败工具与错误首行）与 `needsFixture: true`
—— 会话日志里没有工作区快照，**目标断言只能由人补**。
