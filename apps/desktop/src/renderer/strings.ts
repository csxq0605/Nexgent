/**
 * Every user-visible string of the renderer, in one place so the Chinese
 * wording stays consistent. Components import from here instead of writing
 * literals.
 */
import type { ApprovalRequest, CredentialInfo, ErrorInfo, FileChange, GoalStatus, LLMUsage, MemberExecutionForm, TurnEndReason } from '@nexgent/kernel'

export const T = {
  appName: 'Nexgent',
  tagline: '把资料交给它，拿回成果',

  backendUnavailableTitle: '无法连接后端',
  backendUnavailableBody: '界面没有拿到桌面应用主进程的接口。请从 Nexgent 桌面应用启动，或重启应用。',
  crashedTitle: '界面出错了',
  crashedBody: '这一块界面遇到错误，已停止显示。你的会话和文件不受影响。',
  reload: '重新加载',
  dismiss: '关闭',
  shellMissing:
    '没有找到 PowerShell 7（pwsh）。Nexgent 在 Windows 上用它执行所有命令，系统自带的 Windows PowerShell 5.1 不能代替；不装的话，任务里的每条命令都会失败。请安装 PowerShell 7（例如在终端运行 winget install --id Microsoft.PowerShell），然后重启 Nexgent。',
  retry: '重试',
  cancel: '取消',
  save: '保存',
  saved: '已保存',
  close: '关闭',
  loading: '加载中…',

  startTitle: '打开一个项目',
  startHint: '选一个文件夹，Nexgent 就在里面帮你做事：读你给的资料，把成果交回给你。',
  startMore: '用路径打开或新建',
  recentProjects: '最近的项目',
  noRecent: '还没有打开过项目。',
  missingProject: '文件夹已不存在',
  chooseFolder: '打开文件夹',
  folderPathLabel: '项目文件夹的绝对路径',
  folderPathPlaceholder: '例如 /home/me/projects/sales 或 C:\\work\\sales',
  openProject: '打开',
  createProject: '新建并打开',
  forget: '从列表移除',
  pathMustBeAbsolute: '请输入绝对路径。',

  projects: '项目',
  switchProject: '切换项目',
  otherProject: '打开其他项目…',
  conversations: '对话',
  newConversation: '新对话',
  noConversations: '还没有对话。点“新对话”开始。',
  groupToday: '今天',
  groupWeek: '本周',
  groupEarlier: '更早',
  capabilities: '能力',
  needsApproval: '等你批准',
  untitled: '未命名对话',
  rename: '改名',
  renameLabel: '对话名称',
  running: '进行中',
  interrupted: '上次中断',
  settings: '设置',

  emptyConversationTitle: '开始一段对话',
  emptyConversationBody: '告诉 Nexgent 你想要什么结果。要用到文件的话，先点“附件”加进来，输入 @ 可以引用。',
  noSessionTitle: '选择或新建一个对话',
  noSessionBody: '左侧列出了这个项目的全部对话。',

  composerPlaceholder: '描述你想要的结果',
  composerPlaceholderMore: '接着说，或者让它改点什么',
  mentionChip: '@ 资料',
  send: '发送',
  stop: '停止',
  stopping: '正在停止…',
  busy: '正在执行…',
  attach: '附件',
  addMaterial: '加入资料',
  dropHint: '点“加入资料”选择文件，原文件不会被修改。',
  mentionNone: '没有匹配的资料',

  you: '你',
  feedbackLabel: '反馈',
  thinking: '思考过程',
  thinkingLive: '正在思考…',
  interruptedText: '（已中断，以上是已生成的内容）',
  image: '图片',
  toolRunning: '执行中',
  toolFailed: '失败',
  toolDone: '完成',
  toolInput: '输入',
  toolOutput: '输出',
  filesChanged: (n: number) => `改动了 ${n} 个文件`,
  filesOther: (n: number) => `过程中另外改动了 ${n} 个文件`,
  stepsRunning: '正在处理',
  thinkingStep: '思考',
  stepsSummary: (parts: readonly string[], seconds: string | undefined) => `${parts.length === 0 ? '处理了一下' : parts.join('，')}${seconds === undefined ? '' : ` · ${seconds}`}`,
  teamProgress: '小组进度',
  teamDone: (done: number, total: number) => `${done} / ${total} 完成`,
  memberWorking: '正在工作',
  compacted: '较早的对话已压缩为摘要',

  approvalTitle: '需要你的批准',
  approvalWhat: (tool: string) => `要${tool}吗？`,
  approvalCommand: '要执行的内容',
  approvalDetail: '详细说明',
  allowAlways: '总是允许',
  allowScope: '选择范围',
  alwaysSession: '在这段对话里总是允许',
  alwaysProject: '在这个项目里总是允许',
  approvalRiskLine: (risk: string) => `风险：${risk}`,
  approvalRisk: '风险',
  allowOnce: '允许一次',
  allowSession: '本对话内允许',
  allowProject: '本项目内允许',
  deny: '拒绝',
  approvalAllowed: '已允许',
  approvalDenied: '已拒绝',
  approvalPattern: '将保存的匹配规则',

  deliverable: '成果',
  version: (n: number) => `v${n}`,
  versionLong: (n: number) => `第 ${n} 版`,
  cardOpen: '打开',
  cardCompare: '对比上一版',
  cardFeedback: '不满意？告诉 Nexgent',
  fileCount: (n: number) => `${n} 个文件`,
  moreFiles: (n: number) => `还有 ${n} 个`,
  viewDeliverable: '查看',
  giveFeedback: '提出修改',
  reveal: '在文件管理器中显示',
  diffTitle: (from: number, to: number) => `v${from} → v${to} 的变化`,
  noDiff: '两个版本没有差异。',
  binaryFile: '二进制文件，不显示内容',
  preview: '预览',
  changes: '变化',
  fileAdded: '新增',
  fileRemoved: '删除',
  fileModified: '修改',
  fileUnchanged: '未变',
  feedbackTitle: '对这个版本提出修改',
  rating: '评分',
  noRating: '不评分',
  comment: '修改意见',
  commentPlaceholder: '说明哪里要改、改成什么样',
  submitFeedback: '提交并开始修改',

  drawerTitle: '资料与成果',
  drawerClose: '收起',
  thisConversation: '这段对话',
  otherConversations: '这个项目的其他对话',
  panelMaterials: '资料',
  panelDeliverables: '成果',
  panelFiles: '文件',
  panelGoal: '目标',
  panelCapabilities: '能力',
  panelImprovements: '改进',
  noMaterials: '还没有资料。添加的文件会复制到项目里，原文件不会被修改。',
  removeMaterial: '移除',
  addByPath: '按路径添加',
  materialPathPlaceholder: '文件的绝对路径',
  noDeliverables: '还没有成果。Nexgent 完成工作后会把成果交给你。',
  noFiles: '项目文件夹里还没有文件。',
  filesRefresh: '刷新',
  filesTruncated: (limit: number) => `文件太多，只列出前 ${limit} 个。`,
  filesChangedHere: '本对话改动过',
  goalNone: '这个对话还没有目标。',
  goalAdd: '设定目标',
  goalLabel: (text: string) => `目标：${text}`,
  backToChat: '返回对话',
  capabilitiesTitle: '能力',
  capabilitiesLead: 'Nexgent 在这个项目里学会的做法，以及每次改进的结果。',
  settingsLead: '这个项目的模型、权限、费用与改进设置。',
  appearance: '外观',
  appearanceHint: '跟随系统时，系统切到深色，Nexgent 也跟着变深。',
  themeSystem: '跟随系统',
  themeLight: '浅色',
  themeDark: '深色',
  goalPlaceholder: '一句话写下这个对话要达成的目标',
  setGoal: '设定目标',
  goalComplete: '标记完成',
  goalAbandon: '放弃',
  goalReopen: '重新开始',

  settingsTitle: '设置',
  settingsProject: '项目设置',
  model: '模型',
  thinkingMode: '先思考再回答',
  thinkingOn: '开启',
  thinkingOff: '关闭',
  effort: '思考深度',
  sandbox: '沙箱模式',
  sandboxReadOnly: '只读',
  sandboxWorkspace: '可写工作区',
  sandboxFull: '完全访问',
  costCaps: '费用上限',
  perTask: '每个任务',
  perProject: '整个项目',
  maxTokens: '最多 token',
  maxRequests: '最多请求数',
  windowDays: '统计窗口（天）',
  unlimited: '不限',
  apiKey: '模型 API 密钥',
  apiKeyPlaceholder: '粘贴密钥后点保存；保存后不会再显示',
  apiKeySave: '保存密钥',
  apiKeyRemove: '移除本机保存的密钥',
  settingsSaved: '设置已保存',

  memberRunning: '进行中',
  memberCompleted: '完成',
  memberFailed: '失败',
  memberCancelled: '已取消',
  memberBudget: '超出额度',
  memberInterrupted: '已中断',
  memberDeliverables: (n: number) => `成果 ${n}`,
  memberNoDeliverables: '这次没有交出成果。',
  openMember: '看它的过程',
  memberSessionTitle: (name: string) => `成员 ${name} 的会话`,
  memberReadOnly: '只读：成员由主对话安排工作，这里不能发消息。',
  backToConversation: '返回主对话',
  workflow: '工作流',
  workflowPhases: '阶段',
  workflowMembers: (n: number) => `${n} 个成员`,
  teamMessage: '团队消息',
  teamFromTo: (from: string, to: string) => `${from} 发给 ${to}`,
  teamQueued: '待投递',
  teamDelivered: '已投递',
  approvalByMember: (name: string, form: string) => `成员 ${name}（${form}）请求这一操作`,
  finalDeliverables: '最终成果',
  memberDeliverablesTitle: '成员成果',
  byMember: (name: string) => `来自成员 ${name}`,
  memberCount: (n: number) => `${n} 个成员`,

  capabilityCurrent: '当前能力版本',
  capabilityBaseline: '基线（未采用任何能力包）',
  capabilityRevision: (n: number) => `第 ${n} 次变更`,
  capabilityComponents: '组件',
  capabilityNoComponents: '没有组件。',
  capabilityNewSessions: '新开的对话使用这个版本；已有对话保持开始时的版本。',
  capabilityProblem: '能力版本有问题',
  capabilityRollback: '回滚到上一版本',
  capabilityRollbackConfirm: '确认回滚',
  capabilityRollbackReason: '回滚原因（可不填）',
  capabilityCandidates: '候选',
  capabilityNoCandidates: '还没有候选。任务里做出可复用的技能或函数并提交后，会出现在这里。',
  capabilityHistory: '采用记录',
  capabilityNoHistory: '还没有采用或回滚。',
  candidateReason: '原因',
  gateRecord: '门控原始记录（英文）',
  candidateTrial: '门控试验',
  candidateTrialRuns: (n: number) => `${n} 次运行`,
  candidateNoTrial: '还没有门控试验。',
  candidateStartTrial: '开始门控',
  candidateApprove: '审批',
  candidateNeedsApproval: '含插件，需要审批',
  pluginApprovalTitle: '插件包需要你的批准',
  pluginApprovalBody: '这个候选通过了门控，其中含有插件。插件在 Nexgent 应用进程内运行，拥有应用的全部权限，可以读写文件、联网、执行程序。只有在你信任它时才允许。',
  pluginApprovalPackages: '插件',
  pluginApprovalVersion: '能力包哈希',
  pluginApprovalFiles: '文件',
  pluginApprovalDescription: '说明',
  pluginApprovalPermissions: '插件自述的权限',
  pluginApprovalTools: '注册的工具',
  pluginApprovalNoTools: '不注册工具',
  pluginApprovalUnreadable: (names: string) => `读不出 ${names} 的 plugin.json（缺失、被改动或格式不对），无法确认它要做什么，所以不能允许。`,
  candidateApprovalTitle: '候选需要你的批准',
  costApprovalBody: '这个候选的检查结果比基线好，但费用超过了自动采用的上限，所以等你决定是否采用。',
  costApprovalRatio: (ratio: string, limit: string) => `费用约为基线的 ${ratio} 倍（超过 ${limit} 倍不自动采用）`,
  costApprovalUsd: (candidate: string, baseline: string) => `估算费用（含缓存）：候选约 ${candidate}，基线约 ${baseline}`,
  costApprovalTokens: (candidate: string, baseline: string) => `没有美元估算，按 token（输入 + 输出）比较：候选 ${candidate}，基线 ${baseline}`,
  costApprovalQuality: (candidate: string, baseline: string) => `检查通过率：候选 ${candidate}，基线 ${baseline}`,
  costApprovalFeedback: (candidate: string, baseline: string) => `其中反馈检查（单独记）：候选 ${candidate}，基线 ${baseline}`,
  pluginAllow: '允许并采用',
  pluginDeny: '拒绝',
  improvementPending: (pending: number, threshold: number) => `已计入 ${pending} / ${threshold} 条反馈`,
  improvementBudget: (used: string, cap: string, days: number) => `预算 ${used} / ${cap} tokens（${days} 天内）`,
  improvementRun: '立即改进',
  improvementJobs: '改进作业',
  improvementNone: '还没有改进作业。反馈或检查失败累计到阈值，或点“立即改进”后，会出现在这里。',
  improvementCancel: '取消',
  improvementCostUnknown: '费用未知',
  improvementTokens: (n: string) => `${n} tokens`,
  improvementItems: (n: number) => `${n} 条信号`,
  improvementDiagnosis: '诊断',
  improvementHypothesis: '假设',
  improvementProposal: '建议的组件',
  improvementFailures: '失败类型',
  improvementEvidence: (n: number) => `${n} 条证据`,
  improvementCandidate: '候选',
  improvementNoCandidate: '还没有产生候选。',
  improvementGate: '门控结果',
  improvementNoGate: '还没有门控结果。',
  improvementPassRate: (cand: string, base: string) => `检查通过率 候选 ${cand} / 基线 ${base}`,
  improvementFeedbackRate: (cand: string, base: string) => `反馈检查（单独记）候选 ${cand} / 基线 ${base}`,
  improvementReviewer: '审核模型的意见决定了结果（仅在检查持平时）。',
  improvementPhases: '各阶段用量',
  improvementFirstUse: (time: string) => `已被后续任务使用：${time}`,
  improvementRolledBack: (time: string) => `该版本已于 ${time} 回滚。`,
  autoImprove: '自动改进',
  autoImproveHelp: '反馈或检查失败累计到阈值时自动在后台改进；手动“立即改进”不受此开关限制，但受预算限制。',
  improvementBudgetTokens: '改进预算（tokens）',
  improvementWindow: '预算窗口（天）',
  improvementSettingsInvalid: '改进预算和窗口必须是正整数。',
  // Step 6: improver versions and meta jobs.
  improverTitle: '改进器',
  improverCurrent: '当前改进器',
  improverRevision: (n: number) => `第 ${n} 次变更`,
  improverAdopter: '采用它的元改进作业',
  improverProblem: '改进器版本有问题',
  improverHistory: '改进器版本记录',
  improverNoHistory: '还没有换过改进器。',
  improverNewJobs: '新开始的改进作业使用这个版本；已在运行的保持原版本。',
  improverRollback: '回滚改进器',
  improverRollbackConfirm: '确认回滚',
  improverRollbackReason: '回滚原因（可不填）',
  improverAdopt: '采用',
  improverRolledBack: '回滚',
  improverOfJob: (version: string) => `改进器 ${version}`,
  improvementRunMeta: '立即元改进',
  improvementMetaBadge: '元改进',
  improvementMetaChild: (version: string) => `提出的新版本 ${version}`,
  improvementMetaStatus: (enabled: boolean, pending: number, every: number) => `元改进 ${enabled ? '开' : '关'} · 已计入 ${pending} / ${every} 个已结束作业`,
  improvementMetaBudget: (used: string, cap: string, days: number) => `元改进预算 ${used} / ${cap} tokens（${days} 天内）`,
  improvementMetaDiagnosis: '元诊断',
  improvementMetaFindings: '发现',
  improvementMetaNoChange: '无',
  improvementMetaProposalChange: '改进器需要一处修改',
  improvementMetaProposal: '结论',
  improvementMetaFinding: (stage: string, jobs: number) => `${stage} · ${jobs} 个作业`,
  improvementChange: '改进器的修改',
  improvementChangeRationale: '理由',
  improvementChangeBefore: '修改前',
  improvementChangeAfter: '修改后',
  improvementChangeMissing: '（无）',
  improvementChangeUnknown: '（未取得父版本）',
  improvementComparison: '父子对比',
  improvementArmParent: '父（当前）',
  improvementArmChild: '子（提议）',
  improvementArmOffspring: '后代',
  improvementArmNoOffspring: '无后代',
  improvementArmGate: '门控',
  improvementArmGatePass: '通过',
  improvementArmGateFail: '未通过',
  improvementArmGateAwait: '等待审批',
  improvementArmQuality: '质量',
  improvementArmCost: '费用',
  improvementMetaCost: '元改进作业费用',
  improvementDecision: '结论',
  improvementDecisionAdopt: '采用子版本',
  improvementDecisionReject: '不采用',
  settingsMeta: '改进器与元改进',
  settingsMetaScope: '这些设置对所有项目生效（改进器是用户级的，由所有项目共用）。',
  settingsUserSave: '保存元改进设置',
  settingsUserInvalid: '元改进的预算、窗口必须是正整数，触发作业数必须是 1 到 20 的整数。',
  settingsShareTitle: '参与改进器学习',
  shareImproverEvidence: '让这个项目参与改进器学习',
  shareImproverHelp: '关闭后，这个项目的改进作业不计入元改进，也不会被元诊断读取；项目仍使用共用的改进器。',
  improverSharedNote: '改进器由所有项目共用：在这里采用或回滚，会影响每个项目之后开始的改进作业。',
  improverRollbackAffectsAll: '回滚会影响所有项目：之后开始的改进作业都改用回滚后的版本。',
  improverRollbackProjects: '最近使用过当前改进器的项目',
  improverRollbackNoProjects: '还没有项目使用过它。',
  improverScopeUser: '用户级',
  improvementRefused: '回放前已拒绝',
  improvementLiteralsTitle: '候选里含有原题的具体值',
  improvementLiteral: (value: string, path: string, source: string) => `${value} · 文件 ${path} · 来源 ${source}`,
  improvementSimilarRate: (cand: string, base: string) => `同类题通过率：候选 ${cand}，现在 ${base}`,
  approvalOriginalOnlyTitle: '只在原题上验证过',
  approvalOriginalOnlyBody: '项目里没有相似任务，这个候选只在反馈对应的原任务上检查过，没有在同类题上验证，所以等你决定是否采用。',
  metaEnabled: '开启元改进',
  metaEnabledHelp: '每累计若干个已结束的改进作业，自动改进一次“改进器”本身；父子对比通过才会换用。不开启时仍可手动点“立即元改进”。',
  metaEveryJobs: '每多少个作业触发一次',
  metaBudgetTokens: '元改进预算（tokens）',
  metaWindow: '元改进预算窗口（天）',
  metaSettingsInvalid: '元改进的预算、窗口必须是正整数，触发作业数必须是 1 到 20 的整数。',
  deliverableImprove: '改进做法',
  deliverableImproveHint: '让 Nexgent 从这次的问题里学习，改进以后同类任务的做法',
  deliverableImproveStarting: '正在开始改进…',
  deliverableImproveStarted: '已开始一次改进。',
  deliverableImproveShow: '查看进度',
} as const

