/**
 * Words of "换个做法再试" (redo the latest task another way, then keep
 * either result). Results only: no mechanics, no settings.
 */
import type { RetrySide } from '@nexgent/sdk'
import { organizationText, usdText } from './strings.js'

/** How a side was organized, in a few words. */
export function sideText(side: RetrySide): string {
  if (side.decision === 'solo') return '一个人做'
  return side.organization === undefined ? '小组' : `小组（${organizationText(side.organization)}）`
}

export const R = {
  offer: (usd: number) => (usd > 0 ? `换个做法再试（约 ${usdText(usd)} 美元）` : '换个做法再试'),
  offerTitle: (side: RetrySide) => `在一份副本里用「${sideText(side)}」重做这个任务，做完你挑一个`,
  running: (side: RetrySide) => `正在用「${sideText(side)}」重做……`,
  stop: '停止',
  stopped: '重做已停止。',
  failed: (detail: string | undefined) => (detail === undefined ? '重做没有完成。' : `重做没有完成：${detail}`),
  original: (side: RetrySide) => `原来的 · ${sideText(side)}`,
  retry: (side: RetrySide) => `新的 · ${sideText(side)}`,
  cost: (usd: number | undefined) => (usd === undefined ? '花费未知' : `约 ${usdText(usd)} 美元`),
  noFiles: '没有改文件',
  moreFiles: (count: number) => `还有 ${count} 个文件`,
  reply: '它的回答',
  changeBadge: { added: '新增', changed: '修改', deleted: '删除' } as const,
  useNew: '用新的',
  keepOriginal: '保留原来的',
  applied: '已换成新的结果。',
  undo: '撤销',
  undoUnavailable: '文件之后又改过，不能撤销了。',
  undone: '已换回原来的结果。',
  dismiss: '知道了',
}
