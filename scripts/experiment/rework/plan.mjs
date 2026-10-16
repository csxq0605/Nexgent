#!/usr/bin/env node
// @ts-check
/**
 * The rework measurement's frozen plan (ADR 0019 §8: "判据或题目在开跑后改动，就作废这一轮，
 * 换新的实验 id"): families and the holdout draw, every case (message, outputs, rubric, input
 * problems, fingerprints, and the SHA-256 of every starting file), the training order and
 * which cases get feedback, the feedback templates, the external reviewer, scoring,
 * statistics and criteria, the arms, the run profiles, and the SHA-256 of every script that
 * generates, judges, scores or reports. Written to `rework-plan-<id>.json`; the run's
 * manifest records the file's SHA-256.
 *
 * The orchestration (run.mjs, arms.mjs, scripted-model.mjs) is not in this hash: the
 * learning arms' adapters are written when their product parts land and frozen at M2,
 * before the first real run; each run's manifest records those scripts' hashes.
 *
 *   node scripts/experiment/rework/plan.mjs --write   freeze: write rework-plan-<id>.json
 *   node scripts/experiment/rework/plan.mjs --check   exit 1 if the file differs from a fresh build
 *   node scripts/experiment/rework/plan.mjs           print the file's SHA-256
 *
 * Linux, macOS and Windows; Node built-ins only.
 */
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ARM_NEEDS, ARMS, FORMAT_POLICY } from './arms.mjs'
import {
  allCases, CONVENTION_MAX_SHARE, CONVENTION_RATE, FAMILIES, feedbackCases, HOLDOUT_FAMILIES, HOLDOUT_SEED, SIZES,
  TASTE_LINES, TASTE_RATE, TRAIN_FAMILIES, trainingOrder,
} from './cases.mjs'
import { POINT_TYPES, sha256 } from './common.mjs'
import { NOTES_POLICY, PRAISE, PRIORITY, RATINGS, SECONDARY, TASTE, TEMPLATES } from './feedback.mjs'
import { EXTERNAL_REVIEWER, POINT_SYSTEM, REVIEW_LIMITS } from './reviewer.mjs'
import { BOOTSTRAP, COMPARISONS, CRITERIA } from './stats.mjs'
import { picker } from '../step6/rng.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
export const EXPERIMENT_ID = 'rework-1'
export const PLAN_FILE = join(HERE, `rework-plan-${EXPERIMENT_ID}.json`)
export const PLAN_FILE_REL = `scripts/experiment/rework/rework-plan-${EXPERIMENT_ID}.json`

/** Scripts whose behaviour the plan freezes (hashed with LF line ends). */
export const FROZEN_SCRIPTS = [
  'common.mjs', 'cases.mjs', 'judges.mjs', 'feedback.mjs', 'reviewer.mjs', 'stats.mjs', 'report.mjs',
  ...FAMILIES.map(f => `families/${f.name}.mjs`),
  '../step6/rng.mjs', '../step6/stats.mjs', '../step6/cases.mjs', '../step6/feedback.mjs',
  '../step6/pilot/common.mjs', '../step6/pilot/feedback.mjs', '../step6/pilot/memory.mjs', '../step6/pilot/reviewer.mjs',
]

/** Orchestration scripts, hashed into each run's manifest (frozen at M2). */
export const ORCHESTRATION_SCRIPTS = ['run.mjs', 'arms.mjs', 'scripted-model.mjs', '../step6/run.mjs', '../step6/budget.mjs', '../step6/pilot/run.mjs', '../step6/pilot/scripted-model.mjs']

/** Hashes of scripts relative to this folder. @param {string[]} list */
export async function scriptHashes(list) {
  /** @type {Record<string, string>} */
  const out = {}
  for (const rel of list) out[`scripts/experiment/${join('rework', rel).replaceAll('\\', '/')}`] = sha256((await readFile(join(HERE, rel), 'utf8')).replace(/\r\n/g, '\n'))
  return out
}