/** A capability version for people: the baseline in words, a bundle by its short hash. */
export function versionText(version: string): string {
  return version === 'baseline' ? T.capabilityBaseline : version.slice(0, 12)
}

/** A candidate's status in words. */
export function candidateStatusText(status: string): string {
  switch (status) {
    case 'drafted':
      return '草稿'
    case 'proposed':
      return '已提交，等待门控'
    case 'trialing':
      return '门控试验中'
    case 'awaiting-approval':
      return '等待审批'
    case 'adopted':
      return '已采用'
    case 'rejected':
      return '未采用'
    case 'rolled-back':
      return '已回滚'
    default:
      return status
  }
}

/** Why a revision or decision happened, in words. */
export function triggerText(trigger: string): string {
  switch (trigger) {
    case 'gate':
      return '门控通过'
    case 'approval':
      return '审批通过'
    case 'load-failure':
      return '加载失败自动回滚'
    case 'usage-regression':
      return '使用退化自动回滚'
    case 'meta-job':
      return '元改进作业通过'
    case 'manual':
      return '手动'
    default:
      return trigger
  }
}

/** A decision reason in words. */
export function decisionReasonText(reason: string): string {
  const words: Record<string, string> = {
    'quality-up': '检查通过率高于基线',
    'cost-down': '质量持平且更省',
    'review-preferred': '质量持平，审核模型更倾向候选',
    'quality-down': '检查通过率低于基线',
    'guard-regressed': '守护任务退步',
    'cost-over-cap': '成本超过上限',
    'no-improvement': '没有改进',
    'unknown-runs': '有运行结果未知',
    'budget-exhausted': '试验额度用尽',
    interrupted: '试验中断',
    approved: '用户批准',
    'approval-denied': '用户拒绝',
    'load-failure': '加载校验失败',
    'usage-regression': '采用后检查通过率下降',
    'component-errors': '新组件连续出错',
    manual: '手动',
    'similar-regression': '同类题变差：候选在相似任务上通过的检查比现在少，已拒绝',
    'no-similar-cases': '只在原题上验证过：项目里没有相似任务可验证，需要你批准',
    'instance-literal': '回放前已拒绝：候选含有原题的具体数值',
  }
  return words[reason] ?? reason
}

