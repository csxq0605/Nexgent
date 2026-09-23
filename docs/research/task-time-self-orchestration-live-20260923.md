# 任务时自编排：MiMo v2.6-flash 开发探针

日期：2026-09-23。性质：开发阶段的真实 Provider 探针；这些任务没有隐藏评价器、预注册抽样或跨任务版本晋升。模型凭据只从本机 Nexgent 配置读入内存，没有写入本仓库。

## 系统路径

每个任务均以 `self_orchestration_package()` 的 `architect → slot` 初始图开始。`architect` 的模型响应通过 `proposal_path` 进入通用图操作编译器；宿主检查节点／边、manifest 角色与工具权限、pending 修订和完整图内容摘要，然后由同一 Episode 执行。外部 Provider 实际报告 `mimo-v2.6-flash`。每个任务的硬预算上限为 8 次模型调用、32,000 completion tokens；以下调用数是实际使用量，不是预算。

| 开发尝试 | 规划结果和执行 | 模型调用 | 结果 |
| --- | --- | ---: | --- |
| BFS 与 DFS 比较，初版图提示 | 规划器把节点字段写成 `operator` 而非 `method`，另有非合同形式的边；编译拒绝，计划停在 v1 | 1 | 失败：`Workflow node requests an unregistered capability` |
| BFS 与 DFS 比较，明确图语法后 | 模型生成 `architect → compare(generalist) → verify(verifier) → publish`，删除占位节点；计划升为 v2，发布对象含 `answer` 与 `caveat`，交付 schema 通过 | 3 | 完成，Episode `episode-2d10c8eaf75841eb` |
| 从文本提取不重复星期 | 规划响应是可由普通 JSON 解析的对象，但在一个节点对象中重复使用 `max_tokens` 键；严格模型解析器拒绝，计划停在 v1 | 1 | 失败：`Provider must return one valid JSON object` |
| 计算 19+23 | 模型生成 `architect → solve(generalist) → verify(verifier) → publish`，删除占位节点；计划升为 v2，发布 `answer: 42` 与说明，交付 schema 通过 | 3 | 完成，Episode `episode-2f314d6113c449b5` |

所有成功调用均由 `TaskService` 的模型账本记录，生成图由 `plan_workflow_ref = generated://<digest>` 标识并保存完整私有快照。确定性端到端测试另验证了暂停恢复时规划节点不重放，以及多个节点／边的增删改变真实后续调用。

## 可支持的结论与缺口

这四次尝试支持：模型**可以**在任务时提出图；编译器能将合法提案变成真实执行计划；执行路径不依赖科学发现或 OpenFOAM。两次成功都选用 generalist 加 verifier，尚未显示系统会根据任务特点选择不同团队拓扑。一次语法错误、一次重复键显示可靠性仍不足；前者需要把编译诊断反馈给规划者并允许有界修复，后者需要模型输出失败时有可审计的重新生成策略。两次交付只通过公开 schema，不能推断答案质量提升。

这里没有新技能实现、任务内新角色身份、从失败归因产生的持久版本、后续任务复用、独立 benchmark 改善或递归自改进。不得将这组探针记作正向 RSI 结果。

## 任务中技能创建探针（同日，开发阶段）

在新增 `develop_skill → delegate` 执行路径后，以“写出并执行求和技能，输入为工件 `[11,13,18]`”作为领域无关开发任务，使用相同的 MiMo v2.6-flash 配置。配置只在本机内存中读取；[可复现脚本](../../experiments/orchestration_qualification/live_task_skill_probe.py)不包含凭据。另有一次本机解释器缺少 `openai` 依赖的启动失败，不算 Provider 尝试；改用项目虚拟环境后进行以下尝试。

