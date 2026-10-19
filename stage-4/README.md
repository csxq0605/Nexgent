# Stage 4: 多 Agent 写作系统

## 交付物
一个多 Agent 管线：研究 → 写作 → 审查 → 修改

## 架构

```
用户主题
    |
    v
[Supervisor] ──────────────────────────┐
    |                                   |
    v                                   |
[Researcher] ──> 关键发现               |
    |                                   |
    v                                   |
[Writer] ──> 文章草稿                   |
    |                                   |
    v                                   |
[Reviewer] ──> 评分 + 反馈              |
    |                                   |
    v                                   |
  评分 >= 7? ──YES──> [完成]            |
    |                                   |
    NO                                  |
    |                                   |
    v                                   |
[Reviser] ──> 改进文章                  |
    |                                   |
    v                                   |
  （循环回 Reviewer，最多 2 次）─────────┘
```

## 关键概念

### 角色分离
每个 agent 都有：
- 专门的系统提示定义其专业领域
- 定义的输入模式（接收什么）
- 定义的输出模式（产出什么）

### Supervisor 模式
Supervisor 负责：
- 将任务委派给专门的 agent
- 在步骤之间聚合结果
- 控制审查-修改循环
- 强制停止条件（最大修改次数、批准阈值）

### 停止条件
- `score >= 7`：文章质量足够好
- `verdict == "approve"`：审查者明确批准
- `revision_count >= max_revisions`：防止无限循环

### 结构化 I/O
所有 agent 通过 JSON 对象通信，支持：
- 程序化聚合
- 质量门（评分阈值）
- 可追踪的数据流

## 运行方式
```bash
# 使用 MiMo 模型（通过 OpenAI 兼容接口）
# 在 .env 中配置 MIMO_BASE_URL, MIMO_API_KEY, MIMO_MODEL
pip install openai python-dotenv
python multi_agent_writer.py
```

## 参考资料
- [Claude Code Sub-agents](https://code.claude.com/docs/en/sub-agents)
- [Google ADK](https://google.github.io/adk-docs/)
- [Agent2Agent Protocol](https://google-a2a.github.io/A2A/specification/)
