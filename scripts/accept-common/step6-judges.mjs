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

/**
 * ADR 0012: every improvement session header and job ledger record names its improver's
 * scope, and it is the user's (the kernel passes it through since R5, PR #155).
 * @returns `{ wrong, carried }`: problems, and how many records carried the field.
 */
function scopeProblems(label, records) {
  const wrong = records.filter(r => r.improverScope !== 'user').map(r => `${label} says improverScope ${r.improverScope ?? 'absent'}`)
  return { wrong: [...new Set(wrong)], carried: records.filter(r => r.improverScope === 'user').length }
}

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
  // ADR 0012: the improver line is the user's; no home of the step-5 runs may hold an adoption.
  const homes = obs.homes ?? []
  if (homes.length === 0) problems.push('no Nexgent home of the step-5 runs was found')
  for (const home of homes) if (home.revisions > 0 || home.bundles > 0) problems.push(`${home.home}/improvers holds ${home.bundles} improver(s) and ${home.revisions} revision(s)`)
  for (const job of jobs) if (job.improverVersion !== undefined && job.improverScope !== 'user') problems.push(`${job.root} job ${job.jobId.slice(0, 8)} improverScope ${job.improverScope ?? 'absent'} (want user)`)
  const sessionScope = scopeProblems('a session header', sessions)
  const ledgerScope = scopeProblems('a ledger record', ledger)
  problems.push(...sessionScope.wrong, ...ledgerScope.wrong)
  if (regression?.status !== 'passed') problems.push(`step 5 regression: ${regression?.evidence ?? 'not judged'}`)
  const context = `${projects.length} step-5 projects, ${homes.length} homes, ${jobs.length} jobs (${pinned.length} with v0 in job.json), ${sessions.length} improvement sessions, ${ledger.length} job ledger records`
  if (problems.length > 0) return fail(problems, context)
  return pass(`${context}: every job, improvement session header and job ledger record reads v0; every pinned job.json says improverScope user; no improver or revision under any <NEXGENT_HOME>/improvers and no .nexgent/improvers/ in any project; improverScope user on all ${sessionScope.carried} session headers and ${ledgerScope.carried} job ledger records; ${regression.evidence}`)
}

