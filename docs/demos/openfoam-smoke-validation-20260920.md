# OpenFOAM cavity smoke 验证：2026-09-20

## 结论

独立 `openfoam_cavity` 插件已在真实 **WSL2 `Ubuntu-20.04` / OpenFOAM Foundation 8** 环境通过冻结的 `smoke` / seed 0 / `cavity_re10` 切片。normal provider test 与后续真实 `TaskService` 受控恢复 episode 都实际运行 `blockMesh`、`checkMesh` 和 `icoFoam`，解析最新写出的 `U`、`p` 字段，并由插件的独立隐藏评价器核对执行收据和最终交付；两条路径的评价结果均为 `accepted=true`。

该结果只建立一个 Re=10、20×20×1 官方教程 case 的执行和结构 smoke。它没有评价稳态、Ghia 中心线精度、Re=100、网格收敛、时间步收敛、性能、其他 OpenFOAM 安装的一致性、一般 CFD 可靠性或 RSI 效果。最初的 normal provider test 直接调用 domain/evaluator 合同；后续恢复证据则由真实 `TaskService` 执行固定、无模型 `AgentPackage`。两者的模型调用数都是 0，因此仍不构成模型自主任务或 RSI 证据。

非敏感的机器可读摘要保存在 [`openfoam-smoke-receipt-20260920.json`](openfoam-smoke-receipt-20260920.json)。原始有界输出由运行收据以预览、字节数和 SHA-256 表示；本页不把预览重新包装成完整日志。

## 冻结合同与运行入口

| 项目 | 冻结值 |
| --- | --- |
| 插件 | `benchmarks/openfoam`，版本 `openfoam-cavity-smoke-v1` |
| 场景 | `split=smoke`、`seed=0`、`cavity_re10` |
| 模板 | Foundation 8 `incompressible/icoFoam/cavity/cavity` |
| 物理量 | (L=0.1\,m)、(U=1\,m/s)、\(\nu=0.01\,m^2/s\)，因此 Re=10 |
| 网格 | 20×20×1；预期 400 cells |
| 求解 | `icoFoam`，预期结束时间 0.5 s |
| 固定命令 | `blockMesh -case <managed-case>`、`checkMesh -case <managed-case>`、`icoFoam -case <managed-case>` |
| 资源限制 | 每个命令 60 s；每个命令保留 64 KiB 输出预览；完整输出流保存字节数与摘要 |

真实 provider 测试由以下显式 opt-in 入口触发：

```powershell
$env:NEXGENT_OPENFOAM_REAL_TEST = '1'
.venv\Scripts\python.exe -m pytest tests/test_openfoam_plugin.py::test_real_openfoam_smoke_is_explicitly_opt_in -q
```

最终结果是 `1 passed in 41.49s`。其中插件记录的三个 OpenFOAM 命令总 wall time 为 18,859 ms；pytest 总耗时还包含环境探针、模板复制、解析和评价。环境不可见时该测试按合同 skip，不伪造求解结果。

## Normal provider test 的真实执行收据

| 程序 | 退出码 | 时长 | 输出字节 | 预览截断 | 超时 | 完整输出 SHA-256 |
| --- | ---: | ---: | ---: | --- | --- | --- |
| `blockMesh` | 0 | 5,078 ms | 2,284 | 否 | 否 | `8f73ac7db7ea349beec59c337bcd5f0d5b88ca0a6c70af87608c06075f9bb751` |
| `checkMesh` | 0 | 5,984 ms | 3,091 | 否 | 否 | `d29329de4abb04bafd7e475dde2b3e6d0f8c481592a40d9293803313ae6b8ec4` |
| `icoFoam` | 0 | 7,796 ms | 73,883 | 是 | 否 | `7d1c072ca0a9af4723c1ea1eab8630bbbebabe16fbccc57fef6bb7877f0667a1` |

`icoFoam` 输出超过 64 KiB，因此只截断可展示预览；`output_bytes` 和完整流摘要仍来自捕获的全部 73,883 bytes。截断不等于求解缺测。

