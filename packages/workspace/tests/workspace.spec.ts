import { readdir, readFile, stat, writeFile } from 'node:fs/promises'
import * as nodePath from 'node:path'
import { Context, NEXGENT_SUBDIRS, type Tool, type ToolRegistry } from '@nexgent/kernel'
import { describe, expect, it } from 'vitest'
import {
  addProjectApproval,
  createWorkspaceServices,
  ensureSessionTempDir,
  loadProjectConfig,
  locateWorkspace,
  openWorkspace,
  removeSessionTempDir,
  validateProjectConfig,
  WorkspacePlugin,
  writeProjectConfig,
} from '../src/index.js'
import { tempDir } from './helpers.js'

describe('workspace layout', () => {
  it('creates the project and every .nexgent subdirectory idempotently', async () => {
    const base = await tempDir()
    const workspace = await openWorkspace(nodePath.join(base, 'p'), { create: true, ensureLayout: true })
    await workspace.ensureLayout()
    expect((await readdir(workspace.layout.dataDir)).sort()).toEqual([...NEXGENT_SUBDIRS].sort())
    expect(workspace.sessionDir('abc')).toBe(nodePath.join(workspace.root, '.nexgent', 'sessions', 'abc'))
    expect(() => workspace.sessionDir('../x')).toThrow()
    expect(workspace.resolve('a/b')).toBe(nodePath.join(workspace.root, 'a', 'b'))
    expect(workspace.relative(nodePath.join(workspace.root, 'a'))).toBe('a')
    expect(await locateWorkspace(nodePath.join(workspace.root, 'deep', 'er'))).toBe(workspace.root)
  })

  it('reports a missing project unless asked to create it', async () => {
    const base = await tempDir()
    await expect(openWorkspace(nodePath.join(base, 'missing'))).rejects.toMatchObject({ code: 'workspace/not-found' })
  })

  it('manages session temp directories', async () => {
    const base = await tempDir()
    const dir = await ensureSessionTempDir('s1', base)
    expect(dir).toBe(nodePath.join(base, 'nexgent-s1'))
    expect((await stat(dir)).isDirectory()).toBe(true)
    await removeSessionTempDir('s1', base)
    await expect(stat(dir)).rejects.toThrow()
  })
})

describe('project config', () => {
  it('defaults a missing file and loads a valid one', async () => {
    const workspace = await openWorkspace(await tempDir(), { ensureLayout: true })
    expect(await loadProjectConfig(workspace.layout)).toMatchObject({ version: 1, sandboxMode: 'workspace-write', approvals: [], extraReadRoots: [] })
    await writeFile(workspace.layout.configFile, JSON.stringify({ version: 1, sandboxMode: 'read-only', costCaps: { perTask: { maxRequests: 2 } } }))
    expect(await loadProjectConfig(workspace.layout)).toMatchObject({
      sandboxMode: 'read-only', costCaps: { perTask: { maxRequests: 2 } }, model: 'claude-sonnet-5-5', thinking: 'off', effort: 'medium',
    })
    await writeFile(workspace.layout.configFile, JSON.stringify({ effort: 'xhigh', thinking: 'on' }))
    expect(await loadProjectConfig(workspace.layout)).toMatchObject({ effort: 'xhigh', thinking: 'on' })
  })

  it('rejects unknown fields, wrong types, bad version and malformed JSON with config/invalid', async () => {
    for (const bad of [{ modle: 'x' }, { sandboxMode: 'yolo' }, { version: 2 }, { thinking: 'maybe' }, { effort: 'extreme' }, { effort: 1 }, { costCaps: { perTask: { windowDays: 3 } } }, { approvals: [{ tool: 'bash' }] }, { extraReadRoots: ['relative'] }, []]) {
      expect(() => validateProjectConfig(bad)).toThrow(expect.objectContaining({ code: 'config/invalid' }))
    }
    const workspace = await openWorkspace(await tempDir(), { ensureLayout: true })
    await writeFile(workspace.layout.configFile, '{ nope')
    await expect(loadProjectConfig(workspace.layout)).rejects.toMatchObject({ code: 'config/invalid' })
  })

  it('writes atomically and appends project grants once', async () => {
    const workspace = await openWorkspace(await tempDir(), { ensureLayout: true })
    await writeProjectConfig(workspace.layout, { model: 'm' })
    const grant = { tool: 'bash', pattern: 'pnpm install', grantedAt: '2026-10-07T08:00:00Z' }
    await addProjectApproval(workspace.layout, grant)
    await addProjectApproval(workspace.layout, grant)
    expect(JSON.parse(await readFile(workspace.layout.configFile, 'utf8'))).toEqual({ model: 'm', approvals: [grant] })
    expect((await readdir(workspace.layout.dataDir)).filter(name => name.endsWith('.tmp'))).toEqual([])
    await expect(writeProjectConfig(workspace.layout, { sandboxMode: 'nope' } as never)).rejects.toMatchObject({ code: 'config/invalid' })
  })

  it('services honour config sandboxMode and the CLI override', async () => {
    const root = await tempDir()
    const first = await createWorkspaceServices({ root })
    await writeProjectConfig(first.workspace.layout, { sandboxMode: 'read-only' })
    expect((await createWorkspaceServices({ root })).sandbox.policy.mode).toBe('read-only')
    expect((await createWorkspaceServices({ root, sandboxMode: 'full-access' })).sandbox.policy.mode).toBe('full-access')
  })
})

describe('Cordis plugin', () => {
  it('provides workspace, sandbox and processes, and registers tools once ctx.tools exists', async () => {
    const app = { ctx: new Context() }
    const root = await tempDir()
    await app.ctx.plugin(WorkspacePlugin, { root })
    expect(app.ctx.workspace.root).toBe(await openWorkspace(root).then(w => w.root))
    expect((await app.ctx.sandbox.checkWrite(app.ctx.workspace.resolve('a.txt'))).allowed).toBe(true)
    expect(typeof app.ctx.processes.run).toBe('function')

    const registered = new Map<string, Tool>()
    const registry: ToolRegistry = {
      register: tool => {
        registered.set(tool.definition.name, tool)
        return () => void registered.delete(tool.definition.name)
      },
      unregister: name => registered.delete(name),
      list: () => [...registered.values()].map(tool => tool.definition),
      get: name => registered.get(name),
      restrict: () => () => {},
    }
    const tools = await app.ctx.plugin((ctx: typeof app.ctx) => {
      ctx.provide('tools', registry)
    })
    expect([...registered.keys()]).toContain('str_replace')
    expect(registered.size).toBe(6)
    await tools.dispose()
    expect(registered.size).toBe(0)
    await app.ctx.fiber.dispose()
  })

  it('rejects an invalid sandbox mode', async () => {
    await expect(createWorkspaceServices({ root: await tempDir(), sandboxMode: 'yolo' as never })).rejects.toMatchObject({ code: 'config/invalid' })
  })
})
