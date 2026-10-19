/**
 * Every user-visible string of the renderer, in one place so the Chinese
 * wording stays consistent. Components import from here instead of writing
 * literals.
 */
import type { ApprovalRequest, CredentialInfo, ErrorInfo, FileChange, GoalStatus, LLMUsage, MemberExecutionForm, OrganizationName, OrganizationRoleKind, TurnEndReason } from '@nexgent/kernel'

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
  // Redesign 3.1: taking the files back to before a message.
  rewindAction: '撤回之后的文件改动',
  rewindActionTitle: '把这条消息之后 Nexgent 改过的文件，恢复成发这条消息之前的样子',
  rewindTitle: '撤回这条消息之后的文件改动',
  rewindLoading: '正在查看会改动哪些文件…',
  rewindUnavailable: '这一轮太早，没有留下文件快照，无法撤回。',
  rewindNothing: '这些文件已经和当时一样，不用撤回。',
  rewindRestore: (n: number) => `恢复成发消息之前的内容（${n}）`,
  rewindDelete: (n: number) => `删除，因为发消息时还没有（${n}）`,
  rewindUnchanged: (n: number) => `另有 ${n} 个文件已经和当时一样，不会动。`,
  rewindKeep: '对话记录会保留，可以接着聊；别的文件不受影响。',
  rewindConfirm: '撤回',
  rewindRestoredBadge: '恢复',
  rewindDeletedBadge: '删除',
  rewindCancel: '取消',
  rewindDone: (restored: number, deleted: number) =>
    `已撤回文件改动：${[restored > 0 ? `恢复 ${restored} 个` : '', deleted > 0 ? `删除 ${deleted} 个` : ''].filter(Boolean).join('，')}`,
  // Redesign 3.2: an automatic retry after failed checks.
  checkRetry: (attempt: number, max: number) => `检查没通过，自动再改一次（第 ${attempt} 次，最多 ${max} 次）`,
  /** A check's detail in plain words where Nexgent wrote it (exit codes, missing or unreadable files); anything else as it is. */
  checkDetail: (detail: string): string => {
    const exit = /exit code (-?\d+)/.exec(detail)
    if (exit !== null) return `退出码 ${exit[1]}`
    const known: Record<string, string> = { missing: '找不到文件', unreadable: '读不了', 'invalid JSON': '不是有效的 JSON', 'not UTF-8 text': '不是 UTF-8 文本', 'not an xlsx workbook': '不是 Excel 工作簿', 'no recorded run': '没有运行记录' }
    return known[detail] ?? detail
  },
  checkFailed: {
    'test-command': (target: string) => `测试命令 ${target} 没通过`,
    'check-command': (target: string) => `检查命令 ${target} 没通过`,
    parses: (target: string, format: string) => `${target} 不能按 ${format} 读取`,
    exists: (target: string) => `${target} 不存在`,
  },
  filesOther: (n: number) => `过程中另外改动了 ${n} 个文件`,
  stepsRunning: '正在处理',
  thinkingStep: '思考',
  stepsSummary: (parts: readonly string[], seconds: string | undefined) => `${parts.length === 0 ? '处理了一下' : parts.join('，')}${seconds === undefined ? '' : ` · ${seconds}`}`,
  teamProgress: '小组进度',
  teamDone: (done: number, total: number) => `${done} / ${total} 完成`,
  reorganized: (reason: string) => `改了分工：${reason}`,
  memberWorking: '正在工作',
  compacted: '较早的对话已压缩为摘要',
  turnCost: (usd: string, partial: boolean) => (partial ? `本轮至少 ${usd} 美元（有的请求没有用量）` : `本轮 ${usd} 美元`),
  turnCostTitle: '按模型价目表估算，含缓存读写',
  planTitle: '计划',
  planProgress: (done: number, total: number) => `${done} / ${total} 完成`,
  todoPending: '未开始',
  todoActive: '进行中',
  todoDone: '已完成',
  planStart: '以计划模式开始',
  planStartHelp: '先只看不改，给出计划；你批准后才动文件',
  keyTitle: '还没有模型 API 密钥',
  keyBody: 'Nexgent 用 Anthropic 的 API 密钥调用模型，没有密钥就没法开始任务。在 Anthropic 控制台创建一个，粘贴到这里。',
  keyEnvHint: '也可以设置环境变量 NEXGENT_API_KEY，然后重启 Nexgent。',
  keyInput: '粘贴 API 密钥',
  keySaved: '密钥已保存，可以开始了。',
  costWarnTitle: (scope: string) => `${scope}的费用快到上限了`,
  costReachedTitle: (scope: string) => `${scope}的费用到上限了`,
  costWarnBody: (used: string, cap: string) => `已用 ${used}，上限 ${cap}。到上限时会停下正在做的任务。`,
  costReachedBody: (scope: string, used: string, cap: string) =>
    `已用 ${used}，上限 ${cap}。${scope === 'perTask' ? '当前任务已停下，发下一条消息会重新算。' : scope === 'perConversation' ? '这段对话不会再开始新任务，可以调高上限或新建对话。' : '这个项目不会再开始新任务，可以在设置里调高或清空上限。'}`,
  costEstimated: '其中有估算。',
  costAdjust: '调整上限',
  costScope: { perTask: '这个任务', perConversation: '这段对话', perProject: '这个项目' } as Record<string, string>,

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
  previewUnavailable: '这个文件不能在这里预览，点上面的“在文件管理器中显示”用其他程序打开。',
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
  planMode: '计划模式',
  planModeHelp: '先只读查看并给出计划，你批准后才会改动文件',
  noOsSandbox: '命令未进系统沙箱',
  osSandboxOff: '系统沙箱已关闭',
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
  memberStuck: '卡住',
  memberStuckOn: (blocker: string) => `卡在：${blocker}`,
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

