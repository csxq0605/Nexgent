/**
 * File dialogs the main process opens on the page's behalf
 * (`permissions.md`: paths the page acts on come from dialogs the main
 * process shows). Electron's `dialog` is injected so the logic is testable
 * and Playwright can stub it in E2E runs.
 */
import { NexgentError } from '@nexgent/kernel'
import type { OpenDialogOptions, OpenDialogReturnValue } from 'electron'

/** The part of Electron's `dialog` used here. */
export type ShowOpenDialog = (options: OpenDialogOptions) => Promise<OpenDialogReturnValue>

/** Pick a project directory (may create one). @returns the absolute path, or `undefined` when cancelled. */
export async function pickProjectDirectory(show: ShowOpenDialog, defaultPath?: string): Promise<string | undefined> {
  const result = await show({
    title: '打开项目',
    buttonLabel: '打开',
    properties: ['openDirectory', 'createDirectory'],
    ...(defaultPath === undefined ? {} : { defaultPath }),
  })
  return result.canceled ? undefined : result.filePaths[0]
}

/** Pick one or more files to add as materials. @returns absolute paths; empty when cancelled. */
export async function pickMaterialFiles(show: ShowOpenDialog, defaultPath?: string): Promise<string[]> {
  const result = await show({
    title: '添加资料',
    buttonLabel: '添加',
    properties: ['openFile', 'multiSelections'],
    ...(defaultPath === undefined ? {} : { defaultPath }),
  })
  return result.canceled ? [] : [...result.filePaths]
}

/** Pick the directory a session export is written into. @returns the absolute path, or `undefined` when cancelled. */
export async function pickExportDirectory(show: ShowOpenDialog, defaultPath?: string): Promise<string | undefined> {
  const result = await show({
    title: '导出会话',
    buttonLabel: '导出到此处',
    properties: ['openDirectory', 'createDirectory'],
    ...(defaultPath === undefined ? {} : { defaultPath }),
  })
  return result.canceled ? undefined : result.filePaths[0]
}

/**
 * The `sessions.export` interceptor: the `outDir` the page passed is only the
 * dialog's starting point; the directory actually written is the one the
 * user picks. Cancelling rejects with `approval/denied`.
 */
export function exportInterceptor(
  show: ShowOpenDialog,
  exportTo: (input: { projectId: string; sessionId: string; outDir: string }) => Promise<unknown>,
): (input: Record<string, unknown>) => Promise<unknown> {
  return async (input) => {
    const outDir = await pickExportDirectory(show, input['outDir'] as string)
    if (outDir === undefined) throw new NexgentError('approval/denied', '已取消导出', { details: { cancelled: true } })
    return exportTo({ projectId: input['projectId'] as string, sessionId: input['sessionId'] as string, outDir })
  }
}
