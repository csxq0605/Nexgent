# 四臂编排 control harness：最小安全前置件

日期：2026-09-23。状态：**可执行的 qualification 前置件，不是四臂因果研究实现。**

## 为什么不直接扩展 RSIStudyService

当前 `RSIStudyService` 有两个有意的 confirmatory 边界：它只接受恰好两个
AgentPackage 臂，并且每个 final-holdout cell 都从空 memory 开始、禁止写回。
因此它不能表示 F/S/M/E 四臂，也不能把冻结的 MemoryService release 作为 M
treatment。绕过这两个检查会混淆已有 final-holdout 证据的含义。

`experiments/orchestration_controls/harness.py` 只补最小前置能力：让四种设置在
真实 `TaskService`、同一 canonical benchmark adapter 和宿主独立 evaluator 上运行，
并检查执行合同。它拒绝 `final_holdout`，不会给出 causal effect estimate，也不写
package 或 memory channel。

## 四臂合同

| 臂 | 冻结设置 | harness 检查 |
| --- | --- | --- |
| F `fixed_multi` | 固定多角色 O/S，空初始 memory | package digest、实际角色调用、用量 |
| S `single_equal_budget` | 单角色三次顺序调用，空初始 memory | 与其他臂相同的 task Episode 硬上限 |
| M `memory_only` | 与 F **完全相同的 package digest**，接受的 memory release | release 与 package 绑定，memory 实际消费 |
| E `evolved` | 已存在的 O/S package、M release 或可用子集 | 声明 surface 与 package/release 差异一致 |

每个四臂 row 复用字节等价的公开 task payload、benchmark snapshot、工具权限和
五项任务硬上限：model calls、completion tokens、tool calls、charged tool work
units、nodes。唯一允许的信息差异是预先声明的 memory treatment；所有臂均禁止
writeback，evaluator 仍留在宿主侧。顺序由冻结 plan 确定，运行前先持久化 plan，
每个 Episode 创建后立即写入 receipt，支持从已记录 Episode 继续。

“等预算”在这里严格指**单个任务 Episode 的相同硬上限**。候选生成、失败候选、
development feedback、memory admission/selection/promotion、guard 和 rollback 不在
该 harness 的预算内。宿主 charged counters 与 provider receipt 中实际报告的
prompt/completion tokens 分开按臂汇总；两者都可能不同，不能因为上限相同就声称
成本相同。完整 E 臂研究必须另行冻结并合并外层演化成本。

## 运行

先准备一个与 F package 绑定、已接受并发布的 memory channel，以及一个已存在的
evolved package JSON。随后运行：

```powershell
python -m experiments.orchestration_controls.run `
  --root PROJECT `
  --data PINNED_BBH_DATA `
  --memory-channel CONTROL_MEMORY `
  --evolved-package CHILD_PACKAGE.json `
  --evolved-surface O --evolved-surface S `
  --split selection --seed 11 --seed 29
```

BBH 只能用于接口和执行 qualification。输出中的 arm mean 是描述统计；
`causal_effect_estimate` 固定为 `null`，claim ceiling 固定为
`qualification_only_noncausal`。即使 `valid_execution_preflight=true`，也只说明四臂
按合同运行，不说明 E 优于 F/S/M，也不说明 RSI 有效。

## 升级为正式研究仍缺什么

正式四臂研究需要新的多臂 study protocol，而不是把四次两臂研究拼接起来：同一
来源 cluster 的四臂联合注册与单次消费、M release 的私有冻结、外层演化成本账本、
跨 family/evolution seed 的分层统计、Holm 校正、基础设施缺测的整组重跑，以及
O/S+M 原子发布。完成这些合同前，本 harness 的结果不能进入 E2–E6 结论。