| 身份 | SHA-256 |
| --- | --- |
| spec | `2783156865071846129427dc895820f0e530f1b12834860e80ef7e8b4e8d7009` |
| template / case before run | `241b4c8cb8e85fa252cc3854be0f5389adb228a67b2163cd21a60ef4a9b597f3` |
| job | `c8400a9d172c4364f4afa875d132dc327f55ca7c87f6f8d9652ab143b7b3a9a5` |
| case after run | `8d9d0414b8e62279a8291d25d8e720e6268303abbe38e8bbcd076ae82f3d8e55` |
| run | `24d3bcca47377e63d2067c1fd52316b900d165d51966b14611709d426e29d63f` |

case 运行前摘要与模板摘要相同，说明准备阶段没有修改官方输入；运行后摘要不同，因为求解器写出了 mesh、日志对应输出和时间目录。摘要变化本身不表示数值正确，作用是绑定同一个准备与运行实例。

## 解析与公开检查

`checkMesh` 报告 `Mesh OK.` 和 400 cells。`icoFoam` 日志解析得到 `end_time=0.5`、`completed=true`；保留预览中观察到 354 条 `Solving for` 记录。由于完整输出为 73,883 bytes、预览按 64 KiB 截断，这个计数明确标为不完整，不能当作总迭代数。最新时间目录中的两个内部场均成功解析：

| 字段 | OpenFOAM class | dimensions | 值数 | 范围 | 有限 | SHA-256 |
| --- | --- | --- | ---: | --- | --- | --- |
| `U` | `volVectorField` | `[0 1 -1 0 0 0 0]` | 400 vectors | -0.368612 … 0.852667 | 是 | `d9cedfff53166ede22d5d7f913f911c79b8d7d82ab7c89d6ea45823a5b456f8c` |
| `p` | `volScalarField` | `[0 2 -2 0 0 0 0]` | 400 scalars | -4.36666 … 4.84854 | 是 | `cd153e93d5c2e7317bb4ae96e47e2ec8bdcd2ab39bd88e4cf60279bb6dd73bc7` |

字段范围仅证明解析出的数值有限；没有与独立解或 Ghia 数据比较。公开 smoke 检查要求三个命令成功、mesh OK、400 cells、到达 0.5 s、`U`/`p` 有限，五项均通过。

隐藏评价器不重新运行 OpenFOAM，也不相信候选自行撰写的 receipt-shaped JSON。它核对冻结输入摘要、可用环境探针、匹配的 case 准备、与最终两个交付物逐值相同的真实 `run_cavity` 收据、准备与 job/template 摘要的绑定、公开检查，以及对最终工件版本的 `validate_delivery` 收据。本次全部成立，返回 `accepted=true`。

## 真实 TaskService 受控恢复 episode

最新代码还完成了一条框架级恢复链。`episode-6ef65a0b81754ce3` 由真实 `TaskService` 执行固定、无模型的 `package-9d3eb88382fcfebbff47b1f4`；package digest 为 `d6162a2b18c6d8366d82a49dfbded3fba3cde089cbc46101a839725f02398067`。episode 最终状态为 `completed`，累计使用 0 次模型调用、5 次工具调用和 7 个执行节点。

该 episode 启用了受控恢复合同：第一次准备调用产生 `synthetic_once_only_rejection`，随后同一冻结任务按合同重试并继续。后续链路真实执行 WSL OpenFOAM，发布两个最终工件 `artifact-42403ae7a6234a8a` 与 `artifact-918635f6f9074d44`，完成最终 `validate_delivery`，再交给冻结的隐藏评价器。评价器 digest 为 `ee61af9540a6f628ccf4cc7ac94a5414c638d1e41699c093a6431a55e9e0a606`，结果为 `accepted=true`、`score=1.0`。

