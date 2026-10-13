/**
 * Judges of the step-6 items wired so far, over the observations of
 * step6-headless.mjs (H01–H03) and step6-experiment.mjs (E01, E04). Pure: each
 * takes observations and returns `{ status: 'passed' | 'failed', evidence }`.
 * Missing observations fail; nothing here passes on absence.
 * Counterexamples: packages/test-support/tests/accept-step6.spec.ts.
 */

const V0 = 'v0'
const VERSION = /^[a-f0-9]{64}$/
const ACTIVE = ['diagnosing', 'proposing', 'trialing']
const FINAL = ['adopted', 'rejected', 'no-proposal', 'budget-exhausted', 'failed', 'interrupted', 'cancelled']

const pass = evidence => ({ status: 'passed', evidence })
const fail = (problems, context = '') => ({ status: 'failed', evidence: `${problems.join('; ')}${context === '' ? '' : ` (${context})`}` })
const short = version => (typeof version === 'string' && version.length > 12 ? `${version.slice(0, 12)}…` : String(version))
/** The version a record or job reads as: absent means `v0` (contract). */
const effective = version => version ?? V0

/** Records whose effective version is not `want`, grouped `phase type version × n`. */
function strayRecords(records, want) {
  const groups = new Map()
  for (const record of records) {
    if (effective(record.improverVersion) === want) continue
    const key = `${record.improvementPhase ?? '—'} ${record.type} ${record.improverVersion === undefined ? '(absent → v0)' : short(record.improverVersion)}`
    groups.set(key, (groups.get(key) ?? 0) + 1)
  }
  return [...groups].map(([key, n]) => `${key} ×${n}`)
}

/**
 * H01: the step-5 projects (no improver written) run on `v0`; step 5's items pass.
 * @param obs - `v0Phase` output.
 * @param regression - H18's verdict over step 5's H01–H19.
 */
export function judgeV0(obs, regression) {
  if (obs === undefined) return fail(['the v0 observations are missing'])
  const problems = []
  const projects = obs.projects ?? []
  const jobs = projects.flatMap(p => p.jobs.map(job => ({ ...job, root: p.root })))
  const sessions = projects.flatMap(p => p.sessions.map(s => ({ ...s, root: p.root })))
  const ledger = projects.flatMap(p => p.ledger)
  if (jobs.length === 0) problems.push('no improvement job in the step-5 projects')
  const pinned = jobs.filter(job => job.improverVersion === V0)
  if (pinned.length === 0) problems.push('no job wrote improverVersion v0 into job.json')
  for (const job of jobs) if (effective(job.improverVersion) !== V0) problems.push(`${job.root} job ${job.jobId.slice(0, 8)} pinned ${short(job.improverVersion)}`)
  // A job that reached diagnosis pins its version (only a job stopped before it may lack one).
  for (const job of jobs) if (job.improverVersion === undefined && job.history.includes('diagnosing')) problems.push(`${job.root} job ${job.jobId.slice(0, 8)} reached diagnosis without improverVersion`)
  for (const s of sessions) if (effective(s.improverVersion) !== V0) problems.push(`${s.root} session ${s.id.slice(0, 8)} header says ${short(s.improverVersion)}`)
  if (sessions.length === 0) problems.push('no improvement session in the step-5 projects')
  const stray = strayRecords(ledger, V0)
  if (stray.length > 0) problems.push(`ledger records not on v0: ${stray.join(', ')}`)
  const withDir = projects.filter(p => p.improversDir).map(p => p.root)
  if (withDir.length > 0) problems.push(`.nexgent/improvers/ appeared in ${withDir.join(', ')}`)
  if (regression?.status !== 'passed') problems.push(`step 5 regression: ${regression?.evidence ?? 'not judged'}`)
  const context = `${projects.length} step-5 projects, ${jobs.length} jobs (${pinned.length} with v0 in job.json), ${sessions.length} improvement sessions, ${ledger.length} job ledger records`
  if (problems.length > 0) return fail(problems, context)
  return pass(`${context}: every job, improvement session header and job ledger record reads v0; no .nexgent/improvers/ in any project; ${regression.evidence}`)
}

