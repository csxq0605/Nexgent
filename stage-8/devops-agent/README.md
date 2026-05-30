# DevOps Agent

A production-ready agent for system health checks, log analysis, and deployment management.

## User
DevOps engineers and SREs who need quick system diagnostics and log analysis.

## Task
- Check system health (CPU, memory, processes)
- Analyze log files for errors and patterns
- Manage service deployments with safety guards

## Success Criteria
- [x] Agent responds within 30 seconds for health checks
- [x] Log analysis correctly identifies error patterns
- [x] Deploy operations require human confirmation
- [x] All actions are logged with trace IDs
- [x] Cost limits prevent runaway API usage

## Features

### Observability
- Structured logging with session trace IDs (`TraceLogger` class)
- Every LLM call and tool execution traced with step numbers
- Logs written to `logs/agent.log` (auto-created)
- Both file and console logging handlers

### Safety
- **Permission gates**: READ is auto-approved, WRITE/EXECUTE require confirmation, DELETE is blocked
- **Dry run mode**: `--dry-run` flag skips all write operations
- **Cost limits**: max 30 tool calls, 5 minutes per session

### Reliability
- **Error retry**: exponential backoff on LLM call failures (429, 5xx, network errors)
- **Timeout**: 5-minute session timeout (configurable)
- **Graceful degradation**: tool failures return error JSON, don't crash the agent

### Deployment
```bash
# Install
pip install openai python-dotenv

# 在 .env 中配置 MIMO_BASE_URL, MIMO_API_KEY, MIMO_MODEL

# Run interactively
python src/agent.py

# Run with a specific task
python src/agent.py --task "Check system health"

# Dry run mode (no write operations)
python src/agent.py --dry-run --task "Analyze logs/app.log"
```

## Architecture

```
[CLI Input]
    |
    v
[DevOpsAgent]
    ├── [TraceLogger] ──> logs/agent.log
    ├── [CostTracker] ──> enforce limits (30 tool calls, 5 min)
    ├── [PermissionGate] ──> confirm risky ops (READ auto, DELETE blocked)
    └── [Agent Loop]
         ├── LLM (MiMo) with retry_with_backoff
         └── Tools
              ├── check_system_health (READ)
              ├── read_log_file (READ, last 100 lines)
              ├── list_services (READ, platform-aware)
              └── deploy_service (DEPLOY, requires confirmation)
```

## Configuration

| Env Variable | Default | Description |
|-------------|---------|-------------|
| `MIMO_API_KEY` | (required) | MiMo API key |
| `MIMO_BASE_URL` | https://token-plan-cn.xiaomimimo.com/v1 | API base URL |
| `MIMO_MODEL` | mimo-v2.5-pro | Model to use |
| `AGENT_LOG_FILE` | logs/agent.log | Log file path |

## Tools

| Tool | Permission | Description |
|------|------------|-------------|
| `check_system_health` | READ | Returns hostname, platform, Python version, CPU count, cwd |
| `read_log_file` | READ | Reads last 100 lines of a log file (3000 char limit) |
| `list_services` | READ | Lists running processes (PowerShell on Windows, ps on Unix) |
| `deploy_service` | DEPLOY | Simulates deployment (requires human confirmation) |

## Extending

To add a new tool:

1. Add tool definition in `create_tools()`
2. Add handler function with `params` dict argument
3. Set permission level in the tool definition
4. Update `DevOpsAgent.SYSTEM_PROMPT` to describe when to use it

## Limitations
- Windows-only system commands (PowerShell) for list_services
- No remote server management (local only)
- Simulated deployments (no actual deploy logic)
- No authentication for sensitive operations
- Log file reading limited to last 100 lines