/** A role of an organization, in words (new direction step 2). */
export function roleKindText(kind: OrganizationRoleKind): string {
  return { plan: '规划', explore: '调查', implement: '实现', test: '测试', review: '审查' }[kind]
}

/** An organization, in words. */
export function organizationText(name: OrganizationName): string {
  return { 'lead-checker': '主做加检查', 'plan-build-review': '规划、并行实现、审查', 'explore-then-build': '先调查再实现', custom: '自定分工' }[name]
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
          : reason.cause === 'step-limit'
            ? '本轮模型调用次数到上限了，工作还没丢；发一句“继续”就接着做'
            : reason.cause === 'timeout'
              ? '超时，已停止'
              : reason.cause === 'parent'
                ? '上级任务已结束，已停止'
                : '应用关闭，已停止'
    case 'error':
      return `出错结束：${ERROR_WORDS[reason.error.code] ?? reason.error.message}`
    case 'max-tokens':
      return '回复多次超出单次输出长度上限，已停止；可以让它分小块继续'
    case 'interrupted':
      return '上次运行被中断（应用曾意外退出）'
  }
}

const ERROR_WORDS: Record<string, string> = {
  'improvement/busy': '已有一个改进作业在运行，请等它结束或先取消。',
  'improvement/budget-exhausted': '改进预算已用尽，调高预算或等窗口过去后再试。',
  'improvement/not-found': '找不到这个改进作业。',
  'credentials/missing': '还没有模型 API 密钥。在对话下方或 设置 → 高级 里粘贴密钥，或设置环境变量 NEXGENT_API_KEY 后重启。',
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
    todo_write: '更新计划',
    exit_plan: '提交计划',
    shell_output: '查看命令输出',
    shell_kill: '停止命令',
    handbook_mark: '标记经验',
  }
  return words[name] ?? '使用工具'
}

