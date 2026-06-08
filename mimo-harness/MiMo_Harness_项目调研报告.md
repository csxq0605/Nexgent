# MiMo Harness 项目调研报告

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
├── agent.py              # 核心循环、依赖注入、断路器、token预算、流式处理
├── cli.py                # REPL、管道输入、输出格式、会话恢复、命令处理
├── config.py             # 配置管理、API密钥验证
├── context.py            # 4级压缩、会话管理、检查点、记忆加载
├── hooks.py              # 18个生命周期事件、命令/HTTP/提示钩子
├── logging_utils.py      # 结构化日志、跟踪ID
├── memory.py             # 4种类型记忆、分层加载、路径范围规则
├── permissions.py        # 6种模式、4阶段管道、受保护路径、符号链接解析
├── project_scanner.py    # 项目分析、AGENTS.md生成
├── security_pipeline.py  # 2层安全（正则+模型）、敏感数据编辑
├── settings.py           # 4级设置层次
├── display.py            # 结构化CLI显示（横幅、旋转器、状态栏、语法高亮）
├── input_utils.py        # 共享提示工具包输入、自动完成和历史
├── tui.py                # 全屏Textual TUI（固定底部输入、滚动输出）
├── subagent.py           # 子代理生命周期、并行/管道执行、消息通道
├── token_counter.py      # tiktoken计数、启发式回退、流式累加器
└── tools/                # 14个工具模块 + 注册表
    ├── code_exec.py      # 隔离子进程中的Python代码执行
    ├── doc_tools.py      # 文档和CSV创建
    ├── file_ops.py       # 文件读/写/编辑、会话范围状态
    ├── interactive.py    # 用户交互、记忆主题加载
    ├── lsp_tools.py      # LSP集成（定义、引用、诊断）
    ├── math_tools.py     # 基于AST的安全数学求值器
    ├── monitor.py        # 后台进程监控
    ├── notebook_tools.py # Jupyter笔记本单元格编辑
    ├── plan_tools.py     # 计划模式（进入/退出、用户批准）
    ├── registry.py       # 工具注册、验证、磁盘溢出
    ├── scheduler_tools.py # 类似cron的会话范围调度
    ├── shell.py          # Shell执行、只读自动检测、环境擦除
    ├── subagent_tools.py # LLM驱动的任务委派给子代理
    ├── task_tools.py     # 任务CRUD（创建/获取/列表/更新/删除）
    └── web_tools.py      # Web搜索和抓取、SSRF保护
