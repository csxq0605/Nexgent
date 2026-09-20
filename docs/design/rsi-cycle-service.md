# 可恢复 RSI Cycle 服务

状态：0.9 后端服务已实现；CLI 与信息窗口接入属于下一阶段。

`RSICycleService` 将一次跨任务行为改进保存为持久状态机，减少调用方在多个命令之间手工搬运 feedback、candidate、trial、decision 和 guard ID。它只编排已有控制面，不替代 `GenerationService`、`EvolutionService` 的不可变记录、独立评价和部署门控。

## 冻结输入

创建 cycle 时固定：

- AgentPackage channel 的 revision、父包身份和 feedback Episode；
- 独立 improver 包与 mutation policy；
- selection 与 guard benchmark 的身份和 snapshot；
- 两阶段 seed、预算、选项和 `PromotionPolicy`；
- guard 退化时是否按冻结策略回滚。

核心不读取 benchmark 的领域语义。Workbench、OpenFOAM 或后续 benchmark 只实现相同 adapter 合同。

## 状态与门控

```text
registered
  -> feedback_captured
  -> generated | generation_missing
  -> selection_planned
  -> selection_run
  -> selected | rejected
  -> guard_planned
  -> promoted
  -> guard_run
  -> completed | guard_failed | rolled_back
```

终态不能从更早阶段跳入。`completed` 必须已经形成 selection decision、monitor plan、实际 promotion、完整 guard run 和 monitor assessment。每个状态只保存现有不可变证据的 ID；cycle 自身另有 revision CAS 和 hash-linked event chain。

## 恢复语义

每次外部步骤前先保存 `pending_action`。普通异常会保留 checkpoint；进程在外部提交与 cycle checkpoint 之间中断时，`resume()` 不会猜测或静默重放。

paired trial 与 monitor run 使用单次 claim。若不可变 run record 已写入但 claim 尚未完成，恢复会唯一核验与 plan 绑定的记录，在一个事务中补齐至多一个 completion event 并完成 claim，不会重复 Episode。若只有 running claim 而没有可关联记录，只有调用方明确确认外部动作未提交，才可清除 claim；否则保持 `recovery_required`。

promotion 后的 guard 执行、评估和回滚都绑定 cycle 记录的 revision、package ID 与 monitor plan。通道漂移会失败，不会把另一部署的 guard 记到当前 cycle。

## 公开投影

`public()` 只返回状态、版本身份、benchmark/snapshot digest、证据 ID、聚合结果和错误类型。adapter snapshot、mutation policy、包内容、内部错误正文和 evaluator 私有内容不会进入公开投影。

这些机制证明 cycle 编排、恢复和门控闭合；它们不证明真实模型候选更好，也不构成统计 RSI 效果。
