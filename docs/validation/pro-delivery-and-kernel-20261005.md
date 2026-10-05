# Pro 交付与 DSH/Cordis 复核（2026-10-05）

本次修复在 `NExgent-kernel-impl`，基于 `2663a1a`。它是通用框架改动，组织应用仍是可选 demo。

## 模型与可运行入口

此前真实验证主要使用 `mimo-v2.6-flash`，无配置的回退模型为 `mimo-v2.5`。
本次把源码回退、示例以及两个本地项目的主执行、子任务、评价和改进角色都切到
`mimo-v2.6-pro`。已完成任务的配置身份和服务返回身份均为 Pro。
凭据仅留在被 Git 忽略的配置中，未写入证据或源码。

结构化程序/JSON 请求显式关闭 MiMo thinking。第一轮默认 thinking 消耗了
3000 completion tokens，却没有产生可解析内容；关闭后仍使用 Pro，不能将本次
结果描述为开启推理模式的对照研究。远端超时的未知结果/费用不能补算为零。

从此检出运行 `./start.ps1`；验证脚本应显式指定本检出的源码，避免虚拟环境的旧
editable 安装指向其他目录：

```powershell
$env:PYTHONPATH = 'src'
$env:PYTHONIOENCODING = 'utf-8'
.\.venv\Scripts\python.exe -u scripts/validate_pro_delivery.py validation-workspace/pro-delivery-new
```

脚本使用默认 `Nexgent`，不注入模型、策略、评价器、benchmark 或改进器。保留失败
attempt，恢复执行时复核并复用已验收成果；远端结果未知的旧调用不会静默重放。
没有真实发布或没有重启后实际使用收据时，脚本失败退出，不把正确答案标成完整闭环。

## 已证明的真实交付

模型在任务中自行生成参数化订单工具源码、装载、实际调用和交付 JSON。
独立评价在固定宿主程序中重新计算，脚本另用宿主 oracle 检查所有字段。
数据包括订单修订、取消、负数退款、整数分计价和合计为零的产品组。

`pro-delivery-v5-20261005` 的三个完成任务：

| 用途 | Episode | 验收/oracle | total_cents | 模型调用 | 已知 tokens |
| --- | --- | --- | ---: | ---: | ---: |
| 不同历史 guard | `2f7380b188044eb5` | true/true | 378 | 7 | 44189 |
| source 第二次 attempt | `16c9dd034b9547b5` | true/true | 774 | 6 | 36496 |
| 重启后新输入 | `0251442f36fe4540` | true/true | 1188 | 16 | 125361 |

但当轮主通道仍为 revision 0。新输入重新开发了工具；不能称为发布后复用。
学习规划器分别漏了必填 `hypothesis` 和 `reason`，真实规划 Episode 失败。
此次明确所有必填键，并澄清“当前任务成功使用”不等于“未来任务已持久采用”；
未放宽质量、成功率、实际使用、费用完整性或回归门控。

修复规划格式后的 `pro-delivery-v6-20261005` 中，guard 第二次 attempt
`d507be90b7264798` 和 source 第二次 attempt `8b1f7e4bf4874d70` 同样得到
accepted=true/oracle=true，分别消耗 9/29 次模型调用、65323/213412 已知 tokens。
source 首次 attempt 的一次远端请求结果未知；guard 首次 attempt 受到错误的
取消产品解释和不完整评价影响。高调用次数包含重复审核和一次自动交付修正，
不能称为稳定低成本执行。

这次规划器确实选择了工具持久采用，并执行真实 parent/candidate selection。
parent/candidate 均交付且实际能力激活，但评价分为 9/8，候选被拒绝；主通道仍为
revision 0，未进入发布后的 guard 和真实新任务复用。规划和 selection 的
15 次模型调用消耗 128954 已知 tokens，费用回执完整。