/** A component kind in words. */
export function componentKindText(kind: string): string {
  const words: Record<string, string> = {
    skill: '技能',
    'function-module': '函数模块',
    plugin: '插件',
    'context-policy': '上下文策略',
    preset: '预设',
    'team-template': '团队模板',
    architecture: '工作流图',
  }
  return words[kind] ?? kind
}

/** How a member was started, in words. */
export function memberFormText(form: MemberExecutionForm): string {
  return form === 'delegated' ? '委派' : form === 'team' ? '队友' : '工作流成员'
}

/** A member run's (or workflow's) status in words. */
export function memberStatusText(status: string): string {
  switch (status) {
    case 'running':
      return T.memberRunning
    case 'completed':
      return T.memberCompleted
    case 'failed':
      return T.memberFailed
    case 'cancelled':
      return T.memberCancelled
    case 'budget':
      return T.memberBudget
    case 'interrupted':
      return T.memberInterrupted
    default:
      return status
  }
}

/** Token usage on one line (`?` where unknown); there is no price table, so cost shows as tokens. */
export function usageText(usage: LLMUsage): string {
  const n = (value: number | 'unknown'): string => (value === 'unknown' ? '?' : String(value))
  return `输入 ${n(usage.inputTokens)} / 输出 ${n(usage.outputTokens)} tokens`
}

