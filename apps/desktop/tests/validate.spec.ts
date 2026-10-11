import { describe, expect, it } from 'vitest'
import { SDK_METHOD_NAMES, type SdkMethodName } from '@nexgent/sdk'
import { isPlainObject, isSnapshotPath, isWhitelisted, METHOD_SPECS, validateInput } from '../src/main/validate.js'

const ABS = process.platform === 'win32' ? 'C:\\work\\proj' : '/work/proj'
const p = { projectId: 'p1' }
const s = { projectId: 'p1', sessionId: 's1' }

/** One valid input per whitelisted method. */
const VALID: Record<SdkMethodName, Record<string, unknown>> = {
  'app.info': {},
  'projects.recent': {},
  'projects.open': { root: ABS, create: true },
  'projects.close': p,
  'projects.forget': { root: ABS },
  'sessions.list': { ...p, includeChildren: true },
  'sessions.children': s,
  'sessions.view': s,
  'sessions.collaboration': s,
  'sessions.create': { ...p, title: '月报', sandboxMode: 'read-only' },
  'sessions.open': s,
  'sessions.close': s,
  'sessions.export': { ...s, outDir: ABS },
  'sessions.rename': { ...s, title: '六月订单' },
  'files.list': p,
  'dialogs.pickDirectory': {},
  'dialogs.pickFiles': {},
  'turns.send': { ...s, text: '你好', materialIds: ['m1'] },
  'turns.cancel': s,
  'approvals.respond': { ...s, decision: { id: 'a1', decision: 'allow', scope: 'once', reason: 'ok' } },
  'materials.add': { ...p, sourcePath: ABS, sessionId: 's1' },
  'materials.list': { ...p, includeRemoved: true },
  'materials.remove': { ...p, materialId: 'm1' },
  'deliverables.list': p,
  'deliverables.get': { ...p, deliverableId: 'd1', version: 1 },
  'deliverables.diff': { ...p, deliverableId: 'd1', from: 1, to: 2 },
  'deliverables.readText': { ...p, deliverableId: 'd1', version: 2, path: 'report/summary.md' },
  'deliverables.reveal': { ...p, deliverableId: 'd1', version: 2, path: 'summary.md' },
  'feedback.submit': { ...s, deliverableId: 'd1', version: 1, rating: 4, comment: '加一列' },
  'feedback.list': { ...p, sessionId: 's1', deliverableId: 'd1' },
  'goals.get': s,
  'goals.set': { ...s, text: '完成月报' },
  'goals.update': { ...s, status: 'completed', note: '已交付' },
  'settings.get': p,
  'settings.update': { ...p, patch: { model: 'claude-sonnet-5-5' } },
  'settings.setApiKey': { value: 'not-a-real-key' },
}

describe('method whitelist', () => {
  it('has one argument spec per SDK method, and nothing else', () => {
    expect(Object.keys(METHOD_SPECS).sort()).toEqual([...SDK_METHOD_NAMES].sort())
  })

  it('accepts exactly the SDK method names', () => {
    for (const method of SDK_METHOD_NAMES) expect(isWhitelisted(method)).toBe(true)
    for (const method of ['fs.read', 'shell.exec', 'constructor', '__proto__', 'app.info ', '', 42, null]) expect(isWhitelisted(method)).toBe(false)
  })
})

describe('validateInput', () => {
  it.each(SDK_METHOD_NAMES)('accepts a valid %s input', (method) => {
    expect(validateInput(method, VALID[method])).toBeUndefined()
  })

  it('rejects inputs that are not plain objects', () => {
    for (const input of [undefined, null, 'x', 1, [], new Date(), new Map()]) {
      expect(validateInput('app.info', input)).toBe('input is not a plain object')
    }
    expect(validateInput('app.info', Object.create(null))).toBeUndefined()
  })

  it('rejects unknown fields without echoing their values', () => {
    expect(validateInput('app.info', { extra: 'secret-value' })).toBe('unknown field "extra"')
  })

  it('rejects missing required fields and accepts missing optional ones', () => {
    expect(validateInput('sessions.open', { projectId: 'p1' })).toBe('missing field sessionId')
    expect(validateInput('materials.add', { projectId: 'p1', sourcePath: ABS })).toBeUndefined()
  })

  it('rejects wrong types', () => {
    expect(validateInput('projects.open', { root: ABS, create: 'yes' })).toBe('invalid field create')
    expect(validateInput('deliverables.get', { ...p, deliverableId: 'd1', version: 0 })).toBe('invalid field version')
    expect(validateInput('deliverables.get', { ...p, deliverableId: 'd1', version: 1.5 })).toBe('invalid field version')
    expect(validateInput('turns.send', { ...s, text: 'x', materialIds: [1] })).toBe('invalid field materialIds')
    expect(validateInput('sessions.create', { ...p, sandboxMode: 'yolo' })).toBe('invalid field sandboxMode')
    expect(validateInput('goals.update', { ...s, status: 'paused' })).toBe('invalid field status')
    expect(validateInput('settings.update', { ...p, patch: [] })).toBe('invalid field patch')
    expect(validateInput('sessions.open', { projectId: '', sessionId: 's1' })).toBe('invalid field projectId')
  })

  it('requires absolute paths where the spec says so', () => {
    for (const root of ['relative/dir', './x', '', 'C:relative', `${ABS}\0evil`]) {
      expect(validateInput('projects.open', { root })).toBe('invalid field root')
    }
    expect(validateInput('materials.add', { ...p, sourcePath: 'notes.txt' })).toBe('invalid field sourcePath')
    expect(validateInput('sessions.export', { ...s, outDir: 'out' })).toBe('invalid field outDir')
  })

  it('keeps snapshot paths inside the snapshot', () => {
    for (const path of ['../x', 'a/../../x', 'a\\..\\x', '/etc/passwd', '\\\\server\\share', 'C:\\x', 'c:x', '', 'a\0b']) {
      expect(isSnapshotPath(path)).toBe(false)
      expect(validateInput('deliverables.readText', { ...p, deliverableId: 'd1', version: 1, path })).toBe('invalid field path')
    }
    for (const path of ['a.md', 'dir/a.md', 'dir\\a.md', '..a/b', 'a..b']) expect(isSnapshotPath(path)).toBe(true)
  })

  it('does not let the page set who decided an approval', () => {
    const decision = { id: 'a1', decision: 'allow', scope: 'once', decidedBy: 'user' }
    expect(validateInput('approvals.respond', { ...s, decision })).toBe('invalid field decision')
    expect(validateInput('approvals.respond', { ...s, decision: { id: 'a1', decision: 'maybe', scope: 'once' } })).toBe('invalid field decision')
  })

  it('treats only plain objects as objects', () => {
    expect(isPlainObject({})).toBe(true)
    expect(isPlainObject(Object.create(null))).toBe(true)
    expect(isPlainObject(Object.create({}))).toBe(false)
    expect(isPlainObject([])).toBe(false)
  })
})