/** H02: the improver store. @param obs - `storePhase` output. */
export function judgeStore(obs) {
  if (obs === undefined) return fail(['the store observations are missing'])
  const problems = []
  if (obs.scope !== 'user' || obs.readOnly !== false) problems.push(`the store is ${obs.scope ?? 'of no scope'}${obs.readOnly ? ', read-only' : ''} (want the user-level line, writable)`)
  if (obs.directory === undefined || obs.directory !== obs.userDir || !String(obs.directory).startsWith('home/')) problems.push(`the store writes ${obs.directory}, not <NEXGENT_HOME>/improvers (${obs.userDir})`)
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
  return pass(`user-level line ${obs.directory} (ADR 0012); same content → same version ${short(v)} (sha-256 of the canonical text; rewritten and reordered: no new file; v0 never stored); 3 revisions each naming the digest of the one before; rollback = revision 3, both improver files kept; damaged improver in force → not loaded, load-failure rollback to v0 (revision ${d.tail?.revision}), file kept; damaged revision ${r.file} → chain stops at revision ${r.activationRevision}, adopt refused`)
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
  for (const [label, job] of [['A', a], ['B', b]]) if (job.improverScope !== 'user') problems.push(`job ${label}'s job.json improverScope ${job.improverScope ?? 'absent'} (want user)`)
  if ((obs.projectLine?.bundles ?? 0) > 0 || (obs.projectLine?.revisions ?? 0) > 0) problems.push(`the adoption reached the project's .nexgent/improvers (${obs.projectLine.bundles} improvers, ${obs.projectLine.revisions} revisions)`)
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

  const mineOnly = rows => rows.filter(r => r.jobId === a.id || r.jobId === b.id || r.improvementId === a.id || r.improvementId === b.id)
  const sessionScope = scopeProblems('a session header', mineOnly(facts.sessions))
  const ledgerScope = scopeProblems('a ledger record', mineOnly(facts.ledger))
  problems.push(...sessionScope.wrong, ...ledgerScope.wrong)

  const count = id => facts.ledger.filter(r => r.improvementId === id).length
  const context = `job A ${a.status ?? '?'} (${count(a.id)} ledger records), job B ${b.status ?? '?'} (${count(b.id)}); child ${short(child)} adopted through ${obs.adoptedBy ?? 'the store'} while A was ${a.statusAtAdoption ?? '?'}`
  if (problems.length > 0) return fail(problems, context)
  return pass(`${context}: A's job.json, ${facts.sessions.filter(s => s.jobId === a.id).length} session headers and every ledger record say v0, its diagnosis prompt has no child paragraph; B's say ${short(child)} and its diagnosis prompt carries the child's paragraph; both job.json say improverScope user and the project's .nexgent/improvers stayed empty; improverScope user on all ${sessionScope.carried} session headers and ${ledgerScope.carried} ledger records of A and B`)
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

// ---- E04, the pilot's report (ADR 0011) ------------------------------------------------------

const pct = x => (x === null ? '—' : `${(x * 100).toFixed(1)}%`)
const tidy = x => Math.round(x * 1e9) / 1e9
const cellsOf = line => line.split('|').slice(1, -1).map(cell => cell.trim())
const rowsOf = (report, first) => report.split('\n').filter(line => line.startsWith('|') && cellsOf(line)[0] === first)
const ARMS6 = ['base', 'memory', 'parent']
/** The judgment of a pair asked in both orders, recomputed (good / first answer shown first as AB). */
const orderOf = (ab, ba) => (ab === null || ab === undefined || ba === null || ba === undefined ? null : (ab === 'tie' && ba === 'tie') || (ab === 'A' && ba === 'B') || (ab === 'B' && ba === 'A') ? (ab === 'A' ? 'first' : ab === 'B' ? 'second' : 'tie') : 'inconsistent')

/**
 * E04 (pilot): the pilot report reproducible, and its added columns traceable to the raw
 * records: reliability criteria 1–3, follow-ups and "can't tell" per arm, the repeat spread,
 * component classes and the instance-literal rate, the total cost.
 * @param obs - `pilotReportObservation` output.
 */
export function judgePilotReport(obs) {
  if (obs === undefined) return fail(['the pilot report observations are missing'])
  const problems = []
  const report = obs.first ?? ''
  const raw = obs.raw ?? {}
  const runs = Array.isArray(raw.runs) ? raw.runs : []
  if (report === '') problems.push('no pilot report was generated')
  if (obs.second !== report) problems.push('two builds of the same pilot records differ')
  if (obs.cli?.code !== 0 || obs.cli?.sameAsInProcess !== true) problems.push(`pilot/report.mjs as its own process ${obs.cli?.code === 0 ? 'wrote a different report' : `exited ${obs.cli?.code}: ${obs.cli?.stderr ?? ''}`}`)
  if (runs.length === 0) problems.push('the pilot records have no run')
  const arms = new Set(runs.map(run => run.arm))
  for (const arm of ARMS6) if (!arms.has(arm)) problems.push(`the pilot records have no ${arm} run`)

  // Reliability criteria 1–3.
  const judges = raw.judges ?? {}
  const row = n => rowsOf(report, String(n))[0] ?? ''
  const verdict = ok => (ok ? '满足' : '不满足')
  if (!row(1).includes(`${judges.samples} 个样本，${(judges.failed ?? []).length} 个判错`) || cellsOf(row(1))[3] !== verdict(judges.pass === true)) problems.push(`criterion 1: the report's row (${row(1) || 'missing'}) is not ${judges.samples} samples, ${(judges.failed ?? []).length} wrong, ${verdict(judges.pass === true)}`)
  const refs = raw.referencePairs ?? []
  const correct = refs.filter(p => orderOf(p.ab, p.ba) === 'first').length
  if (!row(2).includes(`${refs.length} 组，选对 ${correct} 组`)) problems.push(`criterion 2: the report's row (${row(2) || 'missing'}) is not ${refs.length} pairs, ${correct} right`)
  const judged = [...refs, ...(raw.armPairs ?? []).filter(p => p.missing !== true)]
  const outcomes = judged.map(p => orderOf(p.ab, p.ba))
  const known = outcomes.filter(o => o !== null).length
  const consistent = outcomes.filter(o => o !== null && o !== 'inconsistent').length
  if (!row(3).includes(`${judged.length} 组，${known} 组两次都有回答，其中一致 ${consistent} 组`)) problems.push(`criterion 3: the report's row (${row(3) || 'missing'}) is not ${judged.length} pairs, ${known} answered both times, ${consistent} consistent`)

  // Per arm: runs, judged, whole passes, "can't tell", follow-ups.
  const families = Object.keys(raw.arms ?? {}).sort()
  let armRows = 0
  for (const family of families) {
    for (const arm of ARMS6) {
      const mine = runs.filter(run => run.family === family && run.arm === arm)
      const knownRuns = mine.filter(run => run.pass !== null && run.pass !== undefined)
      const want = [family, arm, String(mine.length), String(knownRuns.length), `${knownRuns.filter(run => run.pass === true).length}（`, String(mine.reduce((n, run) => n + (run.unclear ?? 0), 0)), String(mine.filter(run => run.followUp === true).length)]
      const got = rowsOf(report, family).map(cellsOf).find(cells => cells[1] === arm && cells.length === 8)
      if (got === undefined || got[2] !== want[2] || got[3] !== want[3] || !got[4].startsWith(want[4]) || got[6] !== want[5] || got[7] !== want[6]) problems.push(`${family} ${arm}: the per-arm row ${got === undefined ? 'is missing' : `(${got.join(' | ')})`} is not runs ${want[2]}, judged ${want[3]}, passed ${want[4].slice(0, -1)}, can't tell ${want[5]}, follow-ups ${want[6]}`)
      else armRows += 1
    }
  }

  // Repeat spread per case × arm.
  let spreadRows = 0
  for (const caseId of [...new Set(runs.map(run => run.caseId))].sort()) {
    for (const arm of ARMS6) {
      const mine = runs.filter(run => run.caseId === caseId && run.arm === arm).sort((a, b) => a.repeat - b.repeat)
      if (mine.length === 0) continue
      const rates = mine.filter(run => typeof run.rate === 'number').map(run => run.rate)
      const unknown = mine.filter(run => run.rate === null).length
      const range = rates.length === 0 ? null : tidy(Math.max(...rates) - Math.min(...rates))
      const want = `| ${caseId} | ${arm} | ${rates.map(x => pct(tidy(x))).join('，') || '—'} | ${pct(range)} | ${unknown} |`
      if (!report.includes(want)) problems.push(`${caseId} ${arm}: the repeat-spread row is not ${want}`)
      else spreadRows += 1
    }
  }

  // Components by class and the instance-literal rate.
  let componentRows = 0
  for (const family of families) {
    for (const arm of ARMS6) {
      const c = raw.components?.[family]?.[arm]
      if (c === undefined) continue
      const n = cls => (c.components ?? []).filter(x => x.class === cls).length
      const lit = c.literal ?? {}
      const got = rowsOf(report, family).map(cellsOf).find(cells => cells[1] === arm && cells.length === 6)
      const want = [String(n('convention-or-fact')), String(n('way-of-working')), `${lit.withLiterals} / ${lit.components}（${pct(lit.rate ?? null)}）`]
      if (got === undefined || got[3] !== want[0] || got[4] !== want[1] || got[5] !== want[2]) problems.push(`${family} ${arm}: the component row ${got === undefined ? 'is missing' : `(${got.join(' | ')})`} is not ${want[0]} conventions or facts, ${want[1]} ways of working, ${want[2]} with literals`)
      else componentRows += 1
      if ((lit.components ?? 0) !== (c.components ?? []).length) problems.push(`${family} ${arm}: the literal rate counts ${lit.components} components of ${(c.components ?? []).length}`)
    }
  }
  if (componentRows === 0) problems.push('no component row could be traced')

  // The total cost.
  const costs = Array.isArray(raw.costs) ? raw.costs : []
  const total = costs.reduce((sum, cost) => sum + (typeof cost.usd === 'number' ? cost.usd : 0), 0)
  const unknownCosts = costs.filter(cost => typeof cost.usd !== 'number').length
  if (!report.includes(`| 合计 | | ${costs.length} | ${total.toFixed(3)} | ${unknownCosts} |`)) problems.push(`the total (${costs.length} costs, ${total.toFixed(3)} USD, ${unknownCosts} unknown) recomputed from the records is not the report's`)

  // Changing the records changes the report.
  for (const [name, change] of Object.entries(obs.changes ?? {})) {
    if (change?.what === undefined) problems.push(`the ${name} change could not be made (nothing to change in the records)`)
    else if (change.report === report) problems.push(`changing ${name} (${change.what}) left the pilot report unchanged`)
  }
  for (const name of ['followUp', 'componentClass', 'rate', 'judges']) if (obs.changes?.[name] === undefined) problems.push(`the ${name} change was not tried`)

  if (problems.length > 0) return fail(problems)
  return pass(`scripted pilot records (pilot/run.mjs --scripted, not the real pilot; R06 checks that): ${runs.length} runs over base / memory / parent; the pilot report built twice in-process and once by pilot/report.mjs as its own process: byte-identical (${report.length} chars); reliability criteria 1–3 (${judges.samples} samples, ${refs.length} reference pairs with ${correct} right, ${judged.length} pairs ${consistent}/${known} consistent), ${armRows} per-arm rows (follow-ups, can't tell), ${spreadRows} repeat-spread rows, ${componentRows} component rows (classes, instance-literal rate) and the total (${total.toFixed(3)} USD) recomputed from the records; changing one follow-up, one component class, one rate or the judges' samples changes the report`)
}