/** A conversation's display name: its title, else its goal, else the first thing the user said. */
export function sessionTitle(
  session: { readonly title?: string; readonly goal?: { readonly text: string }; readonly firstMessage?: string } | undefined,
  firstMessage?: string,
): string {
  const text = session?.title ?? session?.goal?.text ?? session?.firstMessage ?? firstMessage
  if (text === undefined || text.trim() === '') return T.untitled
  const line = text.trim().split('\n')[0]!
  return line.length > 40 ? `${line.slice(0, 39)}…` : line
}

export function credentialText(info: CredentialInfo | undefined): string {
  if (info === undefined) return '未知'
  if (!info.configured) return '未配置'
  if (info.source === 'env') return '已配置（来源：环境变量）'
  if (info.source === 'file') return '已配置（来源：本机凭证文件）'
  return '已配置'
}

export function riskText(risk: ApprovalRequest['risk']): string {
  return risk === 'high' ? '高' : risk === 'medium' ? '中' : '低'
}

export function goalStatusText(status: GoalStatus): string {
  return status === 'active' ? '进行中' : status === 'completed' ? '已完成' : '已放弃'
}

export function fileChangeText(change: FileChange['change']): string {
  return change === 'added' ? '新增' : change === 'deleted' ? '删除' : '修改'
}

