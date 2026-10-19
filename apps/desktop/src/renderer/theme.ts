/**
 * Light / dark appearance (ADR 0020 §5): follows the system unless the user
 * fixes one in 设置. A per-machine view preference, so it lives in the
 * renderer's localStorage and never in project or user config.
 */
export type Theme = 'system' | 'light' | 'dark'

const KEY = 'nexgent.theme'

export function readTheme(): Theme {
  try {
    const value = window.localStorage.getItem(KEY)
    return value === 'light' || value === 'dark' ? value : 'system'
  } catch {
    return 'system'
  }
}

/** Set `data-theme` on the root element (`system` removes it, so `prefers-color-scheme` decides). */
export function applyTheme(theme: Theme): void {
  const root = document.documentElement
  if (theme === 'system') root.removeAttribute('data-theme')
  else root.setAttribute('data-theme', theme)
}

export function saveTheme(theme: Theme): void {
  try {
    if (theme === 'system') window.localStorage.removeItem(KEY)
    else window.localStorage.setItem(KEY, theme)
  } catch {
    // Storage unavailable: the choice holds for this window only.
  }
  applyTheme(theme)
}
