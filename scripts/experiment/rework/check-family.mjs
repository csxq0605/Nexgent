#!/usr/bin/env node
// @ts-check
/**
 * Check one family module on its own, before it joins the plan: for many seeds, with and
 * without the convention point, the rubric rules hold, the generator gives the same case
 * for the same seed, the known good end state passes every checked point, and each known
 * bad end state fails the point it was made for. Prints one line per problem; exit 1 when
 * any.
 *
 *   node scripts/experiment/rework/check-family.mjs <family file name, e.g. reconcile> [seeds=18]
 *
 * Linux, macOS and Windows; Node built-ins only.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { applyAnswer, checkRubric, runChecks, writeFiles } from './common.mjs'

/**
 * @typedef {import('./common.mjs').Family} Family
 * @typedef {import('./common.mjs').InnerCase} InnerCase
 */

/**
 * Run every checker of a case on its good end state and on each bad one.
 * @param {Family} family
 * @param {InnerCase} task
 * @returns {Promise<Array<{ sample: string, ok: boolean, detail: string }>>}
 */
export async function judgeSamples(family, task) {
  const results = []
  const samples = [{ point: null, answer: family.good(task) }, ...family.bad(task)]
  for (const sample of samples) {
    const dir = await mkdtemp(join(tmpdir(), 'nx-rework-'))
    try {
      await writeFiles(dir, task.files)
      await applyAnswer(dir, sample.answer)
      const judged = await runChecks(task, family.checkers(task), dir)
      if (sample.point === null) {
        const failed = judged.points.filter(p => p.pass !== true)
        results.push({ sample: 'good', ok: failed.length === 0, detail: failed.map(p => `${p.id}: ${p.detail}`).join('; ') || 'ok' })
      } else {
        const target = judged.points.find(p => p.id === sample.point)
        results.push({ sample: `bad:${sample.point}`, ok: target?.pass === false, detail: target?.detail ?? 'no such point' })
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }
  const checked = task.rubric.filter(p => p.by === 'check').map(p => p.id)
  for (const id of checked) if (!samples.some(s => s.point === id)) results.push({ sample: `bad:${id}`, ok: false, detail: 'no bad sample for this point' })
  return results
}

/**
 * All problems of a family over `count` seeds.
 * @param {Family} family
 * @param {number} [count]
 */
export async function checkFamily(family, count = 18) {
  const problems = []
  const combos = new Set()
  for (let i = 1; i <= count; i += 1) {
    for (const convention of [false, true]) {
      const seed = `${family.name}-check-${i}`
      const task = family.build(seed, { convention })
      const again = family.build(seed, { convention })
      const text = (/** @type {InnerCase} */ c) => JSON.stringify(c, (_, v) => (v instanceof Uint8Array ? Buffer.from(v).toString('base64') : v))
      if (text(task) !== text(again)) problems.push(`${seed}: not deterministic`)
      const asCase = /** @type {any} */ ({ ...task, id: seed, family: family.name, split: 'train', index: i, seed, folder: seed })
      problems.push(...checkRubric(asCase))
      if (convention !== task.rubric.some(p => p.type === 'convention')) problems.push(`${seed}: convention option not honoured`)
      for (const trap of task.traps) if (!family.trapPool.includes(trap)) problems.push(`${seed}: trap ${trap} not in the pool`)
      combos.add(task.traps.join('+'))
      for (const r of await judgeSamples(family, task)) if (!r.ok) problems.push(`${seed}${convention ? '+c' : ''} ${r.sample}: ${r.detail}`)
    }
  }
  if (combos.size < 3) problems.push(`only ${combos.size} distinct input-problem combinations over ${count} seeds`)
  return problems
}

if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const name = process.argv[2]
  if (name === undefined) {
    console.error('usage: check-family.mjs <family file name> [seeds]')
    process.exit(2)
  }
  const module = await import(new URL(`./families/${name}.mjs`, import.meta.url).href)
  const family = /** @type {Family | undefined} */ (Object.values(module).find(v => v !== null && typeof v === 'object' && typeof v.build === 'function'))
  if (family === undefined) {
    console.error(`families/${name}.mjs exports no family`)
    process.exit(2)
  }
  const problems = await checkFamily(family, Number(process.argv[3] ?? 18))
  for (const problem of problems) console.log(problem)
  console.log(problems.length === 0 ? `${family.name}: ok` : `${family.name}: ${problems.length} problems`)
  process.exit(problems.length === 0 ? 0 : 1)
}
