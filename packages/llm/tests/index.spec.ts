import { describe, expect, it } from 'vitest'
import { packageName } from '../src/index.js'

describe('@nexgent/llm', () => {
  it('is wired into the workspace', () => {
    expect(packageName).toBe('@nexgent/llm')
  })
})
