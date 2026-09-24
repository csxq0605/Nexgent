# 在普通任务中启用自动改进

Nexgent 核心不内置任务评分器。项目宿主先安装一个实现 `BenchmarkAdapter` 的独立评价插件，再在项目根目录创建 `nexgent.auto-evolution.json`。Main 与 `nexgent task` 共用这个配置；单通道项目不需要在每次任务中输入反馈、候选或评价 ID。没有配置时，普通任务照常执行，但不会自动晋升包版本。

```json
{
  "schema": "nexgent.auto-evolution-config.v1",
  "improver_channel": "project-improver",
  "bootstrap_default_improver": true,
  "default_channel": "project-tasks",
  "channels": {
    "project-tasks": {
      "evaluator_id": "installed-benchmark-id",
      "candidate_types": ["tool", "service_provider", "orchestration", "no_change"],
      "budget": {
        "max_model_calls": 8,
        "max_completion_tokens": 32000,
        "max_tool_calls": 12,
        "max_nodes": 48
      },
      "promotion_policy": {
        "min_quality_delta": 0,
        "min_success_rate": 1,
        "max_cost_ratio": 3,
        "max_regressions": 0
      }
    }
  }
}
```

`evaluator_id` 必须是本机已安装且可用的独立插件；配置读取时会验证。`default_channel` 决定 Main 和不带 `--package-channel` 的 CLI 任务使用哪个版本化包；多个通道但没有默认项时，CLI 要显式指定通道，Main 不会静默选错。`bootstrap_default_improver` 只在该改进器通道不存在时注册 R0，不覆盖现有版本。模型配置仍由项目的 `models.json`／环境变量提供，API 密钥不能写入此文件。

每个普通终态任务先得到持久反馈工作项；改进器可以返回 `no_change`。有候选时，宿主才运行独立 selection；只有证据满足策略才晋升、运行 guard，后续任务读取新通道版本。CLI 的 `auto_evolution.work` 和 Main 的运行消息显示工作项状态；`rejected` 或 `rolled_back` 是有效的防退化结果，不代表收益。原始 Episode、评价和版本收据保存在项目 `.nexgent` 中。

Main 启动时会在后台扫描和恢复未完成的工作。命令行进程中断后，可运行 `nexgent --root PROJECT rsi-auto-advance` 恢复，无需手动传递内部 ID。关闭 Main 或按停止时，当前模型／评价步骤收到取消信号；已持久化的未知外部结果不会被擅自重发。

此路径首次真实调用的[负结果和限制](../../experiments/ordinary_feedback_live/RESULTS.md)可供核对。正式效果结论仍需同任务族、多 seed 和固定编排／单智能体／仅记忆对照。
