# DSH Main

Nexgent 的目标是可实际使用的通用任务应用，以及从真实任务反馈中产生、验证和复用能力版本的 RSI 框架。Main、CLI、Python 和 benchmark 继续使用同一个 Episode、预算、工件和发布账本。订单、Excel、科研及组织提案都是应用，不进入内核的判断规则。

这次把成熟 DSH/Cordis 的原生工具调用循环接入 Main。DSH 负责模型与工具迭代，Nexgent 宿主负责授权、真实调用收据、发布、独立评价与能力版本。使用官方 Python SDK、`sdk-minimal` profile、官方 MCP 客户端及公开 LLM adapter；没有维护另一套 agent loop 或私有 SDK 启动协议。

## 使用

已安装匹配的官方 DSH Python SDK/runtime 和 Nexgent 可选依赖时：

```powershell
python -m pip install -e ".[dsh]"
nexgent --root ./my-dsh-project run "完成任务" --model-root . --kernel dsh --attach ./input.json
nexgent-gui --project ./my-dsh-project --model-root . --kernel dsh
```

```python
from nexgent import Nexgent
agent = Nexgent("my-dsh-project", model_root=".", kernel="dsh")
task = agent.create("完成任务", inputs={"material": material})
result = agent.run(task["id"])
```

内核选择存入项目的 `.nexgent/kernel.json`，重启自动加载。新项目初始 Main 包采用 DSH；已有项目的已部署版本保持原样，选择内核不会绕过门控覆盖它。使用新项目目录测试原生 Main。旧 Python 入口继续兼容；本次没有默认重置所有项目。

模型仍由 `models.json` / `.env` 配置；默认 `mimo-v2.6-pro`。模型密钥只在宿主 gateway 使用。原生 DSH 进程只能通过本次任务的本地短期凭证调用已授权 MCP 能力和宿主模型代理。工具的实际 input schema、开发后的工具列表变化和 required deliverable schema 都进入原生工具目录。

## 当前 Windows 开发运行方式

本轮验证使用官方 DSH 源码提交 `46a7f68b0922371ce7144b668b90e377d8e799f4` 的已构建 CLI、Node 24.15.0，以及官方 SDK/runtime 源码。上游 runtime 的 **node carrier 是开发方式**；本轮没有交付生产 SEA 可执行文件或 runtime wheel。`.[dsh]` 只安装 MCP/HTTP 依赖，不会下载 DSH runtime。

提供一个可直接进入 Main 的开发启动器。`DshSource` 必须是官方已构建 checkout（`apps/cli/lib/bin.js` 及其依赖闭包）；上游的安装和构建以该提交 README 为准。启动器在本仓库忽略的 `validation-workspace` 中复制未改动的官方 Python runtime 源文件，创建指向已构建 CLI 的目录 junction，并显式选择官方 node carrier。它不修改上游 checkout 或共享虚拟环境。

```powershell
# 普通虚拟环境已安装 .[dsh] 时无需 DependencyPath
./scripts/start-dsh-dev.ps1 -DshSource E:/path/to/deepseek-harness -Check
./scripts/start-dsh-dev.ps1 -DshSource E:/path/to/deepseek-harness -Project ./my-dsh-project

# pip --target 安装的依赖需要处理 .pth，启动器也支持这个方式
./scripts/start-dsh-dev.ps1 -DshSource E:/path/to/deepseek-harness -DependencyPath ./validation-workspace/dsh-deps -Check
./scripts/start-dsh-dev.ps1 -DshSource E:/path/to/deepseek-harness -DependencyPath ./validation-workspace/dsh-deps -Project ./my-dsh-project

# CLI 使用同一运行环境；run 的参数仍显式选 DSH
./scripts/start-dsh-dev.ps1 -DshSource E:/path/to/deepseek-harness -Cli run "完成任务" --kernel dsh
```

`-Check` 只检查导入、官方 launcher 和摘要，不发送模型请求，也不检查任务质量。实际 Main 会话仍需要有效模型配置。

## 本轮行为和限制

- Main 的交付由固定宿主 evaluator 复核，初始包不再另跑一个可修改的包内 reviewer。审核可按剩余预算限制核验轮数并留出判断调用；缺少核验仍不能验收通过。执行时耗尽所有预算仍可能无法交付。
- 静态 `run_python`、任务开发工具和已采用工具使用相同 worker trace 计量。失败后的实际消耗保留；未测到的消耗标为未知。单位是 worker 执行事件，不是秒数、CPU 指令或美元。
- 原生模型请求经过同一个宿主准入和收据链，上下文服务附加字段作为数据进入该请求。模型未知远端结果不自动重发。
- 原生收尾可以是文字、Markdown 或结构化文本。输出引用只来自本轮成功的宿主 `publish` 收据，并再次核验工件和声明的 schema；最后回复中的引用没有发布权限。未发布 required deliverable 或发布被 schema 拒绝时，不能完成交付。
- 已完成 Episode 重启读取与原生进程退出已验证。中途未完成的整个原生循环还不能自动从 DSH 会话继续；保留收据和会话，进入既有人工协调恢复边界。不能声称完整中断恢复已经完成。
- adapter 当前支持文字及工具消息；附件通过现有工作区/工件工具读取，尚不支持原生视觉消息。受限计算 worker 和 Cordis scope 都不是 OS 容器。
- 自建工具可在当前任务开发并调用；跨任务复用必须通过现有 selection、guard 和发布门控。本轮真实闭环结果单独记录，不能以脚本测试或一次正确交付代替正向 RSI 结论。
- 规划器获得任务内能力的说明、作用域和拟议的持久化用途，以宿主提供的 `source_ref` 选择候选。不可变定义摘要仍在宿主账本中核验。审核最后一轮只请求评价结论，缺少独立计算或文件读取仍不能通过。
- 同一源码可被不同改进尝试再次生成。包保留第一次的来源说明；发布权限根据当前不可变生成记录、实际 `improve` 收据及补丁重放核验，不由包的来源说明授予。相同代码不会覆盖此前来源记录，也不能以不同代码冒充该次生成。

验收记录见 [DSH Main 实测](validation/dsh-main-20261006.md)。