export function turnEndText(reason: TurnEndReason): string | undefined {
  switch (reason.kind) {
    case 'completed':
      return undefined
    case 'cancelled':
      return reason.cause === 'user'
        ? '已停止'
        : reason.cause === 'cost-cap'
          ? '达到费用上限，已停止'
          : reason.cause === 'timeout'
            ? '超时，已停止'
            : '应用关闭，已停止'
    case 'error':
      return `出错结束：${reason.error.message}`
    case 'max-tokens':
      return '回复达到长度上限'
    case 'interrupted':
      return '上次运行被中断（应用曾意外退出）'
  }
}

const ERROR_WORDS: Record<string, string> = {
  'improvement/busy': '已有一个改进作业在运行，请等它结束或先取消。',
  'improvement/budget-exhausted': '改进预算已用尽，调高预算或等窗口过去后再试。',
  'improvement/not-found': '找不到这个改进作业。',
}

export function errorText(error: ErrorInfo): string {
  const words = ERROR_WORDS[error.code]
  return words !== undefined ? `${words}（${error.code}）` : `${error.message}（${error.code}）`
}

export function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / 1024 / 1024).toFixed(1)} MB`
}

export function formatTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${date.getMonth() + 1}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** Absolute path on POSIX or Windows. */
export function isAbsolutePath(value: string): boolean {
  return value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\')
}

/** An improvement job's status in words. */
export function improvementStatusText(status: string): string {
  const words: Record<string, string> = {
    queued: '排队中',
    diagnosing: '诊断中',
    proposing: '提出候选中',
    trialing: '门控试验中',
    'meta-diagnosing': '元诊断中',
    'meta-proposing': '提出改进器修改中',
    comparing: '父子对比中',
    'waiting-history': '等待更多历史任务',
    'awaiting-approval': '等待审批',
    adopted: '已采用',
    rejected: '未采用',
    'no-proposal': '不是能力问题',
    'budget-exhausted': '预算用尽',
    failed: '失败',
    interrupted: '已中断',
    cancelled: '已取消',
  }
  return words[status] ?? status
}

/** Statuses a running or waiting job can be cancelled in. */
export const IMPROVEMENT_CANCELLABLE: readonly string[] = ['queued', 'diagnosing', 'proposing', 'trialing', 'meta-diagnosing', 'meta-proposing', 'comparing', 'waiting-history']

/** What started an improvement job. */
export function improvementTriggerText(trigger: string): string {
  return trigger === 'feedback-count' ? '反馈累计' : trigger === 'explicit' ? '手动' : trigger === 'check-failure' ? '检查失败' : trigger === 'job-count' ? '作业累计' : trigger
}

export function failureCategoryText(category: string): string {
  const words: Record<string, string> = { 'system-design': '系统设计', 'inter-agent-misalignment': '成员间不一致', 'task-verification': '任务验证' }
  return words[category] ?? category
}

export function improvementPhaseText(phase: string): string {
  return phase === 'diagnose' ? '诊断' : phase === 'propose' ? '提出候选' : phase === 'trial' ? '门控试验' : phase === 'meta-diagnose' ? '元诊断' : phase === 'meta-propose' ? '改进器提案' : phase === 'compare' ? '父子对比' : phase
}

/** A gate's cost ratio, candidate over baseline. */
export function costRatioText(ratio: number | 'unknown' | undefined): string {
  return typeof ratio === 'number' ? `费用是基线的 ${ratio.toFixed(2)} 倍` : T.improvementCostUnknown
}

/** The gate's numbers in the UI's words (the decision's own `detail` is an English log line). */
export function verdictText(verdict: { readonly passRate: { readonly candidate: number; readonly baseline: number }; readonly similarPassRate?: { readonly candidate: number; readonly baseline: number }; readonly feedbackPassRate?: { readonly candidate: number; readonly baseline: number }; readonly costRatio: number | 'unknown' }): string {
  const parts = [T.improvementPassRate(percentText(verdict.passRate.candidate), percentText(verdict.passRate.baseline))]
  if (verdict.similarPassRate !== undefined) parts.push(T.improvementSimilarRate(percentText(verdict.similarPassRate.candidate), percentText(verdict.similarPassRate.baseline)))
  if (verdict.feedbackPassRate !== undefined) parts.push(T.improvementFeedbackRate(percentText(verdict.feedbackPassRate.candidate), percentText(verdict.feedbackPassRate.baseline)))
  parts.push(costRatioText(verdict.costRatio))
  return `${parts.join('；')}。`
}

export function percentText(rate: number): string {
  return `${Math.round(rate * 100)}%`
}

export function tokensText(n: number | 'unknown'): string {
  return n === 'unknown' ? '未知' : n.toLocaleString('en-US')
}

/** A short improver version: `v0` stays, a hash shows 12 characters. */
export function improverVersionText(version: string | undefined): string {
  return version === undefined ? 'v0' : version.slice(0, 12)
}

/** Why the comparison of a meta job concluded as it did. */
export function improverReasonText(reason: string): string {
  const words: Record<string, string> = {
    'gate-passed': '子的后代通过门控而父的没有',
    'quality-up': '质量更高',
    'cost-down': '质量相同且费用低 10% 以上',
    'no-improvement': '没有改进',
    'no-offspring': '子没有产出后代',
    'unknown-arm': '有一臂结果未知',
    'origin-mismatch': '两臂起点不一致',
    'epoch-mismatch': '评价纪元不同',
  }
  return words[reason] ?? reason
}

/** A meta-diagnosis finding's stage in words. */
export function metaStageText(stage: string): string {
  const words: Record<string, string> = { diagnose: '诊断', propose: '提出候选', trial: '门控试验', other: '其他' }
  return words[stage] ?? stage
}

/** What a tool call does, as a Chinese verb (ADR 0020: no internal tool names on screen). */
export function toolVerb(name: string): string {
  const words: Record<string, string> = {
    read_file: '读取',
    read_document: '读取',
    read_spreadsheet: '读取表格',
    write_file: '写入',
    write_spreadsheet: '写入表格',
    str_replace: '修改',
    list_files: '查看目录',
    search_text: '搜索',
    bash: '运行命令',
    pwsh: '运行命令',
    run_code: '运行代码',
    present: '交付成果',
    web_fetch: '读取网页',
    load_skill: '读取做法说明',
    delegate: '委派成员',
    spawn_teammate: '安排成员',
    wait_teammates: '等待成员',
    send_message: '给成员留言',
    team_task_create: '建小组任务',
    team_task_list: '查看小组任务',
    team_task_update: '更新小组任务',
    workflow: '按流程安排',
    capability_draft: '起草新做法',
    capability_try: '试用新做法',
    capability_propose: '提交新做法',
  }
  return words[name] ?? '使用工具'
}

/** Counted actions for the folded process line, in the order they first appear: “读了 1 个文件”. */
export function stepsParts(names: readonly string[]): string[] {
  const groups: Array<[string, (n: number) => string]> = []
  const counts = new Map<string, number>()
  const label = (name: string): [string, (n: number) => string] => {
    if (['read_file', 'read_document', 'read_spreadsheet'].includes(name)) return ['read', n => `读了 ${n} 个文件`]
    if (['write_file', 'write_spreadsheet', 'str_replace'].includes(name)) return ['write', n => `写入 ${n} 个文件`]
    if (['bash', 'pwsh'].includes(name)) return ['run', n => `运行了 ${n} 条命令`]
    if (name === 'run_code') return ['code', n => `运行了 ${n} 段代码`]
    if (['list_files', 'search_text'].includes(name)) return ['look', n => `查找了 ${n} 次`]
    if (name === 'web_fetch') return ['web', n => `读了 ${n} 个网页`]
    if (name === 'present') return ['present', () => '交付了成果']
    if (['delegate', 'spawn_teammate'].includes(name)) return ['member', n => `安排了 ${n} 个成员`]
    if (name === 'wait_teammates') return ['wait', () => '等待成员']
    return ['other', n => `用了 ${n} 次其他工具`]
  }
  for (const name of names) {
    const [key, text] = label(name)
    if (!counts.has(key)) groups.push([key, text])
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return groups.map(([key, text]) => text(counts.get(key)!))
}

/** A duration in Chinese: “0.2 秒”, “18 秒”, “2 分 5 秒”; under 0.1 s it says so instead of “0.0”. */
export function durationText(ms: number): string {
  if (ms < 100) return '不到 0.1 秒'
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)} 秒`
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds} 秒`
  return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`
}