const smokeDraw = picker('rework-m1-smoke')
const SMOKE_TRAIN = smokeDraw.pick(TRAIN_FAMILIES)
const SMOKE_HOLDOUT = smokeDraw.pick(HOLDOUT_FAMILIES)
const holdoutIds = (/** @type {string[]} */ families, /** @type {number} */ per) => allCases().filter(c => c.split === 'holdout' && families.includes(c.family) && c.index <= per).map(c => c.id)

/**
 * Run profiles (rework-partition.md M2–M4). A real run of `m3` or `m4` is asked of the
 * user first; `gateUsd` is the profile's cost gate.
 */
export const PROFILES = Object.freeze({
  smoke: { package: 'M2', families: [SMOKE_TRAIN], holdout: holdoutIds([SMOKE_HOLDOUT], 6), arms: ['base', 'notes', 'L1'], repeats: 2, estimateUsd: 8, gateUsd: 9 },
  m3: { package: 'M3', families: [...TRAIN_FAMILIES], holdout: holdoutIds(HOLDOUT_FAMILIES, SIZES.holdoutPerFamily), arms: ['base', 'format', 'notes', 'L1', 'L1+L2'], repeats: 3, estimateUsd: 80, gateUsd: 90 },
  m4: { package: 'M4', families: [...TRAIN_FAMILIES], holdout: holdoutIds(HOLDOUT_FAMILIES, SIZES.holdoutPerFamily), arms: ['L1+L2', 'L1+L2+L3'], repeats: 3, estimateUsd: 80, gateUsd: 80 },
})

