/**
 * Judges of step 6's E02 (holdout isolation) and E03 (three-arm holdout runs), over the
 * observations of step6-rehearsal.mjs. Pure: each takes observations and returns
 * `{ status: 'passed' | 'failed', evidence }`. Missing observations fail; nothing here
 * passes on absence. The observations are a scripted rehearsal (run.mjs --scripted), and the
 * evidence says so: the real experiment's isolation and arms are R05's.
 * Counterexamples: packages/test-support/tests/accept-step6-rehearsal-judges.spec.ts.
 */

const SCRIPTED = 'scripted rehearsal, not the real experiment (R05 checks that)'
const pass = evidence => ({ status: 'passed', evidence: `${evidence} [${SCRIPTED}]` })
const fail = (problems, context = '') => ({ status: 'failed', evidence: `${problems.slice(0, 12).join('; ')}${problems.length > 12 ? `; … ${problems.length - 12} more` : ''}${context === '' ? '' : ` (${context})`} [${SCRIPTED}]` })
const list = value => (Array.isArray(value) ? value : [])
const count = value => (typeof value === 'number' && Number.isFinite(value) ? value : 0)

/**
 * E02: no holdout message, seed or material in an experiment project's sessions, snapshots or
 * receipts (nor in any kept arm copy), and the gate picked no holdout case.
 * @param obs - `runRehearsal` observations.
 */
export function judgeIsolation(obs) {
  if (obs === undefined || obs === null || typeof obs !== 'object' || obs.error !== undefined) return fail([obs?.error === undefined ? 'the rehearsal observations are missing' : `the rehearsal crashed: ${String(obs.error).slice(0, 200)}`])
  const iso = obs.isolation
  const gate = obs.gate
  if (iso === undefined || gate === undefined) return fail(['isolation or gate observations are missing'])
  const problems = []
  const holdout = list(obs.holdoutCaseIds)
  if (holdout.length === 0) problems.push('no holdout case ids were observed')

  const roots = list(iso.roots)
  if (roots.length === 0) problems.push('no root was scanned for leaks')
  const families = new Set([...list(gate.families).map(f => f.family), ...roots.map(r => r.family)].filter(Boolean))
  if (families.size === 0) problems.push('no experiment family was observed')
  for (const family of families) {
    for (const label of ['project', 'arm:base', 'arm:parent', 'arm:child']) {
      if (!roots.some(r => r.family === family && r.label === `${family} ${label}`)) problems.push(`${family}: ${label} was not scanned`)
    }
  }
  let leaks = 0
  let files = 0
  for (const r of roots) {
    const name = r.label ?? String(r.root)
    if (r.exists !== true) problems.push(`${name}: root does not exist`)
    if (count(r.scanned) === 0) problems.push(`${name}: the scan covered no files`)
    if (count(r.directories?.sessions?.scanned) === 0) problems.push(`${name}: the scan covered no session files`)
    if (count(r.directories?.snapshots?.scanned) === 0) problems.push(`${name}: the scan covered no snapshot files`)
    for (const leak of list(r.leaks)) problems.push(`${name}: leak of ${leak.caseId} in ${leak.file}`)
    leaks += list(r.leaks).length
    files += count(r.scanned)
  }

  // The negative control: the scan must see a holdout fingerprint when one is there.
  const control = iso.negativeControl
  if (control === undefined || control.planted !== true) problems.push(`negative control did not run (${control?.reason ?? 'missing'})`)
  else {
    if (count(control.plantedLeaks) < 1 || control.foundPlantedCase !== true) problems.push(`negative control: the scan did not find the planted holdout fingerprint of ${control.caseId} (${count(control.plantedLeaks)} leaks)`)
    if (count(control.cleanScanned) === 0 || count(control.plantedScanned) === 0) problems.push('negative control: the scan covered no file')
    if (count(control.cleanLeaks) !== 0) problems.push(`negative control: the unplanted copy reported ${control.cleanLeaks} leaks`)
  }

  // The gate's picks, recomputed from the trial records.
  const picks = []
  for (const g of list(gate.families)) {
    const picked = list(g.picked)
    if (count(g.trialFiles) === 0) problems.push(`${g.family}: no trial record was read`)
    if (picked.length === 0) problems.push(`${g.family}: the gate picked no case`)
    for (const id of picked) if (holdout.includes(id)) problems.push(`${g.family}: gate picked holdout case ${id}`)
    for (const id of list(g.unmapped)) problems.push(`${g.family}: trial records name session ${String(id).slice(0, 8)}, which maps to no case`)
    picks.push(`${g.family} ${picked.length}`)
  }
  if (list(gate.families).length === 0) problems.push('no gate observations')

  const context = `${roots.length} roots, ${files} files scanned, ${leaks} leaks; gate picks ${picks.join(', ')}; negative control ${control?.planted === true ? `found ${control.plantedLeaks} planted, ${control.cleanLeaks} clean` : 'not run'}`
  if (problems.length > 0) return fail(problems, context)
  return pass(`${context}: no holdout fingerprint in any project, arm copy, session, snapshot or receipt (every root's sessions and snapshots were scanned, and the scan finds a planted fingerprint); every case the gate picked is dev, selection or guard, recomputed from the trial records`)
}

