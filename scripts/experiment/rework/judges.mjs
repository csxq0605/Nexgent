// @ts-check
/**
 * M1 done criterion "判定器好坏样本全对": every case's checkers pass its known good end state
 * and each known bad end state fails the point it was made for. Run before any model call;
 * a failure stops the run.
 *
 * Linux, macOS and Windows; Node built-ins only.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { badOf, goodOf, judgeCase } from './cases.mjs'
import { applyAnswer, writeFiles } from './common.mjs'

/**
 * @param {import('./common.mjs').ReworkCase[]} cases
 * @returns {Promise<{ pass: boolean, results: Array<{ caseId: string, sample: string, ok: boolean, detail: string }> }>}
 */
export async function checkJudges(cases) {
  const results = []
  for (const task of cases) {
    const bad = badOf(task)
    for (const sample of [{ point: null, answer: goodOf(task) }, ...bad]) {
      const dir = await mkdtemp(join(tmpdir(), 'nx-rework-judge-'))
      try {
        await writeFiles(dir, task.files)
        await applyAnswer(dir, sample.answer)
        const judged = await judgeCase(task, dir)
        if (sample.point === null) {
          const failed = judged.points.filter(p => p.pass !== true)
          results.push({ caseId: task.id, sample: 'good', ok: failed.length === 0, detail: failed.map(p => `${p.id}: ${p.detail}`).join('; ') || 'ok' })
        } else {
          const target = judged.points.find(p => p.id === sample.point)
          results.push({ caseId: task.id, sample: `bad:${sample.point}`, ok: target?.pass === false, detail: target?.detail ?? 'no such point' })
        }
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    }
    for (const point of task.rubric.filter(p => p.by === 'check')) {
      if (!bad.some(b => b.point === point.id)) results.push({ caseId: task.id, sample: `bad:${point.id}`, ok: false, detail: 'no bad sample for this point' })
    }
  }
  return { pass: results.every(r => r.ok), results }
}
