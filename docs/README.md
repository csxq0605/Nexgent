# Nexgent 文档索引

本目录是 Nexgent 下一代应用（TypeScript monorepo，以 Cordis 为运行架构、以 DeepSeek Harness 为只读参考重写）的文档树。起点是 2026-10-07 的评审与计划：[`research/pr4-review-and-plan-2026-10/README.md`](research/pr4-review-and-plan-2026-10/README.md)，下文简称“计划”。计划第 4 节按六步给出每步的参考实现、工作项与验收；本目录的其余文档都挂在这六步之下。

## 目录结构

| 位置 | 内容 | 何时写、何时改 |
| --- | --- | --- |
| [`research/`](research/) | 评审与调研报告（PR 评审、文献调研、参考库分析） | 结论性文档；发布后只勘误，不改写结论 |
| [`adr/`](adr/) | 架构决策记录（ADR），编号递增 | 每个决策一份；要改决策就写一份新 ADR 取代旧的，不改旧文 |
| [`spec/`](spec/) | 规范：数据与文件格式、权限与审批模型 | 先于编码写；每种格式配 schema 与读写测试，二者同步改 |
| [`plan/`](plan/) | 各步骤的任务拆分、分工与文件归属 | 每步开工前写，开工后只记偏差 |
| [`validation/`](validation/) | 各步验收记录、摘要 JSON、SHA-256 manifest | 每步一份记录；见下节 |
| [`reference-map.md`](reference-map.md) | DSH 包 → Nexgent 包 → 处理方式（改写 / 重写 / 不要）的对照表，以及参考库的获取方法 | 每次从参考库改写文件、新增或删除 Nexgent 包时更新 |

仓库根目录另有 [`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md)（第三方软件声明）；从参考库复制并改写的每个文件都要在其中登记。

## 根 README 只描述已验收能力

仓库根目录的 `README.md` 只描述**通过了验收记录**的能力。一项功能在 `docs/validation/` 里有对应步骤的验收记录（两平台 CI 通过、真实模型手动验收留有摘要）之前，只能出现在本目录的计划、规范与研究文档里，不进入根 README。这条规则来自计划 4.10“文档体系”一行，目的是让 README 的每句话都有证据可查，不再出现五代入口并存的描述。

在步骤 2 验收通过、集成分支替换 `main` 之前，根 README 的主体仍描述现有 Python / PyQt 产品；顶部只保留一段指向本目录的“开发中”说明。

## 验收记录的归属

每一步一份验收记录，位置与命名固定：

- 记录正文：`docs/validation/step-<n>-<yyyymmdd>.md`，按 [`validation/TEMPLATE.md`](validation/TEMPLATE.md) 填写；
- 摘要 JSON：`docs/validation/step-<n>/*.json`（脚本化 provider 与真实模型各一份或多份）；
- manifest：`docs/validation/step-<n>/manifest.sha256`，覆盖该目录下全部摘要文件；
- 原始 JSONL 请求记录不进入主分支，放在 Release 附件，记录正文写明位置与 manifest 摘要。

证据政策的细则见 [`validation/README.md`](validation/README.md)。里程碑与每步的退出门槛见计划 4.7。

## 当前文档一览

| 文档 | 状态 |
| --- | --- |
| [`research/pr4-review-and-plan-2026-10/README.md`](research/pr4-review-and-plan-2026-10/README.md) | 计划，2026-10-07 |
| [`adr/0001-reference-rewrite.md`](adr/0001-reference-rewrite.md) | 已接受：参考重写与计划 4.9 的全部决策 |
| [`reference-map.md`](reference-map.md) | 步骤 0 建立，随各步更新 |
| [`plan/step-1-work-partition.md`](plan/step-1-work-partition.md) | 步骤 1 分工，开工前定稿 |
| [`spec/data-formats.md`](spec/data-formats.md) | 桩：只有章节标题与一句意图，步骤 1 开工前写完 |
| [`spec/permissions.md`](spec/permissions.md) | 桩：同上 |
| [`validation/README.md`](validation/README.md) | 证据政策 |
| [`validation/TEMPLATE.md`](validation/TEMPLATE.md) | 验收记录模板 |
