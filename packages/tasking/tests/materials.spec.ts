import { existsSync, readFileSync } from 'node:fs'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import * as nodePath from 'node:path'
import { NexgentError } from '@nexgent/kernel'
import { validateMaterialMetadata, validateSessionRecord } from '@nexgent/session'
import { describe, expect, it } from 'vitest'
import { guessMediaType, materialAddedRecord, storedNameFor } from '../src/index.js'
import { project, SESSION_A, sha256Of } from './helpers.js'

const XLSX_MAGIC = Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x06, 0x00, 0x08, 0x00, 0x00, 0x00, 0x21, 0x00])

describe('materials', () => {
  it('copies a file into materials/<id>/, writes valid metadata and leaves the source untouched', async () => {
    const p = await project()
    const source = nodePath.join(p.outside, 'orders.csv')
    await writeFile(source, 'id,amount\n1,"1,200"\n2,30\n')
    const before = sha256Of(source)
    const material = await p.tasking.materials.add({ sourcePath: source, sessionId: SESSION_A })

    expect(validateMaterialMetadata(material)).toEqual([])
    expect(material).toMatchObject({
      formatVersion: 1,
      originalName: 'orders.csv',
      path: `.nexgent/materials/${material.id}/orders.csv`,
      mediaType: 'text/csv',
      text: true,
      sessionId: SESSION_A,
      status: 'active',
      size: Buffer.byteLength('id,amount\n1,"1,200"\n2,30\n'),
    })
    expect(material.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    // K1: the record keeps the logical path; the copy lives in the data directory.
    const copy = nodePath.join(p.workspace.layout.materials, material.id, 'orders.csv')
    expect(sha256Of(copy)).toBe(before)
    expect(material.sha256).toBe(before)
    expect(sha256Of(source)).toBe(before)
    const onDisk = JSON.parse(await readFile(nodePath.join(p.workspace.layout.materials, material.id, 'material.json'), 'utf8'))
    expect(onDisk).toEqual(material)
    expect(p.tasking.materials.absolutePath(material)).toBe(copy)
  })

  it('treats office files and bytes that are not UTF-8 as binary', async () => {
    const p = await project()
    const xlsx = nodePath.join(p.outside, 'regions.xlsx')
    await writeFile(xlsx, XLSX_MAGIC)
    const blob = nodePath.join(p.outside, 'data.bin')
    await writeFile(blob, Uint8Array.from([0xff, 0xfe, 0x00, 0x41]))
    const notes = nodePath.join(p.outside, 'NOTES')
    await writeFile(notes, '中文说明\n')
    const [a, b, c] = [await p.tasking.materials.add({ sourcePath: xlsx }), await p.tasking.materials.add({ sourcePath: blob }), await p.tasking.materials.add({ sourcePath: notes })]
    expect(a).toMatchObject({ mediaType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', text: false })
    expect(a.sessionId).toBeUndefined()
    expect(b).toMatchObject({ mediaType: 'application/octet-stream', text: false })
    expect(c).toMatchObject({ mediaType: 'application/octet-stream', text: true, originalName: 'NOTES' })
  })

  it('rejects a missing source and a directory with workspace/not-found', async () => {
    const p = await project()
    await expect(p.tasking.materials.add({ sourcePath: nodePath.join(p.outside, 'nope.csv') })).rejects.toMatchObject({ code: 'workspace/not-found' })
    await expect(p.tasking.materials.add({ sourcePath: p.outside })).rejects.toBeInstanceOf(NexgentError)
    expect((await readdir(p.workspace.layout.materials)).length).toBe(0)
  })

  it('lists oldest first, gets by id, and removal only changes the metadata', async () => {
    let tick = 0
    const p = await project()
    const { createTaskingService } = await import('../src/index.js')
    const tasking = createTaskingService(p.workspace.layout, p.sessions, { now: () => new Date(Date.UTC(2026, 9, 11, 8, 0, tick++)) })
    const files = ['b.txt', 'a.txt']
    for (const name of files) await writeFile(nodePath.join(p.outside, name), name)
    const first = await tasking.materials.add({ sourcePath: nodePath.join(p.outside, 'b.txt') })
    const second = await tasking.materials.add({ sourcePath: nodePath.join(p.outside, 'a.txt') })
    expect((await tasking.materials.list()).map(m => m.id)).toEqual([first.id, second.id])
    expect(await tasking.materials.get(second.id)).toEqual(second)
    expect(await tasking.materials.get('../../config')).toBeUndefined()
    expect(await tasking.materials.get('00000000-0000-4000-8000-000000000000')).toBeUndefined()

    const removed = await tasking.materials.remove(first.id)
    expect(removed).toMatchObject({ status: 'removed', removedAt: '2026-10-11T08:00:02.000Z' })
    expect(validateMaterialMetadata(removed)).toEqual([])
    expect(existsSync(tasking.materials.absolutePath(first))).toBe(true)
    expect((await tasking.materials.list()).map(m => m.id)).toEqual([second.id])
    expect((await tasking.materials.list({ includeRemoved: true })).map(m => m.id)).toEqual([first.id, second.id])
    expect(await tasking.materials.remove(first.id)).toEqual(removed)
    await expect(tasking.materials.remove('00000000-0000-4000-8000-000000000000')).rejects.toMatchObject({ code: 'workspace/not-found' })
  })

  it('never lists a half-written material and removes leftovers on cleanup', async () => {
    const p = await project()
    const tmp = nodePath.join(p.workspace.layout.materials, '.tmp-00000000-0000-4000-8000-000000000000')
    await mkdir(tmp, { recursive: true })
    await writeFile(nodePath.join(tmp, 'orders.csv'), 'partial')
    const corrupt = nodePath.join(p.workspace.layout.materials, '33333333-3333-4333-8333-333333333333')
    await mkdir(corrupt)
    await writeFile(nodePath.join(corrupt, 'material.json'), '{"formatVersion":1,')
    expect(await p.tasking.materials.list({ includeRemoved: true })).toEqual([])
    expect(await p.tasking.cleanup()).toBe(1)
    expect(existsSync(tmp)).toBe(false)
  })

  it('builds a valid material.added host record', async () => {
    const p = await project()
    const source = nodePath.join(p.outside, 'orders.csv')
    await writeFile(source, 'x\n')
    const material = await p.tasking.materials.add({ sourcePath: source })
    const record = materialAddedRecord(material)
    expect(record).toEqual({ type: 'material.added', material: { id: material.id, originalName: 'orders.csv', path: material.path, size: 2, sha256: material.sha256, mediaType: 'text/csv' } })
    expect(validateSessionRecord({ ...record, seq: 2, ts: '2026-10-11T08:00:00.000Z', sessionId: SESSION_A })).toEqual([])
  })

  it('is visible to a new service instance (restart)', async () => {
    const p = await project()
    const source = nodePath.join(p.outside, 'orders.csv')
    await writeFile(source, 'x\n')
    const material = await p.tasking.materials.add({ sourcePath: source })
    expect(await p.reopen().materials.list()).toEqual([material])
    expect(readFileSync(p.tasking.materials.absolutePath(material), 'utf8')).toBe('x\n')
  })
})

describe('stored names and media types', () => {
  it('sanitizes names as data-formats.md says', () => {
    expect(storedNameFor('orders.csv')).toBe('orders.csv')
    expect(storedNameFor('a:b*c?"d<e>f|g.txt')).toBe('a_b_c__d_e_f_g.txt')
    expect(storedNameFor('dir/sub\\name.txt')).toBe('name.txt')
    expect(storedNameFor('trailing. . ')).toBe('trailing')
    expect(storedNameFor('tab\there.md')).toBe('tab_here.md')
    expect(storedNameFor('CON.txt')).toBe('material.txt')
    expect(storedNameFor('nul')).toBe('material')
    expect(storedNameFor('...')).toBe('material')
    expect(storedNameFor('报表.xlsx')).toBe('报表.xlsx')
  })

  it('guesses media types from the extension, case-insensitively', () => {
    expect(guessMediaType('A.CSV')).toBe('text/csv')
    expect(guessMediaType('report.md')).toBe('text/markdown')
    expect(guessMediaType('doc.pdf')).toBe('application/pdf')
    expect(guessMediaType('weird.zzz')).toBe('application/octet-stream')
  })
})
