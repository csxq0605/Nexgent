# 普通任务候选修复探针结果

按先推送的 [READY 合同](WORKBENCH_CANDIDATE_REPAIR_CONTRACT.md)，从新的普通 CLI 项目运行一次 Workbench development seed 16 的公开任务，模型 `mimo-v2.6-flash`。[脱敏收据](workbench-candidate-repair-receipt-20260924.json)记录终态、调用数与固定错误类别；原始 Episode 和搜索账本在本机 `E:/PKU/program/2026/Aug/te/NExgent-live-candidate-repair-20260924/.nexgent`。没有换题或追加调用。

**结果为负。** 来源任务在 2 次模型调用、1 次工具调用后因图节点绑定路径不可用而失败，计量完整。R0 用 1 次模型调用选择了 `orchestration_search`。两次 MiMo 生成均产生合法 PackagePatch v3，且都修改了 O 类 `workflows/main.json`，但可执行编排投影未变化：第一次新增不属于 `ask` 网关接口的 binding 字段；第二次新增运行时不识别的根图字段 `error_routing`。搜索分别记录 `no_executable_orchestration_delta`，0 个候选进入 development 配对，0 个具备 selection 资格；guard、晋升和新任务复用均未运行，channel revision 为 0。此前新增的开发期候选错误码因未到达 development 而没有被真实检验。

这次暴露的是生成合同与可执行图语义之间的边界：包文件有 O 类变动并不等于执行编排有变化。随后修复将静态预检移到无编排增量判定之前，使不合法 `ask` binding 先收到 `ask_unsupported_gateway_arguments`；对未知根图字段新增 `unsupported_workflow_fields`，并在 R0 提示中列明可执行图字段。42 项编排及 17 项生成修复定向测试通过。修复发生在该次调用之后，不追溯修改收据，也不能据此称已走通后半段。下一次真实机制运行仍须先固定新合同；当前缺少合格候选、selection／guard 和跨进程复用的正向普通任务证据。
