# MiMo Harness 待办事项

## 1. 优化 Tokens 计数方式

**目标**: 参考最新的 Claude Code 和 Codex 的实现方式，优化 tokens 统计和计数机制

**当前状态**:
- 使用加权启发式算法（~3.5-4.5 chars/token）
- 基于内容类型的差异化比率（tool/system/code/natural language）

**需要研究**:
- [ ] Claude Code 的 token 计数实现方式
- [ ] Codex 的 token 统计方法
- [ ] 是否使用 tiktoken 或其他 tokenizer 库
- [ ] 流式输出时的实时 token 统计
- [ ] Token 预算管理和警告机制

**参考资源**:
- Claude Code 源码分析
- OpenAI tiktoken 库
- Anthropic 的 token 计数文档

---

## 2. 优化权限管线 - 模型驱动的权限判别

**目标**: 参考 Claude Code 的最新实现，使用模型来判别权限，减少算法逻辑依赖

**当前状态**:
- 4 阶段权限管线（protected_paths → hook_blocked → model_classifier → rule_engine）
- 使用正则表达式和规则引擎进行权限判断
- 模型分类器仅在 auto_approve 模式下启用

**需要改进**:
- [ ] 研究 Claude Code 的权限判别实现
- [ ] 将模型分类器设为主要判别方式
- [ ] 实现自动审查机制（模型自我审查）
- [ ] 减少硬编码的算法逻辑
- [ ] 添加权限决策的可解释性

**Claude Code 参考**:
- 使用模型进行安全分类（SafetyDecision）
- 自动审查和确认机制
- 基于上下文的动态权限判断

---

## 3. 添加子 Agent 系统

**目标**: 参考 Claude Code 的 Agent Team 实现方式，在 harness 架构中添加子 agent 系统

**当前状态**:
- 单一 agent 循环
- 无子 agent 支持
- 无并行任务执行

**需要实现**:
- [ ] 研究 Claude Code 的 Agent Team 架构
- [ ] 设计子 agent 生命周期管理
- [ ] 实现子 agent 间通信机制
- [ ] 支持并行任务执行
- [ ] 实现子 agent 结果聚合
- [ ] 添加子 agent 资源限制和隔离

**Claude Code 参考**:
- `Agent` 工具：启动独立子 agent
- `SendMessage`：与子 agent 通信
- 工作树隔离（worktree isolation）
- 后台任务执行
- 子 agent 结果返回机制

**架构设计**:
```
MiMoHarness (主 agent)
├── Agent Loop
├── Tool Registry
└── Sub-Agent Manager
    ├── Agent Pool
    ├── Task Queue
    ├── Communication Channel
    └── Result Aggregator
```

---

## 优先级

| 任务 | 优先级 | 预估工作量 |
|------|--------|-----------|
| 1. Tokens 计数优化 | 中 | 1-2 天 |
| 2. 权限管线优化 | 高 | 2-3 天 |
| 3. 子 Agent 系统 | 高 | 3-5 天 |

## 参考资源

- [Claude Code 官方文档](https://docs.anthropic.com/en/docs/claude-code)
- [Claude Code 架构分析](https://github.com/anthropics/claude-code)
- [OpenAI Codex](https://github.com/openai/codex)
- [Agent Design Patterns](https://www.anthropic.com/engineering/building-effective-agents)
