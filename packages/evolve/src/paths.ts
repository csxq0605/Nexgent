import { join } from 'node:path'
import type { WorkspaceLayout } from '@nexgent/kernel'
import { IMPROVEMENTS_DIR } from './types.js'

/** `<root>/.nexgent/improvements`. */
export function improvementsDir(layout: Pick<WorkspaceLayout, 'dataDir'>): string {
  return join(layout.dataDir, IMPROVEMENTS_DIR)
}