```

### 2.2 核心设计模式

#### 2.2.1 Agent循环模式
- **依赖注入**: AgentDeps类提供可测试性和环境抽象
- **断路器**: CircuitBreaker防止级联失败
- **状态机**: 继续/终止路径的有限状态机
- **Token预算**: TokenBudget跟踪上下文窗口使用情况
- **系统提示缓存**: 稳定的系统提示前缀提高缓存命中率

#### 2.2.2 权限管道（4阶段）
1. **验证**: 检查工具和参数有效性
2. **规则匹配**: 应用权限规则（deny > ask > allow优先级）
3. **上下文评估**: 考虑当前状态和模式
4. **用户提示**: 必要时请求用户批准

#### 2.2.3 安全管道（2层防御）
- **第1层**: 快速正则表达式预过滤器，捕获明显违规
- **第2层**: 基于模型的分类器，LLM评估上下文中的操作安全性

## 3. 功能特性

### 3.1 代理循环
- 依赖注入可测试性
- 断路器防止级联失败
- Token预算跟踪和警告
- 并行工具调度
- 流式处理
- 努力级别（low/medium/high）
- 回退模型支持
- 优雅中止

### 3.2 工具模块（14个）
1. **文件操作**: 读取、写入、编辑文件
2. **Shell执行**: 命令执行，只读自动检测
3. **代码执行**: Python代码在隔离子进程中运行
4. **Web工具**: 搜索和网页抓取，SSRF保护
5. **文档工具**: 文档和CSV创建
6. **数学工具**: 基于AST的安全数学求值器
7. **交互工具**: 用户交互，记忆主题加载
8. **监控工具**: 后台进程监控
9. **笔记本工具**: Jupyter笔记本单元格编辑
10. **任务工具**: 任务CRUD操作
11. **计划工具**: 计划模式，用户批准工作流
12. **LSP工具**: 语言服务器协议集成
13. **调度器工具**: 类似cron的会话范围调度
14. **子代理工具**: LLM驱动的任务委派

### 3.3 权限系统
- **6种权限模式**:
  1. DEFAULT: 每个写操作需要确认
  2. PLAN: 只读操作，不允许写入
  3. AUTO: 自动批准安全操作
  4. ACCEPT_EDITS: 读取+文件编辑自动批准，shell仍询问
  5. DONT_ASK: 仅预批准工具，其余自动拒绝
  6. BYPASS: 所有操作允许（仅断路器用于rm -rf /）

### 3.4 上下文管理
- **4级渐进压缩**:
  1. snip: 移除旧工具结果
  2. microcompact: 保留最近N个工具结果
  3. LLM语义压缩: 使用LLM总结对话
  4. 激进截断: 紧急情况下的最后手段
- **Thrashing保护**: 检测和防止压缩循环

### 3.5 记忆系统
- **4种记忆类型**:
  1. user: 用户是谁？角色、偏好、知识
  2. feedback: 什么实践已验证？更正+确认
  3. project: 为什么这样做？决策、截止日期
  4. reference: 在哪里找到外部信息？链接、仪表板
- **MEMORY.md索引**: 200行/25KB限制
- **路径安全验证**: 防止目录遍历攻击

### 3.6 会话管理
- **自动保存**: JSONL格式
- **会话恢复**: 多种恢复方式（按ID、最近、交互选择）
- **命名会话**: 便于识别和管理
- **会话ID验证**: 仅允许字母、数字、连字符、下划线，最长64字符
- **检查点**: 文件编辑前自动创建快照
- **Fork**: 从当前会话创建新会话

### 3.7 设置层次（4级）
1. 托管设置（最高优先级）
2. 用户设置
3. 项目设置
4. 本地设置（最低优先级）

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

### 3.10 显示系统
- **结构化CLI**: 类似Claude Code的丰富输出
- **对话气泡**: 用户与模型视觉区分
- **工具调用可视化**: 结构化、可折叠
- **代码语法高亮**: 使用pygments
- **状态栏**: 显示当前状态
- **流式输出格式化**: 实时显示生成内容
- **Unicode/ASCII回退**: 跨平台兼容性

### 3.11 TUI（文本用户界面）
- **全屏Textual界面**: 专业终端UI
- **固定底部输入**: 类似聊天界面
- **滚动输出**: 查看历史对话
- **命令自动完成**: 提高输入效率
- **输入历史**: 上下箭头浏览历史

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
1. **Token计数**: 使用tiktoken精确计数，启发式回退
2. **流式处理**: 实时输出生成内容
3. **并行执行**: 工具并行调度提高效率
4. **磁盘溢出**: 大输出自动溢出到磁盘
5. **SSRF保护**: Web工具防止服务器端请求伪造
6. **敏感数据编辑**: 自动编辑API密钥、密码等敏感信息
7. **提示注入检测**: 检测并阻止提示注入攻击

## 5. 测试情况

### 5.1 测试规模
- **总测试数**: 806个测试通过
  - 760个单元测试
  - 46个端到端测试
- **测试文件**: 24个测试文件

### 5.2 测试覆盖范围
1. **安全性**: 路径遍历、SSRF、Shell注入、大输入、Unicode、敏感数据编辑、提示注入检测
2. **权限**: 6种模式、4阶段管道、受保护路径、符号链接解析、规则匹配
3. **上下文**: 4级压缩、并行调度、流式处理、Thrashing保护、孤立过滤
4. **工具**: 文件操作、Shell、Web、文档、数学、笔记本、任务、LSP、计划、调度器、代码执行
5. **显示**: 横幅、步骤标题、工具调用显示、旋转器、状态栏、Unicode回退、对话气泡、代码块、硬换行
6. **CLI**: 交互式REPL、管道输入、输出格式、会话管理、参数解析、流式输出
7. **钩子**: 18个生命周期事件、命令/HTTP/提示钩子、异步执行
8. **设置**: 4级层次、配置热重载
9. **会话**: ID验证、检查点、Fork、恢复、JSONL持久化
10. **子代理**: 生命周期、并行执行、管道、资源限制、消息通道
11. **Token计数器**: tiktoken计数、启发式回退、流式累加器
12. **压力/边界**: 极端输入、并发访问、资源限制

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
MIMO_API_KEY=[REDACTED]
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

### 6.4 主要命令
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
7. **全面测试**: 800+测试用例，覆盖各个功能模块

该项目展示了如何构建一个生产就绪的AI代理系统，遵循了Claude Code的架构模式，并在此基础上进行了创新和改进。
