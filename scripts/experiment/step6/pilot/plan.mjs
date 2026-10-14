#!/usr/bin/env node
// @ts-check
/**
 * The pilot's frozen plan (ADR 0011 decision 6): cases (tasks, set split, starting files,
 * rubrics), feedback templates, external reviewer prompts and models, statistics, arm
 * definitions, reliability criteria and reference pairs, the budget, and the SHA-256 of
 * every script that generates, judges or scores, written to `pilot-plan.json`. The
 * experiment manifest records the file's SHA-256; once the real pilot has started, any
 * change to it voids that round.
 *
 *   node scripts/experiment/step6/pilot/plan.mjs --write   regenerate pilot-plan.json
 *   node scripts/experiment/step6/pilot/plan.mjs --check   exit 1 if the file differs from a fresh build
 *   node scripts/experiment/step6/pilot/plan.mjs           print the file's SHA-256
 *
 * Linux, macOS and Windows; Node built-ins only.
 */
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { folderOf, PILOT_FAMILIES, pilotCases, pilotReferencePairs } from './cases.mjs'
import { POINT_TYPES, SET_SIZES } from './common.mjs'
import { PRAISE, PRIORITY, RATINGS, SECONDARY, TASTE, TEMPLATES } from './feedback.mjs'
import { MEMORY_POLICY } from './memory.mjs'
import { CRITERIA } from './reliability.mjs'
import { EXTERNAL_REVIEWER, IN_LOOP_REVIEWER, PAIR_SYSTEM, POINT_SYSTEM } from './reviewer.mjs'
import { BOOTSTRAP, COMPARISONS, PILOT_ARMS } from './stats.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
export const PLAN_FILE = join(HERE, 'pilot-plan.json')
export const PILOT_ID = 'step6-pilot-1'

/** Scripts whose behaviour the plan freezes (hashed with LF line ends, so a Windows checkout hashes the same). */
export const FROZEN_SCRIPTS = ['office.mjs', 'common.mjs', 'files.mjs', 'docs.mjs', 'cases.mjs', 'feedback.mjs', 'reviewer.mjs', 'memory.mjs', 'stats.mjs', 'reliability.mjs', 'run.mjs', 'report.mjs', '../rng.mjs', '../stats.mjs', '../cases.mjs', '../feedback.mjs', '../run.mjs', '../budget.mjs']

const sha256 = (/** @type {string | Uint8Array} */ data) => createHash('sha256').update(data).digest('hex')

/** A starting file as JSON: text as is, binary as base64. @param {string | Uint8Array} content */
const fileJson = content => (typeof content === 'string' ? { text: content } : { base64: Buffer.from(content).toString('base64') })