| 尝试 | 实际模型调用 | 结果 |
| --- | ---: | --- |
| 1 | 4 | 模型创建 `architect → read_numbers → propose_skill → develop_run → delegate_run → verify → publish` 的 v2 图；技能节点把 `python` 错当宿主 RPC，按权限合同拒绝。Episode `episode-11ab68df20b04f36`。 |
| 2 | 2 | 模型创建 v2 图并运行到 `develop_skill`，但提案使用 `schema_version`、`python_source`，把 schema 放到顶层，不符合精确合同。Episode `episode-3b6c64cbbc824316`。 |
| 3 | 2 | 规划器创建 v2 图，生成技能的模型调用在 Provider 响应读取阶段发生连接错误；未执行技能。Episode `episode-064a7042039d4be3`。 |
| 4 | 2 | 规划器创建 v2 图，生成技能的模型调用达到 180 秒墙钟上限，远端结果未知；未执行技能。Episode `episode-2300b89dfa084310`。 |
| 5 | 1 | 规划器创建 v2 图，但给 `ask` 型 coder 节点绑定了网关不接受的顶层 `task` 参数；图编译阶段未识别参数合同，执行时报 `ModelGateway.ask() got an unexpected keyword argument 'task'`。Episode `episode-7129980b48294011`，未执行技能。 |
| 6 | 2 | 加上网关参数编译检查后，规划器创建 v2 图，coder 节点完成；它仍将提案字段写成 `schema_version` 而非 `schema`，`develop_skill` 拒绝 `Task skill proposal has an invalid envelope`。Episode `episode-e12cf4e8017a4389`，未生成子包。 |
| 7 | 3 | 加入有界技能修复后，规划器创建 v2 图，coder 的初版源码含未授权 `import`，`develop_skill` 编译拒绝；同一 Episode 的修复模型调用收到诊断，返回合法完整提案，宿主编译并登记 `package-e262593718f5fbf0b674db89`。随后 `delegate` 因静态 `task.deliverables` 是对象而非非空列表失败，子 Episode 未创建，新技能未执行。Episode `episode-fe1154b1bbec4d4e`。 |
| 8 | 4 | 加入静态委派 TaskSpec 准入后，规划器经一次图编译修复形成 v2 图并执行 coder；`develop_skill` 的初始提案及一次修复均违反提案 envelope，节点以 `TaskSkillRepairExhausted` 失败。未形成新技能或子 Episode。Episode `episode-fe3af09d42d34f5b`。 |

前两次失败使规划提示补上精确提案 envelope、RPC 名称与工件读取方式，但后两次因 Provider 故障没有检验这次修订。第五次暴露了宿主图编译器漏检 `ask` 参数的缺陷；第六次虽通过图编译，却再次暴露技能提案字段错误。第七次第一次观察到**真实模型提出、根据编译诊断修复并成功形成任务专用技能子包**；委派任务合同错误阻止了实际执行。第八次的静态准入已把这类委派错误前移，但本次失败在更早的技能提案 envelope。八次都证明模型可选择技能创建图；**没有一次证明真实模型在父任务中自主执行所创建的技能**。确定性测试的子包加载与 `answer:42` 只证明框架路径可运行。独立验证与新任务复用仍未发生。

为了隔离“模型写出的技能本身是否可执行”，又在同一个开发项目中由宿主手工创建一个受创建者树约束的诊断子 Episode，加载第七次编译的原样子包、提供正确的 `deliverables` 列表和相同输入。子 Episode `episode-9ae147854d014893` 实际运行受控代码并发布 `{"answer":42}`，没有另一次模型生成。这证明该**真实模型修复后的技能代码可运行**；由于父任务的 `delegate` 节点仍失败，它不构成“智能体自主完成委派”、独立任务复用或效果提升证据。

## 非技能任务的团队选择探针

以 API 延迟事故的两种根因假设作为通用分析任务，输入公开的观察和假设，要求模型自行选择最小团队。MiMo v2.6-flash 提出的 v2 图为 `architect → 两个 read_artifact 并行 → investigator → critic → verifier → publish`，使用三个不同的既有角色，没有创建任务专用角色或消息边。两项 `read_artifact` 节点均缺少必需的 `artifact_id` 参数，执行时报 `KeyError`，下游全部跳过；Episode `episode-363450c3f7064bf5`，实际 1 次模型调用，任务失败。这证明模型能提出与先前 generalist/verifier 不同的图形，但本次没有完成节点链，更不能作为多智能体效果证据。需让通用能力参数合同在图编译阶段拒绝并反馈这种错误，避免“合法图、不可执行节点”。

加入通用 capability 参数编译前检查后，用同一类 API 延迟诊断任务重跑了一次任务类型无关的 AgentProgram 探针。MiMo v2.6-flash 提出并实际执行 `architect → 两个并行 read_artifact → investigator → critic → verifier → publish`，7 个有效节点全部完成，5 次模型调用，Episode `episode-de7c84ec8fbc4054`、计划版本 2。交付工件 `artifact-0b8c87f17c014149` 将数据库连接池饱和判断为较有证据支持的解释，并明确部署造成饱和的具体机制尚未证实。输入观察包括数据库等待从 4 ms 增至 610 ms、缓存命中率基本不变、回滚后延迟恢复。这个结果证明**真实模型设计的非固定多角色 DAG 可以被执行并交付**；图没有使用任务新角色、消息边或执行中第二次重编排，亦没有独立评分或与单智能体对照，因此不支持多智能体优势或 RSI 收益结论。