/**
 * E03: every holdout case × arm (base, parent, child) ran at least 3 times, each run in its own
 * copy with its own new session; unknown results are counted apart and are never passes.
 * @param obs - `runRehearsal` observations.
 */
export function judgeHoldoutArms(obs) {
  if (obs === undefined || obs === null || typeof obs !== 'object' || obs.error !== undefined) return fail([obs?.error === undefined ? 'the rehearsal observations are missing' : `the rehearsal crashed: ${String(obs.error).slice(0, 200)}`])
  const holdout = list(obs.holdoutCaseIds)
  const arms = list(obs.arms)
  const need = Number.isInteger(obs.repeatsRequired) ? obs.repeatsRequired : 3
  const runs = list(obs.raw?.runs)
  const records = list(obs.holdout?.families).flatMap(f => list(f.records))
  if (holdout.length === 0) return fail(['no holdout case ids were observed'])
  if (arms.length === 0 || !['base', 'parent', 'child'].every(arm => arms.includes(arm))) return fail([`arms observed: ${JSON.stringify(arms)}, expected base, parent and child`])
  if (runs.length === 0) return fail(['raw.json has no run'])
  if (records.length === 0) return fail(['no per-run copy or session was observed (the runner records neither; they were not found under <family>/runs either)'])
  const problems = []

  // 3 runs per case × arm, distinct repeat numbers.
  const cells = []
  for (const caseId of holdout) {
    for (const arm of arms) {
      const mine = runs.filter(run => run.caseId === caseId && run.arm === arm)
      const repeats = mine.map(run => run.repeat)
      const distinct = new Set(repeats)
      if (distinct.size !== repeats.length) problems.push(`${caseId} ${arm}: repeat numbers repeat (${repeats.join(',')})`)
      if (distinct.size < need) problems.push(`${caseId} ${arm}: ${distinct.size} runs with distinct repeats, need ${need}`)
      for (const run of mine) if (!Number.isInteger(run.repeat) || run.repeat < 1) problems.push(`${run.runId}: repeat ${String(run.repeat)} is not a positive integer`)
      cells.push(distinct.size)
    }
  }
  for (const run of runs) if (!holdout.includes(run.caseId)) problems.push(`${run.runId}: run of ${run.caseId}, which is not a holdout case`)
  const ids = runs.map(run => run.runId)
  if (new Set(ids).size !== ids.length) problems.push('raw.json has duplicate run ids')

  // Every run: its own copy, its own session, the session file in the copy.
  for (const run of runs) {
    const rec = records.find(r => r.runId === run.runId)
    if (rec === undefined) { problems.push(`${run.runId}: no run directory or session was found for it`); continue }
    if (rec.claims !== 1) problems.push(`${run.runId}: ${rec.claims} sessions claim this run id`)
    if (typeof rec.copyDir !== 'string' || rec.copyExists !== true) problems.push(`${run.runId}: its copy directory is missing`)
    if (typeof rec.sessionId !== 'string' || rec.sessionId === '') problems.push(`${run.runId}: no session id`)
    if (rec.sessionFileExists !== true) problems.push(`${run.runId}: its session file is not in the copy`)
    if (rec.sessionMatchesCase !== true) problems.push(`${run.runId}: its session does not start with the case's message`)
    if (rec.sessionInArmSource === true) problems.push(`${run.runId}: its session id is one of the arm source's own sessions (reused, not new)`)
  }
  const shared = (key, label) => {
    const groups = new Map()
    for (const rec of records) if (typeof rec[key] === 'string' && rec[key] !== '') groups.set(rec[key], [...(groups.get(rec[key]) ?? []), rec.runId])
    for (const [value, who] of groups) if (who.length > 1) problems.push(`${label} ${value.slice(-48)} is shared by ${who.join(', ')}`)
  }
  shared('copyDir', 'copy directory')
  shared('sessionId', 'session id')
  for (const f of list(obs.holdout?.families)) {
    if (list(f.directories).length !== list(f.records).length) problems.push(`${f.family}: ${list(f.directories).length} run directories for ${list(f.records).length} runs`)
    if (f.stopped !== undefined || f.error !== undefined) problems.push(`${f.family}: the runner stopped early (${f.error ?? JSON.stringify(f.stopped)})`)
  }

  // Unknown never counts as a pass.
  let passes = 0
  let fails = 0
  let unknown = 0
  for (const run of runs) {
    if (run.pass === true) passes += 1
    else if (run.pass === false) fails += 1
    else if (run.pass === null) unknown += 1
    else problems.push(`${run.runId}: pass is ${JSON.stringify(run.pass)}, not true, false or null (unknown)`)
  }

  const context = `${holdout.length} holdout cases × ${arms.length} arms, ${runs.length} runs (${passes} passed, ${fails} failed, ${unknown} unknown, not counted as passes), ${new Set(records.map(r => r.copyDir)).size} copies, ${new Set(records.map(r => r.sessionId)).size} sessions`
  if (problems.length > 0) return fail(problems, context)
  return pass(`${context}: every case × arm ran ${need}+ times with distinct repeat numbers, each run in its own fresh copy with its own new session whose file is in that copy`)
}
