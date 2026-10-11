# @nexgent/sdk

进程内 TypeScript SDK：CLI 与桌面应用共用的项目、会话、轮次与事件、审批、资料、成果、反馈、目标、设置与导出接口。桌面应用的主进程持有一个实例，渲染进程经 IPC 按 `SdkMethods` 的方法名调用（白名单与令牌规则见 `docs/spec/permissions.md` §本地 IPC 与访问令牌）。

归属：计划步骤 2。接口 `src/api.ts` 由 W0（「步骤二契约」）在第 1 轮冻结，只有类型与方法名清单；实现由 W4（「SDK 与 CLI」）在第 3 轮完成。冻结后改接口走契约修改 PR，并在 PR 描述里点名受影响的包（`apps/desktop`、`apps/cli`）。

约束：

- 不 import Electron，可在纯 Node 下运行；
- 所有参数与结果都是 JSON 安全的，原样跨 IPC；错误以 `NexgentError` 拒绝，跨 IPC 时传 `toErrorInfo` 的投影；
- 任何方法都不返回密钥值，只返回 `CredentialInfo`（`configured`、`source`）；
- 每个轮次的事件流以且仅以一个 `turn.end` 收尾，取消、审批超时、强杀恢复时也一样。
