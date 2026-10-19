# Stage 5: 可复用代码审查 Skill

## 交付物
一个可复用的 `code-review` skill，包含 SKILL.md、审查脚本和冒烟测试。

## Skill vs Tool vs Prompt vs MCP

| 概念 | 是什么 | 示例 |
|------|--------|------|
| **Tool** | 可调用的 API 端点 | `read_file(path)` 返回文件内容 |
| **Prompt** | 一次性指令 | "审查这段代码的 bug" |
| **Skill** | 可复用的工作流，包含步骤、脚本、模板和验收标准 | 这个 code-review skill |
| **MCP** | 连接外部工具/数据源的协议 | Jira MCP 服务器用于工单访问 |

Skill **不仅仅是 prompt**，它有：
- 定义的触发条件（"何时使用"）
- 分步骤工作流
- 支持脚本和模板
- 成功的验收标准
- 验证其工作的冒烟测试

## Skill 结构

```
code-review-skill/
├── SKILL.md          # Skill 定义（名称、描述、使用时机、步骤、验收标准）
└── review.py         # 入口脚本，带冒烟测试
```

## 运行方式

```bash
pip install openai python-dotenv

# 冒烟测试（验证 skill 工作 - 测试 SQL 注入和硬编码凭据检测）
python review.py --smoke-test

# 审查文件
# 在 .env 中配置 MIMO_BASE_URL, MIMO_API_KEY, MIMO_MODEL
python review.py src/auth.py

# 指定焦点审查（security, bug, style, performance）
python review.py src/api.py --focus security
```

## 审查输出格式

审查产生结构化 JSON 输出：
- **issues**：发现数组，包含严重性（critical/warning/info）、类别、行号、描述和建议
- **summary**：审查文件数、按严重性统计的问题数、整体质量评级

## 冒烟测试

冒烟测试验证：
1. 到 MiMo 模型的 API 连通性
2. JSON 输出解析
3. 测试代码中的 SQL 注入检测
4. 测试代码中的硬编码凭据检测

## 参考资料
- [Claude Code Skills](https://code.claude.com/docs/en/skills)
- [OpenClaw Skills](https://github.com/openclaw/openclaw/blob/main/docs/tools/skills.md)
- [SWE-Skills-Bench](https://arxiv.org/abs/2603.15401)
