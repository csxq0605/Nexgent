# ADR 0008：改进器版本、元改进作业、父子比较与评价器纪元

- **状态**：已接受
- **日期**：2026-10-13
- **依据**：用户 2026-10-13 15:15 对步骤 6 分工表（`docs/plan/step-6-work-partition.md`，PR #123）“已定的决定”8 项回复“按推荐”；本 ADR 定下第 1–5 项落到格式与规则上的细节，第 6–8 项（测量规模、报告口径、模型与预算）属于实验，见分工表。
- **替代**：无。ADR 0006（改进作业）、ADR 0007（门控费用规则）全部仍然有效；本 ADR 在它们之上加一层。

## 背景

步骤 5 的改进作业按写死在 `@nexgent/evolve` 里的文字诊断、按写死的简报提案，门控参数取项目配置。计划 4.6 要求改进流程本身也能被改进（递归改进），而且新版本必须实际承担一次改进作业、产出后代候选，才能和旧版本比较。

这样做有一个风险：如果“改进流程”能改“怎样判定变好”，它可以靠放松考题来变好。所以要先把能改的部分（改进器）和判定的部分（评价器）分开，再规定怎样比较两个改进器。

## 决策

1. **改进器是有版本的数据，项目级、单独一条版本线。**
   - 改进器（`ImproverBundle`）有三部分，全是数据：诊断策略（诊断会话 `# Policy` 下的段落）、提案算子（允许的组件种类与顺序、每种的简报模板）、比较参数（`selectionCases` 2–4、`repeats` 2–3、`selection` 为 `similarity` 或 `recency`）。占位符写作 `{{name}}`，只有固定的几个。
   - 版本号是规范化清单的 SHA-256；内置的 `v0` 是步骤 5 的原文与参数，版本号是字面量 `v0`，不存文件。测试固定 `v0` 渲染出的文字与步骤 5 代码逐字相等，所以没有采用过别的改进器的项目，行为与步骤 5 完全相同。
   - 存放在 `.nexgent/improvers/`：`bundles/<version>.json`（只写一次）与 `activation/<n>.json`（摘要链，写法与能力包的采用历史相同）。它与能力包分开采用、分开回滚。
   - 每个作业开始时固定一个改进器版本，写进 `job.json` 与账本（`improverVersion`），作业中途采用新改进器不影响它。
2. **改进器能改什么。**
   - 元改进作业一次只提一个类型化改动（`ImproverChange`）：改写或追加一段诊断策略、改允许的组件种类与顺序、改一种组件的简报模板、在上下限内改一个比较参数。没有自由代码，插件永远不能被列为可提种类。
   - 项目配置的 `capabilities.selectionCases`、`repeats` 仍是下限：作业实际取它与改进器值中较大的一个。改进器只能要求更多证据，不能更少。
   - 改动的名字是评价器字段、超出上下限、多于一个改动、改完不合法或与父相同，都拒绝（`checkImproverChange`）。
3. **元改进作业。**
   - 它是 `kind: "meta"` 的改进作业，与能力作业共用“同一项目同时只有一个作业”的作业位。状态：`queued → meta-diagnosing → meta-proposing → comparing → adopted | rejected`，元诊断认为没问题时 `no-proposal`。分工表写的“触发加 `meta`”落成 `kind` 字段：触发仍说明“为什么开始”，元改进作业的触发是 `job-count`（自动）或 `explicit`（手动）。
   - 计数：每个结束于 `adopted`、`rejected`、`no-proposal`、`failed` 的能力作业计 1 个；`cancelled`、`interrupted`、`budget-exhausted`、元改进作业本身与比较臂不计。计入的作业 id 记在队列的 `metaCounted` / `metaPending`，重启不重计。
   - 默认关（`improvement.meta.enabled: false`）；打开后每 3 个（`everyJobs`，1–20）开始一次。手动触发不看开关与计数。
   - 单独的元改进预算 `improvement.meta.budget`，默认每 30 天 600 万计费 token（约 6 美元），计法同改进预算；能力改进预算不再包含元改进的费用。`improvement.meta` 是受保护的配置字段，写入要审批。
   - 元诊断与元提案会话只有只读的 `improve_*` 工具，最多各交 3 次。