selection 还暴露了当时未修复的成本可比性缺陷：临时工具执行中的 worker 指令数没有
进入 `charged_tool_work_units`（0），采用后的相应工具则计入了（104）。所以
41.4/143.8 的保守工作量不能作为真实效率差的结论。拒绝记录保留，但不据此
断言工具采用更慢。位置为 `TaskService._invoke_dynamic_tool` 与
`_invoke_package_tool`；当前默认工具工作量预算及失败结算也须一并复核。
统一成本计量应以两路径运行相同算法时的收据和预算边界作为验收；当轮尚未完成。
后续新 PR 已统一两条工具路径的 worker 计量，详见文末追加记录。旧 selection
使用旧宿主，不能用新计量方式追溯改分或改成采纳成功。

最后一次新输入 `a0d3ecc212104d71` 是明确负结果：主通道 revision 0，没有采用
候选，输出错误地保留了取消订单的旧版本，得到 kept_orders=5、total_cents=2056，
正确值应为 4/1188。模型独立评价 accepted=true，但宿主 oracle=false，脚本失败。
它暴露了相同模型的评价误判，进一步说明真实框架交付尚不可靠。
任务题目、结果和 oracle 均保留，不能只报告先前的三个正确结果。

所有本轮 Python 默认入口实测合计 **152 次模型调用、1072466 已知 tokens**，
另有 **3 次调用结果/费用未知**；不含 DSH 调试调用，不能将该数字当作完整账单。
根 Episode 身份、模型身份、费用状态以及两轮学习记录见
[完整实测摘要](evidence-pro-delivery-20261005.json)。

## 修复与负结果

- 动态工具成功后，工作区 provider 扫描历史工具事件会用静态全局 registry
  查询动态名字，导致独立 `run_python` 也报 unknown tool。现在按提供者身份和
  工作区工具 inventory 识别事件，新增真实动态调用后独立计算的回归测试。
- Pro/Flash 有时在 JSON 后暴露一个或多个 `<|im_end|>`。适配器只移除已知模型的
  尾部终止标记，保留 JSON 字符串内部标记，其他文本仍按原合同拒绝。
- 评价器在耗尽验证行动后明确返回最终评价，避免继续请求不可用工具；宿主仍检查
  实际计算/读取收据以及必需 requirement checks。工具成功不能直接代替评价。
- 产品两种完成格式的稳定失败来自过期的“三次模型调用”预期；实际执行加评价为
  两次。更新断言，继续检查正确完成、验收和两条调用记录。
- 默认单请求墙钟上限从 90 秒调到现有网关支持的 180 秒；仍观察到远端超时。
- CI 保留用户原定的手动触发；本轮回归为本地执行结果。此前加入的 push/PR
  触发在重新核对对话约束后已撤回。

失败记录包括 thinking 额度耗尽、工作区 lookup 缺陷、评价器重复验证/错误解释、
必填计划字段缺失，以及模型调用结果/费用未知。完整本地 SQLite 和逐次 summary
均保留在被忽略的 `validation-workspace/pro-delivery*-20261005`，不只保留成功样本。

## DSH/Cordis

