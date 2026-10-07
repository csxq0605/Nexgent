# Nexgent 原生应用

Nexgent 的默认应用直接运行本仓库 `runtime/` 中的 DSH 派生源码。应用继承原生会话、上下文、文件工具、子智能体、工作流、凭证服务和浏览器界面；Nexgent 自己决定产品默认值并继续改造这些实现。

## 构建与运行

需要 Windows、PowerShell 7、Node.js 22.19 或 Node.js 24+，以及 pnpm 11.7。当前验收环境为 Node.js 24.15、pnpm 11.7。项目目录需先创建；Windows 进程隔离要求目录由调用者拥有并授予 WRITE_OWNER，仅有 Modify 不足以设置完整性标签。在项目 `.env` 中配置 `NEXGENT_API_KEY`，或在启动进程的环境中提供它。不要将密钥写入源码或 profile。

```powershell
cd runtime
pnpm install --frozen-lockfile
pnpm run build
cd ..
./start.ps1 -Project ./my-project
```

启动器使用应用自带的 `nexgent` profile，打开浏览器 Main。`-NoOpen` 只启动服务器；`-Port 3094` 指定端口；`-Check` 输出默认组合配置，不执行模型任务。服务保留 DSH 的本地访问保护，启动日志中的临时访问 token 不应分享。

同一原生运行基础提供一次性命令与 headless 会话恢复：

```powershell
./run.ps1 -Project ./my-project -Json -Task "读取资料并完成任务"
./run.ps1 -Project ./my-project -Json -SessionId session-... -Task "继续上次任务"
```

从第一次 JSON 输出中取实际 session ID；未知 ID 会报错。当前 headless 只能接续其支持的原生会话，尚未验证对所有浏览器 preset 会话的互相接续。浏览器与 headless 保存同一格式的原生记录，但不能据此承诺所有会话可跨入口恢复。

默认模型为 `mimo/mimo-v2.6-pro`，使用继承的 pi-ai OpenAI-compatible 适配器，thinking 默认为关闭。默认接口为 `https://token-plan-cn.xiaomimimo.com/v1`；接口覆盖通过原生模型配置完成，配置补丁不直接内联环境变量。主任务的 provider 重试额度为 0；标题生成属于独立请求，不能误计为任务重试。

## 项目与源码归属

每个项目的 `.nexgent/native/` 保存原生 profile、Session 和相关存储。启动器设置项目 cwd 与独立数据目录，并在结束时恢复调用进程的环境。该目录由 Git 忽略。旧 Python Episode 数据仍保留，当前没有自动转换为原生 Session。

源码来源为 `deepseek-ai/deepseek-harness@46a7f68b0922371ce7144b668b90e377d8e799f4`，完整导入放在独立提交中，保留 MIT LICENSE 与原始归属。后续 Nexgent 改造直接发生在 `runtime/`。内部的 `@nexgent/application` 是随应用构建的私有默认配置层；用户无需把 Nexgent 安装进外部 DSH。Cordis 和原来的模块名保留，以复用依赖解析、服务与生命周期。

## 已执行的验收

完整原生 host/client/web 构建通过；默认 profile 可解析。配置、品牌生命周期和构建环境共 50 项聚焦检查通过。`node scripts/test-native-app.mjs` 仅替换外部 HTTP 模型服务，验证原生 write/read、实际文件内容、另一个 OS 进程中的历史恢复、MiMo 请求兼容参数和 403 主任务不重试。

`node scripts/verify-native-live.mjs` 使用本地已配置密钥调用真实 MiMo-V2.6-Pro，从原生 `run.ps1` 读取 CSV、写出 count/sum/mean，然后在另一个进程恢复同一 Session 并添加 min/max。验收脚本独立读取 JSON 校验结果，保留实际工具事件与每步用量。数据与完整日志在 `validation-workspace/native-pro-*/`；此验证只支持文件交付与续聊，不支持 RSI 收益结论。

