#!/usr/bin/env node
// @ts-check
/**
 * Scripted difficulty calibration of the step-6 multi-file code family (no model):
 * for every code case, what the untouched project does (visible tests, hidden judge),
 * what the reference answer needs (files and lines changed) and how the judge rates
 * the reference with and without the convention's tests. The real-model check (one
 * dev task on improver v0 before the experiment) is a separate, budgeted run.
 *
 *   node scripts/experiment/step6/calibrate.mjs [--out calibration.md]
 *
 * Linux, macOS and Windows; needs only Node.
 */
import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { familyCases, judgeCase, writeCaseFiles } from './cases.mjs'
import { changedModules, cleanEnv, codeParams, referenceSolution, renderProject } from './code.mjs'

/**
 * Count lines that differ between two texts (a plain LCS line diff: added + removed).
 * @param {string} a
 * @param {string} b
 */
export function changedLines(a, b) {
  const x = a.split('\n')
  const y = b.split('\n')
  const dp = Array.from({ length: x.length + 1 }, () => new Array(y.length + 1).fill(0))
  for (let i = x.length - 1; i >= 0; i -= 1) for (let j = y.length - 1; j >= 0; j -= 1) dp[i][j] = x[i] === y[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
  return x.length + y.length - 2 * dp[0][0]
}

/**
 * Visible tests of a project directory: `{ passed, failed }`.
 * @param {string} dir
 * @returns {Promise<{ passed: number, failed: number }>}
 */
function visibleTests(dir) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, ['--test', '--test-reporter=tap'], { cwd: dir, env: cleanEnv(), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let output = ''
    child.stdout.on('data', chunk => { output += chunk })
    child.on('close', () => resolve({ passed: [...output.matchAll(/^# pass (\d+)/gm)].reduce((s, m) => s + Number(m[1]), 0), failed: [...output.matchAll(/^# fail (\d+)/gm)].reduce((s, m) => s + Number(m[1]), 0) }))
  })
}

/**
 * Write a project (relative paths) under `root/dir`.
 * @param {string} root
 * @param {string} dir
 * @param {Record<string, string>} files
 */
async function writeProject(root, dir, files) {
  await writeCaseFiles({ id: '', family: 'code', set: 'dev', variant: '', seed: 0, message: '', files: Object.fromEntries(Object.entries(files).map(([p, t]) => [`${dir}/${p}`, t])), materials: [], outputs: [], fingerprints: [], hidden: {} }, root)
}

/** Calibrate every code case. */
export async function calibrate() {
  const rows = []
  for (const task of familyCases('code')) {
    const hidden = /** @type {import('./code.mjs').CodeHidden} */ (task.hidden)
    const p = codeParams(hidden.seed)
    const original = renderProject(p, { bug: hidden.variant === 'bugfix' ? p.bug : null })
    const solved = referenceSolution(task, { withTests: true })
    const bare = referenceSolution(task, { withTests: false })
    const work = await mkdtemp(join(tmpdir(), 'nx6-cal-'))
    try {
      await writeCaseFiles(task, join(work, 'original'))
      const visible = await visibleTests(join(work, 'original', hidden.dir))
      const untouched = await judgeCase(task, join(work, 'original'))
      await writeProject(join(work, 'solved'), hidden.dir, solved)
      const good = await judgeCase(task, join(work, 'solved'))
      await writeProject(join(work, 'bare'), hidden.dir, bare)
      const noTests = await judgeCase(task, join(work, 'bare'))
      const files = Object.keys(solved).filter(path => solved[path] !== original[path]).sort()
      rows.push({
        id: task.id,
        kind: hidden.kindDetail,
        visible: `${visible.passed} 过 / ${visible.failed} 败`,
        hiddenTests: (hidden.tests.match(/^test\(/gm) ?? []).length,
        untouched: untouched.pass === true ? '通过' : untouched.pass === null ? '未知' : `不过（${[...new Set(untouched.issues.map(i => i.kind))].join(', ')}）`,
        srcModules: changedModules(original, solved).join(', '),
        files: files.length,
        lines: files.reduce((sum, path) => sum + changedLines(original[path] ?? '', solved[path]), 0),
        reference: good.pass === true ? '通过' : `不过（${good.problems.join('; ')}）`,
        withoutTests: noTests.pass === true ? '通过' : `不过（${[...new Set(noTests.issues.map(i => i.kind))].join(', ')}）`,
      })
    } finally {
      await rm(work, { recursive: true, force: true })
    }
  }
  return rows
}

/** @param {Awaited<ReturnType<typeof calibrate>>} rows */
export function calibrationTable(rows) {
  const out = ['| 用例 | 种类 | 原项目可见测试 | 隐藏测试数 | 原项目判定 | 参考答案改的模块 | 改动文件 | 改动行 | 参考答案判定 | 参考答案不补测试 |', '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |']
  for (const r of rows) out.push(`| ${r.id} | ${r.kind} | ${r.visible} | ${r.hiddenTests} | ${r.untouched} | ${r.srcModules} | ${r.files} | ${r.lines} | ${r.reference} | ${r.withoutTests} |`)
  return `${out.join('\n')}\n`
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const index = process.argv.indexOf('--out')
  calibrate().then(async rows => {
    const text = calibrationTable(rows)
    if (index >= 0) await writeFile(process.argv[index + 1], text)
    else process.stdout.write(text)
  }, error => { process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`); process.exitCode = 1 })
}
