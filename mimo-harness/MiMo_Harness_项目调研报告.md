# MiMo Harness 项目调研报告

## 1. 项目概述

**项目名称**: MiMo Harness
**版本**: 0.3.0
**描述**: 一个生产级的AI代理工具，由小米MiMo模型驱动，遵循Claude Code架构模式
**所属项目**: Agent Learning Hub
**许可证**: MIT License
**Python版本要求**: >=3.10

## 2. 核心架构

### 2.1 目录结构
```
mimo_harness/
├── agent.py              # 核心循环、依赖注入、断路器、token预算、流式处理、_StreamReader
├── cli.py                # REPL、管道输入、输出格式、会话恢复、28个命令
├── config.py             # 配置管理、API密钥验证
├── context.py            # 4级压缩、会话管理、检查点、记忆加载
├── hooks.py              # 18个生命周期事件、命令/HTTP/提示钩子
├── logging_utils.py      # 结构化日志、跟踪ID
├── memory.py             # 4种类型记忆、分层加载、路径范围规则
├── permissions.py        # 6种模式、4阶段管道、受保护路径、TUI回调
├── project_scanner.py    # 项目分析、AGENTS.md生成
├── security_pipeline.py  # 2层安全（正则+模型）、敏感数据编辑
├── settings.py           # 4级设置层次
├── display.py            # 结构化CLI显示、TUI override回调（8个）
├── input_utils.py        # 共享提示工具包输入、自动完成和历史
├── tui.py                # 全屏Textual TUI（队列输出、override回调、builtins.print拦截）
├── subagent.py           # 子代理生命周期、并行/管道执行、消息通道
├── token_counter.py      # tiktoken计数、启发式回退、流式累加器
└── tools/                # 14个工具模块，30个注册工具
    ├── code_exec.py      # execute_python — 隔离子进程中的Python代码执行
    ├── doc_tools.py      # create_doc, create_spreadsheet — 文档和CSV创建
    ├── file_ops.py       # read_file, read_files, write_file, edit_file, glob_files, grep_files
    ├── interactive.py    # ask_user_question, read_memory_topic
    ├── lsp_tools.py      # lsp_definition, lsp_references, lsp_diagnostics
    ├── math_tools.py     # calculator — 基于AST的安全数学求值器
    ├── monitor.py        # monitor_start, monitor_stop, monitor_list
    ├── notebook_tools.py # notebook_edit — Jupyter笔记本单元格编辑
    ├── plan_tools.py     # enter_plan_mode, exit_plan_mode
    ├── registry.py       # 工具注册、验证、4阶段执行、磁盘溢出
    ├── scheduler_tools.py # cron_create, cron_delete, cron_list
    ├── shell.py          # run_command — Shell执行、只读自动检测、环境擦除
    ├── subagent_tools.py # subagent_run — LLM驱动的任务委派给子代理
    ├── task_tools.py     # task_create, task_get, task_list, task_update, task_delete
    └── web_tools.py      # web_search, web_fetch — SSRF保护、响应缓存
```

### 2.2 核心设计模式

#### 2.2.1 Agent循环模式
- **依赖注入**: AgentDeps类提供可测试性和环境抽象
- **断路器**: CircuitBreaker防止级联失败（3次连续失败后熔断）
- **状态机**: while True 循环 + 7种终止原因
- **Token预算**: TokenBudget跟踪上下文窗口使用情况（1M窗口，4096保留输出）
- **系统提示缓存**: 稳定的系统提示前缀提高缓存命中率
- **_StreamReader**: 流式API调用使用后台线程+队列，每块120s超时
- **重试退避**: retry_with_backoff 对 429/500/502/503/504 和网络错误指数退避重试

#### 2.2.2 权限管道（4阶段）
1. **验证**: Plan模式阻止写入，受保护路径检查（.git, .env等）
2. **安全分类**: 模型驱动的 classify_action 评估操作风险
3. **规则匹配**: deny > ask > allow 优先级的规则匹配
4. **用户确认**: Y/n 提示（TUI回调支持）

#### 2.2.3 安全管道（2层防御）
- **第1层**: 快速正则表达式预过滤器，捕获明显违规（rm -rf /、凭据访问等）
- **第2层**: 基于模型的分类器，LLM评估上下文中的操作安全性
- **输出过滤**: sanitize_output() + detect_prompt_injection() 防止输入探测攻击

## 3. 功能特性

