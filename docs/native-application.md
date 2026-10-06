# Nexgent 原生应用

Nexgent 的默认应用直接运行本仓库 `runtime/` 中的 DSH 派生源码。应用继承原生会话、上下文、文件工具、子智能体、工作流、凭证服务和浏览器界面；Nexgent 自己决定产品默认值并继续改造这些实现。

## 构建与运行

需要 Windows、PowerShell 7、Node.js 22.19 或 Node.js 24+，以及 pnpm 11.7。当前验收环境为 Node.js 24.15、pnpm 11.7。项目目录需先创建；在项目 `.env` 中配置 `NEXGENT_API_KEY`，或在启动进程的环境中提供它。不要将密钥写入源码或 profile。

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

原生浏览器服务可以启动；未授权访问返回 401，本地访问凭证可以取得标题为 Nexgent 的页面，且没有配置行等待激活。自动化浏览器策略拦截了 localhost 页面，视觉与交互验收尚未完成。真实任务中 PowerShell 工具曾被本机 Windows ACL 限制拒绝，原生文件工具完成了交付；不能据此声称 shell 和受隔离的代码工作流已在本机可用。

已执行验收的来源、会话身份、独立进程、输出、原生每步用量和限制记录在[验证摘要](validation/native-application-20261006.json)。标题请求与前台步骤分别执行，摘要中的前台用量不代表全部账户费用。

## 后续主线

可版本化架构图、原生候选试用与发布、独立 selection/guard 和改进器自身进化尚未接入。旧 Python 中有效的门控、账本和反馈逻辑需要迁入原生服务；它们当前不保护原生会话。下一步应在已有 Agent/subagent/workflow 机制上实现图结构执行和版本采用，随后验证跨任务进化，避免重新造任务循环或围绕领域 demo 固定架构。