/** H02: the improver store. @param obs - `storePhase` output. */
export function judgeStore(obs) {
  if (obs === undefined) return fail(['the store observations are missing'])
  const problems = []
  const c = obs.content ?? {}
  const v = c.first?.version
  if (!VERSION.test(v ?? '')) problems.push(`first write gave version ${String(v)}`)
  if (c.first?.created !== true) problems.push('the first write did not create a file')
  if (c.again?.version !== v || c.again?.created !== false) problems.push('writing the same improver again did not give the same version without a new file')
  if (c.reordered?.version !== v) problems.push('the same content with keys reordered gave another version')
  if (c.other?.version === v || !VERSION.test(c.other?.version ?? '')) problems.push('a different improver did not get its own version')
  if (c.versionOfContent !== v || c.canonicalSha !== v) problems.push('the version is not the sha-256 of the canonical improver text')
  if (c.v0Write?.version !== V0 || c.v0Write?.created !== false) problems.push('writing v0 stored a file or gave another version')
  if (JSON.stringify(c.storedVersions) !== JSON.stringify([v, c.other?.version].sort())) problems.push(`stored versions ${JSON.stringify(c.storedVersions)}`)

  const chain = obs.chain ?? {}
  const revisions = chain.revisions ?? []
  if (revisions.length !== 3) problems.push(`expected 3 revisions (adopt, adopt, rollback), found ${revisions.length}`)
  revisions.forEach((revision, i) => {
    const want = i === 0 ? null : chain.digests?.[i - 1]
    if (revision.previous !== want) problems.push(`revision ${revision.revision} names previous ${short(revision.previous)}, not the digest of revision ${i}`)
    if (revision.revision !== i + 1) problems.push(`revision ${i + 1} is numbered ${revision.revision}`)
  })
  if (chain.activation?.digest !== chain.digests?.at(-1)) problems.push('the activation digest is not the digest of the last revision')
  if (obs.adoptAgain?.code !== 'improver/activation') problems.push(`adopting the improver in force again was ${obs.adoptAgain?.code ?? 'accepted'}`)
  const back = revisions[2]
  if (back?.type !== 'rollback' || back?.version !== v || back?.from !== c.other?.version || back?.trigger !== 'manual') problems.push('the rollback is not a new revision returning to the earlier improver')
  if (JSON.stringify(chain.bundlesKept) !== JSON.stringify(c.storedVersions)) problems.push('a rollback removed an improver file')

  const d = obs.damage ?? {}
  if (d.resolved?.version !== V0) problems.push(`with the improver in force damaged, resolve gave ${short(d.resolved?.version ?? d.resolved?.code)}`)
  if (d.resolved?.rollbacks?.[0]?.version !== d.version || d.resolved?.rollbacks?.[0]?.code !== 'improver/invalid') problems.push('resolve did not report the damaged improver as rolled back (improver/invalid)')
  if (d.tail?.type !== 'rollback' || d.tail?.trigger !== 'load-failure' || d.tail?.version !== V0) problems.push('no load-failure rollback revision to v0 was written')
  if (d.loadAfter?.code !== 'improver/invalid') problems.push('the damaged improver still loads')
  if (d.fileKept !== true) problems.push('the damaged improver file was deleted')

  const r = obs.damagedRevision ?? {}
  if (r.problem?.file !== r.file) problems.push(`a damaged revision was not reported (${JSON.stringify(r.problem)})`)
  if (r.activationRevision !== Number.parseInt(r.file ?? '0', 10) - 1) problems.push(`the chain did not stop before the damaged revision (in force: revision ${r.activationRevision})`)
  if (r.adopt?.code !== 'improver/activation') problems.push(`adopting on a damaged chain was ${r.adopt?.code ?? 'accepted'}`)
  if ((r.filesAfter ?? []).length !== Number.parseInt(r.file ?? '0', 10)) problems.push('a revision was added to a damaged chain')

  if (problems.length > 0) return fail(problems)
  return pass(`same content → same version ${short(v)} (sha-256 of the canonical text; rewritten and reordered: no new file; v0 never stored); 3 revisions each naming the digest of the one before; rollback = revision 3, both improver files kept; damaged improver in force → not loaded, load-failure rollback to v0 (revision ${d.tail?.revision}), file kept; damaged revision ${r.file} → chain stops at revision ${r.activationRevision}, adopt refused`)
}

