/**
 * The H judges of accept-step3: each decides one checklist item from the
 * observations step3-headless.mjs collected. Judges are pure — they read
 * `obs`, touch no files and start nothing — so each is tested against a
 * deliberately broken observation (packages/test-support/tests/accept-step3.spec.ts).
 *
 * Only items whose product side exists get a judge; the rest stay out of
 * {@link JUDGES} and are reported `not-implemented` by the runner.
 */
import { verdict } from './step2-judges.mjs'

/** Top-level paths the old Python products used (plan W7, check H23). */
export const FORBIDDEN_TOP_LEVEL = ['nexgent', 'tests', 'config.py', 'runtime']
const isForbidden = path => {
  const top = path.split('/')[0] ?? ''
  return FORBIDDEN_TOP_LEVEL.includes(top) || /^stage-/.test(top)
}

/** H23: no Python file and none of the old top-level directories in the repository's tracked files. */
function h23(obs) {
  const files = obs.repo?.files
  if (!Array.isArray(files) || files.length === 0) return { status: 'failed', evidence: 'no repository file list was collected' }
  const python = files.filter(path => /\.py$/i.test(path))
  const old = [...new Set(files.filter(isForbidden).map(path => path.split('/')[0]))]
  return verdict([
    [python.length === 0, `${python.length} Python file(s), e.g. ${python.slice(0, 3).join(', ')}`],
    [old.length === 0, `old top-level paths present: ${old.join(', ')}`],
  ], `${files.length} tracked files (${obs.repo.source}); no *.py, no ${FORBIDDEN_TOP_LEVEL.join(', ')}, stage-*`)
}

/** Judges by checklist id. */
export const JUDGES = { H23: h23 }

/** Run one judge; a throw is a failure, a missing judge is not-implemented. */
export function judge(id, obs) {
  const fn = JUDGES[id]
  if (fn === undefined) return { status: 'not-implemented', evidence: 'no judge' }
  try {
    return fn(obs ?? {})
  } catch (error) {
    return { status: 'failed', evidence: `judge threw: ${error instanceof Error ? error.message : String(error)}` }
  }
}
