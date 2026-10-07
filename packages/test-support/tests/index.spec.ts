import { describe, expect, it } from 'vitest'
import { scriptedModelServer } from '../src/index.js'

describe('scriptedModelServer (stub)', () => {
  it('exposes the factory and reports that step 1 has not implemented it', async () => {
    expect(typeof scriptedModelServer).toBe('function')
    await expect(scriptedModelServer({ script: [] })).rejects.toThrow(/step 1/)
  })
})
