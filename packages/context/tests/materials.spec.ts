import { createHash, randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { MaterialMetadata } from '@nexgent/kernel'
import { materialsProvider, planMaterialReferences, readMaterialMetadata, renderMaterialReferences } from '../src/index.js'
import { tempDir, turnInput } from './helpers.js'

/** Write a material the way `MaterialStore.add` lays it out. */
async function addMaterial(root: string, name: string, content: Buffer | string, overrides: Partial<MaterialMetadata> = {}): Promise<MaterialMetadata> {
  const id = randomUUID()
  const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content)
  const dir = join(root, '.nexgent', 'materials', id)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, name), buffer)
  const material: MaterialMetadata = {
    formatVersion: 1,
    id,
    originalName: name,
    path: `.nexgent/materials/${id}/${name}`,
    size: buffer.byteLength,
    sha256: createHash('sha256').update(buffer).digest('hex'),
    mediaType: name.endsWith('.csv') ? 'text/csv' : name.endsWith('.xlsx') ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'text/plain',
    text: !name.endsWith('.xlsx') && !name.endsWith('.bin'),
    addedAt: '2026-10-11T08:00:00.000Z',
    status: 'active',
    ...overrides,
  }
  await writeFile(join(dir, 'material.json'), JSON.stringify(material, null, 2))
  return material
}

/** The numbered entries of a rendered reference list, as `{ name, path, content }`. */
function entries(text: string): { name: string; path?: string; content?: string }[] {
  const list = text.split('\n\nContent of ')[0]!
  const result: { name: string; path?: string; content?: string }[] = []
  for (const line of list.split('\n')) {
    const item = /^\d+\. (.*)$/.exec(line)
    if (item) {
      result.push({ name: item[1]! })
      continue
    }
    const field = /^ {3}- (path|content): (.*)$/.exec(line)
    if (field && result.length > 0) result[result.length - 1]![field[1] as 'path' | 'content'] = field[2]!
  }
  return result
}

describe('materials provider', () => {
  it('gives nothing when the message attaches no materials', async () => {
    const root = await tempDir()
    expect(await materialsProvider().beginTurn(turnInput(root))).toEqual({})
  })

  it('inlines a small text file, gives a large text file and a binary .xlsx by path, as one inject message', async () => {
    const root = await tempDir()
    const csv = await addMaterial(root, 'orders.csv', 'id,qty\n1,3\n2,```5\n')
    const big = await addMaterial(root, 'log.txt', 'y'.repeat(40 * 1024))
    const xlsx = await addMaterial(root, 'sales.xlsx', Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 1, 2]))
    const contribution = await materialsProvider().beginTurn(turnInput(root, { materialIds: [csv.id, big.id, xlsx.id] }))
    expect(contribution.systemSections).toBeUndefined()
    expect(contribution.inject).toHaveLength(1)
    const text = contribution.inject![0]!

    expect(text.split('\n')[0]).toContain('read-only copies under .nexgent/materials/')
    expect(entries(text)).toEqual([
      { name: 'orders.csv', path: csv.path, content: 'inlined below' },
      { name: 'log.txt', path: big.path, content: 'not inlined (too large); read it with read_file (use offset/limit for large files)' },
      { name: 'sales.xlsx', path: xlsx.path, content: 'not inlined (binary); read it with read_document' },
    ])
    // The inlined block is fenced so the content's own backticks cannot close it.
    const block = text.split(`Content of ${csv.path}:\n`)[1]!
    expect(block).toBe('````\nid,qty\n1,3\n2,```5\n````')
    expect(text).not.toContain('y'.repeat(100))
    expect(text).not.toContain(`Content of ${big.path}`)
  })

  it('keeps the total inline budget and reports unknown, removed and changed materials', async () => {
    const root = await tempDir()
    const a = await addMaterial(root, 'a.txt', 'a'.repeat(600))
    const b = await addMaterial(root, 'b.txt', 'b'.repeat(600))
    const removed = await addMaterial(root, 'old.txt', 'old', { status: 'removed', removedAt: '2026-10-11T09:00:00.000Z' })
    const changed = await addMaterial(root, 'changed.txt', 'before')
    await writeFile(join(root, ...changed.path.split('/')), 'after!')
    const unknown = randomUUID()

    const refs = await planMaterialReferences([a.id, b.id, removed.id, changed.id, unknown, a.id], root, { inlineTotalMaxBytes: 1000 })
    expect(refs.map(ref => [ref.kind, 'reason' in ref ? ref.reason : undefined])).toEqual([
      ['inline', undefined],
      ['path', 'budget'],
      ['missing', 'removed'],
      ['path', 'changed'],
      ['missing', 'unknown'],
    ])
    const text = renderMaterialReferences(refs)
    expect(entries(text).map(entry => entry.name)).toEqual([
      'a.txt',
      'b.txt',
      `old.txt (${removed.id}): removed by the user; do not use it`,
      'changed.txt',
      `${unknown}: not found`,
    ])
  })

  it('never reads a material whose metadata points outside its own directory', async () => {
    const root = await tempDir()
    await writeFile(join(root, 'secret.txt'), 'secret')
    const material = await addMaterial(root, 'x.txt', 'secret')
    const forged = { ...material, path: '.nexgent/materials/../../secret.txt' }
    const refs = await planMaterialReferences([material.id], root, { lookup: async () => forged })
    expect(refs).toEqual([{ kind: 'path', id: material.id, material: forged, reason: 'unreadable' }])
  })

  it('reads material.json from disk and refuses a file that fails its schema', async () => {
    const root = await tempDir()
    const material = await addMaterial(root, 'n.txt', 'n')
    expect(await readMaterialMetadata(material.id, root)).toEqual(material)
    expect(await readMaterialMetadata('not-a-uuid', root)).toBeUndefined()
    await writeFile(join(root, '.nexgent', 'materials', material.id, 'material.json'), JSON.stringify({ ...material, sha256: 'nope' }))
    await expect(readMaterialMetadata(material.id, root)).rejects.toMatchObject({ code: 'session/corrupt' })
    await expect(materialsProvider().beginTurn(turnInput(root, { materialIds: [material.id] }))).rejects.toMatchObject({ code: 'session/corrupt' })
  })
})
