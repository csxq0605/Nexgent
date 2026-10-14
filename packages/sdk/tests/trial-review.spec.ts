import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { ReviewInput } from '@nexgent/capabilities'
import type { Ledger, LedgerRecord, LedgerRecordInput } from '@nexgent/kernel'
import { requestText, scriptedModelServer } from '@nexgent/test-support'
import { describe, expect, it } from 'vitest'
import { documentText, llmReviewer, renderInputs } from '../src/trial-entry.js'
import { tempDir } from './helpers.js'

const KEY = 'sk-trial-review-test-key-5d1a'
const fixture = (name: string) => readFile(fileURLToPath(new URL(`../../skill/tests/fixtures/${name}`, import.meta.url)))

function memoryLedger(): Ledger {
  const records: LedgerRecord[] = []
  return {
    writeFailures: 0,
    async append(record: LedgerRecordInput) {
      records.push(record as LedgerRecord)
      return record as LedgerRecord
    },
    async *read() {
      yield* records
    },
  } as Ledger
}

describe('ADR 0016: documents the reviewer is shown', () => {
  it('reads spreadsheets, Word documents and PDFs as text, other binary files not at all', async () => {
    const sheet = await documentText('out/orders.xlsx', await fixture('orders.xlsx'))
    expect(sheet).toContain('## Sheet: Summary')
    expect(sheet).toContain('Total,139.75')
    expect(await documentText('report.DOCX', await fixture('report.docx'))).toEqual(expect.any(String))
    expect(await documentText('report.pdf', await fixture('report.pdf'))).toEqual(expect.any(String))
    expect(await documentText('logo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]))).toBeUndefined()
    // A broken document is shown as binary, never an error.
    expect(await documentText('broken.xlsx', Buffer.from([0x50, 0x4b, 0xff]))).toBeUndefined()
  })
})

describe('ADR 0016: the reviewer prompt', () => {
  it('lists the input files beyond the shown ones by path', () => {
    expect(renderInputs({ files: [] })).toBe('# Input files\n(none)')
    expect(renderInputs({ files: [{ path: 'orders.csv', text: 'a,b' }], unshown: ['z.txt'], unlisted: 1 })).toBe([
      '# Input files (the project as the task started)',
      '## orders.csv\n```\na,b\n```',
      'Also in the project (contents not shown): 2 more file(s)',
      '- z.txt',
      '- … and 1 more',
    ].join('\n'))
  })


  it('shows the input files and puts the attempts in the order the gate asks for', async () => {
    const server = await scriptedModelServer({ script: Array.from({ length: 4 }, () => ({ content: '{"better": "A", "reason": "A has the south row"}', usage: { inputTokens: 40, outputTokens: 10 } })) })
    try {
      const reviewer = llmReviewer({ ledger: memoryLedger(), home: await tempDir(), env: { NEXGENT_API_KEY: KEY, NEXGENT_API_BASE_URL: server.baseUrl } })
      const input = (candidateFirst: boolean): ReviewInput => ({
        trialId: '00000000-0000-4000-8000-0000000000aa',
        set: 'selection',
        caseId: 'case-1',
        repeat: 1,
        messages: [{ text: 'total orders.csv by region' }],
        feedback: [{ comment: 'always sort the regions by name', rating: 2 }],
        inputs: { files: [{ path: 'orders.csv', text: 'region,amount\nnorth,1\nsouth,2\n' }] },
        candidate: { files: [{ path: 'out/totals.csv', text: 'CANDIDATE-OUTPUT' }] },
        baseline: { files: [{ path: 'out/totals.csv', text: 'BASELINE-OUTPUT' }] },
        candidateFirst,
      } as unknown as ReviewInput)
      const settings = { model: 'claude-sonnet-5-5', thinking: 'off' } as Parameters<typeof reviewer.review>[1]
      const first = await reviewer.review(input(true), settings, new AbortController().signal)
      const second = await reviewer.review(input(false), settings, new AbortController().signal)
      // "A" is the candidate in the first order and the baseline in the second.
      expect([first.preference, second.preference]).toEqual(['candidate', 'baseline'])
      const [asFirst, asSecond] = server.requests.map(request => requestText(request.body))
      for (const text of [asFirst!, asSecond!]) {
        expect(text).toContain('# Input files (the project as the task started)')
        expect(text).toContain('## orders.csv\n```\nregion,amount\nnorth,1\nsouth,2\n')
        expect(text).toContain('The order in which the attempts are shown means nothing.')
        // ADR 0015's feedback stays: the task, the input files, the feedback, then the attempts.
        expect(text.indexOf('# Input files')).toBeLessThan(text.indexOf('# Feedback on an earlier attempt'))
        expect(text.indexOf('always sort the regions by name')).toBeLessThan(text.indexOf('## Attempt A'))
      }
      expect(asFirst!.indexOf('CANDIDATE-OUTPUT')).toBeLessThan(asFirst!.indexOf('BASELINE-OUTPUT'))
      expect(asSecond!.indexOf('BASELINE-OUTPUT')).toBeLessThan(asSecond!.indexOf('CANDIDATE-OUTPUT'))
    } finally {
      await server.close()
    }
  })
})
