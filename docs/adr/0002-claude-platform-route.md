# ADR 0002：模型路由改为 Claude Platform，默认 Claude Sonnet 5.5

- **状态**：已接受
- **日期**：2026-10-10
- **替代**：[ADR 0001](0001-reference-rewrite.md) 决策 5、6 的模型部分；其余决策不变。

## 背景

ADR 0001 按用户当时给定的产品定义把默认模型定为 `mimo-v2.6-pro`，以一条 OpenAI 兼容路由接入，执行时关闭 thinking。步骤 1 第 2 阶段按此实现了 `@nexgent/llm`（OpenAI 兼容流式客户端、自写代理隧道）与 test-support 的 OpenAI 兼容假服务，但真实模型的手动验收尚未进行。

2026-10-10 用户决定：API 换成 Claude Platform（Anthropic Messages API），模型用 Claude Sonnet 5.5。

## 决策

1. **路由改为 Claude Platform。** `@nexgent/llm` 使用官方 `@anthropic-ai/sdk`（0.133.0）调用 `POST /v1/messages` 流式接口；不再保留 OpenAI 兼容线路格式，也不做多 provider 抽象。端点默认 `https://api.anthropic.com`，可由 `.nexgent/config.json` 的 `endpoint` 或环境变量 `NEXGENT_API_BASE_URL` 覆盖（验收脚本用它指向本地假服务）。
2. **默认模型 `claude-sonnet-5-5`。** 模型 ID 不带日期后缀；`.nexgent/config.json` 的 `model` 与 `--model` 可换成其他 Claude 模型。
3. **thinking 与 effort 的映射。** 配置 `thinking: 'off'`（默认）发送 `thinking: { type: 'between_tools' }`，这是 Sonnet 5.5 上最低的 thinking 设置（`disabled` 会被该模型拒绝）；`thinking: 'on'` 发送自适应 thinking。新增配置 `effort`（`low | medium | high | xhigh | max`，默认 `medium`，用于多步工具调用的起点）作为 `output_config.effort`；`between_tools` 只在 `high` 及以下有效，`xhigh`/`max` 时改为自适应 thinking。不发送 `temperature` 等采样参数，不使用强制 `tool_choice`。
4. **保留 thinking 块（preserved thinking）。** 模型回复的内容块原样保存在会话记录 `assistant.message.providerContent` 中，恢复与续聊时原样回放；会话历史只追加不改写。这是契约 `AssistantMessage.providerContent` 与 `DoneEvent.providerContent` 的来源。
5. **拒答与回退。** `stop_reason: 'refusal'` 映射为契约的 `finishReason: 'refusal'`，附 `RefusalInfo`；kernel 不执行该回复中的工具调用，以 `llm/refused` 结束轮次。对 Claude API 主机默认开启服务端回退（`fallbacks: 'default'`，beta `server-side-fallback-2026-07-01`），配置 `fallbacks: 'off'` 可关闭；对非官方主机自动不发送。
6. **流式工具输入。** 工具定义带 `eager_input_streaming: true`，大参数边生成边到达；因此 provider 不假定参数 JSON 完整，kernel 在执行前按工具 schema 校验，`max_tokens` 截断的回复不执行工具调用。
7. **凭证。** 仍按 `permissions.md` 的顺序读 `NEXGENT_API_KEY`（环境变量或 `~/.nexgent/credentials.json`）；两者都没有时回退到环境变量 `ANTHROPIC_API_KEY`。
8. **代理。** 删除自写的 HTTP 代理隧道，改用 Node 的 `NODE_USE_ENV_PROXY=1` 或 SDK 的 `fetch` 选项；对应的 DSH 改写件从第三方声明中移除。
9. **假服务。** test-support 的 `scriptedModelServer` 改为 Anthropic Messages API 的 SSE 格式，脚本格式与服务 API 不变。
10. **真实模型验收。** 步骤 1 的真实模型手动验收改为对 Claude Sonnet 5.5 做一次带工具调用的请求，记录进 `docs/validation/`；它同时验证决策 3 的 `between_tools` 映射。

## 后果

- 契约变更：`ProjectConfig.effort`、`LLMRequest.effort`、`AssistantMessage.providerContent`、`DoneEvent.providerContent / refusal`、`FinishReason` 增加 `'refusal'`、错误码 `llm/refused`；`DEFAULT_PROJECT_CONFIG` 的 `model`、`endpoint` 随之改变。
- 费用按 Claude Sonnet 5.5 的价目计（输入 $2 / 输出 $10 每百万 token，缓存读取 $0.20），步骤 4–6 的预算上限按此重新约定。
- 步骤 5–6 的“改进与审核允许换更强模型”保留，可换 `claude-opus-5-5`。