/** `claude-sonnet-5-5` → `Claude Sonnet 5.5`; anything else unchanged. */
export function modelText(model: string): string {
  const match = /^claude-([a-z]+)-(\d+)(?:-(\d+))?$/.exec(model)
  if (match === null) return model
  const family = match[1]!.charAt(0).toUpperCase() + match[1]!.slice(1)
  return `Claude ${family} ${match[2]}${match[3] === undefined ? '' : `.${match[3]}`}`
}

/** Which list group a conversation falls in by its last update: 今天, 本周 (the last 7 days), 更早. */
export function sessionGroup(iso: string, now: Date = new Date()): 'today' | 'week' | 'earlier' {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return 'earlier'
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  if (date.getTime() >= startOfDay) return 'today'
  if (date.getTime() >= startOfDay - 6 * 24 * 60 * 60 * 1000) return 'week'
  return 'earlier'
}

/** The upper-case extension shown on a file badge: `XLSX`, `CSV`; `FILE` without one. */
export function fileKind(path: string): string {
  const match = /\.([A-Za-z0-9]{1,5})$/.exec(path)
  return match === null ? 'FILE' : match[1]!.toUpperCase()
}

/** How hard the model thinks, in words: `medium` → 中. */
export function effortText(effort: string): string {
  const words: Record<string, string> = { low: '低', medium: '中', high: '高', xhigh: '很高', max: '最高' }
  return words[effort] ?? effort
}
