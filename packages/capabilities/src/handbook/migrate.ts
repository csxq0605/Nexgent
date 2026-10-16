/**
 * ADR 0018 decision 4: a context policy a project adopted (its
 * `instructions` and `personaSuffix`) becomes project-level, active handbook
 * entries, one per paragraph or list item. Each policy text is migrated once
 * (the operations carry `actor: 'migration'` and `source.taskId`
 * `context-policy:<sha256 of the text>`), so adopting the same policy again
 * adds nothing, and a later, changed policy adds its new parts.
 */
import { createHash } from 'node:crypto'
import { HANDBOOK_LIMITS } from '@nexgent/kernel'
import type { Handbook, HandbookChangeResult } from './handbook.js'
import { terms } from './tokens.js'

/** At most this many entries come from one policy text. */
export const MAX_MIGRATED_ENTRIES = 24

/** The migration key of a policy text. */
export function contextPolicyKey(text: string): string {
  return `context-policy:${createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 32)}`
}

function splitLong(text: string): string[] {
  const max = HANDBOOK_LIMITS.maxTextChars
  if ([...text].length <= max) return [text]
  const out: string[] = []
  let current = ''
  for (const sentence of text.split(/(?<=[.!?。！？；;])\s*/u)) {
    const next = current === '' ? sentence : `${current} ${sentence}`
    if ([...next].length <= max) {
      current = next
      continue
    }
    if (current !== '') out.push(current)
    current = sentence
    while ([...current].length > max) {
      out.push([...current].slice(0, max).join(''))
      current = [...current].slice(max).join('')
    }
  }
  if (current.trim() !== '') out.push(current)
  return out
}

/** The practices of a policy text: paragraphs, or the items of a list, each within the entry text limit. */
export function policyPractices(text: string): string[] {
  const parts: string[] = []
  for (const block of text.split(/\n\s*\n/)) {
    const lines = block.split('\n').map(line => line.trim()).filter(line => line !== '' && !/^#+\s/.test(line))
    if (lines.length === 0) continue
    const items = lines.every(line => /^([-*•]|\d+[.)])\s+/.test(line)) ? lines.map(line => line.replace(/^([-*•]|\d+[.)])\s+/, '')) : [lines.join(' ')]
    for (const item of items) parts.push(...splitLong(item.trim()))
  }
  return parts.filter(part => part !== '').slice(0, MAX_MIGRATED_ENTRIES)
}

/** Keywords of a text: its most frequent terms (words, and CJK character pairs), at most eight. */
export function deriveKeywords(text: string): string[] {
  const counts = new Map<string, number>()
  for (const term of terms(text)) {
    if ([...term].length < 2 || /^\d+$/.test(term)) continue
    counts.set(term, (counts.get(term) ?? 0) + 1)
  }
  return [...counts]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .slice(0, 8)
    .map(([term]) => term.slice(0, HANDBOOK_LIMITS.maxKeywordChars))
}

/**
 * Migrate policy texts into the project's handbook. Texts migrated before
 * are skipped.
 * @returns the results of the new entries (none when everything was migrated).
 */
export async function migrateContextPolicies(handbook: Handbook, texts: readonly string[]): Promise<HandbookChangeResult[]> {
  const done = new Set((await handbook.project.read()).filter(op => op.actor === 'migration' && op.source !== undefined).map(op => op.source!.taskId))
  const results: HandbookChangeResult[] = []
  for (const text of texts) {
    const key = contextPolicyKey(text)
    if (done.has(key)) continue
    done.add(key)
    const practices = policyPractices(text)
    results.push(...await handbook.apply(
      practices.map(practice => ({ op: 'add' as const, text: practice, keywords: deriveKeywords(practice), scope: 'project' as const, status: 'active' as const })),
      { actor: 'migration', source: { projectId: handbook.projectId, taskId: key }, },
    ))
  }
  return results
}
