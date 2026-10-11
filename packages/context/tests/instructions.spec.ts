import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadInstructions, workspaceInstructionsProvider } from '../src/index.js'
import { tempDir, turnInput } from './helpers.js'

describe('workspace-instructions provider', () => {
  it('injects AGENTS.md as a "Project instructions" system section and writes nothing to the session', async () => {
    const root = await tempDir()
    await writeFile(join(root, 'AGENTS.md'), '# Rules\n\nAlways write reports in Chinese.\n')
    const contribution = await workspaceInstructionsProvider().beginTurn(turnInput(root))
    expect(contribution.inject).toBeUndefined()
    expect(contribution.systemSections).toHaveLength(1)
    const [section] = contribution.systemSections!
    expect(section).toMatchObject({ id: 'workspace-instructions', title: 'Project instructions' })
    expect(section!.body).toContain('from AGENTS.md in the project root')
    expect(section!.body).toContain('# Rules\n\nAlways write reports in Chinese.')
    expect(section!.body).not.toContain('only the beginning is shown')
  })

  it('falls back to NEXGENT.md, prefers AGENTS.md when both exist, and gives nothing when neither exists', async () => {
    const root = await tempDir()
    const provider = workspaceInstructionsProvider()
    expect(await provider.beginTurn(turnInput(root))).toEqual({})

    await writeFile(join(root, 'NEXGENT.md'), 'Use metric units.')
    const fallback = await provider.beginTurn(turnInput(root))
    expect(fallback.systemSections?.[0]?.body).toContain('from NEXGENT.md')
    expect(fallback.systemSections?.[0]?.body).toContain('Use metric units.')

    await writeFile(join(root, 'AGENTS.md'), 'Use imperial units.')
    const both = await provider.beginTurn(turnInput(root))
    expect(both.systemSections?.[0]?.body).toContain('Use imperial units.')
    expect(both.systemSections?.[0]?.body).not.toContain('metric')
  })

  it('treats a blank AGENTS.md as no instructions (no fallback) and a directory named AGENTS.md as absent', async () => {
    const blank = await tempDir()
    await writeFile(join(blank, 'AGENTS.md'), '  \n\n')
    await writeFile(join(blank, 'NEXGENT.md'), 'ignored')
    expect(await workspaceInstructionsProvider().beginTurn(turnInput(blank))).toEqual({})

    const dir = await tempDir()
    await mkdir(join(dir, 'AGENTS.md'))
    await writeFile(join(dir, 'NEXGENT.md'), 'from nexgent')
    expect((await loadInstructions(dir))?.file).toBe('NEXGENT.md')
  })

  it('truncates an oversized file at a character boundary and says so', async () => {
    const root = await tempDir()
    // 3-byte characters, no line breaks: the cut must not split one.
    const text = '说明'.repeat(2000)
    await writeFile(join(root, 'AGENTS.md'), text)
    const loaded = await loadInstructions(root, 1000)
    expect(loaded).toMatchObject({ file: 'AGENTS.md', truncated: true, size: Buffer.byteLength(text) })
    expect(Buffer.byteLength(loaded!.text)).toBeLessThanOrEqual(1000)
    expect(loaded!.text).not.toContain('�')
    expect(text.startsWith(loaded!.text)).toBe(true)

    const section = (await workspaceInstructionsProvider({ maxBytes: 1000 }).beginTurn(turnInput(root))).systemSections?.[0]
    expect(section?.body).toContain('[AGENTS.md is 11.7 KiB; only the beginning is shown here. Read the file for the rest.]')
  })

  it('prefers to cut at a line break near the limit', async () => {
    const root = await tempDir()
    const lines = Array.from({ length: 100 }, (_, i) => `line ${String(i).padStart(3, '0')} ${'x'.repeat(40)}`)
    await writeFile(join(root, 'AGENTS.md'), lines.join('\n'))
    const loaded = await loadInstructions(root, 500)
    expect(loaded!.text.endsWith('\n')).toBe(true)
    expect(loaded!.text.split('\n').filter(Boolean).every(line => lines.includes(line))).toBe(true)
  })

  it('rejects a bad maxBytes', () => {
    expect(() => workspaceInstructionsProvider({ maxBytes: 0 })).toThrow(expect.objectContaining({ code: 'config/invalid' }))
  })
})
