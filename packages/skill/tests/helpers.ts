import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach } from 'vitest'
import type { MaterialMetadata } from '@nexgent/kernel'

const dirs: string[] = []

/** A fresh temporary directory, removed after the test. */
export async function tempDir(prefix = 'nexgent-skill-'): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true, maxRetries: 5 })))
})

/** Absolute path of a fixture. */
export function fixture(name: string): string {
  return fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url))
}

/** Bytes of a fixture. */
export function fixtureBytes(name: string): Promise<Buffer> {
  return readFile(fixture(name))
}

/** Write `<root>/.nexgent/skills/<dir>/SKILL.md`. */
export async function writeProjectSkill(root: string, dir: string, text: string): Promise<string> {
  const skillDir = join(root, '.nexgent', 'skills', dir)
  await mkdir(skillDir, { recursive: true })
  await writeFile(join(skillDir, 'SKILL.md'), text)
  return join(skillDir, 'SKILL.md')
}

/** A SKILL.md text. */
export function skillText(name: string, description = `Does ${name}.`, body = `Instructions for ${name}.`): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`
}

/** Copy a file in as a material, the way `MaterialStore.add` lays it out. */
export async function addMaterial(root: string, name: string, bytes: Buffer, mediaType: string): Promise<MaterialMetadata> {
  const id = randomUUID()
  const dir = join(root, '.nexgent', 'materials', id)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, name), bytes)
  const material: MaterialMetadata = {
    formatVersion: 1,
    id,
    originalName: name,
    path: `.nexgent/materials/${id}/${name}`,
    size: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    mediaType,
    text: false,
    addedAt: new Date().toISOString(),
    status: 'active',
  }
  await writeFile(join(dir, 'material.json'), JSON.stringify(material, null, 2))
  return material
}
