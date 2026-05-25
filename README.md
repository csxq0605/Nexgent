# Agent Learning Hub - MiMo 全阶段实践

> 基于 [datawhalechina/Agent-Learning-Hub](https://github.com/datawhalechina/Agent-Learning-Hub) 学习路线，使用小米 **MiMo 模型**（`mimo-v2.5-pro`）完成 Stage 0-8 全部实践，包含完整运行结果与代码审查。

## 项目来源

本项目是对 [datawhalechina/Agent-Learning-Hub](https://github.com/datawhalechina/Agent-Learning-Hub) 仓库的完整实践。原始仓库由 Datawhale 成员陈思州维护，提供了一份系统的 AI Agent 学习路线，从理论基础到生产级 Agent 共分 9 个阶段。

**本仓库的定位**：不是原始仓库的 fork，而是独立的实践记录——将每个 Stage 的代码实际运行起来，发现并修复安全和可靠性问题，记录完整的运行结果和工程洞察。

## 模型配置

所有 Agent 均使用小米 MiMo 模型，通过 OpenAI 兼容接口调用：

| 配置项 | 值 |
|--------|-----|
| Base URL | `https://token-plan-cn.xiaomimimo.com/v1` |
| Model | `mimo-v2.5-pro` |
| 接口格式 | OpenAI Compatible (tool calling) |

## 阶段概览

| Stage | 主题 | 核心能力 |
|-------|------|----------|
| 0 | 理论基础 | Agent 概念、ReAct 模式 |
| 1 | 最小 Agent | 单轮 tool calling、安全数学求值 |
| 2 | RAG 研究助手 | 文本分块、嵌入检索、代码执行 |
| 3 | Agent Harness | 工具注册、权限门控、上下文压缩 |
| 4 | 多 Agent 协作 | 研究→写作→审阅→修改 pipeline |
| 5 | Skill 框架 | 可复用 Skill 定义与执行 |
| 6 | 浏览器自动化 | Playwright 异步操作、安全守卫 |
| 7 | 评估框架 | 15 项测试用例、多层评判 |
| 8 | 生产级 DevOps Agent | 结构化日志、重试、成本追踪 |

## 核心文件

```
├── config.py                    # 统一配置加载（从 .env 读取）
├── STAGE_RESULTS.md             # 全阶段运行结果与深度解析
├── CODE_REVIEW.md               # 代码审查报告
├── stage-0/note-why-agent.md    # 理论笔记
├── stage-1/minimal_agent.py     # 最小 Agent（安全数学求值）
├── stage-2/research_assistant.py # RAG 研究助手
├── stage-3/harness_demo.py      # Agent Harness 框架
├── stage-4/multi_agent_writer.py # 多 Agent 写作流水线
├── stage-5/code-review-skill/   # Skill 框架示例
├── stage-6/browser_agent.py     # 浏览器自动化 Agent
├── stage-7/eval_runner.py       # Agent 评估框架
├── stage-8/devops-agent/        # 生产级 DevOps Agent
└── mimo-harness/                # 完整 Agent Harness（可安装使用）
```

## 代码审查

对 Stage 0-8 及 MiMo Harness 进行了系统性代码审查，涵盖安全漏洞、可靠性问题和代码质量。详细审查报告见 [CODE_REVIEW.md](CODE_REVIEW.md)。

## 运行结果

- **Stage 7 评估**：修复前 14/15（93.3%），修复后 **15/15（100%）**
- **安全测试**：所有沙箱逃逸尝试均被阻断
- **全 Stage 通过**：8 个代码 Stage 全部成功调用 MiMo API 并返回正确结果

详见 [STAGE_RESULTS.md](STAGE_RESULTS.md)。

## 快速开始

```bash
# 1. 克隆仓库
git clone https://github.com/csxq0605/Agent-Learning-Hub-MiMo.git
cd Agent-Learning-Hub-MiMo

# 2. 安装依赖
pip install openai python-dotenv

# 3. 配置 API
# 创建 .env 文件：
echo 'MIMO_BASE_URL=https://token-plan-cn.xiaomimimo.com/v1' > .env
echo 'MIMO_API_KEY=your-api-key-here' >> .env
echo 'MIMO_MODEL=mimo-v2.5-pro' >> .env

# 4. 运行任意 Stage
python stage-1/minimal_agent.py
python stage-2/research_assistant.py
python stage-3/harness_demo.py
python stage-4/multi_agent_writer.py
python stage-7/eval_runner.py

# 5. 或者直接使用完整 Harness（推荐）
cd mimo-harness
pip install -e .
mimo-harness --task "What is 247 * 893?"
mimo-harness  # 进入交互模式
```


## MiMo Harness

基于 Stage 0-8 的经验，构建了一个完整的、可下载体验的 Agent Harness，参考 Claude Code 架构设计。

**核心能力**：Agent Loop（DI + 熔断 + Token 预算 + 并行调度 + 流式响应）、15 个工具（并发安全标记）、4 阶段权限管线（路径级规则）、Token-based 上下文压缩（200K 窗口 + LLM 语义摘要）、4 类型记忆系统、Hook 生命周期、`/init` 生成 AGENTS.md、交互式 REPL、后台监控。

**测试覆盖**：306 个测试（含 119 个压力/边界测试），覆盖路径遍历、SSRF、Shell 注入、大输入、Unicode、权限压力、并发安全、数学 DoS、压缩集成、并行调度、流式响应、后台任务、交互式工具等场景。

详见 [mimo-harness/README.md](mimo-harness/README.md)。

## Agent 工程能力总结

通过 9 个 Stage 的实践，提炼出 Agent 工程的核心能力模型：

```
Agent = LLM(大脑) + Tools(手脚) + Memory(记忆) + Planning(规划) + Harness(约束框架)
```

**Harness 是区分 Demo 与生产 Agent 的关键**：
- 工具注册与协议定义
- 权限门控与安全边界
- 会话管理与上下文压缩
- 结构化日志与可观测性
- 成本追踪与熔断机制
- 评估体系与持续改进

## 致谢

- 原始学习路线：[datawhalechina/Agent-Learning-Hub](https://github.com/datawhalechina/Agent-Learning-Hub)
- 模型支持：小米 MiMo 团队
- 组织：Datawhale

## License

MIT License. See [LICENSE](LICENSE) for details.
