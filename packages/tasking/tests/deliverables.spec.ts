import { existsSync } from 'node:fs'
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import * as nodePath from 'node:path'
import type { PresentInput } from '@nexgent/kernel'
import { validateDeliverableVersion } from '@nexgent/session'
import { describe, expect, it } from 'vitest'
import { createTaskingService } from '../src/index.js'
import { project, SESSION_A, sha256Of, type TestProject } from './helpers.js'

function presentInput(paths: string[], extra: Partial<PresentInput> = {}): PresentInput {
  return { sessionId: SESSION_A, turn: 1, toolCallId: 'call_1', paths, summary: 'Monthly sales summary.', ...extra }
}

async function withReport(p: TestProject): Promise<void> {
  await p.write('report/summary.csv', 'region,month,total\nnorth,2026-01,100\nsouth,2026-01,80\n')
  await p.write('report/README.md', '# Report\n\nCleaning rules: none yet.\n')
}

describe('present', () => {
  it('snapshots the files into outputs/<id>/v1/ with valid metadata', async () => {
    const p = await project()
    await withReport(p)
    const v1 = await p.tasking.deliverables.present(presentInput(['report/summary.csv', './report/README.md']))
    expect(validateDeliverableVersion(v1)).toEqual([])
    expect(v1).toMatchObject({ version: 1, title: 'summary.csv', summary: 'Monthly sales summary.', sessionId: SESSION_A, turn: 1, toolCallId: 'call_1' })
    expect(v1.files.map(file => file.path)).toEqual(['report/summary.csv', 'report/README.md'])
    expect(v1.files[0]).toMatchObject({ mediaType: 'text/csv', sha256: sha256Of(p.abs('report/summary.csv')) })
    const snapshot = p.tasking.deliverables.snapshotPath(v1.deliverableId, 1, 'report/summary.csv')
    expect(snapshot).toBe(nodePath.join(p.workspace.layout.outputs, v1.deliverableId, 'v1', 'files', 'report', 'summary.csv'))
    expect(sha256Of(snapshot)).toBe(v1.files[0]!.sha256)
    const metadata = JSON.parse(await readFile(nodePath.join(p.workspace.layout.outputs, v1.deliverableId, 'v1', 'deliverable.json'), 'utf8'))
    expect(metadata).toEqual(v1)
  })

  it('accepts absolute paths inside the project and drops duplicates', async () => {
    const p = await project()
    await withReport(p)
    const v1 = await p.tasking.deliverables.present(presentInput([p.abs('report/summary.csv'), 'report/summary.csv'], { title: 'Sales' }))
    expect(v1.files.map(file => file.path)).toEqual(['report/summary.csv'])
    expect(v1.title).toBe('Sales')
  })

  it('rejects missing files, files outside the project, .nexgent/ files and directories with readable errors, writing nothing', async () => {
    const p = await project()
    await withReport(p)
    await writeFile(nodePath.join(p.outside, 'secret.txt'), 'x')
    const cases: Array<[string, string, RegExp]> = [
      ['report/missing.csv', 'workspace/not-found', /does not exist in the project; write it first/],
      [nodePath.join(p.outside, 'secret.txt'), 'workspace/outside-root', /outside the project/],
      ['../outside/secret.txt', 'workspace/outside-root', /outside the project/],
      ['.nexgent/config.json', 'sandbox/denied', /inside \.nexgent\//],
      ['.nexgent/materials', 'sandbox/denied', /inside \.nexgent\//],
      ['report', 'workspace/not-found', /is not a file/],
    ]
    for (const [path, code, message] of cases) {
      const attempt = p.tasking.deliverables.present(presentInput(['report/summary.csv', path]))
      await expect(attempt, path).rejects.toMatchObject({ code })
      await expect(attempt, path).rejects.toThrow(message)
    }
    await expect(p.tasking.deliverables.present(presentInput(['report/summary.csv'], { summary: '  ' }))).rejects.toMatchObject({ code: 'tool/invalid-input' })
    await expect(p.tasking.deliverables.present(presentInput([]))).rejects.toMatchObject({ code: 'tool/invalid-input' })
    expect(await p.tasking.deliverables.list()).toEqual([])
  })

  it.skipIf(process.platform === 'win32')('rejects a symlink that leads out of the project', async () => {
    const p = await project()
    await writeFile(nodePath.join(p.outside, 'secret.txt'), 'x')
    await symlink(nodePath.join(p.outside, 'secret.txt'), p.abs('link.txt'))
    await expect(p.tasking.deliverables.present(presentInput(['link.txt']))).rejects.toMatchObject({ code: 'workspace/outside-root' })
    await p.write('.nexgent/outputs/x.txt', 'x')
    await symlink(p.workspace.layout.dataDir, p.abs('data'))
    await expect(p.tasking.deliverables.present(presentInput(['data/outputs/x.txt']))).rejects.toMatchObject({ code: 'sandbox/denied' })
  })

  it('adds versions by deliverableId or by the same primary path; old snapshots never change', async () => {
    const p = await project()
    await withReport(p)
    const v1 = await p.tasking.deliverables.present(presentInput(['report/summary.csv', 'report/README.md']))
    const v1Hashes = v1.files.map(file => sha256Of(p.tasking.deliverables.snapshotPath(v1.deliverableId, 1, file.path)))

    await p.write('report/summary.csv', 'region,month,total,mom\n华北,2026-01,100,\n华南,2026-01,80,\n')
    const v2 = await p.tasking.deliverables.present(presentInput(['report/summary.csv', 'report/README.md'], { deliverableId: v1.deliverableId, turn: 2, toolCallId: 'call_2', summary: 'Chinese region names, MoM column.' }))
    expect(v2).toMatchObject({ deliverableId: v1.deliverableId, version: 2, title: 'summary.csv', turn: 2 })

    await p.write('report/README.md', '# Report\n\nCleaning rules: dedupe order ids.\n')
    const v3 = await p.tasking.deliverables.present(presentInput(['report/summary.csv', 'report/README.md'], { turn: 3, toolCallId: 'call_3' }))
    expect(v3).toMatchObject({ deliverableId: v1.deliverableId, version: 3 })

    const other = await p.tasking.deliverables.present(presentInput(['report/README.md']))
    expect(other.deliverableId).not.toBe(v1.deliverableId)
    expect(other.version).toBe(1)

    expect(v1.files.map(file => sha256Of(p.tasking.deliverables.snapshotPath(v1.deliverableId, 1, file.path)))).toEqual(v1Hashes)
    expect(await p.tasking.deliverables.get(v1.deliverableId, 1)).toEqual(v1)
    expect(v2.files[0]!.sha256).not.toBe(v1.files[0]!.sha256)

    // Order between deliverables follows the first presentedAt (ms); both may fall in the same ms here.
    const list = await p.tasking.deliverables.list()
    expect(new Map(list.map(entry => [entry.deliverableId, entry.versions.map(version => version.version)]))).toEqual(new Map([
      [v1.deliverableId, [1, 2, 3]],
      [other.deliverableId, [1]],
    ]))
    await expect(p.tasking.deliverables.present(presentInput(['report/summary.csv'], { deliverableId: '00000000-0000-4000-8000-000000000000' }))).rejects.toThrow(/no deliverable with id/)
    await expect(p.tasking.deliverables.present(presentInput(['report/summary.csv'], { deliverableId: '../x' }))).rejects.toMatchObject({ code: 'tool/invalid-input' })
  })

  it('diffs text by line and binary files by change only', async () => {
    const p = await project()
    await withReport(p)
    await p.write('report/chart.png', Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 1]))
    const v1 = await p.tasking.deliverables.present(presentInput(['report/summary.csv', 'report/README.md', 'report/chart.png']))
    await p.write('report/summary.csv', 'region,month,total\nnorth,2026-01,100\nsouth,2026-01,85\n')
    await p.write('report/chart.png', Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 2]))
    await p.write('report/notes.txt', 'new file\n')
    const v2 = await p.tasking.deliverables.present(presentInput(['report/summary.csv', 'report/chart.png', 'report/notes.txt'], { deliverableId: v1.deliverableId }))

    const diff = await p.tasking.deliverables.diff(v1.deliverableId, 1, v2.version)
    expect(diff).toMatchObject({ deliverableId: v1.deliverableId, from: 1, to: 2 })
    expect(diff.files.map(file => [file.path, file.change, file.binary])).toEqual([
      ['report/summary.csv', 'modified', false],
      ['report/chart.png', 'modified', true],
      ['report/notes.txt', 'added', false],
      ['report/README.md', 'removed', false],
    ])
    expect(diff.files[0]!.hunks).toEqual([{
      fromStart: 1, fromLines: 3, toStart: 1, toLines: 3,
      lines: [
        { op: 'context', text: 'region,month,total' },
        { op: 'context', text: 'north,2026-01,100' },
        { op: 'remove', text: 'south,2026-01,80' },
        { op: 'add', text: 'south,2026-01,85' },
      ],
    }])
    expect(diff.files[1]!.hunks).toBeUndefined()
    expect(diff.files[2]!.hunks).toEqual([{ fromStart: 0, fromLines: 0, toStart: 1, toLines: 1, lines: [{ op: 'add', text: 'new file' }] }])
    expect(diff.files[3]!.hunks?.[0]?.lines.every(line => line.op === 'remove')).toBe(true)

    const same = await p.tasking.deliverables.diff(v1.deliverableId, 1, 1)
    expect(same.files.every(file => file.change === 'unchanged' && file.hunks === undefined)).toBe(true)
    await expect(p.tasking.deliverables.diff(v1.deliverableId, 1, 9)).rejects.toMatchObject({ code: 'workspace/not-found' })
  })

  it('refuses snapshot paths that climb out of the version directory', async () => {
    const p = await project()
    const id = '44444444-4444-4444-8444-444444444444'
    for (const bad of ['../x', 'a/../../x', '/etc/passwd', 'C:/x', 'a\\b', '']) {
      expect(() => p.tasking.deliverables.snapshotPath(id, 1, bad), bad).toThrow(/not a project-relative path/)
    }
    expect(() => p.tasking.deliverables.snapshotPath('x', 1, 'a')).toThrow(/not a deliverable id/)
    expect(() => p.tasking.deliverables.snapshotPath(id, 0, 'a')).toThrow(/not a version number/)
  })

  it('ignores half-written versions, removes them on cleanup and keeps numbering without gaps', async () => {
    const p = await project()
    await withReport(p)
    const v1 = await p.tasking.deliverables.present(presentInput(['report/summary.csv']))
    const leftover = nodePath.join(p.workspace.layout.outputs, v1.deliverableId, '.tmp-00000000-0000-4000-8000-000000000000')
    await mkdir(nodePath.join(leftover, 'files'), { recursive: true })
    await writeFile(nodePath.join(leftover, 'deliverable.json'), '{}')
    const restarted = p.reopen()
    expect((await restarted.deliverables.list())[0]!.versions).toEqual([v1])
    expect(await restarted.cleanup()).toBe(1)
    expect(existsSync(leftover)).toBe(false)
    const v2 = await restarted.deliverables.present(presentInput(['report/summary.csv']))
    expect(v2.version).toBe(2)
  })

  it('serializes concurrent presents of the same deliverable into consecutive versions', async () => {
    const p = await project()
    await withReport(p)
    const v1 = await p.tasking.deliverables.present(presentInput(['report/summary.csv']))
    const other = createTaskingService(p.workspace.layout, p.sessions)
    const results = await Promise.all([
      p.tasking.deliverables.present(presentInput(['report/summary.csv'], { deliverableId: v1.deliverableId })),
      p.tasking.deliverables.present(presentInput(['report/summary.csv'], { deliverableId: v1.deliverableId })),
      other.deliverables.present(presentInput(['report/summary.csv'], { deliverableId: v1.deliverableId })),
    ])
    expect(results.map(result => result.version).sort()).toEqual([2, 3, 4])
  })
})

describe('Windows paths', () => {
  it.runIf(process.platform === 'win32')('accepts backslashes and any letter case, and records the real portable path', async () => {
    const p = await project()
    await withReport(p)
    const v1 = await p.tasking.deliverables.present(presentInput(['REPORT\\Summary.CSV', p.abs('report/README.md').toUpperCase()]))
    expect(v1.files.map(file => file.path)).toEqual(['report/summary.csv', 'report/README.md'])
    // A later present that spells the primary path differently still adds a version.
    const v2 = await p.tasking.deliverables.present(presentInput(['report\\summary.csv']))
    expect(v2).toMatchObject({ deliverableId: v1.deliverableId, version: 2 })
    await expect(p.tasking.deliverables.present(presentInput(['.NEXGENT\\config.json']))).rejects.toMatchObject({ code: 'sandbox/denied' })
    const drive = p.root.slice(0, 2)
    const flipped = (drive === drive.toUpperCase() ? drive.toLowerCase() : drive.toUpperCase()) + p.root.slice(2)
    const v3 = await p.tasking.deliverables.present(presentInput([`${flipped}\\report\\summary.csv`]))
    expect(v3.files[0]!.path).toBe('report/summary.csv')
  })
})