/** The plan object. */
export async function buildPlan() {
  const cases = pilotCases()
  /** @type {Record<string, string>} */
  const scripts = {}
  for (const rel of FROZEN_SCRIPTS) scripts[`scripts/experiment/step6/${join('pilot', rel).replaceAll('\\', '/')}`] = sha256((await readFile(join(HERE, rel), 'utf8')).replace(/\r\n/g, '\n'))
  return {
    formatVersion: 1,
    pilotId: PILOT_ID,
    decision: 'docs/adr/0011-measurement-pilot.md',
    partition: 'docs/plan/step-6-rework-partition.md',
    families: PILOT_FAMILIES,
    setSizes: SET_SIZES,
    pointTypes: POINT_TYPES,
    conventions: {
      docs: '文末列出引用的资料文件名（只在反馈里出现）',
      files: '输出的文件名和目录名不含空格（只在反馈里出现）',
    },
    caseFolder: '每题在项目里有自己的目录（以种子命名）：起始文件与输出都在其中，任务消息开头说明；同一类的题共用一个项目，这样后一题不会碰到前一题留下的输入与输出',
    cases: cases.map(task => ({
      id: task.id, family: task.family, set: task.set, variant: task.variant, seed: task.seed, folder: folderOf(task),
      message: task.message,
      outputs: task.outputs,
      rubric: task.rubric,
      files: Object.fromEntries(Object.entries(task.files).map(([path, content]) => [path, fileJson(content)])),
      fingerprints: task.fingerprints,
      hidden: task.hidden,
    })),
    scoring: {
      metric: '要点通过率：每次运行中计分要点（不含个人口味）通过的比例；“看不出”按未通过计并单列；判定器未能完成的运行记为未知，不计入，单列',
      wholeCase: '整题通过：全部计分要点通过',
      checks: 'by=check 的要点由确定性判定器判；by=review 的要点由外部评审判（只有文档类）；by=none 的个人口味要点不计分',
      holdoutOnlyReview: '外部评审只判 holdout 运行与参考成对样本；它的判语不写进项目，也不生成反馈',
    },
    feedback: {
      source: '只用确定性判定（by=check）没通过的要点；外部评审的判语不进反馈',
      priority: PRIORITY,
      templates: TEMPLATES,
      secondary: SECONDARY,
      taste: TASTE,
      praise: PRAISE,
      ratings: RATINGS.map(r => r ?? null),
      counting: '评分 ≤ 3，或有评论没评分，计入改进阈值（同 ../feedback.mjs counts）',
      tasteRule: '成果不符合个人口味要点时，在第一条反馈里说一句；通过的用例用评分 4（不计数）',
    },
    reviewer: {
      external: EXTERNAL_REVIEWER,
      inLoop: { ...IN_LOOP_REVIEWER, use: '同一要点提示，判同一批 holdout 文档运行，只用于一致率（判据 4）' },
      pointPrompt: { system: POINT_SYSTEM, user: '# 任务 / # 资料（每个资料文件：【文件名】+全文）/ # 成果（输出路径）/ # 评分要点（- id：text，只列 by=review）' },
      pairPrompt: { system: PAIR_SYSTEM, user: '# 任务 / # 资料 / # 成果 A / # 成果 B' },
      pairwise: { arms: ['parent', 'memory'], repeat: 1, bothOrders: true, use: '每道文档类 holdout 题，第 1 次重复，parent 与 memory 两臂的成果，两种顺序各判一次；只作辅助指标与判据 3' },
    },
    statistics: {
      pairing: 'holdout 用例',
      bootstrap: { levels: ['case', 'repeat'], iterations: BOOTSTRAP.iterations, seed: BOOTSTRAP.seed, interval: 0.95, quantile: 'R type 7' },
      verdict: '区间下限 > 0 记“正”，上限 < 0 记“负”，否则记“零”；没有可配对的用例记“不足”',
      comparisons: COMPARISONS,
      repeats: 3,
      scope: '两类分别算，再两类合并算',
      also: ['整题通过率', '每题三次重复的波动', '“看不出”次数按臂', '追问成果次数按臂', '被采用组件按“项目约定或事实 / 做事方法”分类（stats.mjs componentClass）', '背答案率（ADR 0013 findInstanceLiterals）', '内外评审一致率', '费用'],
    },
    arms: {
      list: PILOT_ARMS,
      base: 'dev 任务与反馈之前的项目快照的副本',
      memory: { ...MEMORY_POLICY, rule: '在 base 副本里经 @nexgent/capabilities 的存储接口直接写入并采用一条上下文策略：instructions 为该类全部计数反馈原文，按时间先后；超长时去掉最早的；不诊断、不过门控' },
      parent: 'dev 反馈触发改进作业（改进器 v0，adr-0014 纪元：ADR 0014 取代 0013 的同类题定义与规则 id）之后的项目副本',
      child: '试点不跑（不跑元改进）',
      isolation: '每个任务族、每个臂用自己的 NEXGENT_HOME',
      holdoutRuns: '每题每臂 3 次，每次在该臂的新副本里新开会话，关自动改进；没交成果时同一会话追问一次（PRESENT_REQUEST），按臂计数',
    },
    reliability: {
      criteria: CRITERIA,
      pairs: pilotReferencePairs(),
      reliableWhen: '判据 1、2、3 都满足',
    },
    freeze: {
      rule: '真实试点开跑后，改动本文件任何一项（含 scripts 哈希），这一轮作废，换新的试点 id，作废的一轮照样写进报告',
      devOnly: '开发与调试只用 dev 与 selection 的题；holdout 题在真实试点开跑前不交给模型',
    },
    orchestration: {
      script: 'scripts/experiment/step6/pilot/run.mjs --real --out <dir> --spend <步骤 6 花费文件>',
      order: ['判据 1（不调模型；不过就停）', '6 组参考成对样本，两种顺序', '每类：历史任务（selection、guard）→ dev 任务 → base 副本 → 模板反馈与改进作业（停在审批时由编排代批并记备注）→ parent 副本 → memory 副本并写入、采用 project-notes → 隔离检查（有泄漏就停）→ holdout 27 次 → 文档类 parent 与 memory 的两两偏好'],
      model: '任务与改进作业：claude-sonnet-5-5，thinking 开（../run.mjs MODEL、IMPROVEMENT）',
      homes: '每类的主项目用 homes/<类>；holdout 运行用 homes/<类>-<臂>：base、memory 为空目录，parent 为主项目 home 的副本',
      gates: '每步开始前，步骤 6 花费文件 + 本步预留不超过 35 美元，且试点花费文件（<dir>/pilot-spend.json）+ 本步预留不超过 12 美元；费用未知按预留计',
      records: 'raw.json（report.mjs 的输入，不含时间、会话与作业 id、绝对路径）、report.md、manifest.json（计划 SHA-256、各臂 NEXGENT_HOME 与改进器版本、memory 策略的能力版本与全文 SHA-256）、observations.json',
    },
    budget: { gateUsd: 12, estimateUsd: [9, 11], note: '计入步骤 6 的 35 美元上限；外部与循环内评审约 1.9 美元（45 次 opus、27 次 sonnet）' },
    scripts,
  }
}

/** The plan file's text. */
export const planText = async () => `${JSON.stringify(await buildPlan(), null, 2)}\n`

/** SHA-256 of the plan file as committed (LF line ends). @param {string} [file] */
export const planSha256 = async (file = PLAN_FILE) => sha256((await readFile(file, 'utf8')).replace(/\r\n/g, '\n'))

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  const mode = process.argv[2]
  if (mode === '--write') {
    await writeFile(PLAN_FILE, await planText())
    console.log(`wrote ${PLAN_FILE} (sha256 ${await planSha256()})`)
  } else if (mode === '--check') {
    const fresh = await planText()
    const current = (await readFile(PLAN_FILE, 'utf8').catch(() => '')).replace(/\r\n/g, '\n')
    if (fresh !== current) {
      console.error('pilot-plan.json differs from a fresh build')
      process.exit(1)
    }
    console.log(`pilot-plan.json is current (sha256 ${await planSha256()})`)
  } else {
    console.log(await planSha256())
  }
}
