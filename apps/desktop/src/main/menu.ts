/**
 * The application menu. Development builds add reload and developer tools;
 * packaged builds have neither (`devTools` is off there as well).
 */
import type { MenuItemConstructorOptions } from 'electron'

/** Options of {@link menuTemplate}. */
export interface MenuOptions {
  readonly dev: boolean
  readonly platform: NodeJS.Platform
}

/** The menu as Electron's `Menu.buildFromTemplate` input. */
export function menuTemplate(options: MenuOptions): MenuItemConstructorOptions[] {
  const mac = options.platform === 'darwin'
  const view: MenuItemConstructorOptions[] = [
    { role: 'resetZoom', label: '实际大小' },
    { role: 'zoomIn', label: '放大' },
    { role: 'zoomOut', label: '缩小' },
    { type: 'separator' },
    { role: 'togglefullscreen', label: '全屏' },
  ]
  if (options.dev) {
    view.unshift({ role: 'reload', label: '重新加载' }, { role: 'toggleDevTools', label: '开发者工具' }, { type: 'separator' })
  }
  return [
    ...(mac ? [{ role: 'appMenu' as const, label: 'Nexgent' }] : []),
    { label: '文件', submenu: [mac ? { role: 'close', label: '关闭窗口' } : { role: 'quit', label: '退出' }] },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' },
      ],
    },
    { label: '视图', submenu: view },
    { label: '窗口', submenu: [{ role: 'minimize', label: '最小化' }, { role: 'close', label: '关闭' }] },
  ]
}
