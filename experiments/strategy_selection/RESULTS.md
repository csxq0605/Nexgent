# D1-B 策略选择真实探针结果

预注册条件与评价规则见 [CONTRACT.md](CONTRACT.md)。每次运行使用新目录；不覆盖失败收据。

## 2026-09-24 批次 `d1b-live-20260924a`

- 源码提交：`c2eac04`。预检通过，四个普通 Episode 均创建；总计四次 selector 模型调用准入、4,800 completion token 预留，未进入任何执行后端。
- 四次调用均在本地 SDK 导入处得到 `ModuleNotFoundError`，收据归类为 `provider_transport`。这属于运行环境错误，H1–H4 均未得到支持，不能据此推断 MiMo 的策略选择能力。
- 原始 v1 证据的 `remote_outcome_unknown=true` 来自运行器把 `connection_phase=unknown` 直接当成可能已出站；对于已明确的本地 `ModuleNotFoundError`，该布尔解释错误。原始文件保持不改，后续运行器版本已修正此分类并加离线回归。
- [原始证据](receipts/d1b-live-20260924a/evidence.json)、[运行身份](receipts/d1b-live-20260924a/run_manifest.json)及[结果索引](receipts/d1b-live-20260924a/results.jsonl)保留。凭据泄漏扫描通过；本地 SQLite Episode 数据库不入库。
- 后续批次只修正 Python 解释器，使用项目既有 `.venv` 中的 OpenAI SDK；任务、候选、提示、评价、预算与模型版本保持预注册值。新批次须有新 manifest 和新目录。

## 2026-09-24 批次 `d1b-live-20260924b`

- 使用项目既有 `.venv`，源码提交 `64734c2`；同一预注册候选包、公开入口、两题、模型 `mimo-v2.6-flash`、预算和评价合同。四个 Episode 共计 21 次模型调用准入、47,600 completion token 预留，均在批次上限内；所有已返回的模型收据均报告 `mimo-v2.6-flash`，凭据泄漏扫描通过。
- 主事件通报任务选 `ordinary-open-loop`，但 reviewer 的响应不是合法 JSON，四次模型调用后任务失败，未形成完成后端或交付质量证据。
- 主三服务发布审查也选 `ordinary-open-loop`，与预注册的 DAG 预期相反；开放循环用尽每 Episode 的八次模型调用预算，任务失败。
- 恢复样本保持 selector 调用与决策身份不重复、绝对截止时间不重置、已有工件未替换；后端未完成，八次模型调用预算耗尽，H3 整体不通过。结果未知的 selector 样本保持 `waiting_input`，未自动重发。
- 因此 **H1–H4 均不通过**。这证明模型确实参与选择且任务确实进入开放循环的调用链，但没有证明选对策略、完成后端、任务质量或 RSI 效益。[原始证据](receipts/d1b-live-20260924b/evidence.json)、[运行身份](receipts/d1b-live-20260924b/run_manifest.json)及[结果索引](receipts/d1b-live-20260924b/results.jsonl)保留。后续若修改选择器、执行策略或预算，必须版本化为新的候选与试验，不把本批次重标为成功。