/** Counted actions for the folded process line, in the order they first appear: “读了 1 个文件”. */
export function stepsParts(names: readonly string[]): string[] {
  const groups: Array<[string, (n: number) => string]> = []
  const counts = new Map<string, number>()
  const label = (name: string): [string, (n: number) => string] => {
    if (['read_file', 'read_document', 'read_spreadsheet'].includes(name)) return ['read', n => `读了 ${n} 个文件`]
    if (['write_file', 'write_spreadsheet', 'str_replace'].includes(name)) return ['write', n => `编辑了 ${n} 个文件`]
    if (name === 'todo_write') return ['plan', () => '更新了计划']
    if (name === 'exit_plan') return ['exit-plan', () => '提交了计划']
    if (name === 'shell_output') return ['shell-output', n => `查看了 ${n} 次命令输出`]
    if (name === 'shell_kill') return ['shell-kill', n => `停止了 ${n} 条命令`]
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

// ---------------------------------------------------------------------------
// Rework D2: the 能力 and 设置 pages in plain words (ui-redesign-research §4.4).
// Nothing here says 门控、候选、基线、改进器 or 元改进 (a test checks).
// ---------------------------------------------------------------------------

export const L = {
  sectionLearned: '经验',
  sectionPractices: '做法与版本',
  sectionHistory: '改进记录',
  leadNone: '做完任务后，Nexgent 会自己检查结果、总结经验；学到的会出现在这里。',
  lead: (active: number, trial: number, rules: number, last: string | undefined) =>
    `Nexgent 在这个项目里用着 ${active} 条经验${rules > 0 ? `、${rules} 条项目规则` : ''}${trial > 0 ? `，另有 ${trial} 条在试用` : ''}${last === undefined ? '' : `，最近一次改进在 ${last}`}。`,
  effect: (points: number) => (points === 0 ? '用上经验的任务和没用上的结果差不多。' : `用上经验的任务，结果${points > 0 ? '好' : '差'} ${Math.abs(points)} 分（满分 100）。`),
  noneActive: '还没有正式用上的经验，试用中的在“改进记录”里。',
  attentionTitle: '等你看一眼',
  recordTitle: '改进记录',
  recordTrial: '试用中和停用的经验',
  recordLearning: '学习开关与费用',
  recordVersions: '做法与版本',
  recordJobs: '一次次改进',
  decideTitle: '等你决定',
  decideRow: (name: string) => `新做法「${name}」测试下来更好，要你同意才会启用`,
  decideWhy: '它会给 Nexgent 加上新的能力（插件），所以先问你。',
  decideOpen: '查看',
  learningTitle: '自己学习',
  learningSwitch: '每次任务后自己学习',
  learningSwitchHelp: '做完任务后给结果打分、总结经验，下次做类似的事时用上。',
  learningOff: '已关闭：不再打分，也不再总结新经验；已经学到的照常使用。',
  learningWaiting: '还没开始：确认一次学习说明后才会花钱学习。',
  learningAcknowledge: '知道了，开始学习',
  learningAdjust: '调整预算和共享',
  spend: (spent: string, max: string, days: number) => `近 ${days} 天学习花了 ${spent} 美元，预算 ${max} 美元`,
  spendEstimated: '（含估算）',
  spendLeft: (left: string) => `还剩 ${left} 美元`,
  phases: { 'self-eval': '给结果打分', calibrate: '抽查打分', reflect: '总结经验', curate: '整理经验' } as Record<string, string>,
  selfEvaluations: (n: number) => (n === 0 ? '还没有给任务打过分' : `给 ${n} 个任务打了分`),
  reliability: {
    insufficient: (sampled: number) => `打分抽查了 ${sampled} 次，还不到 10 次：经验照常试用，新技能先等你批准。`,
    reliable: (rate: string) => `抽查时和外部评审一致 ${rate}，打分可信。`,
    unreliable: (rate: string) => `抽查时和外部评审只一致 ${rate}（低于 80%）：新技能要等你批准。`,
  },
  // ADR 0024: rules the user stated for this project.
  rulesTitle: '项目规则',
  pendingRulesTitle: '这些话要当成项目规则吗？',
  pendingRulesHelp: '从你的话里看不出是不是以后都要这样。确认后每次任务都会遵守。',
  ruleMeta: (appliesTo: string | undefined, date: string) => `适用于：${appliesTo ?? '整个项目'} · ${date} 记下`,
  confirmRule: '确认',
  rejectRule: '不要',
  activeTitle: '已学会',
  trialTitle: '试用中',
  retiredTitle: (n: number) => `已停用（${n}）`,
  empty: '还没有学到经验。每条新经验先试用，帮上忙两次后正式启用；带偏了就自动停用。',
  scopeUser: '所有项目共用',
  scopeProject: '只用于这个项目',
  helpful: (n: number) => `帮上忙 ${n} 次`,
  harmful: (n: number) => `带偏 ${n} 次`,
  untilActive: (n: number) => `再帮上忙 ${n} 次就正式启用`,
  sinceDate: (date: string) => `${date} 学到`,
  stop: '停用',
  restore: '恢复',
  // Redesign UI 1: give/withhold evidence and last use (outcome means are 0–1, shown on a 100-point scale).
  trials: (shown: number, heldBack: number) => (shown === 0 && heldBack === 0 ? '还没有对照记录' : `给过 ${shown} 次，没给 ${heldBack} 次`),
  trialGap: (points: number) => (points === 0 ? '两组结局一样' : `给了的结局${points > 0 ? '好' : '差'} ${Math.abs(points)} 分（满分 100）`),
  lastUsed: (when: string | undefined) => (when === undefined ? '还没用到过' : `最近一次用到：${when}`),
  historyTitle: '经过',
  keywords: '适用于',
  sources: (n: number) => `从 ${n} 个任务里学到`,
  op: {
    add: '学到这条经验',
    edit: '改写了内容',
    upvote: '一次任务里帮上了忙',
    downvote: '一次任务里带偏了',
    trial: '回到试用',
    active: '正式启用',
    retired: '停用',
  } as Record<string, string>,
  byUser: '你',
  noticeTitle: 'Nexgent 会在后台学习',
  noticeBody: (max: string, days: number) =>
    `每次任务结束后，Nexgent 会给结果打分、总结经验，下次做类似的事时用上。每个项目每 ${days} 天最多花 ${max} 美元；在 设置 → 自动改进 里可以关掉或改预算。`,
  noticeOk: '知道了',
  noticeSettings: '去设置',
  // settings
  settingsLead: '改动会立即保存。',
  saving: '正在保存…',
  saved: '已保存',
  groups: { general: '通用', model: '模型', permissions: '权限', checks: '完成检查', cost: '费用', learning: '自动改进', advanced: '高级' } as Record<string, string>,
  groupHelp: {
    general: '外观和语言，对所有项目生效。',
    model: '这个项目用哪个模型、想多深。',
    permissions: 'Nexgent 能动这个项目里的哪些文件。',
    checks: '每轮做完后怎么确认真的做好了；没做好时让 Nexgent 接着改。',
    cost: '超过上限时停下当前任务。按美元算，空着就是不限。',
    learning: '做完任务后自己总结经验，花费单独记、有上限。',
    advanced: '密钥、数据位置和以前的改进方式。',
  } as Record<string, string>,
  // Redesign 3.2: checks at the end of a turn.
  checkRetries: '没通过时自动再改',
  checkRetriesHelp: '测试没过、交付的文件打不开，或下面的检查命令失败时，Nexgent 在同一轮里接着改，最多这么多次。',
  checkRetriesOption: (n: number) => (n === 0 ? '不自动改' : `最多 ${n} 次${n === 2 ? '（默认）' : ''}`),
  checkCommands: '检查命令',
  checkCommandsHelp: (max: number) => `这一轮改过文件后，在项目文件夹里依次运行；有一条失败就算没做好。每行一条，最多 ${max} 条，空着就不运行。`,
  checkCommandsPlaceholder: '例如：npm test',
  checkCommandsTooMany: (max: number) => `最多 ${max} 条命令`,
  checkCommandsTooLong: (max: number) => `每条命令最多 ${max} 个字符`,
  language: '语言',
  languageHelp: 'Nexgent 写给你的经验和说明用这种语言。界面目前只有中文。',
  languageAuto: '跟每个任务一致',
  model: '模型',
  modelHelp: '执行任务用的模型。',
  thinking: '先思考再回答',
  thinkingHelp: '复杂任务更稳，但更慢、更贵。',
  effort: '思考深度',
  effortHelp: '想得越深越慢、越贵。',
  sandbox: '文件权限',
  sandboxHelp: '只读时 Nexgent 只能看；可写时只能改这个项目里的文件。',
  perTask: '每个任务',
  perTaskHelp: '一次任务（含它分出去的成员）最多花多少。',
  perConversation: '每段对话',
  perConversationHelp: '一段对话所有轮次加起来最多花多少。',
  perProject: '整个项目',
  perProjectHelp: (days: number) => `这个项目 ${days} 天内最多花多少。`,
  usd: '美元',
  unlimited: '不限',
  windowDays: '天数',
  usageCaps: '也可以按用量限制（tokens、请求次数），一般不用填。',
  maxTokens: '最多 tokens',
  maxRequests: '最多请求次数',
  learningBudget: '学习预算',
  learningBudgetHelp: (days: number) => `每个项目 ${days} 天内学习最多花多少，打分也算在里面。`,
  useShared: '用其他项目学到的经验',
  useSharedHelp: '关掉后，这个项目只用自己学到的。',
  contribute: '把这里学到的经验分享给其他项目',
  contributeHelp: '关掉后，这里学到的只留在这个项目。',
  apiKey: '模型 API 密钥',
  apiKeyHelp: '保存在本机，保存后不再显示。',
  dataDir: '数据位置',
  dataDirHelp: '这个项目的对话记录、资料副本、成果和学到的经验都存在这里，不在项目文件夹里。',
  legacyTitle: '以前的改进方式',
  legacyHelp: '只对以前留下的改进记录和手动“改进做法”有效；平时的学习看“自动改进”。',
  legacyBudget: '改进预算（tokens）',
  legacyWindow: '统计天数',
  shareEvidence: '让改进方式参考这个项目的改进记录',
  shareEvidenceHelp: '改进方式由所有项目共用；关掉后它不再读这个项目的记录。',
  metaTitle: '改进方式也自己学习',
  metaHelp: '对所有项目生效：积累几次改进后，Nexgent 试着改进“怎么改进”。默认关闭。',
  metaEnabled: '开启',
  metaEvery: '每几次改进学一次',
  metaBudget: '预算（tokens）',
  metaWindow: '统计天数',
  invalidNumber: '请填正数，或留空表示不限。',
  invalidInteger: '请填正整数。',
  invalidModel: '模型不能为空。',
  invalidEvery: '请填 1 到 20 的整数。',
}

/** Rework D3: a turn's dollars, “不到 0.01” for tiny amounts. */
export function turnUsdText(usd: number): string {
  return usd > 0 && usd < 0.01 ? '不到 0.01' : usdText(usd)
}

/** Rework D3: a cost cap's amount in its own unit. */
export function capAmountText(limit: 'maxUsd' | 'maxTokens' | 'maxRequests', value: number): string {
  if (limit === 'maxUsd') return `${usdText(value)} 美元`
  return limit === 'maxTokens' ? `${Math.round(value).toLocaleString('en-US')} tokens` : `${Math.round(value)} 次请求`
}

/** Dollars for the 能力 and 设置 pages: two decimals below 10, else one. */
export function usdText(usd: number): string {
  return usd < 10 ? usd.toFixed(2) : usd.toFixed(1)
}

/** A percentage of a rate in [0, 1]. */
export function rateText(rate: number | undefined): string {
  return rate === undefined ? '—' : `${Math.round(rate * 100)}%`
}

/** How long ago, as people say it: 刚才 / 5 分钟前 / 3 小时前 / 2 天前, then the day. */
export function agoText(iso: string, now: number = Date.now()): string {
  const at = Date.parse(iso)
  if (Number.isNaN(at)) return iso
  const minutes = Math.floor((now - at) / 60_000)
  if (minutes < 1) return '刚才'
  if (minutes < 60) return `${minutes} 分钟前`
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)} 小时前`
  if (minutes < 30 * 24 * 60) return `${Math.floor(minutes / (24 * 60))} 天前`
  return dayText(iso)
}

/** A day as people say it: 10 月 16 日. */
export function dayText(iso: string): string {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? iso : `${date.getMonth() + 1} 月 ${date.getDate()} 日`
}
