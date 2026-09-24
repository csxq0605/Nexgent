# D1-B 策略选择真实探针结果

预注册条件与评价规则见 [CONTRACT.md](CONTRACT.md)。每次运行使用新目录；不覆盖失败收据。

## 2026-09-24 批次 `d1b-live-20260924a`

- 源码提交：`c2eac04`。预检通过，四个普通 Episode 均创建；总计四次 selector 模型调用准入、4,800 completion token 预留，未进入任何执行后端。
- 四次调用均在本地 SDK 导入处得到 `ModuleNotFoundError`，收据归类为 `provider_transport`。这属于运行环境错误，H1–H4 均未得到支持，不能据此推断 MiMo 的策略选择能力。
- [原始证据](receipts/d1b-live-20260924a/evidence.json)、[运行身份](receipts/d1b-live-20260924a/run_manifest.json)及[结果索引](receipts/d1b-live-20260924a/results.jsonl)保留。凭据泄漏扫描通过；本地 SQLite Episode 数据库不入库。
- 后续批次只修正 Python 解释器，使用项目既有 `.venv` 中的 OpenAI SDK；任务、候选、提示、评价、预算与模型版本保持预注册值。新批次须有新 manifest 和新目录。
