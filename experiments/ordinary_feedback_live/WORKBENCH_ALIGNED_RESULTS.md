# 同任务族真实探针结果

按事先推送的[READY 合同](WORKBENCH_ALIGNED_CONTRACT.md)，仅运行一次 `mimo-v2.6-flash`，从普通 `nexgent task` 提交 Workbench development seed 11 的公开任务。原始持久收据在本机 `E:/PKU/program/2026/Aug/te/NExgent-live-workbench-rsi-20260924/.nexgent`；[仓库脱敏摘要](workbench-aligned-receipt-20260924.json)不包含凭据、私有答案或工件正文。

源任务运行了 2 次模型调用后失败：生成的工作流在 `reconcile` 节点引用不存在的 `result` 绑定。自动反馈和 R0 开发仍继续；R0 用 1 次模型调用选择 `orchestration / episode_os`，宿主把该任务工作流原样制成候选，随后自动跑独立 Workbench selection。父臂 3 次模型调用、候选臂 1 次；两臂都失败、均未接受、得分 0。候选没有有效行为激活，质量、完成率和成功率门均未通过。系统拒绝晋升，revision 保持 0；未运行 guard，也没有后续复用。未改合同、seed、预算或晋升门。

这次对齐了来源与评价任务族，仍没有改进。诊断很具体：`episode_os` 当前只要求存在已归档的生成图，失败的图也能被原样采用；独立评价最终把它挡住，但白费了候选和配对调用。下一步应在候选准入和采用服务两层要求整图来源任务完成且使用量完整；失败图仍可通过通用包补丁路径尝试修复，不能直接作为已验证的可复用执行图。该修正属于框架通用行为，不依赖 Workbench 字段。

本样本证明普通入口能处理来源失败、继续形成候选并独立拒绝；它不证明正向 RSI、guard、递归改进或跨任务收益。正式效果研究仍需多 seed、预注册 holdout、固定编排、等预算单智能体与仅记忆对照。
