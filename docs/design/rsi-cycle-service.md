# 可恢复 RSI Cycle 服务

状态：0.9 后端服务、CLI 与信息窗口只读投影已实现。

`RSICycleService` 将一次跨任务行为改进保存为持久状态机，减少调用方在多个命令之间手工搬运 feedback、candidate、trial、decision 和 guard ID。它只编排已有控制面，不替代 `GenerationService`、`EvolutionService` 的不可变记录、独立评价和部署门控。

## 冻结输入

创建 cycle 时固定：

- AgentPackage channel 的 revision、父包身份和 feedback Episode；
- 独立 improver 包，或独立 R channel 的 revision、package ID 与 digest；
- mutation policy；
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

当 cycle 从递归 improver channel 取得 `R` 时，创建 cycle 会冻结 channel、revision、package ID 与 digest。GenerationService 的首次解析不是唯一检查点：可信宿主会在创建 Episode 前重新解析一次，并在 Episode 从 `ready` 转为 `running`、写入 `episode_started` 和执行包之前再次核验。任何 TOCTOU 漂移都会在模型调用前失败；调用方不能通过普通 task context 注入或替换这份宿主登记。

## 公开投影

`public()` 只返回状态、版本身份、benchmark/snapshot digest、证据 ID、聚合结果和错误类型。adapter snapshot、mutation policy、包内容、内部错误正文和 evaluator 私有内容不会进入公开投影。

这些机制证明 cycle 编排、恢复和门控闭合；它们不证明真实模型候选更好，也不构成统计 RSI 效果。

## 产品入口

- `rsi-cycle-start` 冻结并默认执行完整 cycle，`--register-only` 只登记；
- `rsi-cycle-resume` 从 checkpoint 继续并重新核验 benchmark snapshot；
- `rsi-cycle-show` 只显示公开投影；
- `rsi-cycle-recover` 处理硬中断，未能安全恢复时输出状态并返回非零；
- GUI“RSI 与版本”页按 cycle ID 查询相同公开投影，不执行写操作。

CLI 默认使用 `reference-os-v1`，也接受显式 improver package，或成对提供 `--improver-channel` 与 `--expected-improver-revision`。公开投影只显示来源类型及 channel/revision/package identity，不返回 R 的源码或归档内容。
