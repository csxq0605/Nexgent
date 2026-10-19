# Nexgent Desktop GUI

`nexgent` 在交互式终端中默认启动 PyQt6 桌面应用；`nexgent --tui` 保留 Textual 界面；`--task`、管道输入、`json` 和 `stream-json` 始终保持无 Qt 的 CLI 路径。

## 功能映射

| GUI 区域 | 使用的 Nexgent 能力 |
| --- | --- |
| Files | 项目文件浏览、`@file` 候选来源、文本/代码/Markdown/图片预览 |
| Sessions | JSONL 自动保存、恢复、分叉、保存与加载 |
| Runs | GUI 表单创建 verified Run、查看证据、继续暂停任务、导出 JSONL |
| Agents | 主 Agent 与每个 SubAgent 的生命周期、任务和独立对话结果 |
| Conversation | 主 Agent 运行、模型/权限切换、工具活动、停止、写入确认 |
| Composer | `/` 命令与 `@` 文件动态候选、Tab 补全、项目级输入历史、运行中指导与排队 |

Runs 为 Coding Harness 的核心生命周期提供原生按钮和表单；其他高级命令不维护重复按钮
矩阵。`nexgent.commands.SLASH_COMMANDS` 仍是 Composer 中 `/` 候选的唯一来源，
`scan_completions()` 同时服务 GUI 与终端的 `@` 文件候选。GUI 表单在内部通过同一个
`CommandService` 和 `NexgentRuntime` 调用正式 Harness，不存在第二套简化运行时。

## GUI 运行 Harness

1. 打开 Runs，点击 New Run；
2. 填写任务与独立验收命令，设置 attempt 和 timeout；
3. 点击 Start Run，在 Conversation 中查看实时阶段和权限请求；
4. 选中 Run，点击 Details 查看证据摘要；
5. PAUSED Run 可点击 Resume；任意 Run 可通过 Export 选择 JSONL 保存位置。

运行期间 Composer 保持可输入。`/btw` 通过线程安全 Session 注入当前上下文，普通输入进入有界 FIFO 队列；Stop 会清除尚未执行的队列项，并在对话中明确显示清除数量。SubAgent 创建、运行、完成、失败和取消都会发出 `SUBAGENT_CHANGED`，GUI据此创建可切换的 Agent 记录；隔离子会话保存在 `.nexgent/sessions/agents/`。子 Agent 与 Workflow Agent 继承父运行时的 `InteractionBroker` 和事件回调，所以写入确认、工具活动、状态与结果都回到同一个 GUI，而不是落回终端或静默执行。

`/clear` 会同时清除 Session 与当前可见主对话；`/load`、`/fork`、`/model` 完成后同步窗口状态。项目配置保存后会立即重载 `ModelRegistry`、更新运行时模型和模型下拉框，不要求重启进程。`/quit` 通过运行时 action 请求窗口正常关闭。

## 安全与线程

耗时运行发生在 Qt 主线程之外。`RuntimeBridge` 只通过 Qt signal 把事件送回窗口。写入和执行确认通过 `InteractionBroker` 传给主线程的模态确认框；没有 handler、超时、窗口关闭或 handler 异常都返回拒绝。Stop 会同时请求主 Harness 中止并调用 `SubAgentManager.cancel_all()`；活动子 Harness 会收到自己的 graceful-abort 请求。

关闭窗口采用显式关闭协议：拒绝新输入、清空队列、断开 Runtime event sink 与 interaction handler、请求主/子 Agent 停止、等待活动 Worker（有界超时），最后关闭运行时。所有 Worker signal 都经过关闭状态检查；即使 Provider 在窗口销毁后才返回，也不会向已删除的 `RuntimeBridge` 发射信号。

## 开发与验证

```bash
python3 -m venv .venv
.venv/bin/pip install -e '.[dev]'
QT_QPA_PLATFORM=offscreen .venv/bin/pytest -q tests/gui
QT_QPA_PLATFORM=offscreen .venv/bin/python scripts/capture_gui_screenshots.py
```

Offscreen 测试只用于快速回归，不构成桌面交付验收。发布前还必须在未设置 `QT_QPA_PLATFORM=offscreen` 的真实窗口中用键盘和鼠标完成：文件预览、补全与历史、全部斜杠命令、权限模式与模态审批、配置即时生效、Session 恢复、真实工具调用、主/子 Agent、Workflow、运行中 `/btw`、队列与 Stop、`/clear`、`/quit`，以及 Provider 阻塞时关闭窗口。真实 Provider 验收还需确认 `SUBAGENT_CHANGED(created → running → completed)`、子会话工具事件和主 Agent 最终回复属于同一次运行。

品牌位图使用 `scripts/build_brand_assets.py` 从 `assets/brand/*.svg` 生成。发布前应再次运行构建脚本并确认生成哈希没有变化。