### 3.1 代理循环
- 依赖注入可测试性（AgentDeps）
- 断路器防止级联失败（CircuitBreaker，阈值3）
- Token预算跟踪和警告（85%阈值）
- 并行工具调度（ThreadPoolExecutor，max_workers=8）
- 流式处理（_StreamReader + StreamingTokenCounter）
- 努力级别（low/medium/high → temperature 0.3/0.7/0.9）
- 回退模型支持（429/503时切换）
- 优雅中止（GracefulAbort，threading.Event）
- 7种终止原因：COMPLETED, MAX_STEPS, MAX_DURATION, MODEL_ERROR, CIRCUIT_BREAKER, TOKEN_LIMIT, USER_ABORT

### 3.2 工具模块（14个，30个工具）

| 模块 | 工具 | 权限 | 并发安全 |
|------|------|------|----------|
| file_ops | read_file, read_files, write_file, edit_file, glob_files, grep_files | READ/WRITE | 读安全，写不安全 |
| shell | run_command | 动态（只读检测） | 不安全 |
| code_exec | execute_python | WRITE | 不安全 |
| web_tools | web_search, web_fetch | READ | 安全 |
| doc_tools | create_doc, create_spreadsheet | WRITE | 不安全 |
| math_tools | calculator | READ | 安全 |
| interactive | ask_user_question, read_memory_topic | READ | ask不安全，read安全 |
| monitor | monitor_start, monitor_stop, monitor_list | READ/WRITE | list安全 |
| notebook_tools | notebook_edit | WRITE | 不安全 |
| task_tools | task_create, task_get, task_list, task_update, task_delete | READ/WRITE | get/list安全 |
| plan_tools | enter_plan_mode, exit_plan_mode | READ | 不安全 |
| lsp_tools | lsp_definition, lsp_references, lsp_diagnostics | READ | 安全 |
| scheduler_tools | cron_create, cron_delete, cron_list | READ | list安全 |
| subagent_tools | subagent_run | WRITE | 不安全 |

### 3.3 权限系统
- **6种权限模式**:
  1. DEFAULT: 每个写操作需要确认
  2. PLAN: 只读操作，不允许写入
  3. AUTO: 自动批准安全操作
  4. ACCEPT_EDITS: 读取+文件编辑自动批准，shell仍询问
  5. DONT_ASK: 仅预批准工具，其余自动拒绝
  6. BYPASS: 所有操作允许（仅断路器用于rm -rf /）

- **TUI集成**: `_tui_permission_request` 回调，内联Y/n提示（不使用输入框）

### 3.4 上下文管理
- **上下文窗口**: 1,000,000 tokens (1M)
- **警告阈值**: 85% (850K tokens) — 打印警告，用户决定是否 `/compact`
- **不阻塞**: agent 永远不会拒绝运行，只警告

- **4级渐进压缩**:
  1. Snip: 替换旧工具结果（>20条消息前）为 `[Old tool result content cleared]`
  2. Microcompact: 仅保留最近5个工具结果
  3. LLM语义压缩: 完整对话摘要（~500词，上限15K tokens）
  4. 截断回退: 仅保留最后15条消息，内容截断到4000字符

- **Thrashing保护**: 检测和防止压缩循环（_compaction_attempts, _compaction_failures计数器）

### 3.5 记忆系统
- **4种记忆类型**:
  1. user: 用户是谁？角色、偏好、知识
  2. feedback: 什么实践已验证？更正+确认
  3. project: 为什么这样做？决策、截止日期
  4. reference: 在哪里找到外部信息？链接、仪表板
- **MEMORY.md索引**: 200行/25KB限制
- **路径安全验证**: 防止目录遍历攻击
- **分层加载**: MEMORY.md索引 → AGENTS.md → CLAUDE.md（向上遍历目录树）→ 全局规则
- **@import指令**: 最多5层嵌套导入

### 3.6 会话管理
- **自动保存**: JSONL格式（每条消息一行）
- **会话恢复**: 多种恢复方式（按ID、最近、交互选择）
- **命名会话**: 便于识别和管理
- **会话ID验证**: 仅允许字母、数字、连字符、下划线，最长64字符
- **检查点**: 文件编辑前自动创建快照，支持批量操作
- **Fork**: 从当前会话创建新会话
- **自动清理**: 删除N天前的旧会话（默认30天）
- **损坏处理**: 自动重命名为 `.jsonl.corrupt`，30%损坏阈值

### 3.7 设置层次（4级）
1. 托管设置 `.mimo/managed.json`（企业级，不可覆盖）
2. 用户设置 `~/.mimo/settings.json`
3. 项目设置 `.mimo/settings.json`（可提交）
4. 本地设置 `.mimo/settings.local.json`（gitignore）
- deny规则跨级别累积，不可覆盖

