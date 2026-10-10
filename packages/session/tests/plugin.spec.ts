import { existsSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { Context, resolveWorkspaceLayout, ValidationError, type Workspace } from '@nexgent/kernel'
import {
  checkSessionPluginConfig,
  createSessionServices,
  JsonlLedger,
  JsonlSessionStore,
  packageName,
  SessionPlugin,
} from '../src/index.js'
import { SESSION_ID, sessionInit, tempDir } from './helpers.js'

function fakeWorkspace(root: string): Workspace {
  const layout = resolveWorkspaceLayout(root)
  return {
    root,
    layout,
    resolve: input => input,
    relative: absolute => absolute,
    sessionDir: id => `${layout.sessions}/${id}`,
    ensureLayout: async () => {},
  }
}

describe('SessionPlugin', () => {
  it('waits for ctx.workspace, then provides ctx.session and ctx.ledger under its layout', async () => {
    const root = await tempDir()
    const ctx = new Context()
    const fiber = ctx.plugin(SessionPlugin)
    expect(ctx.get('session')).toBeUndefined()
    ctx.provide('workspace', fakeWorkspace(root))
    await fiber
    expect(ctx.session).toBeInstanceOf(JsonlSessionStore)
    expect(ctx.ledger).toBeInstanceOf(JsonlLedger)
    const layout = resolveWorkspaceLayout(root)
    expect((ctx.session as JsonlSessionStore).sessionsDir).toBe(layout.sessions)
    expect((ctx.ledger as JsonlLedger).ledgersDir).toBe(layout.ledgers)

    const lock = await ctx.session.create(sessionInit(root))
    expect(existsSync(lock.path)).toBe(true)
    await fiber.dispose()
    // Disposal released the lock (after a closing checkpoint) and withdrew the services.
    expect(existsSync(lock.path)).toBe(false)
    expect(ctx.get('session')).toBeUndefined()
    const { records } = await new JsonlSessionStore({ layout }).readAll(SESSION_ID)
    expect(records.map(record => record.type)).toEqual(['session.start'])
  })

  it('config root/directories override the workspace layout', async () => {
    const root = await tempDir()
    const other = await tempDir()
    const ctx = new Context()
    ctx.provide('workspace', fakeWorkspace(root))
    await ctx.plugin(SessionPlugin, { root: other, checkpointEvery: 5 })
    expect((ctx.session as JsonlSessionStore).sessionsDir).toBe(resolveWorkspaceLayout(other).sessions)
    await ctx.fiber.dispose()
  })

  it('rejects invalid config through Cordis validation', async () => {
    const ctx = new Context()
    ctx.provide('workspace', fakeWorkspace(await tempDir()))
    await expect(ctx.plugin(SessionPlugin, { checkpointEvery: 0 })).rejects.toBeInstanceOf(ValidationError)
    await expect(ctx.plugin(SessionPlugin, { root: 'relative/dir' })).rejects.toBeInstanceOf(ValidationError)
    await ctx.fiber.dispose()
  })
})

describe('createSessionServices', () => {
  it('builds both services from a root', async () => {
    const root = await tempDir()
    const { store, ledger } = createSessionServices({ root })
    expect(store.sessionsDir).toBe(resolveWorkspaceLayout(root).sessions)
    expect(ledger.ledgersDir).toBe(resolveWorkspaceLayout(root).ledgers)
    expect(packageName).toBe('@nexgent/session')
  })

  it('validates its config', () => {
    expect(() => createSessionServices({})).toThrow(TypeError)
    expect(checkSessionPluginConfig({ fsync: 'never', extra: 1 }, false).map(issue => issue.path?.[0])).toEqual([
      'extra',
      'fsync',
    ])
    expect(checkSessionPluginConfig(null)).toHaveLength(1)
  })
})
