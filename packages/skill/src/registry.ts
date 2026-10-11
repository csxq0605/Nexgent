/**
 * `SkillRegistry` over three directories: the built-in skills shipped in
 * this package (`skills/<name>/SKILL.md`), the user's
 * `~/.nexgent/skills/<name>/SKILL.md` (step 3) and the project's
 * `.nexgent/skills/<name>/SKILL.md`; for one name project overrides user
 * overrides built-in. Every call rescans, so a skill added mid-session
 * shows up at the next turn.
 */
import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  NexgentError,
  PROJECT_SKILLS_DIR,
  SKILL_FILE,
  type LoadedSkill,
  type SkillCatalog,
  type SkillManifest,
  type SkillProblem,
  type SkillRegistry,
  type SkillSource,
} from '@nexgent/kernel'
import { parseSkillFile } from './frontmatter.js'

/** The skills shipped with this package. */
export const BUILTIN_SKILLS_DIR = fileURLToPath(new URL('../skills', import.meta.url))

/** A `SKILL.md` larger than this is refused (it would not fit a tool result anyway). */
export const MAX_SKILL_FILE_BYTES = 256 * 1024

/** Options of {@link FileSkillRegistry}. */
export interface FileSkillRegistryOptions {
  /** Absolute project root; project skills live in `<root>/.nexgent/skills`. */
  readonly projectRoot: string
  /** Built-in skills directory; default {@link BUILTIN_SKILLS_DIR}. */
  readonly builtinDir?: string
  /** User skills directory (absolute; normally `<Nexgent home>/skills`); absent: no user skills. */
  readonly userDir?: string
}

interface Found {
  readonly manifest: SkillManifest
  readonly body: string
}

async function scanDirectory(dir: string, source: SkillSource, problems: SkillProblem[]): Promise<Found[]> {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return []
    problems.push({ path: dir, reason: `cannot list skills: ${code ?? String(error)}` })
    return []
  }
  const found: Found[] = []
  const seen = new Map<string, string>()
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    if (entry.name.startsWith('.')) continue
    const skillDir = join(dir, entry.name)
    const path = join(skillDir, SKILL_FILE)
    let info
    try {
      if (!(await stat(skillDir)).isDirectory()) continue
      info = await stat(path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      problems.push({ path, reason: `cannot read: ${(error as NodeJS.ErrnoException).code ?? String(error)}` })
      continue
    }
    if (!info.isFile()) continue
    if (info.size > MAX_SKILL_FILE_BYTES) {
      problems.push({ path, reason: `file is ${info.size} bytes; the limit is ${MAX_SKILL_FILE_BYTES}` })
      continue
    }
    let text: string
    try {
      text = await readFile(path, 'utf8')
    } catch (error) {
      problems.push({ path, reason: `cannot read: ${(error as NodeJS.ErrnoException).code ?? String(error)}` })
      continue
    }
    const parsed = parseSkillFile(text, path, source)
    if (!parsed.ok) {
      problems.push({ path, reason: parsed.reason })
      continue
    }
    const earlier = seen.get(parsed.manifest.name)
    if (earlier !== undefined) {
      problems.push({ path, reason: `duplicate skill name ${parsed.manifest.name} (also defined in ${earlier})` })
      continue
    }
    seen.set(parsed.manifest.name, path)
    found.push({ manifest: parsed.manifest, body: parsed.body })
  }
  return found
}

/** The file-backed {@link SkillRegistry}. */
export class FileSkillRegistry implements SkillRegistry {
  readonly projectRoot: string
  readonly builtinDir: string
  readonly userDir: string | undefined

  constructor(options: FileSkillRegistryOptions) {
    this.projectRoot = options.projectRoot
    this.builtinDir = options.builtinDir ?? BUILTIN_SKILLS_DIR
    this.userDir = options.userDir
  }

  /** Absolute directory of project skills. */
  get projectDir(): string {
    return join(this.projectRoot, ...PROJECT_SKILLS_DIR.split('/'))
  }

  private async scan(): Promise<{ skills: Found[]; problems: SkillProblem[] }> {
    const problems: SkillProblem[] = []
    const builtin = await scanDirectory(this.builtinDir, 'builtin', problems)
    const user = this.userDir === undefined ? [] : await scanDirectory(this.userDir, 'user', problems)
    const project = await scanDirectory(this.projectDir, 'project', problems)
    const byName = new Map<string, Found>()
    // Later sources override earlier ones of the same name: project > user > built-in.
    for (const skill of [...builtin, ...user, ...project]) byName.set(skill.manifest.name, skill)
    const skills = [...byName.values()].sort((a, b) => (a.manifest.name < b.manifest.name ? -1 : 1))
    return { skills, problems }
  }

  async catalog(): Promise<SkillCatalog> {
    const { skills, problems } = await this.scan()
    return { skills: skills.map(skill => skill.manifest), problems }
  }

  async load(name: string): Promise<LoadedSkill> {
    const { skills, problems } = await this.scan()
    const skill = skills.find(candidate => candidate.manifest.name === name)
    if (skill === undefined) {
      const broken = problems.find(problem => basename(dirname(problem.path)) === name)
      throw new NexgentError('tool/not-found', `unknown skill ${JSON.stringify(name)}${broken === undefined ? '' : ` (${broken.path}: ${broken.reason})`}; available: ${skills.map(s => s.manifest.name).join(', ') || '(none)'}`)
    }
    return { manifest: skill.manifest, body: skill.body }
  }
}
