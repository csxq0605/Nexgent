# Stage A 内核小样结果

日期：2026-09-23。固定任务与出口见[共同合同](CONTRACT.md)。小样脚本是诊断代码，不进入 Nexgent 产品执行路径。

## Python 路径：第一次实跑

命令（仓库根目录，使用本地 Python 3.12 环境）：

```powershell
$env:PYTHONPATH=(Resolve-Path 'src').Path
..\NExgent\.venv\Scripts\python.exe experiments\kernel_spike\python_route.py
```

脚本在独立临时项目中建立真实 `TaskService`／`EpisodeStore`，用固定模型接口响应完成 `ask → tool → publish`。人工编写的 `spike.multiply` 预先注册和授权后，交付 `{"answer":42}`；模型调用收据 1、工具调用收据 1，工具事件记录参数和结果。未授权的另一 Episode 调用同名工具被拒绝。全局移除处理器后，对原 Episode 的调用也被拒绝。

**共同合同尚未通过。** 空工具作用域的 Episode 创建后，试图增补能力得到 `PermissionError: Immutable Episode identity field: capabilities`。`ToolRegistry` 只有注册，没有公开卸载；诊断脚本使用私有字典模拟全局移除，不能证明任务作用域的插件生命周期。试验工具在宿主进程中执行，模型是固定响应替身。真实模型、暂停恢复、独立 evaluator 投影、重启后处理器恢复均未测。

首次脚本还观察到 Windows 临时目录清理遇到 `research.sqlite3` 文件占用；修订脚本忽略临时清理错误以保留主要诊断结果。阶段 A3 的 Windows／恢复评估需核查数据库连接生命周期，不能把这次退出码 0 当成文件句柄问题已解决。

这条路线如果进入生产，需要显式的任务内能力租约和原子装入／卸载 API，在不改写 Episode 原始任务合同的情况下记录新增准入、实际 handler 摘要和回放行为。不能简单修改 `TaskService._change` 或全局 `ToolRegistry._tools` 来掩盖基线阻断。

## DeepSeek Harness 路径

固定 `dsh-v0.1.7-rc.1` / `46a7f68b0922371ce7144b668b90e377d8e799f4` 已在独立目录检出，`git rev-parse HEAD` 与目标 SHA 一致。使用本机 Node `24.15.0`，把 Corepack 缓存放在试验工作区以取得仓库指定 pnpm `11.7.0`。`corepack pnpm install --frozen-lockfile --ignore-scripts` 通过；完整 `corepack pnpm run build` 在宿主环境退出码 0，`corepack pnpm dsh --version` 返回 `0.1.7-rc.1`。

首次受限构建遇到 Node `os.userInfo()` 的 `uv_os_get_passwd returned ENOMEM`；单独执行同一调用在受限环境失败、宿主环境成功。重跑构建成功，故这次不是上游 TypeScript 编译错误。依赖安装采用 `--ignore-scripts`，暂未验证依赖构建脚本的所有功能。

定向上游检查：

| 运行项 | 实际结果 | 证据边界 |
| --- | --- | --- |
| `corepack pnpm exec vitest run packages/core/tools/tests/scoped.spec.ts --reporter=dot` | 27 passed | 证明固定源码中 scope-aware ToolRuntime 对显式注册的可见性、调用、释放合同；不是 Nexgent 任务或模型开发插件 |
| `corepack pnpm exec vitest run --config vitest.e2e.config.ts apps/cli/tests/profiles/headless/tests/source-tool.built.e2e.ts --reporter=dot` | 1 passed | 官方命名 headless profile 经固定模型接口到宿主工具及持久 `tool/call`／`tool/result`；这是上游自带 shell smoke，不是本合同的 `multiply` 工具或 Episode 桥接 |

第一次运行 headless 测试没有传其 `vitest.e2e.config.ts`，默认配置只收 `*.spec.ts`，因此报 `No test files found`；使用专用配置后通过。两项定向测试与完整源码构建都只在固定上游检出中运行，不能算 Nexgent 实现通过。

### 同题 headless 运行（固定模型接口）

新增 [`dsh_driver.ts`](dsh_driver.ts)、[`dsh_headless.patch.yml`](dsh_headless.patch.yml) 和 [`dsh_spike_plugin.mjs`](dsh_spike_plugin.mjs)，只在固定上游 `46a7f68b0922371ce7144b668b90e377d8e799f4` 的官方 `headless` profile 上叠加诊断插件。复现命令（在 Nexgent 根目录）：

```powershell
node experiments/kernel_spike/dsh_driver.ts ..\NExgent-upstream-deepseek-46a7f68
```

2026-09-23 本机定向运行退出码 0；原始收据保存在独立工作区目录 `E:\PKU\program\2026\Aug\te\.nexgent-dsh-spike-jcxy5n\receipts`，摘要为 `summary.json`，另外保留 headless 输出、主任务及另一任务的持久 session JSONL、插件 side receipts 和 stderr。首次把试验项目放在 `%TEMP%` 时，第二 Agent 创建触发受限环境的 `EPERM: realpath C:\Users\Lenovo`；失败收据保留在 `%TEMP%\nexgent-dsh-spike-R4vp0m\receipts`。移到可访问的 E: 工作区后，同一断言通过，无需提升沙箱权限。

通过的是**固定模型替身和人工编写工具的后端合同**：主 Agent 第一请求的工具 schema 只有 `spike.multiply`；同进程第二 Agent 的工具列表为空，直接调用同名工具失败；主 Agent 的模型接口请求 `multiply(6,7)` 并收到 42。工具执行时调用 disposer，下一条持久 `request/header` 已没有该 schema；模型接口再次请求同名工具，持久 `tool/result` 记录 unknown-tool 错误；最后交付精确 `{"answer":42}`。诊断插件 SHA-256 为 `6ca07a39515b539c16c0d6bee50ed0e03cd68de7f640f8c3d99f7b2847e3d892`。外部模型调用为 0。

此处的“隔离”仅是 DeepSeek 同进程 Agent 作用域注册；诊断插件自身在宿主进程执行，**不是 OS 代码沙箱**。Creator 的 profile 持久安装也不能代替任务内隔离试装。上游持久日志记录模型工具 schema、调用、结果和会话顺序，但不包含 Nexgent 所需的 handler 摘要、依赖锁定、能力版本及准入账；插件摘要只在独立收据中，生产桥接需将其与事件绑定。

**共同合同尚未完整通过：**真实模型、重启恢复和 Nexgent Episode／benchmark 评价投影仍待验证。当前 `TaskService` 没有公开的外部执行结算接口；事后导入 DeepSeek 日志不能冒充执行前预算准入或原任务完成。A2 下一项是构造清楚标记为“外部证据投影”的诊断 Episode，再判定 A3 的生产桥接与技术选型。
