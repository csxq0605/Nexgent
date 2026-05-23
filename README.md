# Agent Learning Hub - MiMo 全阶段实践

> 基于 [datawhalechina/Agent-Learning-Hub](https://github.com/datawhalechina/Agent-Learning-Hub) 学习路线，使用小米 **MiMo 模型**（`mimo-v2.5-pro`）完成 Stage 0-8 全部实践，包含完整运行结果、代码审查与安全修复。

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

| Stage | 主题 | 核心能力 | 关键修复 |
|-------|------|----------|----------|
| 0 | 理论基础 | Agent 概念、ReAct 模式 | - |
| 1 | 最小 Agent | 单轮 tool calling、安全数学求值 | `eval()` → AST 沙箱 |
| 2 | RAG 研究助手 | 文本分块、嵌入检索、代码执行 | `exec()` → subprocess 隔离 |
| 3 | Agent Harness | 工具注册、权限门控、上下文压缩 | 路径校验、权限确认、orphan 过滤 |
| 4 | 多 Agent 协作 | 研究→写作→审阅→修改 pipeline | 健壮 JSON 提取 |
| 5 | Skill 框架 | 可复用 Skill 定义与执行 | JSON 提取、温度调优 |
| 6 | 浏览器自动化 | Playwright 异步操作、安全守卫 | 返回类型一致性 |
| 7 | 评估框架 | 15 项测试用例、多层评判 | 千分位分隔符归一化 |
| 8 | 生产级 DevOps Agent | 结构化日志、重试、成本追踪 | 选择性重试、跨平台兼容 |

## 核心文件

```
├── config.py                    # 统一配置加载（从 .env 读取）
├── STAGE_RESULTS.md             # 全阶段运行结果与深度解析
├── CODE_REVIEW.md               # 代码审查报告（P0-P3 分级）
├── stage-0/note-why-agent.md    # 理论笔记
├── stage-1/minimal_agent.py     # 最小 Agent（安全数学求值）
├── stage-2/research_assistant.py # RAG 研究助手
├── stage-3/harness_demo.py      # Agent Harness 框架
├── stage-4/multi_agent_writer.py # 多 Agent 写作流水线
├── stage-5/code-review-skill/   # Skill 框架示例
├── stage-6/browser_agent.py     # 浏览器自动化 Agent
├── stage-7/eval_runner.py       # Agent 评估框架
└── stage-8/devops-agent/        # 生产级 DevOps Agent
```

## 代码审查与修复

共发现并修复 **14 项问题**，按严重级别分类：

### Critical (P0) - 安全漏洞
1. **`eval()` 沙箱逃逸**（Stage 1, 3）→ AST 遍历安全求值器
2. **`exec()` 任意代码执行**（Stage 2）→ subprocess + tempfile + 超时隔离
3. **权限门控绕过**（Stage 3）→ 交互式确认 + EOFError 处理
4. **路径遍历写入**（Stage 3）→ Path.resolve() + cwd 校验

### Warning (P1) - 可靠性问题
5. **死循环**（Stage 2 chunk_text）→ chunk_size > overlap 校验
6. **orphan tool 引用**（Stage 3 compact_context）→ valid_tool_call_ids 过滤
7. **脆弱 JSON 提取**（Stage 4, 5）→ 多层正则 + 降级解析
8. **评判系统千分位**（Stage 7）→ 逗号归一化正则
9. **重试认证错误**（Stage 8）→ 仅重试 429/5xx

### Info (P2-P3) - 优化项
10-14. 温度调优、返回类型一致性、跨平台兼容等

详见 [CODE_REVIEW.md](CODE_REVIEW.md)。

## 运行结果摘要

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
```

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
