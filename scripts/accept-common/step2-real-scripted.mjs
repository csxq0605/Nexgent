/**
 * A scripted stand-in for the real model on the step-2 real task, so the
 * real layer's runner and R judges can be exercised without a model: the
 * replies a competent model would give, in request order, for
 * round 1 → feedback → round 3 (stalls mid-stream; the runner kills it) →
 * resume. Used by packages/test-support/tests/accept-step2-real.spec.ts and
 * by the script-level test (`--layer real` against a loopback server).
 * Nothing here is evidence about a real model.
 */
import { DATA_PATH, README_PATH, SCRIPT_PATH, SUMMARY_PATH } from '../real-task/step2-sales-hidden.mjs'
import { REGIONS } from '../real-task/step2-sales/generate.mjs'
import { materialPath, OFFICE_SKILL, shellCall } from './scenario-step2.mjs'

const usage = { inputTokens: 900, outputTokens: 120, totalTokens: 1020, cacheReadTokens: 4000, cacheWriteTokens: 600, reasoningTokens: 40 }

const BUILD_V1 = `import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'

const USE_NAMES = false
const WITH_GROWTH = false
const NAMES = ${JSON.stringify(REGIONS)}

function parseCsv(text) {
  const rows = []
  let row = []
  let field = ''
  let quoted = false
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i += 1 } else if (ch === '"') quoted = false
      else field += ch
    } else if (ch === '"') quoted = true
    else if (ch === ',') { row.push(field); field = '' }
    else if (ch === '\\n') { row.push(field); rows.push(row); row = []; field = '' }
    else if (ch !== '\\r') field += ch
  }
  if (field !== '' || row.length > 0) { row.push(field); rows.push(row) }
  return rows
}

const [, ...lines] = parseCsv(readFileSync('data/orders.csv', 'utf8'))
const seen = new Set()
const totals = new Map()
for (const [id, date, region, amount] of lines) {
  if (id === undefined || seen.has(id)) continue
  seen.add(id)
  const code = String(region ?? '').trim().toLowerCase()
  if (code === '') continue
  const key = (USE_NAMES ? NAMES[code] : code) + '|' + date.slice(0, 7)
  totals.set(key, (totals.get(key) ?? 0) + Number(String(amount).replace(/,/g, '')))
}
const keys = [...totals.keys()].sort()
const out = [WITH_GROWTH ? 'region,month,sales,mom_growth' : 'region,month,sales']
let previous
for (const key of keys) {
  const [region, month] = key.split('|')
  const sales = Math.round(totals.get(key) * 100) / 100
  if (previous?.region !== region) previous = undefined
  const growth = previous === undefined ? '' : ((sales - previous.sales) / previous.sales).toFixed(4)
  out.push(WITH_GROWTH ? [region, month, sales.toFixed(2), growth].join(',') : [region, month, sales.toFixed(2)].join(','))
  previous = { region, sales }
}
mkdirSync('report', { recursive: true })
writeFileSync('report/summary.csv', out.join('\\n') + '\\n')
`

const README_V1 = '# 销售汇总\n\n运行 `node scripts/build-report.mjs` 生成 `report/summary.csv`（按地区和月份汇总销售额）。\n'
const RULES = '\n## 清洗规则\n\n- 地区为空的订单剔除。\n- 地区代码去掉首尾空格并转小写，再换成对照表里的中文名。\n- 金额去掉千分位逗号。\n'
const DUPLICATES = '\n## 重复订单\n\n订单号相同即视为重复，只保留第一次出现的那一条，其余丢弃。\n'

const presentedId = (body) => {
  const match = /Presented deliverable ([0-9a-f-]{36})/.exec(JSON.stringify(body))
  if (match === null) throw new Error('no present result in the request')
  return match[1]
}
const material = (body, name) => {
  // In the JSON text a Windows `\` is escaped as `\\`, which materialPath turns into `//`.
  const path = materialPath(JSON.stringify(body), name)?.replace(/(?<!^)\/{2,}/g, '/')
  if (path === undefined) throw new Error(`no ${name} material path in the request`)
  return path
}

/** Marker text the round-3 reply streams before it stalls. */
export const STALL = '我来补充重复订单的说明'

/**
 * The scripted replies, in request order.
 */
export function realLikeScript() {
  const present = (summary, extra = {}) => ({ name: 'present', arguments: { paths: [SUMMARY_PATH, README_PATH], summary, ...extra } })
  return [
    // round 1
    { reasoning: '先看两份资料，再写脚本。', content: '我先读地区对照表。', toolCalls: [{ name: 'load_skill', arguments: { name: OFFICE_SKILL } }], usage },
    body => ({ toolCalls: [{ name: 'read_document', arguments: { path: material(body, 'regions.xlsx') } }], usage }),
    body => ({ reasoning: '把订单原样复制到 data/。', toolCalls: [shellCall({
      bash: `mkdir -p data && cp '${material(body, 'orders.csv')}' ${DATA_PATH}`,
      pwsh: `New-Item -ItemType Directory -Force data | Out-Null; Copy-Item -LiteralPath '${material(body, 'orders.csv')}' -Destination ${DATA_PATH}`,
    })], usage }),
    { toolCalls: [{ name: 'write_file', arguments: { path: SCRIPT_PATH, content: BUILD_V1 } }], usage },
    { toolCalls: [{ name: 'write_file', arguments: { path: README_PATH, content: README_V1 } }], usage },
    { toolCalls: [shellCall({ bash: `node ${SCRIPT_PATH}`, pwsh: `node ${SCRIPT_PATH}` })], usage },
    { toolCalls: [present('按地区和月份汇总的销售额')], usage },
    { content: '汇总已生成并交付。', usage },
    // feedback → v2 (edits of existing files go through str_replace)
    { reasoning: '改用中文名并加环比。', toolCalls: [{ name: 'str_replace', arguments: { path: SCRIPT_PATH, old_str: 'const USE_NAMES = false\nconst WITH_GROWTH = false', new_str: 'const USE_NAMES = true\nconst WITH_GROWTH = true' } }], usage },
    { toolCalls: [{ name: 'str_replace', arguments: { path: README_PATH, old_str: '（按地区和月份汇总销售额）。\n', new_str: `（按地区和月份汇总销售额）。\n${RULES}` } }], usage },
    { toolCalls: [shellCall({ bash: `node ${SCRIPT_PATH}`, pwsh: `node ${SCRIPT_PATH}` })], usage },
    body => ({ toolCalls: [present('地区改为中文名，加环比增长，README 写明清洗规则', { deliverableId: presentedId(body) })], usage }),
    { content: '已按反馈修改并重新交付。', usage },
    // round 3: streams, then stalls; the runner kills the process here
    { reasoning: '要补 README。', content: [STALL, '，先看看现在的 README。'], fault: { kind: 'timeout', afterChunks: 4 } },
    // resume
    { reasoning: '上一轮被中断，接着补 README。', toolCalls: [{ name: 'str_replace', arguments: { path: README_PATH, old_str: '- 金额去掉千分位逗号。\n', new_str: `- 金额去掉千分位逗号。\n${DUPLICATES}` } }], usage },
    body => ({ toolCalls: [present('README 补充重复订单的处理方式', { deliverableId: presentedId(body) })], usage }),
    { content: '重复订单的处理方式已写进 README，并重新交付。', usage },
  ]
}