### 3.8 钩子系统
- **18个生命周期事件**:
  - PreToolUse, PostToolUse, PostToolUseFailure
  - Stop, SessionStart, SessionEnd
  - UserPromptSubmit, PreCompact, PostCompact
  - TaskCreated, TaskCompleted
  - SubagentStart, SubagentStop
  - PermissionRequest, PermissionDenied
  - ConfigChange, CwdChanged, FileChanged
- **3种钩子类型**: 命令、HTTP、提示

### 3.9 子代理系统
- **并行/管道执行**: 使用ThreadPoolExecutor
- **资源限制**: token、时间、数量限制
- **消息通道**: 父子代理间通信
- **优先级调度**: LOW, NORMAL, HIGH, CRITICAL
- **可配置工具子集**: 每个SubAgent可限制允许的工具

### 3.10 显示系统
- **结构化CLI**: 类似Claude Code的丰富输出
- **对话气泡**: 用户与模型视觉区分
- **工具调用可视化**: 结构化、可折叠、并行索引 [1/N]、错误详情
- **代码语法高亮**: 使用pygments
- **状态栏**: 实时显示session/tokens/messages
- **流式输出格式化**: 实时显示生成内容
- **Unicode/ASCII回退**: 跨平台兼容性

### 3.11 TUI（文本用户界面）
- **全屏Textual界面**: 专业终端UI（RichLog + Static + Input）
- **队列输出架构**: 50ms定时器轮询queue.Queue，消除call_from_thread死锁
- **8个override回调**: _tui_write, _tui_stream_token, _tui_stream_end, _tui_print, _tui_model_output_start/end, _tui_tool_call_collapsible, _tui_tool_call_result
- **builtins.print拦截**: 替换builtins.print捕获所有print()调用
- **_console.file抑制**: 设置为io.StringIO()防止直接_console.print输出
- **_StdoutProxy**: 安全网，捕获剩余sys.stdout.write()调用
- **固定底部输入**: 类似聊天界面
- **滚动输出**: RichLog自动滚动
- **命令自动完成**: 28个斜杠命令
- **输入历史**: 上下箭头浏览
- **内联权限提示**: Y/n 按键，不使用输入框
- **Ctrl+K强制终止**: PyThreadState_SetAsyncExc + 清理孤立tool_calls
- **实时状态栏**: 每50ms更新tokens/messages

## 4. 技术实现

### 4.1 依赖库
- **openai>=1.0.0**: OpenAI API客户端
- **python-dotenv>=1.0.0**: 环境变量管理
- **requests>=2.28.0**: HTTP请求
- **tiktoken>=0.5.0**: Token计数
- **prompt_toolkit>=3.0.0**: 交互式输入
- **rich>=13.0.0**: 丰富的终端输出
- **textual>=0.40.0**: TUI框架

### 4.2 开发依赖
- **pytest>=7.0.0**: 测试框架
- **pytest-cov>=4.0.0**: 测试覆盖率

### 4.3 关键技术特性
1. **Token计数**: 使用tiktoken精确计数，启发式回退，StreamingTokenCounter
2. **流式处理**: _StreamReader后台线程+队列，每块120s超时
3. **并行执行**: 并发安全工具并行调度，编辑/写入工具批量执行
4. **磁盘溢出**: 大输出自动溢出到磁盘
5. **SSRF保护**: Web工具防止服务器端请求伪造
6. **DNS重绑定防护**: web_fetch 验证解析后的IP地址
7. **敏感数据编辑**: 自动编辑API密钥、密码等敏感信息
8. **提示注入检测**: 检测并阻止提示注入攻击
9. **MiMo API兼容**: reasoning_content在tool_calls请求中回传

## 5. 测试情况

### 5.1 测试规模
- **总测试数**: 884个测试通过
- **测试文件**: 25个测试文件

### 5.2 测试覆盖范围
1. **安全性**: 路径遍历、SSRF、Shell注入、大输入、Unicode、敏感数据编辑、提示注入检测
2. **权限**: 6种模式、4阶段管道、受保护路径、符号链接解析、规则匹配
3. **上下文**: 4级压缩、并行调度、流式处理、Thrashing保护、孤立过滤
4. **工具**: 文件操作、Shell、Web、文档、数学、笔记本、任务、LSP、计划、调度器、代码执行
5. **显示**: 横幅、步骤标题、工具调用显示、旋转器、状态栏、Unicode回退、对话气泡、代码块、硬换行
6. **CLI**: 交互式REPL、管道输入、输出格式、会话管理、参数解析、流式输出
7. **TUI**: 队列输出、命令建议器、流缓冲区、类属性、内联权限、override回调
8. **钩子**: 18个生命周期事件、命令/HTTP/提示钩子、异步执行
9. **设置**: 4级层次、配置热重载
10. **会话**: ID验证、检查点、Fork、恢复、JSONL持久化
11. **子代理**: 生命周期、并行执行、管道、资源限制、消息通道
12. **Token计数器**: tiktoken计数、启发式回退、流式累加器
13. **压力/边界**: 极端输入、并发访问、资源限制

