# Nexgent

基于 Claude Code 架构的生产级模型无关 AI Agent Harness。

版本：`0.5.0` | Python：`>=3.10` | License：MIT

## Demo — 看 Nexgent 能做什么

```bash
cd nexgent/demo-project
nexgent
```

一个 FastAPI 认证服务。用 Nexgent 来审查代码、修复问题、实现功能：

```
nexgent> Read AGENTS.md                                    # 理解项目
nexgent> Run the tests                                     # 查看当前状态
nexgent> Review src/auth/admin.py for security issues      # 代码审查
nexgent> /parallel Review admin.py | Review rate_limit.py | Review roles.py  # 并行审查
nexgent> Fix the most critical bug you found               # 修复问题
nexgent> Implement the refresh feature in service.py       # 实现功能
nexgent> /goal All tests pass and no NotImplementedError remain  # 自主循环
nexgent> /workflow run examples/workflow-full-review.py     # 多阶段工作流
nexgent> /demo                                             # 一键跑完所有功能
```

Demo 包含：
- **9 个源码模块**（~1500 行），完整的认证服务
- **54 个测试**，覆盖核心功能
- **AGENTS.md** 项目知识库（自动加载）
- **/demo skill** 一键展示所有功能
- **workflow 脚本** 展示多阶段编排

## 核心特性

- **Agent Loop**: 依赖注入、熔断器（CircuitBreaker）、Token 预算、并行工具调度、流式输出、指数退避重试、优雅中断
- **38 个工具**（15 个模块）: 文件操作、Shell、代码执行、Web 搜索/抓取、文档创建、数学计算、笔记本编辑、任务管理、LSP 集成、调度器、计划模式、进程监控、交互提示、子代理、工作流
- **MCP 工具桥接**: MCP 服务器的工具自动注入 ToolRegistry，与内置工具统一调用
- **权限管线**: 6 种模式（DEFAULT/PLAN/AUTO/ACCEPT_EDITS/DONT_ASK/BYPASS），4 阶段管线（验证→规则匹配→上下文评估→用户提示），规则优先级 deny > ask > allow
- **安全管线**: 2 层防御（regex 预过滤 + 模型分类器），敏感数据自动脱敏，提示注入检测
- **上下文管理**: 1M token 窗口，4 级渐进压缩（snip → microcompact → collapse → autocompact），85% 阈值触发
- **记忆系统**: 4 类型记忆（user/feedback/project/reference），MEMORY.md 索引，YAML frontmatter 格式
- **会话管理**: JSONL 自动保存、检查点回滚、会话分叉、会话恢复、自动清理
- **Hook 系统**: 18 种生命周期事件，3 种 Hook 类型（command/HTTP/prompt），优先级排序，超时管理
- **SubAgent**: 并行/Pipeline 执行，生命周期管理，资源限制（最大步数/时长/token）
- **工作流引擎**: Python 脚本编排多代理，pipeline/parallel/phase 编排，Token 预算控制，可恢复/可保存，对标 Claude Code Dynamic Workflows
- **多模型配置**: `models.json` 统一管理多个 LLM 提供商，通过 `${VAR}` 引用 `.env` 中的密钥，支持为主对话/子代理/快速任务分别设置默认模型，运行时 `/model` 切换
- **插件系统**: `plugin.json` 清单、自动发现/加载/注册、工具注入到 ToolRegistry、技能/代理贡献、生命周期管理
- **Web 搜索**: Tavily API（结构化结果+AI 摘要）+ Bing/DuckDuckGo 双后端降级
- **MCP**: Model Context Protocol 集成，stdio/HTTP/SSE/WebSocket 协议，工具自动桥接到内置注册表
- **Skills**: SKILL.md 格式、动态上下文注入、参数替换、GitHub URL 安装
- **插件系统**: `plugin.json` 清单、自动发现/加载/注册、GitHub URL 安装（`/plugin install`）
- **TUI**: 全屏 Textual 界面，固定输入区 + 滚动输出，队列架构，斜杠命令自动补全
- **CLI**: 30+ 个斜杠命令，管道输入，3 种输出格式（text/json/stream-json），配置热重载
- **自定义智能体**: YAML frontmatter 定义，项目级/用户级，6 个预设模板
- **后台任务**: 异步执行、状态跟踪、取消、自动清理
- **@文件引用**: `@file`、`@folder/`、`@*.ext` 语法，自动注入上下文，路径遍历保护
- **目标管理**: `/goal` 设置完成条件，自动评估，持续工作直到满足
- **设置层级**: 4 级配置（managed → user → project → local），deny 规则不可覆盖
- **显示层**: Rich 终端输出，对话气泡、代码语法高亮、工具调用可折叠展示、状态栏、Unicode/ASCII 自动降级

