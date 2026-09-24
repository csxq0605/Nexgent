# 固定错误码后的普通任务搜索复测结果

按[预先推送的 READY 合同](WORKBENCH_SEARCH_REPAIR_CONTRACT.md)，在独立本机项目中重复 Workbench development seed 13 的公开任务；模型为 `mimo-v2.6-flash`。这是同题机制复测，不是独立统计样本。[脱敏收据](workbench-search-repair-receipt-20260924.json)保留实际身份、调用数、状态和安全错误类别，不含密钥、模型原文或隐藏答案。

**结果仍为负，但真实流程已进入开发资格评估。** 来源任务首个模型响应不是合法 JSON 对象，因此 1 次调用后失败。R0 用 1 次调用再次选择 `orchestration_search`。第一次候选生成用 1 次调用，得到可验证的 O 图变化；资格评估自动排除同题来源，使用 development seed 14。候选图在执行前因 `ask` 节点传入不支持的 `prior_findings` 参数失败，模型调用数为 0；父图用 2 次调用，发布的 ledger 包含 schema 不允许的 `excluded_rows`，也失败。两臂得分均为 0，候选未加载，资格评估给出 `artifact_contract_invalid`、`candidate_execution_failed`、`orchestration_not_loaded`。第二次生成收到了这些代码，用 1 次调用提出的新工作流却不是合法 JSON，未形成候选。搜索耗尽；独立 selection、guard、复用均未发生，channel revision 仍为 0。

与上一轮相比，“生成 → 独立 development 任务对照 → 公开失败代码 → 再生成”已由真实 MiMo 跑通。由于第一轮并非补丁合同错误，本轮没有实际触发新加的细粒度 `component_ids`／`path` 错误码；它们只在定向测试中验证了传递。当前最关键的下游缺口是资格评估把具体的通用图／工件接口错误压成三个粗代码，修复器不知道 `ask` 参数或发布 schema 错在哪里；候选的静态图错误还让父臂白跑了两次模型调用。下一步应在开发资格评估前做可执行图预检，并把宿主产生的有界、脱敏节点错误传给修复尝试。此结果不支持编排收益或 RSI 效益声明。