| 项目 | 恢复 episode 证据 |
| --- | --- |
| episode | `episode-6ef65a0b81754ce3`；`completed` |
| AgentPackage | `package-9d3eb88382fcfebbff47b1f4`；digest `d6162a2b18c6d8366d82a49dfbded3fba3cde089cbc46101a839725f02398067` |
| 用量 | 0 model calls；5 tool calls；7 nodes |
| 恢复 | `synthetic_once_only_rejection` → retry → completed |
| spec | `2783156865071846129427dc895820f0e530f1b12834860e80ef7e8b4e8d7009` |
| job | `c8400a9d172c4364f4afa875d132dc327f55ca7c87f6f8d9652ab143b7b3a9a5` |
| run | `c44da613aa7d1d06dba6cab415c8ceb4a22211a32dec5cda9f4222a9d62cc63a` |
| OpenFOAM wall time | 16,656 ms |
| command durations | `blockMesh` 4,593 ms；`checkMesh` 5,265 ms；`icoFoam` 6,797 ms |
| 残差日志 | 保留预览中观察 353 行；`residual_scan_complete=false`，不能解释为完整迭代总数 |
| 最终工件 | `artifact-42403ae7a6234a8a`；`artifact-918635f6f9074d44` |
| 隐藏评价 | accepted；score 1.0；evaluator digest `ee61af9540a6f628ccf4cc7ac94a5414c638d1e41699c093a6431a55e9e0a606` |

这条证据证明通用框架实际承载了“固定 AgentPackage → 一次性受控拒绝 → 重试 → 真实求解器 → 工件发布 → 最终校验 → 隐藏评价”的恢复链。受控拒绝是插件定义的合成合同事件，不是一次生产 OpenFOAM 故障；固定包也没有调用模型。它不证明模型自主诊断、模型驱动恢复、跨任务改进或 RSI。

## 失败证据与修复轨迹

开发过程中的失败保留为适配器证据，没有从最终结果中删除：

| 顺序 | 实际失败 | 诊断 | 修复与保留边界 |
| ---: | --- | --- | --- |
| 1 | 最初 WSL 环境探针使用 10 s 上限，抛出 `TimeoutExpired` | 首次启动发行版和加载 OpenFOAM 环境可能超过 10 s；不能把超时解释为安装缺失 | 固定探针上限改为 30 s；仍然有界，超时继续返回不可用原因 |
| 2 | 一版 `wsl ... -- bash` 调用得到五行空输出，触发 Foundation 8 contract mismatch | launcher/参数组合没有按预期执行探针脚本 | 改为固定 `--exec /bin/bash --noprofile --norc -c <constant-script>`；只加载固定 bashrc，不接受任务 shell 文本 |
| 3 | 官方 Foundation 8 `transportProperties` 的 `nu [0 2 -1 0 0 0 0] 0.01;` 被初版正则拒绝，报 `nu_dimensions_or_value_mismatch_for_re10` | 初版解析器误设了 `nu nu [...]` 形态 | 正则兼容实际官方 `nu [...]` 与可接受的命名形式，同时继续核对维度和值 0.01 |
| 4 | 首次真实求解后 mesh cell 解析失败，报 `Bounded logs do not contain mesh cell count and solver time evidence` | Foundation 8 的权威 `cells:` 行来自 `checkMesh`，初版只从 `blockMesh` 取值 | 改为优先解析 `checkMesh`，以 `blockMesh` 为兼容回退；最终收据从 `checkMesh` 得到 400 |

这些失败表明环境可读不等于适配器可执行，也表明测试替身日志不能代替目标版本的真实输出。最终通过发生在上述修复之后；历史失败不能改称成功，最终成功也不应抹去失败原因。

## 未完成工作

- P1 的真实模型 episode 仍等待用户明确授权外部供应商载荷；normal smoke 与固定无模型 `TaskService` 恢复 episode 都不能代替它。
- 受控 `synthetic_once_only_rejection` 已在真实 `TaskService`、真实 WSL 求解器链中观察并恢复；尚未检验模型自主理解或处理未知故障。
- Re=100、20/40/80 网格、时间步敏感性、稳态判据、中心线取样和合法冻结的独立参考仍需单独校准并预注册。
- 本次 wall time 只描述这一台机器和一次 smoke，不是性能 benchmark。
