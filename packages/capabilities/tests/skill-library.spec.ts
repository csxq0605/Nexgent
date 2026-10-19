/**
 * ADR 0025 layer 2 storage and exposure: versions never overwrite, the fold
 * retires older versions when a new one is enabled, retrieval goes through
 * the handbook's relevance gate, root tasks get the ADR 0023 draws, members
 * use their root's, outcomes enable a version, and a trial copy draws no
 * coin.
 */
import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { foldSkillLibrary, HANDBOOK_EVIDENCE, type SessionRecord, type SkillLibraryOp } from '@nexgent/kernel'
import { LEARNED_SKILLS_HEADER, SkillLibrary, SkillLibraryHost, withLearnedSkills } from '../src/index.js'
import { tempDir } from './helpers.js'

const PROJECT = 'b'.repeat(64)
const source = (taskId: string) => ({ projectId: PROJECT, taskId, sessionId: taskId })

const SKILL = {
  name: 'merge-spreadsheet-exports',
  description: 'Merge several spreadsheet exports into one table, aligning their columns.',
  whenToUse: 'The task asks to combine monthly or per-store spreadsheet exports.',
  body: '1. List the columns of every <input file>.\n2. Map renamed columns before merging.\n3. Check the row count of the result.',
  sources: [source('t1'), source('t2')],
}

function start(sessionId: string, extra: Record<string, unknown> = {}): SessionRecord {
  return { seq: 1, ts: '2026-10-19T00:00:00.000Z', sessionId, type: 'session.start', version: 1, projectRoot: '/p', model: 'claude-sonnet-5-5', sandboxMode: 'workspace-write', ...extra } as SessionRecord
}

describe('skill library (ADR 0025)', () => {
  it('adds versions with their files, folds activation and retrieves by description', async () => {
    const library = new SkillLibrary(await tempDir())
    const v1 = await library.add(SKILL)
    expect(v1).toMatchObject({ id: 'merge-spreadsheet-exports@v1', version: 1, status: 'trial' })
    const file = await readFile(library.pathOf(v1), 'utf8')
    expect(file).toContain('name: merge-spreadsheet-exports')
    expect(await library.body(v1)).toBe(SKILL.body)
    const v2 = await library.add({ ...SKILL, body: `${SKILL.body}\n4. Report columns that did not match.`, replaces: v1.id })
    expect(v2.id).toBe('merge-spreadsheet-exports@v2')
    await expect(library.add({ ...SKILL, replaces: 'nope@v1' })).rejects.toThrow(/replaces unknown/)
    await expect(library.add({ ...SKILL, name: 'Bad Name' })).rejects.toThrow(/kebab-case/)
    await library.setStatus(v2.id, 'active', 'host', 'enabled')
    const skills = await library.skills({ includeRetired: true })
    expect(skills.find(skill => skill.id === v1.id)).toMatchObject({ status: 'retired', supersededBy: v2.id })
    expect((await library.retrieve('Please merge the store spreadsheet exports for October')).map(hit => hit.skill.id)).toEqual([v2.id])
    expect(await library.retrieve('Write a poem about autumn')).toEqual([])
  })

  it('folds a prefix (rollback is folding fewer operations)', () => {
    const at = '2026-10-19T00:00:00.000Z'
    const ops: SkillLibraryOp[] = [
      { formatVersion: 1, seq: 1, at, op: 'add', skillId: 'a@v1', actor: 'induction', name: 'a', version: 1, description: 'd', sources: [source('t')] },
      { formatVersion: 1, seq: 2, at, op: 'status', skillId: 'a@v1', actor: 'host', status: 'active' },
    ]
    expect(foldSkillLibrary(ops, 1)[0]!.status).toBe('trial')
    expect(foldSkillLibrary(ops)[0]!.status).toBe('active')
  })

  it('draws for root tasks, shares the draw with members, and enables on outcomes', async () => {
    const home = await tempDir()
    const projectRoot = await tempDir()
    const records = new Map<string, SessionRecord[]>()
    let coin = 0
    const host = new SkillLibraryHost({ projectRoot, home, readRecords: async id => records.get(id) ?? [], readOnly: async () => false, random: () => coin })
    const skill = await host.library.add(SKILL)
    const text = 'Merge the spreadsheet exports from both stores into one table'
    // Shown (coin below 0.5), then held back (coin above).
    const sessions: string[] = []
    for (let n = 0; n < 2 * HANDBOOK_EVIDENCE.activateMinPerArm; n += 1) {
      const id = `root-${n}`
      sessions.push(id)
      records.set(id, [start(id)])
      coin = n % 2 === 0 ? 0.1 : 0.9
      const injected = await host.forTurn({ sessionId: id, turn: 1, text })
      if (n % 2 === 0) {
        expect(injected).toContain(LEARNED_SKILLS_HEADER)
        expect(injected).toContain('merge-spreadsheet-exports (on trial)')
        expect(await host.skillsFor(id)).toEqual([{ name: SKILL.name, entryPath: host.library.pathOf(skill) }])
      } else {
        expect(injected).toBeUndefined()
        expect(await host.skillsFor(id)).toEqual([])
      }
    }
    // A member of a shown root sees the root's skill; a second turn draws nothing new.
    records.set('member', [start('member', { parentSessionId: 'root-0' })])
    expect((await host.skillsFor('member')).map(item => item.name)).toEqual([SKILL.name])
    expect(await host.forTurn({ sessionId: 'root-0', turn: 2, text })).toBeUndefined()
    // Outcomes: shown tasks did as well as held-back ones → enabled.
    for (const id of sessions) expect(await host.library.recordOutcome({ projectId: PROJECT, sessionId: id, taskId: id, score: 0.9, evidence: ['check'] })).toBe(true)
    expect(await host.library.recordOutcome({ projectId: PROJECT, sessionId: 'never-drawn', taskId: 'x', score: 1, evidence: ['check'] })).toBe(false)
    await host.library.applyEvidence()
    expect((await host.library.find(skill.id))?.status).toBe('active')
  })

  it('gives nothing to improvement sessions or without useShared, and draws no coin in a trial copy', async () => {
    const home = await tempDir()
    const projectRoot = await tempDir()
    const records = new Map<string, SessionRecord[]>([['imp', [start('imp', { purpose: 'improvement' })]], ['copy', [start('copy')]]])
    const text = 'Merge the spreadsheet exports from both stores into one table'
    const copy = new SkillLibraryHost({ projectRoot, home, readRecords: async id => records.get(id) ?? [], readOnly: async () => true, random: () => 0.99 })
    await copy.library.add(SKILL)
    expect(await copy.forTurn({ sessionId: 'imp', turn: 1, text })).toBeUndefined()
    expect(await copy.forTurn({ sessionId: 'copy', turn: 1, text })).toContain(SKILL.name)
    expect(await copy.library.usage.read()).toEqual([])
    expect(withLearnedSkills(undefined, 'x')).toEqual({ ids: [], text: 'x' })
    expect(withLearnedSkills({ ids: ['e'], text: 'a' }, 'b')).toEqual({ ids: ['e'], text: 'a\n\nb' })
    const { mkdir, writeFile } = await import('node:fs/promises')
    const { join } = await import('node:path')
    await mkdir(join(projectRoot, '.nexgent'), { recursive: true })
    await writeFile(join(projectRoot, '.nexgent', 'config.json'), `${JSON.stringify({ version: 1, learning: { useShared: false } })}\n`)
    records.set('later', [start('later')])
    expect(await copy.forTurn({ sessionId: 'later', turn: 1, text })).toBeUndefined()
    expect(await copy.skillsFor('copy')).toEqual([])
  })
})
