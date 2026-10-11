# 步骤 <n> 验收记录：<一句话标题>

> 复制本文件为 `step-<n>-<yyyymmdd>.md` 后填写。每一栏都要填；没有的写“无”，不知道的写“unknown”并说明原因。

## 步骤

- 步骤编号与名称：
- 退出门槛（抄自计划 4.7）：
- 验收脚本：`scripts/accept-step<n>.mjs`（或说明为何无脚本）

## 日期

- 验收日期：
- 覆盖的工作区间（起止提交）：

## 分支与提交

- 分支：
- 提交：`<sha>`
- 相关 PR：

## 环境

| 平台 | OS 与版本 | Node | pnpm | 其他（Electron、PowerShell 等） |
| --- | --- | --- | --- | --- |
| Linux | | | | |
| Windows | | | | |

## 脚本化 provider 结果

| 平台 | 命令 | CI run 链接 | 结果 | 摘要文件 |
| --- | --- | --- | --- | --- |
| Linux | `pnpm ...` | | 通过 / 失败 | `step-<n>/<name>.json` |
| Windows | `pnpm ...` | | 通过 / 失败 | `step-<n>/<name>.json` |

说明脚本模拟了什么、注入了哪些故障（断网、超时、kill）。

## 真实模型结果

| 模型（thinking 开 / 关） | 任务 | 调用数 | 已知 tokens（输入 / 输出） | 未知结果数 | 费用 | 结果 | 摘要文件 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `claude-sonnet-5-5`（thinking 关，effort medium） | | | | | | | |

- 手动 workflow 链接或本机运行说明：
- unknown 的来源（用量缺失、进程中断、审核模型无判断等）：

## 失败与缺测

- 失败的用例与原因：
- 没有测到的部分（平台、故障类型、任务类型）：
- 已知但未修的问题：

## 结论边界

- 本记录证明：
- 本记录不证明：
- 是否满足退出门槛：是 / 否（缺什么）

## 原始记录位置与 manifest 摘要

- 原始 JSONL：Release `<tag>` 附件 `<file>`，SHA-256 `<hash>`
- 摘要目录：`docs/validation/step-<n>/`
- `manifest.sha256` 内容：

```text
<sha256>  <file>
```