原生浏览器服务可以启动；未授权访问返回 401，本地访问凭证可以取得标题为 Nexgent 的页面，且没有配置行等待激活。自动化浏览器策略拦截了 localhost 页面，视觉与交互验收尚未完成。真实任务中 PowerShell 工具曾被本机 Windows ACL 限制拒绝；只读工作流协调进程和原生文件工具现已通过验收，仅有 Modify 权限的 E 盘目录仍无法执行 workspace-write 进程；普通调用者自有、具备 FullControl 的临时项目已经验证受限 PowerShell 与同进程 Node 测试执行，通用子进程与构建兼容性仍未完成验收。

`node scripts/test-native-code.mjs` 已验证原生 write 交付源码与测试、受限 PowerShell 启动 Node、四项实际检查及执行产生的文件。`node scripts/verify-native-code-live.mjs` 已用真实 MiMo 编写 JSONL 处理模块，执行宿主提供且保持原样的五项公开检查，并独立核对产物。测试使用 `--test-isolation=none`，仍在原生受限进程内运行；默认 Node 测试派生进程曾返回 EPERM，不能据此承诺所有构建流程。`--modify-project` 负例确认当前 E 盘 Modify-only 目录会拒绝执行，保留 Win32 API、错误码与 WRITE_OWNER 提示。结果见[代码交付验证摘要](validation/native-code-20261007.json)。

已执行验收的来源、会话身份、独立进程、输出、原生每步用量和限制记录在[验证摘要](validation/native-application-20261006.json)。标题请求与前台步骤分别执行，摘要中的前台用量不代表全部账户费用。

## 后续主线

原生 `workflow` 已接受声明式 `architecture`：节点包含角色、任务、依赖、模型选择及可选对象输出 schema，编译后复用原生工作流执行、取消和持久记录，并返回内容版本。可选 `persona` 使用原生模板替换成员人设；`toolFilter` 对成员的全局工具施加 allow/deny 掩码，继承限制取交集，结构化提交等作用域工具保持可用。角色字段本身仍是任务数据。674 项所属检查通过，所选六个源文件的语句、分支、函数和行覆盖率均为 100%。上下文策略和执行器变化尚未成为图节点配置。

`node scripts/test-native-architecture.mjs` 已验证构建后的应用执行三个真实成员、实际文件写入与读回、依赖输出传递及另一个 OS 进程中的同一会话恢复，以及新会话按保存版本执行，仅替换外部 HTTP 模型。应用的协调脚本使用 read-only，成员仍继承任务的 workspace-write；额外只读任务验证写入被拒绝、文件保持原样且依赖成员不启动。收紧协调脚本权限不会扩大成员权限。额外进程验证未知与损坏的版本不启动成员。保存与新会话复用的身份和结果见[版本存储验证摘要](validation/native-architecture-store-20261007.json)。

`node scripts/verify-native-architecture-live.mjs` 已用真实 MiMo v2.6 Pro 验证同一路径：两个成员分别交付 totals.json 和 range.json，review 成员使用两者实际输出并交付 review.json。外部验收脚本独立读取三个文件，确认 count=3、sum=21、mean=7、min=3、max=11。进程身份、版本与输出记录在[架构执行验证摘要](validation/native-architecture-20261006.json)；其中前台用量不包含所有成员与标题请求，不能用于整体费用或 RSI 收益结论。

图定义已保存在项目的 `.nexgent/native/architectures/`，新 Session 可通过 `architectureVersion` 复用。保存记录不代表采用；原生候选试用与发布、独立 selection/guard、后续任务自动复用采用版本和改进器自身进化尚未接入。旧 Python 中有效的门控、账本和反馈逻辑需要迁入原生服务；它们当前不保护原生会话。下一步在已有 Agent/subagent/workflow 机制和保存定义上实现候选试用、独立评估与版本采用，随后验证跨任务进化。

2026-10-07 的[节点配置验证](validation/native-node-composition-20261007.json)进一步验证了实际人设模板、成员工具列表、被隐藏写工具的执行拒绝，以及新进程、新会话中的配置复用。`node scripts/verify-native-code-live.mjs --architecture` 使用真实 MiMo，通过带工具范围的实现成员生成 records.mjs、运行未改动的五项公开验收，再由只能读取的复核成员读取源代码、验收文件和实际产物。宿主验收读取原生压缩会话，关联成员身份、PowerShell 调用和真实测试结果；这不代表独立 selection/guard 或自动采用已经完成。
