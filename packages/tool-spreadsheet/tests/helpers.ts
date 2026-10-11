import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { strToU8, unzipSync, zipSync } from 'fflate'
import { afterEach } from 'vitest'
import type { SandboxMode, ToolContext } from '@nexgent/kernel'
import { createWorkspaceServices } from '@nexgent/workspace'

const dirs: string[] = []

/** A fresh temporary directory, removed after the test. */
export async function tempDir(prefix = 'nexgent-sheet-'): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true, maxRetries: 5 })))
})

/** Workspace services and a tool context factory for one project. */
export async function setup(mode: SandboxMode = 'workspace-write') {
  const dir = await tempDir()
  const services = await createWorkspaceServices({ root: dir, sandboxMode: mode })
  const asks: unknown[] = []
  const context = (options: { approve?: boolean; mode?: SandboxMode } = {}): ToolContext => ({
    sessionId: 's', callId: 'c', turn: 1, workspace: services.workspace, sandboxMode: options.mode ?? mode,
    signal: new AbortController().signal, approved: false,
    requestApproval: async ask => {
      asks.push(ask)
      return options.approve ?? false
    },
  })
  return { root: services.workspace.root, services, context, asks }
}

const MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'

/**
 * A hand-made `.xlsx` from raw `<sheetData>` XML per sheet (inline strings
 * only), the way other programs write files this package did not: shared
 * formulas, stale caches, no `<dimension>`.
 */
export function rawXlsx(sheets: Record<string, string>): Uint8Array {
  const names = Object.keys(sheets)
  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8('<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
      + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>'
      + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
      + names.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')
      + '</Types>'),
    '_rels/.rels': strToU8(`<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`),
    'xl/workbook.xml': strToU8(`<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="${MAIN}" xmlns:r="${REL}"><sheets>`
      + names.map((name, i) => `<sheet name="${name}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('') + '</sheets></workbook>'),
    'xl/_rels/workbook.xml.rels': strToU8('<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + names.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${REL}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('') + '</Relationships>'),
  }
  names.forEach((name, i) => {
    files[`xl/worksheets/sheet${i + 1}.xml`] = strToU8(`<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="${MAIN}"><sheetData>${sheets[name]}</sheetData></worksheet>`)
  })
  return zipSync(files)
}

/** The XML of one part of an `.xlsx`. */
export function partOf(bytes: Uint8Array, path: string): string {
  const part = unzipSync(bytes, { filter: file => file.name === path })[path]
  if (part === undefined) throw new Error(`no part ${path}`)
  return new TextDecoder().decode(part)
}

/** Replace one part of an `.xlsx`. */
export function withPart(bytes: Uint8Array, path: string, xml: string): Uint8Array {
  const files = unzipSync(bytes)
  files[path] = strToU8(xml)
  return zipSync(files)
}
