# Agent Learning Hub - MiMo

基于 [datawhalechina/Agent-Learning-Hub](https://github.com/datawhalechina/Agent-Learning-Hub) 学习路线，使用小米 MiMo 模型完成 Stage 0-8 全部实践。

## 模型配置

| 配置项 | 值 |
|--------|-----|
| Base URL | `https://token-plan-cn.xiaomimimo.com/v1` |
| Model | `mimo-v2.5-pro` |
| 接口格式 | OpenAI Compatible |

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

## 快速开始

```bash
git clone https://github.com/csxq0605/Agent-Learning-Hub-MiMo.git
cd Agent-Learning-Hub-MiMo
pip install openai python-dotenv

# 配置 .env
echo 'MIMO_BASE_URL=https://token-plan-cn.xiaomimimo.com/v1' > .env
echo 'MIMO_API_KEY=your-api-key-here' >> .env
echo 'MIMO_MODEL=mimo-v2.5-pro' >> .env

# 运行任意 Stage
python stage-1/minimal_agent.py

# 或使用完整 Harness（推荐）
cd mimo-harness && pip install -e .
mimo-harness   # 进入交互模式
```

## MiMo Harness

基于 Stage 0-8 经验构建的完整 Agent Harness，参考 Claude Code 架构。详见 [mimo-harness/README.md](mimo-harness/README.md)。

## License

MIT License. See [LICENSE](LICENSE) for details.
