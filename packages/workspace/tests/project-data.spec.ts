/**
 * K1 (ADR 0017 decision 4): project data lives in the user data directory;
 * old in-project data is copied once, verified, and kept.
 */
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import * as nodePath from 'node:path'
import {
  defaultProjectId,
  layoutOfDataDir,
  locateProjectData,
  MIGRATION_NOTICE_FILE,
  projectGitignoreText,
  readProjectSettings,
  resolveDataPath,
  resolveProjectDataLayout,
  resolveProjectLayout,
  type MigrationRecord,
} from '@nexgent/kernel'
import { describe, expect, it } from 'vitest'
import { addProjectApproval, openWorkspace, prepareProjectData } from '../src/index.js'
import { tempDir } from './helpers.js'

async function setup() {
  const base = await tempDir()
  const home = nodePath.join(base, 'home')
  const root = nodePath.join(base, 'project')
  await mkdir(root, { recursive: true })
  return { base, home, root }
}

const grant = { tool: 'bash', pattern: 'npm test', grantedAt: '2026-10-16T00:00:00.000Z' }

describe('project data location', () => {
  it('puts a new project\'s data in the user data directory and leaves only shareable files in the project', async () => {
    const { home, root } = await setup()
    const workspace = await openWorkspace(root, { ensureLayout: true, home })
    const projectId = defaultProjectId(workspace.root)
    const data = resolveProjectDataLayout(home, projectId)
    expect(workspace.layout).toMatchObject({ location: 'user-data', projectId, dataDir: data.dataDir, sessions: data.sessions, grantsFile: data.grantsFile })
    expect(workspace.layout.configFile).toBe(nodePath.join(workspace.root, '.nexgent', 'config.json'))
    expect((await readdir(nodePath.join(root, '.nexgent'))).sort()).toEqual(['.gitignore', 'project.json'])
    expect(await readFile(nodePath.join(root, '.nexgent', '.gitignore'), 'utf8')).toBe(projectGitignoreText())
    expect(JSON.parse(await readFile(nodePath.join(root, '.nexgent', 'project.json'), 'utf8'))).toMatchObject({ formatVersion: 1, projectId, name: 'project' })
    expect(JSON.parse(await readFile(data.indexFile, 'utf8'))).toMatchObject({ formatVersion: 1, projectId, root: workspace.root })
    // Every entry point resolves the same layout without the workspace service.
    expect(resolveProjectLayout(root, { home })).toEqual(workspace.layout)
    expect(layoutOfDataDir(data.dataDir)).toMatchObject({ root: workspace.root, sessions: data.sessions })
  })

  it('keeps the id when the folder moves, and gives a copied .nexgent its own id', async () => {
    const { base, home, root } = await setup()
    const first = await openWorkspace(root, { ensureLayout: true, home })
    const copy = nodePath.join(base, 'copy')
    await mkdir(nodePath.join(copy, '.nexgent'), { recursive: true })
    await writeFile(nodePath.join(copy, '.nexgent', 'project.json'), await readFile(nodePath.join(root, '.nexgent', 'project.json')))
    const second = await openWorkspace(copy, { ensureLayout: true, home })
    expect(second.layout.projectId).not.toBe(first.layout.projectId)
    expect(second.layout.projectId).toBe(defaultProjectId(second.root))
    // The original keeps its id and data.
    expect((await openWorkspace(root, { ensureLayout: true, home })).layout.projectId).toBe(first.layout.projectId)
  })

  it('migrates old in-project data once: copied, verified, grants moved, old data kept', async () => {
    const { home, root } = await setup()
    const old = nodePath.join(root, '.nexgent')
    await mkdir(nodePath.join(old, 'sessions', 's1'), { recursive: true })
    await writeFile(nodePath.join(old, 'sessions', 's1', 'session.jsonl'), '{"type":"session.start"}\n')
    await writeFile(nodePath.join(old, 'sessions', 's1', '.lock'), JSON.stringify({ pid: 999999999, ts: 'x', host: 'h' }))
    await mkdir(nodePath.join(old, 'materials', 'm1'), { recursive: true })
    await writeFile(nodePath.join(old, 'materials', 'm1', 'a.csv'), 'a,b\n1,2\n')
    await writeFile(nodePath.join(old, 'config.json'), JSON.stringify({ version: 1, approvals: [grant] }))
    expect(locateProjectData(root, { home }).location).toBe('project')

    const prepared = await prepareProjectData(root, { home })
    const migration = prepared.migration as MigrationRecord
    expect(migration).toMatchObject({ status: 'done', grantsMoved: 1, oldDataKept: true, from: nodePath.join(prepared.place.root, '.nexgent') })
    expect(migration.entries).toEqual([{ name: 'sessions', files: 1, bytes: 25 }, { name: 'materials', files: 1, bytes: 8 }])
    expect(prepared.layout.location).toBe('user-data')
    expect(await readFile(nodePath.join(prepared.layout.sessions, 's1', 'session.jsonl'), 'utf8')).toBe('{"type":"session.start"}\n')
    expect(await readdir(nodePath.join(prepared.layout.sessions, 's1'))).toEqual(['session.jsonl'])
    // Old data stays; the notice and the .gitignore are written; grants left config.json.
    expect(await readFile(nodePath.join(old, 'materials', 'm1', 'a.csv'), 'utf8')).toBe('a,b\n1,2\n')
    expect(await readFile(nodePath.join(old, MIGRATION_NOTICE_FILE), 'utf8')).toContain(prepared.layout.dataDir)
    expect(JSON.parse(await readFile(nodePath.join(old, 'config.json'), 'utf8'))).toEqual({ version: 1 })
    expect((await readProjectSettings(prepared.layout)).config.approvals).toEqual([grant])
    // A recorded project-relative path resolves to the moved copy.
    expect(resolveDataPath(prepared.layout, '.nexgent/materials/m1/a.csv')).toBe(nodePath.join(prepared.layout.materials, 'm1', 'a.csv'))
    // Later opens do not migrate again.
    expect((await prepareProjectData(root, { home })).migration).toBeUndefined()
  })

  it('does not migrate while a session of the project is locked by a live process', async () => {
    const { home, root } = await setup()
    const old = nodePath.join(root, '.nexgent', 'sessions', 's1')
    await mkdir(old, { recursive: true })
    await writeFile(nodePath.join(old, 'session.jsonl'), 'x\n')
    await writeFile(nodePath.join(old, '.lock'), JSON.stringify({ pid: process.pid, ts: 'x', host: 'h' }))
    const prepared = await prepareProjectData(root, { home })
    expect(prepared.migration).toBeUndefined()
    expect(prepared.layout.location).toBe('project')
    expect(prepared.layout.sessions).toBe(nodePath.join(prepared.place.root, '.nexgent', 'sessions'))
  })

  it('writes project grants to grants.json once the data is in the user data directory', async () => {
    const { home, root } = await setup()
    const workspace = await openWorkspace(root, { ensureLayout: true, home })
    await addProjectApproval(workspace.layout, grant)
    await addProjectApproval(workspace.layout, grant)
    expect(JSON.parse(await readFile(workspace.layout.grantsFile!, 'utf8'))).toEqual({ formatVersion: 1, approvals: [grant] })
    // A config.json brought in by a clone grants nothing.
    await writeFile(workspace.layout.configFile, JSON.stringify({ version: 1, approvals: [{ ...grant, tool: 'write_file' }] }))
    expect((await readProjectSettings(workspace.layout)).config.approvals).toEqual([grant])
  })
})