### 5.3 测试文件分布

| 测试文件 | 测试数 |
|---------|--------|
| test_display.py | 99 |
| test_tools.py | 98 |
| test_context.py | 97 |
| test_security_pipeline.py | 89 |
| test_e2e.py | 46 |
| test_subagent.py | 42 |
| test_stress_boundary.py | 36 |
| test_token_counter.py | 35 |
| test_cli.py | 32 |
| test_permissions.py | 32 |
| test_scheduler_tools.py | 31 |
| test_agent.py | 24 |
| test_hooks.py | 22 |
| test_task_tools.py | 22 |
| test_settings.py | 20 |
| test_memory.py | 20 |
| test_project_scanner.py | 20 |
| test_tui.py | 19 |
| test_plan_tools.py | 19 |
| test_notebook_tools.py | 18 |
| test_lsp_tools.py | 16 |
| test_registry.py | 15 |
| test_subagent_tools.py | 14 |
| test_logging.py | 11 |
| test_config.py | 7 |

## 6. 配置和使用

### 6.1 安装
```bash
cd mimo-harness
pip install -e .
cp .env.example .env  # 编辑API密钥
```

### 6.2 环境变量配置
```env
MIMO_BASE_URL=https://token-plan-cn.xiaomimimo.com/v1
MIMO_API_KEY=your-api-key-here
MIMO_MODEL=mimo-v2.5-pro
```

### 6.3 使用方式

#### 交互模式（推荐）
```bash
mimo-harness
```

#### 单次任务
```bash
mimo-harness --task "What is 247 * 893?"
```

#### 管道输入
```bash
cat error.log | mimo-harness -p "分析这些错误"
```

#### 会话恢复
```bash
mimo-harness --continue                    # 恢复最近会话
mimo-harness --resume                      # 从列表中选择会话
mimo-harness --session-id my-project       # 按指定ID恢复
```

### 6.4 主要命令（28个）
- `/help`: 显示帮助信息
- `/quit`, `/exit`, `/q`: 退出
- `/clear`: 清空当前会话
- `/tools`: 列出所有可用工具
- `/save <path>`: 保存会话到文件
- `/load <path>`: 从文件加载会话
- `/dry-run`: 切换干跑模式
- `/auto`: 切换自动审批模式
- `/plan`: 切换计划模式
- `/abort`: 请求中止当前任务
- `/memory`: 列出已存储的记忆
- `/remember`: 将当前上下文保存为记忆
- `/hooks`: 列出已注册的钩子
- `/stats`: 显示会话统计
- `/tokens`: 显示token使用进度条
- `/compact`: 手动压缩上下文
- `/context`: 按消息显示token明细
- `/init`: 扫描项目并生成AGENTS.md
- `/rewind`: 回退到上一个文件检查点
- `/fork`: 分叉当前会话
- `/subagents`: 列出活跃的子代理
- `/subagent <task>`: 运行单个子代理任务
- `/parallel <t1> | <t2>`: 并行运行多个任务
- `/pipeline <t1> | <t2>`: 管道模式运行多个任务
- `/effort [low|medium|high]`: 查看或切换推理强度
- `/mode [default|plan]`: 查看或切换权限模式
- `/save`, `/load`: 会话保存/加载
- `!<cmd>`: 直接执行shell命令

## 7. 示例用例

### 7.1 编程助手
- 生成和测试代码
- 调试代码
- 重构代码
- 添加测试
- 代码审查
- 编辑Jupyter笔记本

### 7.2 办公工作
- 文档处理
- 数据分析
- 报告生成

### 7.3 研究工作
- 信息搜索
- 内容总结
- 知识整理

## 8. 总结

MiMo Harness是一个功能丰富、架构清晰的AI代理工具，具有以下特点：

1. **生产级质量**: 完整的错误处理、安全机制、权限控制
2. **模块化设计**: 清晰的组件分离，便于维护和扩展
3. **安全优先**: 多层安全防护，敏感数据保护
4. **用户友好**: 丰富的交互方式，直观的命令系统
5. **可扩展性**: 钩子系统、子代理系统支持复杂工作流
6. **跨平台**: Windows/Unix兼容，Unicode/ASCII回退
7. **全面测试**: 884个测试用例，25个测试文件，覆盖各个功能模块

该项目展示了如何构建一个生产就绪的AI代理系统，遵循了Claude Code的架构模式，并在此基础上进行了创新和改进。
