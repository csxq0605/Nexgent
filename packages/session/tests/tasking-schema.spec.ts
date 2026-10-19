import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  toDeliverableVersionRef,
  toMaterialRef,
  type DeliverableVersion,
  type MaterialMetadata,
} from '@nexgent/kernel'
import {
  deliverableVersionSchema,
  materialMetadataSchema,
  validateDeliverableVersion,
  validateMaterialMetadata,
  validateSessionRecord,
} from '../src/index.js'
import { tempDir } from './helpers.js'

const SHA = 'c'.repeat(64)
const TS = '2026-10-11T08:00:00.000Z'

const material: MaterialMetadata = {
  formatVersion: 1,
  id: '0f0e0d0c-0b0a-4908-8706-050403020100',
  originalName: '订单 明细.csv',
  path: '.nexgent/materials/0f0e0d0c-0b0a-4908-8706-050403020100/订单 明细.csv',
  size: 2048,
  sha256: SHA,
  mediaType: 'text/csv',
  text: true,
  addedAt: TS,
  sessionId: 's1',
  status: 'active',
}

const version: DeliverableVersion = {
  formatVersion: 1,
  deliverableId: 'aa0e0d0c-0b0a-4908-8706-050403020100',
  version: 2,
  title: 'Sales summary',
  summary: 'Adds month-over-month growth',
  files: [
    { path: 'report/summary.csv', size: 120, sha256: SHA, mediaType: 'text/csv' },
    { path: 'report/README.md', size: 300, sha256: SHA, mediaType: 'text/markdown' },
  ],
  presentedAt: TS,
  sessionId: 's1',
  turn: 2,
  toolCallId: 'toolu_01',
}

describe('material.json and deliverable.json', () => {
  it('round-trip through a file and pass the schema', async () => {
    const dir = await tempDir()
    for (const [name, value, validate] of [
      ['material.json', material, validateMaterialMetadata],
      ['deliverable.json', version, validateDeliverableVersion],
    ] as const) {
      const file = join(dir, name)
      await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
      const read: unknown = JSON.parse(await readFile(file, 'utf8'))
      expect(read).toEqual(value)
      expect(validate(read)).toEqual([])
    }
    expect(validateMaterialMetadata({ ...material, status: 'removed', removedAt: TS })).toEqual([])
  })

  it('rejects malformed metadata', () => {
    expect(validateMaterialMetadata({ ...material, formatVersion: 2 })).not.toEqual([])
    expect(validateMaterialMetadata({ ...material, sha256: 'ABC' })).not.toEqual([])
    expect(validateMaterialMetadata({ ...material, status: 'deleted' })).not.toEqual([])
    expect(validateMaterialMetadata({ ...material, path: '.nexgent\\materials\\x' })).not.toEqual([])
    expect(validateMaterialMetadata({ ...material, extra: true })).not.toEqual([])
    expect(validateDeliverableVersion({ ...version, files: [] })).not.toEqual([])
    expect(validateDeliverableVersion({ ...version, version: 0 })).not.toEqual([])
    const { toolCallId: _toolCallId, ...missing } = version
    expect(validateDeliverableVersion(missing)).not.toEqual([])
  })

  it('project to the references session records carry', () => {
    const base = { seq: 2, ts: TS, sessionId: 's1' }
    expect(validateSessionRecord({ ...base, type: 'material.added', material: toMaterialRef(material) })).toEqual([])
    expect(validateSessionRecord({
      ...base,
      type: 'deliverable.presented',
      turn: 2,
      step: 1,
      toolCallId: version.toolCallId,
      deliverable: toDeliverableVersionRef(version),
    })).toEqual([])
  })

  it('are published verbatim as schema/*.v1.schema.json', async () => {
    const material = await readFile(new URL('../schema/material.v1.schema.json', import.meta.url), 'utf8')
    const deliverable = await readFile(new URL('../schema/deliverable.v1.schema.json', import.meta.url), 'utf8')
    expect(JSON.parse(material)).toEqual(materialMetadataSchema)
    expect(JSON.parse(deliverable)).toEqual(deliverableVersionSchema)
  })
})