/** The plan object. */
export async function buildPlan() {
  const cases = allCases()
  return {
    formatVersion: 1,
    experimentId: EXPERIMENT_ID,
    decision: 'docs/adr/0019-evaluation-epoch-practice-set.md §8',
    partition: 'docs/plan/rework-partition.md M1',
    rules: 'adr-0019',
    families: FAMILIES.map(f => ({ name: f.name, title: f.title, habit: f.habit, trapPool: f.trapPool, convention: f.convention, split: HOLDOUT_FAMILIES.includes(f.name) ? 'holdout' : 'train' })),
    holdoutDraw: { seed: HOLDOUT_SEED, method: 'rng.mjs picker(seed).shuffle(六个题族按计划顺序).slice(0, 2)', families: HOLDOUT_FAMILIES, drawnBefore: '任何题目生成和运行之前；不按任何臂的结果挑' },
    sizes: SIZES,
    pointTypes: POINT_TYPES,
    caseRules: {
      folder: '每题在项目里有自己的目录（名字由题目 id 哈希得到，不含题族或分组）；任务消息开头说明',
      inputProblems: '每题从本族问题池里随机抽 2–3 个输入问题；同一族的题目组合不同，记住一条规则做不对',
      convention: `约 ${CONVENTION_RATE * 100}% 的题有 1 个项目约定要点（种子抽取），只在反馈里出现，权重不超过该题总分的 ${CONVENTION_MAX_SHARE * 100}%`,
      taste: { rate: TASTE_RATE, lines: TASTE_LINES, rule: '一次性要求，只在反馈第一条里说，不计分' },
      closing: '每题消息结尾是同一句通用话：资料或输入有问题时写明发现了什么、怎么处理的（common.mjs problemLine）',
      visibleWords: '题目对模型可见的内容里不出现 train / holdout / guard 或题族名',
    },
    cases: cases.map(task => ({
      id: task.id, family: task.family, split: task.split, index: task.index, folder: task.folder, variant: task.variant, traps: task.traps,
      message: task.message,
      outputs: task.outputs,
      rubric: task.rubric,
      files: Object.fromEntries(Object.entries(task.files).map(([path, content]) => [path, sha256(content)])),
      fingerprints: task.fingerprints,
    })),
    guardSet: { cases: cases.filter(c => c.split === 'guard').map(c => c.id), form: 'C1 PracticeCase（common.mjs practiceCaseOf，source generic，split guard）；给 G1 的通用防退步题，只来自训练题族' },
    trainingStream: {
      order: trainingOrder(),
      orderRule: '训练题族轮流：每族第 1 题，然后每族第 2 题……',
      feedbackCases: feedbackCases(),
      feedbackRule: '每个训练题族 8 题里种子抽 4 题给模板人类反馈，其余只有产品自己的信号',
      projects: '每个训练题族一个项目，整条训练流一个 NEXGENT_HOME',
      learning: '有可运行的学习臂时开学习（L1 / L1+L2 用同一条训练流）；没有时关',
    },
    scoring: {
      metric: '一次运行的得分 = 确定性要点按权重的通过比例（0–100），个人口味不计；判定器未能完成的运行记为未知，不计入，单列',
      wholeCase: '整题通过：全部计分要点通过',
      contract: '与 C1 combineScore 的关系：这里只有确定性检查，没有模型打分；要点即 C1 RubricItem（id r1…，权重 1–3）',
    },
    feedback: { priority: PRIORITY, templates: TEMPLATES, secondary: SECONDARY, taste: TASTE, praise: PRAISE, ratings: RATINGS.map(r => r ?? null), counting: '评分 ≤ 3，或有评论没评分，计入（同 step6 feedback.mjs counts）' },
    reviewer: { model: EXTERNAL_REVIEWER, system: POINT_SYSTEM, user: '# 任务 / # 资料（起始文件）/ # 成果（运行新建或改动的文件）/ # 评分要点（全部计分要点）', limits: REVIEW_LIMITS, sample: '每题每臂第 1 次重复', use: '只做报告：与确定性判定的一致率；不改分数、不进项目、不成反馈' },
    statistics: {
      pairing: '留出题',
      bootstrap: { levels: ['case', 'repeat'], ...BOOTSTRAP },
      verdict: '区间下限 > 0 记“正”，上限 < 0 记“负”，否则记“零”；没有可配对的题记“不足”',
      comparisons: COMPARISONS,
      scope: '合并、按留出题族、按要点类型分别算',
      also: ['整题通过率', '每题重复间波动', '追问成果次数', '外部评审一致率', '笔记与学到内容的背答案率（ADR 0013 findInstanceLiterals，来源为训练题的输入与反馈）', '费用'],
    },
    criteria: CRITERIA,
    arms: {
      list: ARMS,
      needs: ARM_NEEDS,
      base: '新项目、空 NEXGENT_HOME，学习关',
      format: { ...FORMAT_POLICY, rule: '新项目里采用一条上下文策略：空手册的框架，没有内容' },
      notes: { policy: NOTES_POLICY, rule: '新项目里采用一条上下文策略：训练流全部计数反馈原文，按先后；超长去掉最早的' },
      learning: 'L1 = 训练流 NEXGENT_HOME 去掉技能；L1+L2 = 训练流 NEXGENT_HOME；L1+L2+L3 = 再加一次离线第 3 层运行。适配在产品部件就绪后写，M2 开跑前冻结',
      holdoutRuns: '每题每臂每次重复：复制该臂的模板项目与 home，新会话，学习关（只用不学）；没交成果时同一会话追问一次并计数',
      standIn: '只用于脚本化演练：学习臂用固定文字的替身策略，记录里标明，不算结果',
    },
    profiles: PROFILES,
    freeze: {
      rule: '真实运行开跑后，改动本文件任何一项（含 scripts 哈希），这一轮作废，换新的实验 id，作废的一轮照样报告',
      devOnly: '开发与调试只用训练题；留出题在真实运行前不交给模型，也不用来调产品',
    },
    scripts: await scriptHashes(FROZEN_SCRIPTS),
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
    console.log(`wrote ${PLAN_FILE_REL} (sha256 ${await planSha256()})`)
  } else if (mode === '--check') {
    const fresh = await planText()
    const current = (await readFile(PLAN_FILE, 'utf8').catch(() => '')).replace(/\r\n/g, '\n')
    if (fresh !== current) {
      console.error(`${PLAN_FILE_REL} is missing or differs from a fresh build`)
      process.exit(1)
    }
    console.log(`${PLAN_FILE_REL} is current (sha256 ${await planSha256()})`)
  } else {
    console.log(await planSha256().catch(() => `${PLAN_FILE_REL} is not frozen yet`))
  }
}
