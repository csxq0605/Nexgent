# 步骤 6 收益测量脚本

归「收益测量」讨论串所有（分工表 `docs/plan/step-6-work-partition.md` W6）。只用于测量，不进产品；不调模型。

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

用户约定只在反馈里出现、任务文字里没有：表格族是每张分组表都带 `avg_order_value`；代码族是改了哪个 `src/` 模块就要新增或修改对应的 `test/<模块>.test.js`，以及金额一律整数分。

## 本地检查

```sh
node --test 'scripts/experiment/step6/tests/*.test.mjs'
node_modules/.bin/tsc --ignoreConfig --noEmit --allowJs --checkJs --strict --module nodenext \
  --moduleResolution nodenext --target es2023 --types node --skipLibCheck scripts/experiment/step6/*.mjs
node scripts/experiment/step6/calibrate.mjs
node scripts/experiment/step6/report.mjs --records <raw.json> --out <report.md>
```

这些测试不在根 `vitest` 项目里（`vitest.config.ts` 只收 `packages/*`、`apps/*`），`pnpm test` 不会跑它们。