4. **父子比较与采用规则。**
   - 起点：元改进作业开始前最近一个结束的、由反馈触发的能力作业，取它的反馈任务快照、反馈 id、开始时的能力版本与当前纪元。宿主把起点复制成两份项目副本，父、子改进器各在一份里跑一次完整作业（诊断、提议、门控），门控只在副本里采用，后代不带回真实项目。
   - 纯函数 `decideImprover` 按顺序判断：
     1. 两臂纪元与起点不一致：不采用（`epoch-mismatch`）；起点其余部分不一致：不采用（`origin-mismatch`）。
     2. 任一臂未知：不采用（`unknown-arm`）。未知指作业没到终态、被中断、取消、预算用尽，因自身诊断不合格之外的错误失败，门控结论为 `unknown-runs` / `budget-exhausted`，或费用未知。
     3. 子没有产出后代：不采用（`no-offspring`），父也没有时同样不采用。
     4. 子的后代通过门控而父的没有：采用（`gate-passed`）。
     5. 两者都通过门控，且子的门控质量（候选通过率）更高：采用（`quality-up`）；质量相同且子的作业总费用（诊断 + 提议 + 门控，估算美元）不超过父的 0.9 倍：采用（`cost-down`）。
     6. 其余不采用（`no-improvement`）。
   - **两处原文没写明的地方，这里定下：**
     - “质量更高”和“质量相同且省 10% 以上”**只在父、子两边的后代都通过门控时才适用**。只有父通过时子更差，不采用；两边都没通过时，门控测得的质量不代表能被采用的能力，也不采用，即使子更便宜。
     - 费用**正好低 10% 算子更好**：判定写作 `子费用 ≤ 父费用 × 0.9`，用乘积比较，比值的舍入不会影响结论。父费用为 0 时不按费用采用。
   - 每次元改进只比一组（一个起点）。
   - 采用时宿主写一条改进器采用修订（`trigger: "meta-job"`），子改进器从下一个真实改进作业起生效；不弹审批。用户可以随时回滚到任一更早的版本，包括 `v0`。
   - 比较副本默认在结论写出后删除；实验可以经 SDK 选项 `keepCopies` 保留，用来在副本里跑 holdout。
5. **评价器不属于改进器，按纪元冻结。**
   - 评价器指采用规则（`decideTrial`、门控评审与反馈检查的提示、`decideImprover`，合起来记为规则 id `adr-0008`），以及 `capabilities.costRatioCap`、`costApprovalRatio`、`guardCases`、`reviewer`。改进预算、`autoImprove` 与元改进开关也不是改进器的一部分，但它们不决定“好不好”，所以不进纪元。
   - 纪元 id 是上述评价器设置规范化文本的 SHA-256。只有用户改了其中一项，或新的 ADR 换了规则 id，才进入新纪元；本步不自动更新评价器。
   - 门控把纪元写进 `TrialPlan.epoch`；父子比较两臂纪元不同即不比较；报告只汇总同一纪元的数据。改进器、元改进作业和模型都写不到评价器（`capabilities`、`improvement` 已在 `GUARDED_PROJECT_CONFIG_FIELDS` 里）。
6. **记录。**
   - 账本：每条改进相关记录带 `improverVersion`；新阶段 `meta-diagnose`、`meta-propose`；比较臂的记录以臂作业 id 为 `improvementId`、以臂作业自己的阶段为 `improvementPhase`，另带 `metaJobId` 与 `comparisonArm`。分工表写的 `improvementPhase: compare` 改为只作为作业 `phases` 的汇总键：臂里的一条请求属于诊断、提议还是门控，比“它属于比较”更有用，而元改进的费用仍可以按 `metaJobId` 整体查到。
   - `improvement.end` 加 `kind`、`childVersion` 与新阶段键。会话 `session.start.improvement` 加 `improverVersion`、`metaJobId`、`comparisonArm`。
   - 新文件：元改进作业目录下的 `meta-diagnosis.json`、`change.json`、`comparison.json`。
   - 全部在各自的 v1 格式内追加；步骤 5 的数据照常读出（缺 `improverVersion` 读作 `v0`，缺 `kind` 读作能力作业）。
   - 错误码：`improvement/epoch-mismatch`、`improver/not-found`、`improver/invalid`、`improver/invalid-change`、`improver/activation`。
7. **SDK API 6。**
   - 新方法 `improvements.runMeta`（可带 `keepCopies`）、`improvers.list`、`improvers.show`、`improvers.rollback`，以及项目级事件 `improver.version`。
   - 作业视图补上 `feedbackIds`、各阶段时间（`phaseTimes`）、`kind`、`improverVersion`、`meta`；列表补上 `autoImprove`（步骤 5 遗留的 SDK 缺口）。
   - 桌面 IPC 白名单同步。新方法在 W2、W5 接通之前以 `internal` 错误拒绝（“not available yet”）。

## 后果

- 递归改进有了边界：改进器只能改文字和有上下限的参数，判定“好不好”的规则与设置只有用户能改。代价是改进器能做的事有限，例如它不能学会更好的评审提示。这是有意的：那样改需要新的纪元，本步不做。
- 一次元改进约等于两个普通改进作业加一次元诊断与元提案。默认关、单独预算，普通改进不会被挤掉。
- 只比一组意味着结论有偶然性：一次比较里子改进器胜出，不能证明它在别的反馈上也更好。是否有收益交给步骤 6 的测量（三臂、holdout、置信区间）回答。
- 两边都没通过门控时不按质量或费用采用，可能错过“子虽然也没通过、但明显更接近”的情况。宁可少采用，也不让没通过门控的结果改变改进器。
- `v0` 与步骤 5 的文字逐字相等由测试固定，`@nexgent/evolve` 改用改进器数据之后，这项测试改为直接比较两者的渲染结果。