## 快速开始

```bash
pip install -e .
cp .env.example .env      # 填入 API 密钥
cp models.json.example models.json  # 配置模型（可选，有默认值）
nexgent                   # 交互模式（TUI）
```

## 配置体系

```
models.json         ← 模型配置（提供商、模型名、base_url、defaults）
                      API key 通过 ${VAR} 引用 .env
.env                ← 所有密钥（MIMO_API_KEY、DEEPSEEK_API_KEY、GITHUB_TOKEN、TAVILY_API_KEY）
.nexgent/           ← 项目级配置
  ├── mcp.json      ← MCP 服务器配置
  ├── permissions.json
  └── settings.json
~/.nexgent/         ← 用户级配置
  ├── settings.json
  ├── skills/
  └── agents/
```

**models.json 示例**：

```json
{
  "providers": {
    "mimo": {
      "base_url": "https://token-plan-cn.xiaomimimo.com/v1",
      "api_key": "${MIMO_API_KEY}",
      "models": {
        "mimo-v2.5-pro": {"description": "MiMo Pro", "tags": ["smart", "default"]}
      }
    },
    "deepseek": {
      "base_url": "https://api.deepseek.com/v1",
      "api_key": "${DEEPSEEK_API_KEY}",
      "models": {
        "deepseek-chat": {"description": "DeepSeek V3", "tags": ["code"]}
      }
    }
  },
  "defaults": {
    "main": "mimo/mimo-v2.5-pro",
    "subagent": "mimo/mimo-v2.5-pro",
    "fast": "mimo/mimo-v2.5-pro"
  }
}
```

## 插件

```bash
# 安装插件
/plugin install https://github.com/csxq0605/plugins/tree/master/nexgent-plugin

# 管理
/plugin list              # 列出已安装插件
/plugin unload <name>     # 卸载插件
```

**可用插件**：

