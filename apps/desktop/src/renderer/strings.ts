/**
 * Every user-visible string of the renderer, in one place so the Chinese
 * wording stays consistent. Components import from here instead of writing
 * literals.
 */
import type { ApprovalRequest, CredentialInfo, ErrorInfo, FileChange, GoalStatus, TurnEndReason } from '@nexgent/kernel'

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
} as const

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

export function errorText(error: ErrorInfo): string {
  return `${error.message}（${error.code}）`
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
