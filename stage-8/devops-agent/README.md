# DevOps Agent

一个生产就绪的 agent，用于系统健康检查、日志分析和部署管理。

## 目标用户
需要快速系统诊断和日志分析的 DevOps 工程师和 SRE。

## 任务
- 检查系统健康（CPU、内存、进程）
- 分析日志文件中的错误和模式
- 带安全守卫的部署管理

## 成功标准
- [x] 健康检查在 30 秒内响应
- [x] 日志分析正确识别错误模式
- [x] 部署操作需要人工确认
- [x] 所有操作都带 trace ID 记录
- [x] 成本限制防止 API 滥用

## 功能特性

### 可观测性
- 带会话 trace ID 的结构化日志（`TraceLogger` 类）
- 每次 LLM 调用和工具执行都带步骤编号追踪
- 日志写入 `logs/agent.log`（自动创建）
- 文件和控制台双日志处理器

### 安全
- **权限门**：READ 自动批准，WRITE/EXECUTE 需要确认，DELETE 被阻止
- **干运行模式**：`--dry-run` 跳过所有写操作
- **成本限制**：最多 30 次工具调用，每会话 5 分钟

### 可靠性
- **错误重试**：LLM 调用失败时指数退避（429, 5xx, 网络错误）
- **超时**：5 分钟会话超时（可配置）
- **优雅降级**：工具失败返回错误 JSON，不崩溃

## 部署
```bash
# 安装
pip install openai python-dotenv

# 在 .env 中配置 MIMO_BASE_URL, MIMO_API_KEY, MIMO_MODEL

# 交互运行
python src/agent.py

# 指定任务运行
python src/agent.py --task "Check system health"

# 干运行模式（无写操作）
python src/agent.py --dry-run --task "Analyze logs/app.log"
```

## 架构

```
[CLI 输入]
    |
    v
[DevOpsAgent]
    ├── [TraceLogger] ──> logs/agent.log
    ├── [CostTracker] ──> 限制执行（30 次工具调用，5 分钟）
    ├── [PermissionGate] ──> 确认高风险操作（READ 自动，DELETE 阻止）
    └── [Agent Loop]
         ├── LLM (MiMo) + retry_with_backoff
         └── 工具
              ├── check_system_health (READ)
              ├── read_log_file (READ, 最后 100 行)
              ├── list_services (READ, 平台感知)
              └── deploy_service (DEPLOY, 需要确认)
```

## 配置

| 环境变量 | 默认值 | 说明 |
|---------|--------|------|
| `MIMO_API_KEY` | （必需） | MiMo API key |
| `MIMO_BASE_URL` | https://token-plan-cn.xiaomimimo.com/v1 | API 基础 URL |
| `MIMO_MODEL` | mimo-v2.5-pro | 使用的模型 |
| `AGENT_LOG_FILE` | logs/agent.log | 日志文件路径 |

## 工具

| 工具 | 权限 | 说明 |
|------|------|------|
| `check_system_health` | READ | 返回主机名、平台、Python 版本、CPU 数、cwd |
| `read_log_file` | READ | 读取日志文件最后 100 行（3000 字符限制） |
| `list_services` | READ | 列出运行中的进程（Windows 用 PowerShell，Unix 用 ps） |
| `deploy_service` | DEPLOY | 模拟部署（需要人工确认） |

## 扩展

添加新工具：
1. 在 `create_tools()` 中添加工具定义
2. 添加带 `params` dict 参数的处理函数
3. 在工具定义中设置权限级别
4. 更新 `DevOpsAgent.SYSTEM_PROMPT` 描述使用时机

## 限制
- `list_services` 仅支持 Windows 系统命令（PowerShell）
- 不支持远程服务器管理（仅本地）
- 模拟部署（无实际部署逻辑）
- 敏感操作无认证
- 日志文件读取限制为最后 100 行
