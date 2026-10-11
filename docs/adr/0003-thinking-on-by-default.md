# ADR 0003：执行默认开启 thinking

- **状态**：已接受
- **日期**：2026-10-11
- **依据**：用户 2026-10-11 的决定“默认开 thinking”（记录于 [`docs/plan/step-2-work-partition.md`](../plan/step-2-work-partition.md) “已定的决定”第 2 条）。
- **替代**：[ADR 0002](0002-claude-platform-route.md) 决策 3 中“`thinking: 'off'`（默认）”的默认值部分，以及计划 4.9 #6 的“执行关闭 thinking”；ADR 0002 决策 3 的其余映射（`off` / `on` 各发什么、`effort` 与 thinking 的组合规则）不变。

## 背景

ADR 0002 把执行时的默认值定为 `thinking: 'off'`，即发送 Claude Sonnet 5.5 上最低的 thinking 设置 `between_tools`。步骤 1 的真实模型验收在这个默认值下完成，因此“thinking 开启时会话里出现 thinking 块、恢复续聊时这些块被原样回放并被 API 接受”一直没有在真实模型下验证过（步骤 1 验收记录 `step-1-20261011.md` 的缺测项）。

2026-10-11 用户决定：执行默认开启 thinking；步骤 2 的真实模型验收只跑一次，在 Linux 云端、开 thinking 跑。

## 决策

1. **默认值改为 `'on'`。** `.nexgent/config.json` 的 `thinking` 字段缺省时取 `'on'`，即发送自适应 thinking（ADR 0002 决策 3 中 `'on'` 的映射）。契约 `DEFAULT_PROJECT_CONFIG.thinking` 随之改为 `'on'`。
2. **`'off'` 保留为配置项。** 用户可以在 `config.json`、设置页（步骤 2）或 CLI 参数里显式写 `thinking: 'off'`；`'off'` 仍发送 `between_tools`，语义不变。
3. **effort 不变。** 默认 `effort: 'medium'`；`xhigh` / `max` 时 `'off'` 仍改为自适应 thinking 的规则不变。
4. **保留 thinking 块的规则不变。** 回复的内容块继续原样存进 `assistant.message.providerContent`，恢复与续聊时原样回放（ADR 0002 决策 4）。步骤 2 的压缩规则补充：被压进摘要的轮次不再回放其 thinking 块，保留下来的近期轮次照常回放（`docs/spec/data-formats.md` §压缩）。
5. **账本照常记录。** `llm.request.start.thinking` 按实际请求记 `'on'` 或 `'off'`；验收摘要按账本统计，不按配置推断。

## 后果

- **代码改动由「kernel 维护」（W7）完成**：`packages/kernel/src/contracts/config.ts` 的 `DEFAULT_PROJECT_CONFIG.thinking`、CLI `--help` 文本、包 README、写死了 `'off'` 的测试与夹具（例如 `packages/kernel/tests/contracts/contracts.spec.ts` 对默认值的断言）。本 ADR 与 `data-formats.md` 先写定，代码在 W7 的 PR 合入后与之一致；两者之间的短暂不一致以规范为准（`data-formats.md` 开头的约定）。
- **费用**：thinking 开启后输出 token 增加（含思考内容）。步骤 2 的真实模型预算按开启估算（分工表“预估费用”：一次运行约 1–1.5 美元，上限 15 美元）。
- **验收**：步骤 2 真实模型层的 R03 检查 thinking 开启时会话含 thinking 块、恢复后的续聊请求被 API 接受（无 400）。
- **不做**：不新增 thinking 预算（`budget_tokens`）配置；不对辅助请求（压缩摘要）单独设 thinking，辅助请求沿用项目配置。