/** H03: a job keeps the improver it started on. @param obs - `pinnedPhase` output. */
export function judgePinned(obs) {
  if (obs === undefined) return fail(['the pinned-version observations are missing'])
  const problems = []
  const child = obs.child?.version
  const a = obs.jobA ?? {}
  const b = obs.jobB ?? {}
  if (!VERSION.test(child ?? '')) problems.push(`no child improver version (${String(child)})`)
  if (obs.adoption?.inForce !== child) problems.push('the child improver was not in force after the adoption')
  if (a.pinnedBeforeAdoption !== V0) problems.push(`job A pinned ${short(a.pinnedBeforeAdoption)} before the adoption, not v0`)
  if (!ACTIVE.includes(a.statusAtAdoption)) problems.push(`the adoption did not land mid-job (job A was ${a.statusAtAdoption ?? 'unknown'})`)
  if (!FINAL.includes(a.status)) problems.push(`job A did not finish (${a.status ?? 'unknown'})`)
  if (!(a.history ?? []).includes('trialing')) problems.push('job A did not reach its gate after the adoption')
  if (a.improverVersion !== V0) problems.push(`job A's job.json says ${short(a.improverVersion)}`)
  if (b.improverVersion !== child) problems.push(`job B's job.json says ${short(b.improverVersion)}, not the child`)
  if (!(b.history ?? []).includes('trialing')) problems.push('job B did not reach its gate')

  const facts = obs.facts ?? { sessions: [], ledger: [] }
  const versionOf = { [a.id]: V0, [b.id]: child }
  for (const [label, job] of [['A', a], ['B', b]]) {
    const sessions = facts.sessions.filter(s => s.jobId === job.id)
    if (sessions.length === 0) problems.push(`job ${label} has no improvement session`)
    for (const s of sessions) if (s.improverVersion !== versionOf[job.id]) problems.push(`job ${label}'s ${s.phase} session header says ${short(s.improverVersion)}`)
    const records = facts.ledger.filter(r => r.improvementId === job.id)
    if (records.length === 0) problems.push(`job ${label} has no ledger records`)
    const stray = strayRecords(records, versionOf[job.id])
    if (stray.length > 0) problems.push(`job ${label} ledger records not on ${short(versionOf[job.id])}: ${stray.join(', ')}`)
  }
  if (!facts.sessions.some(s => s.jobId === a.id && s.phase === 'propose' && s.improverVersion === V0)) problems.push('job A has no propose session on v0 (opened after the adoption)')
  const texts = obs.diagnoseTexts ?? []
  if (texts[0]?.hasChildParagraph !== false) problems.push('job A\'s diagnosis prompt carried the child\'s paragraph (or was not seen)')
  if (texts[1]?.hasChildParagraph !== true) problems.push('job B\'s diagnosis prompt lacks the child\'s paragraph')

  const count = id => facts.ledger.filter(r => r.improvementId === id).length
  const context = `job A ${a.status ?? '?'} (${count(a.id)} ledger records), job B ${b.status ?? '?'} (${count(b.id)}); child ${short(child)} adopted through ${obs.adoptedBy ?? 'the store'} while A was ${a.statusAtAdoption ?? '?'}`
  if (problems.length > 0) return fail(problems, context)
  return pass(`${context}: A's job.json, ${facts.sessions.filter(s => s.jobId === a.id).length} session headers and every ledger record say v0, its diagnosis prompt has no child paragraph; B's say ${short(child)} and its diagnosis prompt carries the child's paragraph`)
}

