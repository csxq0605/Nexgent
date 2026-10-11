/**
 * `SKILL.md` parsing: YAML front matter between `---` lines, then the body.
 * Fields (`docs/spec/agent-hooks.md` §技能): `name` (`SKILL_NAME_PATTERN`),
 * `description` (required, one line), `when_to_use` (optional), `tools`
 * (optional string array). Unknown fields are ignored.
 */
import { SKILL_NAME_PATTERN, type SkillManifest, type SkillSource } from '@nexgent/kernel'
import { parse as parseYaml } from 'yaml'

/** A parsed skill file, or why it cannot be used. */
export type ParsedSkill =
  | { readonly ok: true; readonly manifest: SkillManifest; readonly body: string }
  | { readonly ok: false; readonly reason: string }

/** Collapse whitespace (YAML folded / multi-line scalars) into one line. */
function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

/** Split front matter from body; `undefined` when the file does not start with a front matter block. Pure. */
export function splitFrontMatter(text: string): { readonly yaml: string; readonly body: string } | undefined {
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(source)
  if (!match) return undefined
  return { yaml: match[1]!, body: source.slice(match[0].length) }
}

/** Parse a `SKILL.md`. Pure. */
export function parseSkillFile(text: string, path: string, source: SkillSource): ParsedSkill {
  const split = splitFrontMatter(text)
  if (split === undefined) return { ok: false, reason: 'missing front matter (the file must start with a --- block)' }
  let data: unknown
  try {
    data = parseYaml(split.yaml)
  } catch (error) {
    return { ok: false, reason: `invalid YAML front matter: ${oneLine((error as Error).message)}` }
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return { ok: false, reason: 'front matter must be a mapping' }
  const fields = data as Record<string, unknown>
  const name = fields['name']
  if (typeof name !== 'string' || !SKILL_NAME_PATTERN.test(name)) {
    return { ok: false, reason: `name must match ${SKILL_NAME_PATTERN.source}, got ${JSON.stringify(name ?? null)}` }
  }
  const description = fields['description']
  if (typeof description !== 'string' || oneLine(description) === '') return { ok: false, reason: 'description is required (one line)' }
  const whenToUse = fields['when_to_use']
  if (whenToUse !== undefined && whenToUse !== null && typeof whenToUse !== 'string') return { ok: false, reason: 'when_to_use must be a string' }
  const tools = fields['tools']
  if (tools !== undefined && tools !== null && (!Array.isArray(tools) || tools.some(tool => typeof tool !== 'string'))) {
    return { ok: false, reason: 'tools must be an array of strings' }
  }
  const manifest: SkillManifest = {
    name,
    description: oneLine(description),
    ...(typeof whenToUse === 'string' && oneLine(whenToUse) !== '' ? { whenToUse: oneLine(whenToUse) } : {}),
    source,
    path,
    ...(Array.isArray(tools) ? { tools: tools as string[] } : {}),
  }
  return { ok: true, manifest, body: split.body.replace(/^\s*\n/, '') }
}
