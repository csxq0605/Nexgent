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
  retry: '重试',
  cancel: '取消',
  save: '保存',
  saved: '已保存',
  close: '关闭',
  loading: '加载中…',

  startTitle: '打开一个项目',
  startHint: '项目是你电脑上的一个文件夹，Nexgent 在里面工作，资料和成果都保存在它的 .nexgent 目录下。',
  recentProjects: '最近的项目',
  noRecent: '还没有打开过项目。',
  missingProject: '文件夹已不存在',
  chooseFolder: '选择文件夹…',
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
  untitled: '未命名对话',
  rename: '改名',
  renameLabel: '对话名称',
  running: '进行中',
  interrupted: '上次中断',
  settings: '设置',

  emptyConversationTitle: '开始一段对话',
  emptyConversationBody: '先在右侧添加资料，然后告诉 Nexgent 你要什么成果。输入 @ 可以引用资料。',
  noSessionTitle: '选择或新建一个对话',
  noSessionBody: '左侧列出了这个项目的全部对话。',

  composerPlaceholder: '描述你要的成果，输入 @ 引用资料（Enter 发送，Shift+Enter 换行）',
  send: '发送',
  stop: '停止',
  stopping: '正在停止…',
  busy: '正在执行…',
  attach: '添加资料',
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
  filesChanged: '本轮改动的文件',
  compacted: '较早的对话已压缩为摘要',

  approvalTitle: '需要你的批准',
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
  goalPlaceholder: '一句话写下这个对话要达成的目标',
  setGoal: '设定目标',
  goalComplete: '标记完成',
  goalAbandon: '放弃',
  goalReopen: '重新开始',

  settingsTitle: '设置',
  settingsProject: '项目设置',
  model: '模型',
  thinkingMode: '思考（thinking）',
  thinkingOn: '开启',
  thinkingOff: '关闭',
  effort: '推理强度（effort）',
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
  openMember: '查看成员会话',
  memberSessionTitle: (name: string) => `成员 ${name} 的会话`,
  memberReadOnly: '只读：成员由主对话安排工作，这里不能发消息。',
  backToConversation: '← 返回主对话',
  workflow: '工作流',
  workflowPhases: '阶段',
  workflowMembers: (n: number) => `${n} 个成员`,
  teamMessage: '团队消息',
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
  deliverableImprove: '改进',
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
export function sessionTitle(session: { readonly title?: string; readonly goal?: { readonly text: string } } | undefined, firstMessage?: string): string {
  const text = session?.title ?? session?.goal?.text ?? firstMessage
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
export const IMPROVEMENT_CANCELLABLE: readonly string[] = ['queued', 'diagnosing', 'proposing', 'trialing', 'waiting-history']

/** What started an improvement job. */
export function improvementTriggerText(trigger: string): string {
  return trigger === 'feedback-count' ? '反馈累计' : trigger === 'explicit' ? '手动' : trigger === 'check-failure' ? '检查失败' : trigger
}

export function failureCategoryText(category: string): string {
  const words: Record<string, string> = { 'system-design': '系统设计', 'inter-agent-misalignment': '成员间不一致', 'task-verification': '任务验证' }
  return words[category] ?? category
}

export function improvementPhaseText(phase: string): string {
  return phase === 'diagnose' ? '诊断' : phase === 'propose' ? '提出候选' : phase === 'trial' ? '门控试验' : phase
}

export function percentText(rate: number): string {
  return `${Math.round(rate * 100)}%`
}

export function tokensText(n: number | 'unknown'): string {
  return n === 'unknown' ? '未知' : n.toLocaleString('en-US')
}