[DSH 官方说明](https://github.com/deepseek-ai/deepseek-harness)明确其建立在
[Cordis](https://github.com/cordiverse/cordis) 上。Cordis 提供服务、事件、作用域及
插件生命周期；DSH 在此基础上提供 Agent 执行。它们应作为同一后端路线评估。

固定 upstream `46a7f68b0922371ce7144b668b90e377d8e799f4` 的 headless profile，
使用 Pro 已完成两次原生模型请求、一次 multiply 调用以及最终 `{"answer":42}`。
共 1332 tokens，实际返回模型两次均为 Pro，凭据泄漏扫描通过。证据见
[完整身份及摘要](../../experiments/kernel_spike/evidence-dsh-pro-live-20261005.json)。

旧失败中，MiMo 终止标记、JSON 参数的空白差异和错误的 header 事件计数断言
属于适配/诊断问题。它们不能继续作为 DSH 不可用的结论。
[ADR](../design/adr-001-python-episode-kernel.md) 已重新开放这条路线评估。

multiply 是预写诊断工具，任务也直接提示了最终答案。本实验只证明原生请求、
工具事件和完整响应链，不证明模型自主开发、任务质量、RSI 或生产接入。
当前生产仍使用 Python Episode 链；DSH 与同一预算准入、费用结算、恢复、独立
评价和发布链的桥接尚未交付。

## 验证边界

新 PR 工具计量改动之前的源码回归分四个互不重叠的文件集合执行，共 **1451 passed，2 deselected**。
四组分别 363/363/363/362 项通过，最长一组 599.02 秒；两个未运行项是显式 opt-in
的 OpenFOAM 实机测试。动态工具后的独立评价、两个产品完成格式、MiMo 请求参数
与终止标记回归均在此套件中。`git diff --check` 通过。文件集合及日志哈希见
[回归身份记录](evidence-pro-regression-20261005.json)。

单组订单数据的开发、selection 和 guard 不能作为独立 held-out 研究。
真实任务可交付与长期自改进收益是不同结论。正式效果研究仍需多任务、多次重复、
未见任务以及“不持久保存变化”的对照；本次不报告统计显著收益。

## 新 PR 的工具计量与 Main 修正

在 `fix/main-delivery-trust-and-tool-accounting` 中，临时工具与采用后的工具共用
同一个 worker 计量入口。正常返回、输出合同失败和程序异常都记录实际 trace
事件数；工作预算限制 worker，触发终止的额外事件也保留。已经消耗的工作量
不会因预算错误而回滚为零。无法取得 worker 回执的超时/停止记为缺测，效率
采纳不能使用不完整费用。旧历史收据保持原状，不追溯改成新计量结果。

默认任务 API 的工作量预算为 200000，与 Main 一致；显式零预算阻止两种工具
执行。采用声明为零的工具也必须预留至少一个工作单位。并发调用按各自启动时
剩余额度限流，最终结算如超支则记录真实消耗并报预算耗尽；这不提供并发 worker
指令额度的事先整体分配，也不把 trace 事件数称为墙钟时间或 CPU 指令数。

Main 将默认模型判断显示为“模型审核通过”，报告写入宿主拥有的
`verification_method=model_review`。它仍是同一模型的开发性评价，不能替代
领域适配器、确定性检查或独立 held-out 研究；本轮未声称已解决模型误判。

追加一次限额 Pro 普通入口实测，最多 12 次模型调用、48000 reserved completion
tokens，不追加重试。模型生成、装载并使用两个订单工具，分别计入 118/148
工作单位，合计 266；12 次模型请求消耗 75208 已知 tokens，费用回执完整。
结果的数值与 oracle 一致，但发布的是 JSON 字符串而非对象，独立评价在模型
额度耗尽后不可用：accepted=null，严格 oracle=false。此轮明确失败，既不是
发布后的复用，也不是完整闭环成功。摘要及两条计量收据见
[限额实测](evidence-pro-metered-delivery-20261005.json)。

验证脚本已显式声明 `result` 的对象合同，保留旧失败，并可用以下命令进行
一次限额交付检查；移除 `--single-task` 才执行原先的 guard、反馈、采用和重启
复用路径。此命令只是可复现用法，不代表修订合同后的实测已经通过。

```powershell
$env:PYTHONPATH = 'src'
.\.venv\Scripts\python.exe scripts/validate_pro_delivery.py validation-workspace/pro-check --single-task --max-model-calls 12 --max-completion-tokens 48000
```

本轮完整套件首轮为 **1460 passed、2 failed、2 deselected**。一处失败来自新增
异常子类改变已有 `PackageError` 分类，已恢复原类型，只在异常上附加 worker
测量；生成器及相关 worker 检查随后 **124 passed**。另一处反馈后重启采纳
集成检查单独在最终代码上 **1 passed**，首轮失败仍保留。最终最小预留及模型
审核显示补改的关联检查为 **56 passed / 29 passed**。这是一轮完整回归加修复后
定向检查，不报告为最终源码另跑了整套无失败回归。四组文件集合、原失败、
后续日志哈希及最终源码哈希见 [本轮回归记录](evidence-meter-regression-20261005.json)。