/** E01: generators reproducible, sets disjoint. @param obs - `setsObservation` output. */
export function judgeSets(obs) {
  if (obs === undefined) return fail(['the case observations are missing'])
  const problems = []
  const first = obs.first ?? []
  const second = obs.second ?? []
  if (first.length === 0) problems.push('no cases were generated')
  if (JSON.stringify(first) !== JSON.stringify(second)) {
    const differ = first.filter((task, i) => JSON.stringify(task) !== JSON.stringify(second[i])).map(task => task.id)
    problems.push(`two generations differ: ${differ.join(', ') || 'case lists differ'}`)
  }
  for (const family of obs.families ?? []) {
    const sets = obs.sets?.[family] ?? {}
    for (const [set, size] of Object.entries(obs.sizes ?? {})) if ((sets[set] ?? []).length !== size) problems.push(`${family} ${set}: ${(sets[set] ?? []).length} cases, plan says ${size}`)
    const ids = Object.values(sets).flat()
    if (new Set(ids).size !== ids.length) problems.push(`${family}: a case is in more than one set`)
    const seeds = first.filter(task => task.family === family).map(task => task.seed)
    if (new Set(seeds).size !== seeds.length) problems.push(`${family}: a seed is used twice`)
  }
  if ((obs.families ?? []).length !== 2) problems.push(`expected two task families, found ${(obs.families ?? []).length}`)
  for (const problem of obs.problems ?? ['checkSets did not run']) problems.push(`checkSets: ${problem}`)
  if (problems.length > 0) return fail(problems)
  const files = first.reduce((n, task) => n + Object.keys(task.hashes).length, 0)
  return pass(`${(obs.families ?? []).join(' + ')}: ${first.length} cases generated from the plan's seeds here and in a fresh process, ${files} hashed files / messages identical; dev / selection / guard / holdout sizes ${Object.values(obs.sizes).join(' / ')} per family, no case or seed in two sets; checkSets (shared fingerprints, holdout variants) found nothing`)
}

/** E04: the report reproducible and traceable. @param obs - `reportObservation` output. */
export function judgeReport(obs) {
  if (obs === undefined) return fail(['the report observations are missing'])
  const problems = []
  const report = obs.first ?? ''
  if (report === '') problems.push('no report was generated')
  if (obs.second !== report) problems.push('two builds of the same record differ')
  if (obs.cli?.code !== 0 || obs.cli?.sameAsInProcess !== true) problems.push(`report.mjs as its own process ${obs.cli?.code === 0 ? 'wrote a different report' : `exited ${obs.cli?.code}: ${obs.cli?.stderr ?? ''}`}`)
  const runs = obs.raw?.runs ?? []
  const costs = obs.raw?.costs ?? []
  for (const run of runs) if (!report.includes(run.runId)) problems.push(`run ${run.runId} is not in the report`)
  for (const cost of costs) if (!report.includes(cost.ref)) problems.push(`cost ${cost.ref} is not in the report`)
  // Each case row, recomputed from the record: passes / known (unknown counted apart).
  for (const caseId of [...new Set(runs.map(run => run.caseId))].sort()) {
    const cells = ['base', 'parent', 'child'].map(arm => {
      const mine = runs.filter(run => run.caseId === caseId && run.arm === arm)
      const known = mine.filter(run => run.pass !== null)
      const unknown = mine.length - known.length
      return `${known.filter(run => run.pass).length}/${known.length}${unknown > 0 ? `（未知 ${unknown}）` : ''}`
    })
    if (!report.includes(`| ${caseId} | ${cells.join(' | ')} |`)) problems.push(`case ${caseId}: the report's row does not match ${cells.join(' / ')} recomputed from the record`)
  }
  const total = runs.reduce((sum, run) => sum + (run.costUsd ?? 0), 0) + costs.reduce((sum, cost) => sum + cost.usd, 0)
  const totalLine = report.split('\n').find(line => line.startsWith('实验总费用')) ?? ''
  if (!totalLine.includes((Math.round(total * 1e6) / 1e6).toFixed(3))) problems.push(`total cost ${total.toFixed(3)} recomputed from the record is not the report's (${totalLine || 'no total line'})`)
  const unknownIds = runs.filter(run => run.pass === null).map(run => run.runId)
  for (const id of unknownIds) if (!report.split('\n').some(line => line.includes('结果未知') && line.includes(id))) problems.push(`unknown run ${id} is not listed under unknown results`)
  if (obs.flipped?.report === report) problems.push(`changing run ${obs.flipped?.runId} left the report unchanged`)
  if (obs.costed?.report === report) problems.push(`changing cost ${obs.costed?.ref} left the report unchanged`)
  if (problems.length > 0) return fail(problems)
  return pass(`scripted record (not a real experiment; R06 checks the real one): ${runs.length} holdout runs, ${costs.length} costs; built twice in-process and once by report.mjs as its own process: byte-identical (${report.length} chars); every run id and cost ref appears; each case row and the total (${total.toFixed(3)} USD) match a recomputation from the record; the unknown run is listed; changing one run or one cost changes the report`)
}
