import { describe, expect, it } from 'vitest'
import { diffLines, renderHunks, splitLines, textHunks } from '../src/index.js'

/** Apply an edit script to check it really turns `a` into `b`. */
function apply(script: ReturnType<typeof diffLines>): { a: string[]; b: string[] } {
  return {
    a: script.filter(line => line.op !== 'add').map(line => line.text),
    b: script.filter(line => line.op !== 'remove').map(line => line.text),
  }
}

describe('line diff', () => {
  it('splits CRLF and LF alike and ignores a final newline', () => {
    expect(splitLines('')).toEqual([])
    expect(splitLines('a\r\nb\n')).toEqual(['a', 'b'])
    expect(splitLines('a\n\n')).toEqual(['a', ''])
  })

  it('produces a minimal script that reproduces both sides', () => {
    const a = ['a', 'b', 'c', 'a', 'b', 'b', 'a']
    const b = ['c', 'b', 'a', 'b', 'a', 'c']
    const script = diffLines(a, b)
    expect(apply(script)).toEqual({ a, b })
    expect(script.filter(line => line.op !== 'context')).toHaveLength(5)
  })

  it('handles random edits', () => {
    let seed = 7
    const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648
    for (let round = 0; round < 50; round++) {
      const a = Array.from({ length: Math.floor(random() * 30) }, () => String.fromCharCode(97 + Math.floor(random() * 4)))
      const b = a.filter(() => random() > 0.2).flatMap(line => (random() > 0.8 ? [line, 'x'] : [line]))
      expect(apply(diffLines(a, b))).toEqual({ a, b })
    }
  })

  it('groups changes into hunks with three lines of context, merging close ones', () => {
    const before = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n')
    const after = before.replace('line 2\n', 'line two\n').replace('line 5\n', 'line five\n').replace('line 18\n', '')
    const hunks = textHunks(before, after)
    expect(hunks.map(h => [h.fromStart, h.fromLines, h.toStart, h.toLines])).toEqual([[1, 8, 1, 8], [15, 6, 15, 5]])
    expect(renderHunks(hunks)).toContain('@@ -15,6 +15,5 @@\n line 15\n line 16\n line 17\n-line 18\n line 19\n line 20')
    expect(textHunks('same\n', 'same\r\n')).toEqual([])
    expect(textHunks('a\n', '')).toEqual([{ fromStart: 1, fromLines: 1, toStart: 0, toLines: 0, lines: [{ op: 'remove', text: 'a' }] }])
  })

  it('stays fast on large inputs with few changes', () => {
    const a = Array.from({ length: 50_000 }, (_, i) => `row ${i}`)
    const b = [...a]
    b[25_000] = 'changed'
    const started = Date.now()
    const hunks = textHunks(a.join('\n'), b.join('\n'))
    expect(hunks).toHaveLength(1)
    expect(Date.now() - started).toBeLessThan(2000)
  })
})
