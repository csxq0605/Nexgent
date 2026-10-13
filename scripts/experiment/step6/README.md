# 步骤 6 收益测量脚本

归「收益测量」讨论串所有（分工表 `docs/plan/step-6-work-partition.md` W6）。只用于测量，不进产品。除 `run.mjs --real` 外都不调模型。

| 文件 | 内容 |
| --- | --- |
| `cases.mjs` | 用例计划（两族各 dev 2 / selection 2 / guard 1 / holdout 3）、集合检查、隔离检查、门控挑选检查、统一的 `judgeCase` |
| `tables.mjs` | 表格 / 数据族：订单 CSV（复用 `scripts/real-task/step4-orders.mjs`，只引入）、退货 CSV、地区 / 商品 / 退货率表与月度汇总，隐藏判定 |
| `code.mjs` | 多文件代码族：按种子生成的开票小库（6 个模块 + 可见测试），修 bug / 加功能 / 重构三种变体，参考模型、隐藏测试与判定 |
| `feedback.mjs` | 模拟用户反馈：按隐藏判定查出的问题套固定模板，不用模型 |
| `stats.mjs` | 配对差、两层自助法 95% 区间、正 / 零 / 负、费用、摊薄 |
| `report.mjs` | 报告生成器：原始记录 → Markdown，同一记录逐字节相同 |
| `budget.mjs` | 费用闸门：累计估算 + 本次估算超过 35 美元就拒绝开始 |
| `calibrate.mjs` | 代码族难度的脚本化校准表 |
| `run.mjs` | 实验编排：经 `@nexgent/sdk` 的产品路径跑历史与 dev 任务、模板反馈、改进作业、元改进作业，再在 base / parent / child 三臂的项目副本里跑 holdout，产出原始记录、报告、实验清单；每步开始前过费用闸门 |
| `scripted-model.mjs` | 演练用的脚本化模型：做任务（只有加载了覆盖本用例的技能才守约定）、诊断、提议、反馈检查、元诊断与元提议；子改进器的诊断段落让提议写出覆盖整族的技能 |

用户约定只在反馈里出现、任务文字里没有：表格族是每张分组表都带 `avg_order_value`；代码族是改了哪个 `src/` 模块就要新增或修改对应的 `test/<模块>.test.js`，以及金额一律整数分。

## 本地检查

```sh
node --test 'scripts/experiment/step6/tests/*.test.mjs'
node_modules/.bin/tsc --ignoreConfig --noEmit --allowJs --checkJs --strict --module nodenext \
  --moduleResolution nodenext --target es2023 --types node --skipLibCheck scripts/experiment/step6/*.mjs
node scripts/experiment/step6/calibrate.mjs
node scripts/experiment/step6/report.mjs --records <raw.json> --out <report.md>
```

## 实验与演练

```sh
pnpm build                                                     # run.mjs 用各包的 dist
node scripts/experiment/step6/run.mjs --scripted --out <dir>   # 脚本化全流程演练，不调模型、不需要密钥
node scripts/experiment/step6/run.mjs --real --dev-trial --out <dir> [--case code/dev/bugfix-101] [--repeats 3]
                                                               # v0 dev 试跑（真实模型，花钱）
node scripts/experiment/step6/run.mjs --real --out <dir>       # 正式实验（真实模型，花钱）
```

- 三臂：`base` 是历史与 dev 任务之后、反馈之前的项目副本；`parent` 与 `child` 是元改进作业用 `keepCopies` 留下的两份比较副本（同一快照出发，分别用旧版与新版改进器重做同一次改进）。holdout 每次运行都在所属臂的新副本里做，关掉自动改进，副本不带改进作业。
- 元改进作业优先走 SDK `improvements.runMeta`；SDK 还没接通时退回 `ImprovementHost.runMeta`，实验清单的备注写明走了哪条路。
- 费用闸门：每步开始前按预留额（任务 0.4、反馈 0.2、改进作业 2.5、元改进 6、holdout 每次 0.4 美元）检查累计花费，超过 `--cap`（默认 35 美元）就停在这一步，已完成的部分照常出报告；花费按账本估算美元记入 `spend.json`（`--spend` 可指定跨次共用的文件），费用未知的一步按 2.5 美元计。
- 真实后端只从环境读 `NEXGENT_API_KEY`（回退 `ANTHROPIC_API_KEY`），不打印、不写文件；没有密钥时以退出码 2 结束，什么都不跑。脚本化后端在运行期间把环境里的密钥换成脚本密钥。
- 输出：`raw.json`（报告的输入）、`report.md`、`observations.json`（每族的作业、审批、比较、检查）、`manifest.json`（实验清单：后端、模型、用例计划版本、三臂来源与能力版本、父子比较的起点种类（`comparison.origin.kind`）与两臂门控结论、闸门与花费、检查结果）；`--dev-trial` 只写 `dev-trial.json`。运行副本默认删掉，`--keep-runs` 保留。
- 改进作业停在等待审批时，编排脚本代替用户批准，并在备注里记下。
- 还没做：反馈检查与隐藏判定的不一致统计（报告里记作缺测，不是 0）。

这些测试不在根 `vitest` 项目里（`vitest.config.ts` 只收 `packages/*`、`apps/*`），`pnpm test` 不会跑它们。