| 插件 | 说明 |
|------|------|
| [team-coord](https://github.com/csxq0605/plugins) | 多 agent 团队协调——lead 纯协调 + worker 并行执行，作为 subagent/workflow 的补充层 |

## 常用命令

```bash
nexgent                                  # 交互 TUI 模式
nexgent --task "问题"                    # 单次任务
cat file | nexgent -p "分析"             # 管道输入
nexgent --continue                       # 恢复最近会话
nexgent --resume                         # 选择会话恢复
nexgent --effort high                    # 高推理力度
nexgent --plan                           # 只读计划模式
nexgent --auto-approve                   # 自动批准写操作
nexgent --bare                           # 跳过记忆加载
nexgent --output-format json             # JSON 输出
nexgent --output-format stream-json      # 流式 JSON 输出
```

## 斜杠命令

| 命令 | 说明 |
|------|------|
| `/help` | 帮助 |
| `/tools` | 列出工具 |
| `/compact` | 压缩上下文 |
| `/context` | 逐消息 token 分解 |
| `/stats` | 会话统计 |
| `/rewind` | 回退检查点 |
| `/fork` | 分叉会话 |
| `/clear` | 清除会话消息 |
| `/save <path>` | 保存会话到文件 |
| `/load <path>` | 从文件加载会话 |
| `/effort <low\|medium\|high>` | 设置推理力度 |
| `/memory` | 列出记忆 |
| `/remember` | 保存新记忆 |
| `/hooks` | 列出 Hook |
| `/init` | 生成 AGENTS.md |
| `/init-config` | 生成配置模板 |
| `/subagents` | 列出活跃子代理 |
| `/subagent <task>` | 运行单个子代理 |
| `/parallel <t1> \| <t2>` | 并行运行任务 |
| `/pipeline <t1> \| <t2>` | 流水线运行任务 |
| `/agents list\|create\|show\|delete` | 自定义智能体管理 |
| `/tasks list\|show\|cancel\|cleanup` | 后台任务管理 |
| `/goal <condition>` | 设置目标条件 |
| `/goal clear` | 清除目标 |
| `/skills` | 查看/安装 Skills |
| `/mcp` | MCP 服务器管理 |
| `/mcp install\|connect\|disconnect\|refresh` | MCP 操作 |
| `/workflow run <script>` | 运行工作流脚本 |
| `/workflow list\|status\|resume\|save` | 工作流管理 |
| `/model` | 列出可用模型 |
| `/model list` | 列出模型配置 |
| `/model set <id>` | 切换主对话模型 |
| `/model default <role> <id>` | 设置默认模型（main/subagent/fast） |
| `/plugin list` | 列出已安装插件 |
| `/plugin install <url>` | 从 GitHub 安装插件 |
| `/plugin load <path>` | 加载插件 |
| `/plugin unload <name>` | 卸载插件 |
| `/btw` | 注入运行中指导 |
| `@file` | 引用文件内容 |
| `!<cmd>` | 执行 shell |
| `/quit`, `/exit`, `/q` | 退出 |

## TUI 快捷键

| 快捷键 | 说明 |
|--------|------|
| `Ctrl+C` | 中断当前任务（优雅停止） |
| `Ctrl+K` | 强制杀死卡住的线程 |
| `Escape` | 中断任务 / 清空输入 |
| `Shift+Tab` | 循环切换模式（default → plan → auto → dry-run） |
| `Tab` | 斜杠命令 / @文件引用 自动补全 |
| `↑` / `↓` | 浏览输入历史 |
| `Ctrl+Y` | 复制最后一条助手输出到剪贴板 |

## 权限模式

| 模式 | 说明 |
|------|------|
| `default` | 每次写操作都需要确认 |
| `plan` | 只读模式，不允许写操作 |
| `auto` | 自动批准安全操作 |
| `accept_edits` | 文件读写自动批准，Shell 仍需确认 |
| `dont_ask` | 仅允许预批准工具，其余自动拒绝 |
| `bypass` | 全部允许（仅熔断器阻止危险操作） |
| `dry-run` | 干运行模式，显示但不执行 |

## 架构

```
nexgent/
├── agent.py              # 核心循环（NexgentAgent、AgentDeps、CircuitBreaker、TokenBudget）
├── cli.py                # REPL 入口、斜杠命令处理
├── workflow.py           # 工作流引擎（pipeline/parallel/phase 编排、预算控制、可恢复）
├── models.py             # 多模型配置（ModelRegistry、ModelProfile）
├── plugins.py            # 插件系统（PluginManager、发现/加载/注册）
├── context.py            # 会话管理 + 渐进压缩
├── permissions.py        # 4 阶段权限管线
├── security_pipeline.py  # 2 层安全防御
├── memory.py             # 4 类型记忆系统
├── hooks.py              # 18 种生命周期 Hook
├── subagent.py           # SubAgent 生命周期管理
├── skills.py             # Skills 系统
├── mcp.py                # MCP 支持（stdio/HTTP/SSE/WebSocket，工具自动桥接到 ToolRegistry）
├── tui.py                # 全屏 TUI 界面
├── display.py            # 显示层（Rich 输出、对话气泡、语法高亮）
├── commands.py           # 命令定义（单一来源）
├── agents.py             # 自定义智能体（YAML frontmatter，6 个预设模板）
├── background_tasks.py   # 后台任务管理
├── file_references.py    # @文件引用
├── goal.py               # 目标管理
├── settings.py           # 4 级层级设置
├── config.py             # 配置加载（models.json → .env 链式加载，3 级搜索路径）
├── token_counter.py      # tiktoken 精确计数
├── project_scanner.py    # 项目分析 + AGENTS.md 生成
├── input_utils.py        # prompt_toolkit 集成 + 持久化历史
├── logging_utils.py      # 结构化追踪日志
└── tools/                # 15 个工具模块，38 个工具
    ├── file_ops.py       # read_file, write_file, edit_file, glob_files, grep_files, list_directory
    ├── shell.py          # run_command（后台任务支持、只读自动检测）
    ├── code_exec.py      # execute_python
    ├── web_tools.py      # web_search（Tavily+降级）, web_fetch（SSRF 防护）
    ├── doc_tools.py      # create_doc, create_spreadsheet
    ├── math_tools.py     # evaluate_math（AST 安全求值）
    ├── interactive.py    # ask_user_question, read_memory_topic
    ├── monitor.py        # monitor_start, monitor_stop, monitor_list
    ├── notebook_tools.py # notebook_edit
    ├── task_tools.py     # task_create, task_list, task_get, task_update, task_delete
    ├── plan_tools.py     # enter_plan_mode, exit_plan_mode
    ├── lsp_tools.py      # lsp_definition, lsp_references, lsp_diagnostics
    ├── scheduler_tools.py # cron_create, cron_delete, cron_list
    ├── subagent_tools.py # subagent_run
    ├── workflow_tools.py # workflow_run, workflow_list, workflow_status, workflow_save, workflow_resume
    └── registry.py       # 工具注册 + 分发 + 磁盘溢出
```

## 测试

```bash
pip install -e ".[dev]"
python -m pytest tests/ --ignore=tests/test_e2e.py -v  # 单元测试
python -m pytest tests/test_e2e.py -v                    # E2E fast
python -m pytest tests/test_e2e.py -v --run-slow         # E2E fast + slow
python run_tests.py --all                                 # 全部
python run_tests.py --no-e2e                              # 跳过 E2E
```

**测试分层**：
- `fast`：无 API 调用，mock 驱动，每个 <1s（默认运行）
- `slow`：真实 API 调用，网络依赖，可能需要几分钟
- `e2e`：端到端测试，真实 API + 真实工具

**测试覆盖**：34 个测试文件，982 个测试用例，覆盖所有核心模块。

## Python API

```python
from nexgent.agent import NexgentAgent

harness = NexgentAgent(auto_approve=True)
result = harness.run("分析 src/ 的架构")

# 子代理
results = harness.run_parallel_subagents(["Task 1", "Task 2"])

# 工作流
runner = harness.workflow_runner
run = runner.run(script_source="async def main(ctx, args): ...")
```

## 设计模式

本项目采用 Claude Code 架构的 20 种设计模式：

1. **依赖注入** — `AgentDeps` 注入 LLM 客户端工厂、UUID 生成器、重试参数
2. **熔断器** — `CircuitBreaker` 连续 N 次错误后停止（默认 3）
3. **状态机** — `TerminationReason` 枚举，7 种终止路径
4. **Fail-Closed 默认** — 工具必须显式声明安全性
5. **4 阶段权限管线** — 验证→规则匹配→上下文评估→用户提示
6. **渐进压缩** — 4 级压缩，85% 阈值触发
7. **类型化记忆** — 4 类型 + YAML frontmatter + MEMORY.md 索引
8. **Hook 生命周期** — 18 事件 × 3 类型
9. **会话作用域状态** — `contextvars` 防止跨 SubAgent 污染
10. **指数退避重试** — HTTP 429/500/502/503/504 + 网络错误
11. **流式分块超时** — `_StreamReader` 后台线程，120s 分块超时
12. **优雅中断** — `GracefulAbort` 使用 `threading.Event` 协作取消
13. **并发工具执行** — `is_concurrency_safe=True` 的工具通过 `ThreadPoolExecutor` 并行
14. **磁盘溢出** — 超过 10K token 的工具结果溢出到 `.nexgent/outputs/`
15. **配置热重载** — `ConfigWatcher` 监控配置变更
16. **层级设置** — 4 级配置，deny 规则累积不可覆盖
17. **2 层安全防御** — regex 预过滤 + 模型分类器
18. **合成响应对象** — `_AttrBag` 替代 `MagicMock` 构建流式响应
19. **Unicode/ASCII 自动降级** — 检测终端编码支持，自动切换
20. **MCP 工具桥接** — MCP 服务器工具自动注入内置 ToolRegistry

## License

MIT License
