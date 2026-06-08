# MiMo Harness 仓库调研报告

# MiMo Harness 仓库调研报告

## 1. 项目概述

**MiMo Harness** 是一个由小米 MiMo 模型驱动的生产级 AI 代理框架，遵循 Claude Code 架构模式。该项目是 [Agent Learning Hub](https://github.com/datawhalechina/Agent-Learning-Hub) 的一部分。

- **版本**: 0.3.0
- **许可证**: MIT License
- **Python 要求**: 3.10+
- **仓库地址**: https://github.com/csxq0605/Agent-Learning-Hub-MiMo

## 2. 主要特性

### 2.1 代理循环 (Agent Loop)
- 依赖注入（DI）提高可测试性
- 电路断路器（Circuit Breaker）防止级联故障
- Token 预算跟踪和警告
- 并行工具调度
- 流式传输支持
- 努力级别（low/medium/high）
- 备用模型支持
- 优雅中止机制

### 2.2 工具模块 (14个)
- **文件操作**: 文件读写编辑、glob搜索、grep搜索
- **Shell 执行**: 命令执行、环境变量清理
- **代码执行**: Python 代码在隔离子进程中执行
- **Web 工具**: 网页搜索（DuckDuckGo/Bing）、网页内容获取、SSRF 保护
- **文档工具**: 创建 Markdown、TXT、CSV 文件
- **数学工具**: 基于 AST 的安全数学表达式求值
- **交互式工具**: 用户交互、记忆主题加载
- **监控工具**: 后台进程监控
- **笔记本工具**: Jupyter notebook 单元格编辑
- **任务工具**: 任务 CRUD（创建/获取/列表/更新/删除）
- **计划工具**: 计划模式（只读操作，用户审批后执行）
- **LSP 工具**: 语言服务器协议集成（定义、引用、诊断）
- **调度工具**: 类 cron 的会话范围调度
- **子代理工具**: LLM 驱动的任务委派给子代理

### 2.3 权限管道 (Permission Pipeline)
- **6 种模式**: DEFAULT/PLAN/AUTO/ACCEPT_EDITS/DONT_ASK/BYPASS
- **4 阶段管道**: 权限检查、规则匹配、路径保护、符号链接解析
- **受保护路径**: 系统关键路径保护
- **符号链接解析**: 防止符号链接绕过

### 2.4 安全管道 (Security Pipeline)
- **两层防御**:
  - 第1层：快速正则表达式预过滤
  - 第2层：基于模型的分类器（LLM 评估动作安全性）
- **敏感数据编辑**: API 密钥、令牌、密码等自动编辑
- **提示注入检测**: 识别并阻止提示注入攻击
- **自我审查机制**: 模型自我评估安全性

### 2.5 上下文管理 (Context Management)
- **4 级渐进压缩**:
  1. snip：截断长输出
  2. microcompact：压缩历史消息
  3. LLM 语义压缩
  4. 激进截断
- **200K token 窗口**: 大上下文支持
- **抖动保护**: 防止频繁压缩

### 2.6 记忆系统 (Memory System)
- **4 种类型**: 用户记忆、反馈记忆、项目记忆、参考记忆
- **@import 指令**: 支持记忆文件导入
- **路径范围规则**: 基于路径的记忆规则
- **分层加载**: 按需加载记忆
- **CLAUDE.md 发现**: 自动发现项目配置文件

### 2.7 会话管理 (Session Management)
- **自动保存**: JSONL 格式保存会话
- **会话恢复**: 多种恢复方式（--continue、--resume、--session-id）
- **命名会话**: 支持会话命名
- **会话 ID 验证**: 严格的 ID 格式验证
- **检查点**: 文件检查点、倒带、分叉、自动清理

### 2.8 设置层次结构 (Settings Hierarchy)
- **4 级配置**: 托管 → 用户 → 项目 → 本地
- **配置热重载**: 通过 ConfigWatcher 实现

### 2.9 钩子系统 (Hook System)
- **18 个生命周期事件**: 覆盖代理生命周期的各个阶段
- **钩子类型**: 命令钩子、HTTP 钩子、提示钩子
- **异步执行**: 即发即忘模式
- **SSRF 保护**: HTTP 钩子的安全防护

### 2.10 子代理系统 (SubAgent System)
- **并行执行**: 多个子代理并行运行
- **流水线执行**: 子代理按顺序执行
- **资源限制**: token/时间/数量限制
- **消息通道**: 子代理间通信
- **优先级调度**: 基于优先级的任务调度

### 2.11 Token 计数器 (Token Counter)
- **tiktoken 精确计数**: 使用 OpenAI 的 tiktoken 库
- **启发式回退**: 当 tiktoken 不可用时使用字符估算
- **流式累加器**: 实时统计 token 使用
- **每会话统计**: 跟踪每个会话的 token 使用情况

### 2.12 显示系统 (Display)
- **结构化 CLI**: Claude Code 风格的命令行界面
- **Unicode/ASCII 回退**: 兼容不同终端
- **对话气泡**: 用户和代理消息的可视化区分
- **代码语法高亮**: 代码块的语法高亮显示
- **微调器**: 加载状态指示器
- **状态栏**: 显示 token 使用、会话状态等信息
- **可折叠工具调用**: 长工具调用可折叠显示

### 2.13 CLI 功能
- **交互式 REPL**: 主要交互模式
- **管道输入**: 支持 stdin 管道输入
- **输出格式**: text/json/stream-json
- **流式传输**: 默认开启
- **!command**: 直接执行 shell 命令
- **25+ 斜杠命令**: 丰富的命令集

## 3. 技术栈

### 3.1 核心依赖
- `openai>=1.0.0`: OpenAI API 客户端
- `python-dotenv>=1.0.0`: 环境变量管理
- `requests>=2.28.0`: HTTP 客户端
- `tiktoken>=0.5.0`: Token 计数
- `prompt_toolkit>=3.0.0`: 交互式命令行
- `rich>=13.0.0`: 富文本显示

### 3.2 开发依赖
- `pytest>=7.0.0`: 测试框架
- `pytest-cov>=4.0.0`: 测试覆盖率

## 4. 项目结构

```
mimo-harness/
├── mimo_harness/              # 主代码目录
│   ├── agent.py               # 核心代理循环、DI、电路断路器、token预算、流式传输
│   ├── cli.py                 # REPL、管道输入、输出格式、会话恢复、命令
│   ├── config.py              # 配置管理、API密钥验证
│   ├── context.py             # 4级压缩、会话管理、检查点、记忆加载
│   ├── display.py             # 结构化CLI显示（横幅、微调器、状态栏、语法高亮）
│   ├── hooks.py               # 18个生命周期事件、命令/HTTP/提示钩子
│   ├── input_utils.py         # 输入工具函数
│   ├── logging_utils.py       # 结构化日志（带跟踪ID）
│   ├── memory.py              # 4种记忆类型、分层加载、路径范围规则
│   ├── permissions.py         # 6种模式、4阶段管道、受保护路径、符号链接解析
│   ├── project_scanner.py     # 项目分析、AGENTS.md生成
│   ├── security_pipeline.py   # 两层安全防御（正则+模型）、敏感数据编辑
│   ├── settings.py            # 4级设置层次结构
│   ├── subagent.py            # 子代理生命周期、并行/流水线执行、消息通道
│   ├── token_counter.py       # tiktoken计数、启发式回退、流式累加器
│   └── tools/                 # 14个工具模块 + 注册表
│       ├── code_exec.py       # Python代码在隔离子进程中执行
│       ├── doc_tools.py       # 文档和CSV创建
│       ├── file_ops.py        # 文件读写编辑、会话范围状态
│       ├── interactive.py     # 用户交互、记忆主题加载
│       ├── lsp_tools.py       # LSP集成（定义、引用、诊断）
│       ├── math_tools.py      # 基于AST的安全数学求值器
│       ├── monitor.py         # 后台进程监控
│       ├── notebook_tools.py  # Jupyter notebook单元格编辑
│       ├── plan_tools.py      # 计划模式（只读，用户审批后执行）
│       ├── registry.py        # 工具注册、验证、磁盘溢出
│       ├── scheduler_tools.py # 类cron的会话范围调度
│       ├── shell.py           # Shell执行（只读自动检测、环境变量清理）
│       ├── subagent_tools.py  # LLM驱动的任务委派给子代理
│       ├── task_tools.py      # 任务CRUD（创建/获取/列表/更新/删除）
│       └── web_tools.py       # 网页搜索和获取（SSRF保护）
├── tests/                     # 测试目录
│   ├── conftest.py            # 测试配置
│   ├── e2e_utils.py           # 端到端测试工具
│   ├── test_agent.py          # 代理循环测试
│   ├── test_cli.py            # CLI测试
│   ├── test_config.py         # 配置测试
│   ├── test_context.py        # 上下文管理测试
│   ├── test_display.py        # 显示系统测试
│   ├── test_e2e.py            # 端到端测试
│   ├── test_hooks.py          # 钩子系统测试
│   ├── test_logging.py        # 日志测试
│   ├── test_lsp_tools.py      # LSP工具测试
│   ├── test_memory.py         # 记忆系统测试
│   ├── test_notebook_tools.py # 笔记本工具测试
│   ├── test_permissions.py    # 权限系统测试
│   ├── test_plan_tools.py     # 计划工具测试
│   ├── test_project_scanner.py # 项目扫描器测试
│   ├── test_registry.py       # 工具注册表测试
│   ├── test_scheduler_tools.py # 调度工具测试
│   ├── test_security_pipeline.py # 安全管道测试
│   ├── test_settings.py       # 设置测试
│   ├── test_stress_boundary.py # 压力/边界测试
│   ├── test_subagent.py       # 子代理测试
│   ├── test_subagent_tools.py # 子代理工具测试
│   ├── test_task_tools.py     # 任务工具测试
│   ├── test_token_counter.py  # Token计数器测试
│   └── test_tools.py          # 工具综合测试
├── examples/                  # 示例目录
├── .env.example               # 环境变量示例
├── .gitignore                 # Git忽略文件
├── README.md                  # 项目说明
├── run_tests.py               # 测试运行脚本
└── setup.py                   # 安装配置
```

## 5. 测试状态

- **单元测试**: 760 个
- **端到端测试**: 46 个
- **总测试数**: 806 个测试通过
- **测试文件**: 24 个测试文件

### 测试覆盖范围
- **安全**: 路径遍历、SSRF、Shell注入、大输入、Unicode、敏感数据编辑、提示注入检测
- **权限**: 6种模式、4阶段管道、受保护路径、符号链接解析、规则匹配
- **上下文**: 4级压缩、并行调度、流式传输、抖动保护、孤立过滤
- **工具**: 文件操作、shell、web、文档、数学、笔记本、任务、LSP、计划、调度、代码执行
- **显示**: 横幅、步骤标题、工具调用显示、微调器、状态栏、Unicode回退、对话气泡、代码块、硬换行
- **CLI**: 交互式REPL、管道输入、输出格式、会话管理、参数解析、流式输出
- **钩子**: 18个生命周期事件、命令/HTTP/提示钩子、异步执行
- **设置**: 4级层次结构、配置热重载
- **会话**: ID验证、检查点、分叉、恢复、JSONL持久化
- **子代理**: 生命周期、并行执行、流水线、资源限制、消息通道
- **Token计数器**: tiktoken计数、启发式回退、流式累加器
- **压力/边界**: 极端输入、并发访问、资源限制

## 6. 使用方式

### 6.1 安装
```bash
cd mimo-harness
pip install -e .
cp .env.example .env  # 编辑添加你的API密钥
```

### 6.2 配置环境变量
```bash
# .env 文件配置
MIMO_BASE_URL=https://token-plan-cn.xiaomimimo.com/v1
MIMO_API_KEY=your_api_key_here
MIMO_MODEL=mimo-v2.5-pro
```

### 6.3 基本使用
```bash
# 交互模式（推荐）
mimo-harness

# 单次任务
mimo-harness --task "What is 247 * 893?"

# 管道输入
cat error.log | mimo-harness -p "分析这些错误"

# 恢复会话
mimo-harness --continue
mimo-harness --resume
mimo-harness --session-id my-project
```

### 6.4 主要斜杠命令
- `/help`: 显示帮助信息
- `/tools`: 列出所有可用工具
- `/context`: 查看token明细
- `/compact`: 手动压缩上下文
- `/rewind`: 回退到上一个检查点
- `/fork`: 分叉当前会话
- `/memory`: 列出已存储的记忆
- `/stats`: 显示会话统计

## 7. 架构模式

该项目遵循 Claude Code 的架构模式：

1. **依赖注入 (DI)**: 提高代码可测试性
2. **电路断路器**: 防止级联故障，提高系统稳定性
3. **状态机**: 明确的继续/终止路径
4. **Token 预算跟踪**: 实时监控和警告
5. **系统提示缓存**: 提高效率
6. **两层安全防御**: 快速预过滤 + 深度模型评估
7. **渐进式压缩**: 智能上下文管理
8. **钩子系统**: 可扩展的生命周期管理

## 8. 总结

MiMo Harness 是一个功能丰富、安全可靠的生产级 AI 代理框架。它提供了：

- **完整的工具链**: 14个工具模块覆盖文件操作、代码执行、Web交互、文档处理等
- **强大的安全防护**: 两层防御、敏感数据编辑、提示注入检测
- **灵活的权限系统**: 6种模式、4阶段管道
- **智能的上下文管理**: 4级渐进压缩、200K token窗口
- **完善的会话管理**: 自动保存、多种恢复方式、检查点支持
- **全面的测试覆盖**: 806个测试通过，覆盖各个功能模块

该项目适合需要构建生产级 AI 代理系统的开发者参考和使用。
