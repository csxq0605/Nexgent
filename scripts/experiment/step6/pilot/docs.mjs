// @ts-check
/**
 * Pilot family "document writing" (ADR 0011; docs/plan/step-6-rework-partition.md): eight
 * tasks that write a Markdown report or memo from the project's `materials/` (meeting
 * notes, weekly reports, interviews, an incident log…). Materials are generated from a
 * seed. Each task has a rubric of 3–6 points: the ones that can be written as string
 * checks (required numbers, dates, owners, cited file names) are deterministic; the rest
 * go to the external reviewer. Every task has a known good document and, for every
 * checked point, a known bad document that fails it; five tasks give the six known
 * good / bad pairs of reliability criterion 2.
 *
 * The project convention of this family, which only feedback states: the document ends
 * with the names of the material files it used.
 *
 * Linux, macOS and Windows; Node built-ins only.
 */
import { picker } from '../rng.mjs'
import { amountForms, citesAll, dateForms, hasAny, hasNumber, normalize } from './common.mjs'

/**
 * @typedef {import('./common.mjs').PilotCase} PilotCase
 * @typedef {import('./common.mjs').Point} Point
 * @typedef {import('./common.mjs').Checker} Checker
 * @typedef {import('./common.mjs').CaseSet} CaseSet
 * @typedef {(text: string) => { pass: boolean, detail: string }} TextCheck
 * @typedef {{
 *   build: (seed: string) => Omit<PilotCase, 'id' | 'family' | 'set' | 'variant' | 'seed'>,
 *   checks: (task: PilotCase) => Record<string, TextCheck>,
 *   good: (task: PilotCase) => string,
 *   bad: (task: PilotCase) => Array<{ point: string, text: string }>,
 *   taste: (task: PilotCase, text: string) => boolean,
 *   pairs?: (task: PilotCase) => Array<{ id: string, flaw: string, good: string, bad: string }>,
 * }} Variant
 */

/** The case plan of this family: set, variant and seed. Changing it is a new pilot. */
export const DOCS_PLAN = /** @type {const} */ ([
  { set: 'dev', variant: 'minutes', seed: 'd-201' },
  { set: 'dev', variant: 'revision', seed: 'd-202' },
  { set: 'selection', variant: 'sales-summary', seed: 'd-203' },
  { set: 'selection', variant: 'compare-memo', seed: 'd-204' },
  { set: 'guard', variant: 'translate-guide', seed: 'd-205' },
  { set: 'holdout', variant: 'incident-review', seed: 'd-206' },
  { set: 'holdout', variant: 'interview-summary', seed: 'd-207' },
  { set: 'holdout', variant: 'decisions-todos', seed: 'd-208' },
])

const CONVENTION = {
  id: 'c', type: /** @type {const} */ ('convention'), by: /** @type {const} */ ('check'),
  text: '文末列出引用的资料文件名',
  feedback: '文末没有列出用到的资料文件',
}

const PEOPLE = ['王磊', '李娜', '陈晨', '赵敏', '刘洋', '周婷', '孙浩', '吴静', '郑凯', '何芳', '马骏', '林悦']
const pad = (/** @type {number} */ n) => String(n).padStart(2, '0')
const ok = (/** @type {string} */ detail = 'ok') => ({ pass: true, detail })
const no = (/** @type {string} */ detail) => ({ pass: false, detail })
const lines = (/** @type {string} */ text) => normalize(text).split(/\r?\n/)
const plain = (/** @type {number} */ n) => n.toLocaleString('en-US')

/** Names of the materials a case gives, in order. @param {PilotCase} task */
const materialNames = task => Object.keys(task.files).filter(p => p.startsWith('materials/')).map(p => p.slice('materials/'.length))

/** Convention check: every material name at the end. @param {PilotCase} task */
const citation = task => /** @type {TextCheck} */ (text => {
  const missing = citesAll(text, materialNames(task))
  return missing.length === 0 ? ok() : no(`文末没有列出：${missing.join('、')}`)
})

/** References section listing the materials. @param {PilotCase} task */
const references = task => `\n## 引用资料\n\n${materialNames(task).map(n => `- ${n}`).join('\n')}\n`

/** Every date of a list is written somewhere. @param {string} text @param {string[]} isoDates */
const missingDates = (text, isoDates) => isoDates.filter(d => !hasAny(normalize(text), dateForms(d)))

/** @type {Record<string, Variant>} */
const VARIANTS = {
  // ①（dev）根据 3 份周会记录写本月会议纪要
  minutes: {
    build(seed) {
      const p = picker(seed)
      const people = p.shuffle(PEOPLE)
      const topics = p.shuffle(['新版官网上线', '渠道返利调整', '客服排班', '618 复盘', '年度预算', '供应商更换', '会员体系', '仓库搬迁', '招聘计划'])
      const dates = ['2026-09-03', '2026-09-10', '2026-09-17']
      /** @type {Record<string, string>} */
      const files = {}
      /** @type {Array<{ date: string, topic: string, text: string, owner: string, due: string }>} */
      const decisions = []
      /** @type {Array<{ value: number, unit: string, label: string }>} */
      const numbers = []
      dates.forEach((date, w) => {
        const attendees = people.slice(w, w + 4)
        const body = []
        for (let k = 0; k < 2; k += 1) {
          const topic = topics[w * 2 + k]
          const owner = attendees[(k + 1) % attendees.length]
          const due = `2026-${p.pick(['09', '10'])}-${pad(p.int(18, 30))}`
          const action = p.pick(['拿出执行方案', '完成供应商比价', '提交预算明细', '确定上线时间', '整理数据并汇报'])
          const amount = p.int(12, 95) * 10_000
          numbers.push({ value: amount, unit: '元', label: `${topic}预算` })
          body.push(`议题${k + 1}：${topic}\n讨论：大家认为${topic}需要尽快推进，预算按 ${plain(amount)} 元控制。${p.pick(['有人担心人手不够。', '财务提醒注意回款周期。', '市场部希望再看一轮数据。'])}\n决定：由${owner}在 ${date.slice(0, 5)}${due.slice(5)} 前${action}。`)
          decisions.push({ date, topic, text: action, owner, due })
        }
        files[`materials/周会记录-${date}.txt`] = `周会记录\n日期：${date}\n参会：${attendees.join('、')}\n\n${body.join('\n\n')}\n`
      })
      return {
        message: '请根据 materials/ 下的 3 份周会记录，写一份 2026 年 9 月的月度会议纪要，保存为 output/9月会议纪要.md。',
        files,
        outputs: ['output/9月会议纪要.md'],
        fingerprints: [],
        rubric: [
          { id: 'm', type: 'missing', by: 'check', text: '每项决定的负责人和截止日期都写进了纪要', feedback: '有的决定没写负责人或截止日期' },
          { id: 'u', type: 'unverified', by: 'check', text: '纪要里的预算数字与周会记录一致', feedback: '纪要里的预算数字和记录对不上，像是没核对' },
          { id: 'r', type: 'wrong-result', by: 'review', text: '纪要内容都能在周会记录里找到依据，没有与记录矛盾或记录里没有的内容', feedback: '纪要里有记录里没有的内容' },
          { id: 'f', type: 'format', by: 'review', text: '按会议日期分节，每节写清议题和决定', feedback: '纪要的结构有点乱，看不出每次会议定了什么' },
          CONVENTION,
          { id: 't', type: 'taste', by: 'none', text: '篇幅控制在 800 字以内', feedback: '这次我想要短一点，800 字以内就行' },
        ],
        hidden: { decisions, numbers, dates },
      }
    },
    checks(task) {
      const decisions = /** @type {Array<{ owner: string, due: string }>} */ (task.hidden.decisions)
      const numbers = /** @type {Array<{ value: number }>} */ (task.hidden.numbers)
      return {
        m: text => {
          const owners = decisions.filter(d => !text.includes(d.owner)).map(d => d.owner)
          const dues = missingDates(text, decisions.map(d => d.due))
          return owners.length === 0 && dues.length === 0 ? ok() : no(`缺负责人 ${owners.join('、') || '无'}；缺截止日期 ${dues.join('、') || '无'}`)
        },
        u: text => {
          const wrong = numbers.filter(n => !hasAny(normalize(text), amountForms(n.value)))
          return wrong.length === 0 ? ok() : no(`缺少或写错的金额：${wrong.map(n => n.value).join('、')}`)
        },
        c: citation(task),
      }
    },
    good(task) {
      const decisions = /** @type {Array<{ date: string, topic: string, text: string, owner: string, due: string }>} */ (task.hidden.decisions)
      const numbers = /** @type {Array<{ value: number }>} */ (task.hidden.numbers)
      const dates = /** @type {string[]} */ (task.hidden.dates)
      const parts = ['# 2026 年 9 月会议纪要', '', '本月共召开 3 次周会，以下按会议日期整理议题与决定。', '']
      for (const date of dates) {
        parts.push(`## ${date} 周会`, '')
        decisions.forEach((d, i) => {
          if (d.date !== date) return
          parts.push(`- 议题：${d.topic}（预算 ${plain(numbers[i].value)} 元）`, `  - 决定：由${d.owner}在 ${d.due} 前${d.text}。`)
        })
        parts.push('')
      }
      return `${parts.join('\n').trimEnd()}\n${references(task)}`
    },
    bad(task) {
      const good = this.good(task)
      const decisions = /** @type {Array<{ owner: string, due: string }>} */ (task.hidden.decisions)
      const numbers = /** @type {Array<{ value: number }>} */ (task.hidden.numbers)
      return [
        { point: 'm', text: good.replace(`由${decisions[0].owner}在 ${decisions[0].due} 前`, '尽快') },
        { point: 'u', text: good.replace(plain(numbers[1].value), plain(numbers[1].value + 30_000)) },
        { point: 'c', text: good.slice(0, good.indexOf('\n## 引用资料')) + '\n' },
      ]
    },
    taste(task, text) {
      return text.replace(/\s/g, '').length <= 800
    },
    pairs(task) {
      const good = this.good(task)
      const decisions = /** @type {Array<{ topic: string, owner: string }>} */ (task.hidden.decisions)
      const fabricated = good.replace(`- 议题：${decisions[2].topic}`, `- 议题：${decisions[2].topic}（会上一致同意追加 50 万元营销费用，并决定下月裁撤客服二组）`)
      const shuffled = (() => {
        const body = good.slice(0, good.indexOf('\n## 引用资料'))
        const bullets = body.split('\n').filter(l => l.startsWith('- ') || l.startsWith('  - ')).map(l => l.replace(/^\s*- /, ''))
        return `# 2026 年 9 月会议纪要\n\n${bullets.sort().join('；')}。\n${references(task)}`
      })()
      return [
        { id: 'minutes-fabricated', flaw: '加入了记录里没有的决定', good, bad: fabricated },
        { id: 'minutes-unstructured', flaw: '不分会议、不分议题，内容堆成一段', good, bad: shuffled },
      ]
    },
  },

  // ②（dev）根据产品说明与 20 条用户意见写一页改版建议
  revision: {
    build(seed) {
      const p = picker(seed)
      const themes = p.shuffle([
        { key: '搜索', say: ['搜索结果经常不相关', '搜不到刚发的内容', '搜索要输全名才行'] },
        { key: '加载', say: ['首页加载很慢', '图片加载要等好几秒', '切换页面时总在加载'] },
        { key: '夜间模式', say: ['晚上用太刺眼，希望有夜间模式', '夜间模式能不能跟随系统', '没有夜间模式看久了眼累'] },
        { key: '导出', say: ['数据没法导出成表格', '导出只能一条条来', '希望能批量导出'] },
        { key: '通知', say: ['通知太多太吵', '重要通知反而被淹没', '通知不能按类型关闭'] },
      ])
      const counts = [7, 5, 4, 2, 2]
      /** @type {Array<[string, string, string]>} */
      const comments = []
      themes.forEach((theme, t) => { for (let k = 0; k < counts[t]; k += 1) comments.push(['', `用户${p.int(100, 999)}`, `${theme.say[k % theme.say.length]}${k >= theme.say.length ? '，' + p.pick(['影响很大', '希望尽快改', '经常遇到']) : ''}`]) })
      const shuffled = p.shuffle(comments).map((c, i) => [String(i + 1), c[1], c[2]])
      const product = p.pick(['知识库 App', '团队笔记', '项目看板'])
      const csv = `编号,用户,意见\n${shuffled.map(r => r.join(',')).join('\n')}\n`
      return {
        message: '请根据 materials/ 下的产品说明和 20 条用户意见，写一页改版建议，保存为 output/改版建议.md：说清楚用户意见最集中的问题，并给出改版建议。',
        files: {
          'materials/产品说明.md': `# ${product}产品说明\n\n${product}面向 20–200 人的团队，核心功能：记录、搜索、分享、通知、数据导出。当前版本 3.2，每两周发布一次。\n`,
          'materials/用户意见.csv': csv,
        },
        outputs: ['output/改版建议.md'],
        fingerprints: [],
        rubric: [
          { id: 'm', type: 'missing', by: 'check', text: '意见最多的 3 类问题都写到了', feedback: '用户意见最多的几个问题没写全' },
          { id: 'r', type: 'wrong-result', by: 'check', text: '最集中的问题给出了意见条数，且与资料一致', feedback: '意见条数没写，或者数得不对' },
          { id: 'f', type: 'format', by: 'review', text: '每条建议都写了理由，并对应到具体的用户意见', feedback: '建议没有理由，也看不出对应哪些意见' },
          CONVENTION,
          { id: 't', type: 'taste', by: 'none', text: '建议用编号列表', feedback: '这次建议我想用编号列表，方便开会时逐条过' },
        ],
        hidden: { themes: themes.map((t, i) => ({ key: t.key, count: counts[i] })) },
      }
    },
    checks(task) {
      const themes = /** @type {Array<{ key: string, count: number }>} */ (task.hidden.themes)
      return {
        m: text => {
          const missing = themes.slice(0, 3).filter(t => !text.includes(t.key)).map(t => t.key)
          return missing.length === 0 ? ok() : no(`没提到：${missing.join('、')}`)
        },
        r: text => {
          const top = themes[0]
          const near = lines(text).some(l => l.includes(top.key) && [`${top.count}条`, `${top.count}位`, `${top.count}人`, `${top.count}个`, `${top.count}次`].some(f => l.includes(f)))
          return near ? ok() : no(`没有写出“${top.key}”的意见条数，或数字不对`)
        },
        c: citation(task),
      }
    },
    good(task) {
      const themes = /** @type {Array<{ key: string, count: number }>} */ (task.hidden.themes)
      const parts = ['# 改版建议', '', '20 条用户意见中，问题最集中的是以下三类：', '']
      themes.slice(0, 3).forEach((t, i) => {
        parts.push(`${i + 1}. **${t.key}**：共 ${t.count} 条意见。建议优先改进${t.key}，理由是这类意见占比最高，用户反复提到。`)
      })
      parts.push('', `其余问题（${themes.slice(3).map(t => t.key).join('、')}）各 2 条，放到下一版本评估。`)
      return `${parts.join('\n')}\n${references(task)}`
    },
    bad(task) {
      const good = this.good(task)
      const themes = /** @type {Array<{ key: string, count: number }>} */ (task.hidden.themes)
      return [
        { point: 'm', text: good.split('\n').filter(l => !l.startsWith('3. ')).join('\n') },
        { point: 'r', text: good.replace(`共 ${themes[0].count} 条意见`, `共 ${themes[0].count + 3} 条意见`) },
        { point: 'c', text: good.slice(0, good.indexOf('\n## 引用资料')) + '\n' },
      ]
    },
    taste(task, text) {
      return /^\s*\d+[.、)]/m.test(text)
    },
    pairs(task) {
      const good = this.good(task)
      const themes = /** @type {Array<{ key: string, count: number }>} */ (task.hidden.themes)
      const bare = `# 改版建议\n\n${themes.slice(0, 3).map((t, i) => `${i + 1}. 改${t.key}（${t.count} 条）。`).join('\n')}\n4. 全面升级界面风格。\n5. 增加 AI 助手。\n${references(task)}`
      return [{ id: 'revision-no-reasons', flaw: '建议没有理由，还加了意见里没有的方向', good, bad: bare }]
    },
  },

  // ③（selection）根据 4 份销售周报写月度小结
  'sales-summary': {
    build(seed) {
      const p = picker(seed)
      const regions = ['华东', '华南', '华北', '西南']
      /** @type {Record<string, string>} */
      const files = {}
      const weeks = [1, 2, 3, 4].map(w => regions.map(() => p.int(80, 320) * 100))
      weeks.forEach((values, w) => {
        files[`materials/销售周报-8月第${w + 1}周.txt`] = `8 月第 ${w + 1} 周销售周报\n\n${regions.map((r, i) => `${r}：${plain(values[i])} 元`).join('\n')}\n\n备注：${p.pick(['华东有一笔大单延期到下周。', '华南新开两家门店。', '华北受天气影响客流下降。', '西南促销活动效果明显。'])}\n`
      })
      const totals = regions.map((_, i) => weeks.reduce((s, w) => s + w[i], 0))
      const weekTotals = weeks.map(w => w.reduce((s, v) => s + v, 0))
      const top = weekTotals.indexOf(Math.max(...weekTotals)) + 1
      return {
        message: '请根据 materials/ 下 4 份销售周报写 8 月的销售月度小结，保存为 output/8月销售小结.md。',
        files,
        outputs: ['output/8月销售小结.md'],
        fingerprints: [],
        rubric: [
          { id: 'r', type: 'wrong-result', by: 'check', text: '月度总销售额正确', feedback: '月度总额算得不对' },
          { id: 'm', type: 'missing', by: 'check', text: '每个区域的月度销售额都给出了', feedback: '有的区域没写月度销售额' },
          { id: 'u', type: 'unverified', by: 'check', text: '指出的销售额最高的一周是对的', feedback: '说的最高那一周不对，像是没核对' },
          { id: 'f', type: 'format', by: 'review', text: '有基于数据的结论，不只是罗列数字', feedback: '只是把数字抄了一遍，没有结论' },
          CONVENTION,
          { id: 't', type: 'taste', by: 'none', text: '金额用万元表示', feedback: '这次金额我想看万元，读起来方便' },
        ],
        hidden: { regions, totals, total: totals.reduce((s, v) => s + v, 0), top, weekTotals },
      }
    },
    checks(task) {
      const { regions, totals, total, top } = /** @type {{ regions: string[], totals: number[], total: number, top: number }} */ (task.hidden)
      return {
        r: text => (hasAny(normalize(text), amountForms(total)) ? ok() : no(`没有正确的月度总额`)),
        m: text => {
          const missing = regions.filter((r, i) => !lines(text).some(l => l.includes(r) && amountForms(totals[i]).some(f => hasNumber(l, f))))
          return missing.length === 0 ? ok() : no(`缺区域月度额：${missing.join('、')}`)
        },
        u: text => (lines(text).some(l => /最高|最好|最多|峰值|最强/.test(l) && l.includes(`第${top}周`)) ? ok() : no(`没有指出最高的是第 ${top} 周`)),
        c: citation(task),
      }
    },
    good(task) {
      const { regions, totals, total, top, weekTotals } = /** @type {{ regions: string[], totals: number[], total: number, top: number, weekTotals: number[] }} */ (task.hidden)
      const best = regions[totals.indexOf(Math.max(...totals))]
      return `# 8 月销售月度小结

8 月总销售额 ${plain(total)} 元。

## 各区域

${regions.map((r, i) => `- ${r}：${plain(totals[i])} 元`).join('\n')}

## 结论

- 销售额最高的是第${top}周（${plain(weekTotals[top - 1])} 元）。
- ${best}贡献最大，占全月的 ${Math.round((Math.max(...totals) / total) * 100)}%，下月应保持投入。
${references(task)}`
    },
    bad(task) {
      const good = this.good(task)
      const { regions, total, top } = /** @type {{ regions: string[], total: number, top: number }} */ (task.hidden)
      return [
        { point: 'r', text: good.replace(`8 月总销售额 ${plain(total)} 元`, `8 月总销售额 ${plain(total + 5000)} 元`) },
        { point: 'm', text: good.split('\n').filter(l => !l.startsWith(`- ${regions[3]}：`)).join('\n') },
        { point: 'u', text: good.replace(`最高的是第${top}周`, `最高的是第${(top % 4) + 1}周`) },
        { point: 'c', text: good.slice(0, good.indexOf('\n## 引用资料')) + '\n' },
      ]
    },
    taste(task, text) {
      return text.includes('万')
    },
    pairs(task) {
      const good = this.good(task)
      const dump = good.slice(0, good.indexOf('## 结论')) + references(task)
      return [{ id: 'sales-no-conclusion', flaw: '只列数字，没有结论', good, bad: dump }]
    },
  },

  // ④（selection）根据两份方案写对比备忘
  'compare-memo': {
    build(seed) {
      const p = picker(seed)
      const budget = p.int(40, 60)
      const a = { label: '方案A', cost: budget - p.int(3, 8), weeks: p.int(14, 20), risk: p.pick(['依赖外部供应商', '需要停机迁移']) }
      const b = { label: '方案B', cost: budget + p.int(5, 15), weeks: p.int(8, 12), risk: p.pick(['团队缺少相关经验', '许可证费用逐年上涨']) }
      const subject = p.pick(['客服系统替换', '数据仓库迁移', '门店网络改造'])
      const plan = (/** @type {typeof a} */ x) => `# ${subject}${x.label}\n\n费用：${x.cost} 万元\n工期：${x.weeks} 周\n主要风险：${x.risk}\n`
      return {
        message: `请根据 materials/ 下的两份方案写一份对比备忘，保存为 output/方案对比备忘.md。预算不超过 ${budget} 万元，请给出推荐意见。`,
        files: { [`materials/${subject}-方案A.md`]: plan(a), [`materials/${subject}-方案B.md`]: plan(b) },
        outputs: ['output/方案对比备忘.md'],
        fingerprints: [],
        rubric: [
          { id: 'm', type: 'missing', by: 'check', text: '两个方案的费用和工期都写出来了', feedback: '费用或工期没写全' },
          { id: 'u', type: 'unverified', by: 'check', text: '两个方案的主要风险都提到了', feedback: '漏了方案的风险，像是没对照原文' },
          { id: 'r', type: 'wrong-result', by: 'review', text: '推荐意见符合预算约束', feedback: '推荐的方案超预算了' },
          { id: 'f', type: 'format', by: 'review', text: '逐项对比（表格或分项），看得出差别', feedback: '没有逐项对比，看不出两个方案差在哪' },
          CONVENTION,
          { id: 't', type: 'taste', by: 'none', text: '开头先写结论', feedback: '这次我想开头先看结论' },
        ],
        hidden: { a, b, budget },
      }
    },
    checks(task) {
      const { a, b } = /** @type {{ a: { cost: number, weeks: number, risk: string }, b: { cost: number, weeks: number, risk: string } }} */ (task.hidden)
      return {
        m: text => {
          const t = normalize(text)
          const missing = [a, b].flatMap(x => [hasAny(t, [`${x.cost}万`]) ? null : `${x.cost} 万`, t.includes(`${x.weeks}周`) ? null : `${x.weeks} 周`]).filter(Boolean)
          return missing.length === 0 ? ok() : no(`缺：${missing.join('、')}`)
        },
        u: text => {
          const missing = [a, b].filter(x => !text.includes(x.risk)).map(x => x.risk)
          return missing.length === 0 ? ok() : no(`缺风险：${missing.join('、')}`)
        },
        c: citation(task),
      }
    },
    good(task) {
      const { a, b, budget } = /** @type {{ a: { label: string, cost: number, weeks: number, risk: string }, b: { label: string, cost: number, weeks: number, risk: string }, budget: number }} */ (task.hidden)
      return `# 方案对比备忘

结论：推荐${a.label}。${b.label}费用 ${b.cost} 万元，超过 ${budget} 万元的预算；${a.label}在预算内，代价是工期更长。

| 项目 | ${a.label} | ${b.label} |
| --- | --- | --- |
| 费用 | ${a.cost} 万元 | ${b.cost} 万元 |
| 工期 | ${a.weeks} 周 | ${b.weeks} 周 |
| 主要风险 | ${a.risk} | ${b.risk} |
${references(task)}`
    },
    bad(task) {
      const good = this.good(task)
      const { a, b } = /** @type {{ a: { cost: number, weeks: number, risk: string }, b: { cost: number, risk: string } }} */ (task.hidden)
      return [
        { point: 'm', text: good.replace(`| 工期 | ${a.weeks} 周`, '| 工期 | 较长') },
        { point: 'u', text: good.replace(`| ${b.risk} |`, '| 无 |') },
        { point: 'c', text: good.slice(0, good.indexOf('\n## 引用资料')) + '\n' },
      ]
    },
    taste(task, text) {
      const first = text.split(/\r?\n/).find(l => l.trim() !== '' && !/^#/.test(l)) ?? ''
      return /推荐|建议|结论/.test(first)
    },
    pairs(task) {
      const good = this.good(task)
      const { a, b, budget } = /** @type {{ a: { label: string }, b: { label: string, cost: number }, budget: number }} */ (task.hidden)
      const wrong = good.replace(/^结论：.*$/m, `结论：推荐${b.label}。${b.label}工期短、见效快，费用 ${b.cost} 万元，可以接受。`)
      void a; void budget
      return [{ id: 'memo-over-budget', flaw: '推荐了超出预算的方案', good, bad: wrong }]
    },
  },

  // ⑤（guard）英文操作说明改写成中文分步指南
  'translate-guide': {
    build(seed) {
      const p = picker(seed)
      const tool = p.pick(['vaultctl', 'bkup', 'snapkit'])
      const steps = [
        { en: `Stop the application service with \`${tool} service stop\`.`, cmd: `${tool} service stop` },
        { en: `Check that free disk space is at least ${p.int(20, 50)} GB.`, cmd: null },
        { en: `Run a full backup: \`${tool} backup --full --target /mnt/backup\`.`, cmd: `${tool} backup --full --target /mnt/backup` },
        { en: `Verify the backup with \`${tool} verify --latest\`. Do not continue if verification fails.`, cmd: `${tool} verify --latest` },
        { en: `Copy the backup to the offsite bucket using \`${tool} sync --offsite\`.`, cmd: `${tool} sync --offsite` },
        { en: 'Record the backup ID in the operations log.', cmd: null },
        { en: `Start the service again with \`${tool} service start\`.`, cmd: `${tool} service start` },
        { en: 'Notify the on-call channel that maintenance has finished.', cmd: null },
      ]
      return {
        message: '请把 materials/ 下的英文操作说明改写成中文的分步操作指南，保存为 output/备份操作指南.md。',
        files: { [`materials/${tool}-backup-guide.md`]: `# Backup procedure (${tool})\n\n${steps.map((s, i) => `${i + 1}. ${s.en}`).join('\n')}\n` },
        outputs: ['output/备份操作指南.md'],
        fingerprints: [],
        rubric: [
          { id: 'm', type: 'missing', by: 'check', text: '8 个步骤都在，并按原顺序编号', feedback: '步骤少了或者顺序变了' },
          { id: 'f', type: 'format', by: 'check', text: '命令和参数原样保留', feedback: '命令被改动了，照着敲会出错' },
          { id: 'r', type: 'wrong-result', by: 'review', text: '每一步的意思与原文一致，注意事项（如校验失败不要继续）没有丢', feedback: '有的步骤意思翻错了，或者注意事项丢了' },
          CONVENTION,
          { id: 't', type: 'taste', by: 'none', text: '不用“您”', feedback: '这次不用写“您”，直接写操作就行' },
        ],
        hidden: { steps, tool },
      }
    },
    checks(task) {
      const steps = /** @type {Array<{ cmd: string | null }>} */ (task.hidden.steps)
      return {
        m: text => {
          const numbers = text.split(/\r?\n/).map(l => /^\s*(?:#{1,6}\s*)?(?:第\s*)?(\d+)\s*(?:[.、)）:：]|步)/.exec(l)?.[1]).filter(Boolean).map(Number)
          const firsts = steps.map((_, i) => numbers.indexOf(i + 1))
          const ordered = firsts.every((at, i) => at >= 0 && (i === 0 || at > firsts[i - 1]))
          return ordered ? ok() : no(`编号 1–${steps.length} 不全或顺序不对`)
        },
        f: text => {
          const missing = steps.filter(s => s.cmd !== null && !text.includes(/** @type {string} */ (s.cmd))).map(s => s.cmd)
          return missing.length === 0 ? ok() : no(`命令被改动或缺少：${missing.join('；')}`)
        },
        c: citation(task),
      }
    },
    good(task) {
      const steps = /** @type {Array<{ en: string, cmd: string | null }>} */ (task.hidden.steps)
      const zh = [
        (/** @type {string} */ c) => `停止应用服务：\`${c}\`。`,
        () => `确认磁盘剩余空间满足要求（见原文数值）。`,
        (/** @type {string} */ c) => `执行全量备份：\`${c}\`。`,
        (/** @type {string} */ c) => `校验备份：\`${c}\`。校验失败时不要继续。`,
        (/** @type {string} */ c) => `把备份同步到异地存储：\`${c}\`。`,
        () => '在运维日志里记下本次备份的 ID。',
        (/** @type {string} */ c) => `重新启动服务：\`${c}\`。`,
        () => '在值班群里通知维护已经结束。',
      ]
      const space = /at least (\d+) GB/.exec(steps[1].en)?.[1]
      const body = steps.map((s, i) => `${i + 1}. ${zh[i](s.cmd ?? '').replace('满足要求（见原文数值）', `不少于 ${space} GB`)}`).join('\n')
      return `# 备份操作指南\n\n${body}\n${references(task)}`
    },
    bad(task) {
      const good = this.good(task)
      const tool = /** @type {string} */ (task.hidden.tool)
      return [
        { point: 'm', text: good.replace(/^4\. .*\n/m, '').replace(/^5\. /m, '4. ').replace(/^6\. /m, '5. ').replace(/^7\. /m, '6. ').replace(/^8\. /m, '7. ') },
        { point: 'f', text: good.replace(`${tool} backup --full --target /mnt/backup`, `${tool} backup --all --to /mnt/backup`) },
        { point: 'c', text: good.slice(0, good.indexOf('\n## 引用资料')) + '\n' },
      ]
    },
    taste(task, text) {
      return !text.includes('您')
    },
    pairs(task) {
      const good = this.good(task)
      const wrong = good.replace('校验失败时不要继续。', '校验失败也可以继续后面的步骤。').replace(/^2\. .*$/m, '2. 清理磁盘上的旧文件。')
      return [{ id: 'guide-mistranslated', flaw: '把“校验失败不要继续”译反了，第 2 步意思错了', good, bad: wrong }]
    },
  },

  // ⑥（holdout）根据事故记录写复盘
  'incident-review': {
    build(seed) {
      const p = picker(seed)
      const id = `INC-${p.int(2000, 9999)}`
      const startH = p.int(9, 16)
      const startM = p.int(0, 20)
      const at = (/** @type {number} */ minutes) => `${pad(startH + Math.floor((startM + minutes) / 60))}:${pad((startM + minutes) % 60)}`
      const detected = p.int(8, 15)
      const mitigated = detected + p.int(15, 30)
      const recovered = mitigated + p.int(10, 25)
      const times = [at(0), at(detected), at(mitigated), at(recovered)]
      const users = p.int(1200, 8800)
      const owners = p.shuffle(PEOPLE).slice(0, 3)
      const actions = [
        `为配置变更增加灰度发布（${owners[0]}，10 月底前）`,
        `给连接池耗尽增加告警（${owners[1]}，10 月 15 日前）`,
        `补充回滚手册并演练一次（${owners[2]}，11 月 10 日前）`,
      ]
      const service = p.pick(['订单服务', '支付网关', '登录服务'])
      return {
        message: '请根据 materials/ 下的事故记录写一份事故复盘，保存为 output/事故复盘.md。',
        files: {
          [`materials/事故记录-${id}.txt`]: `事故编号：${id}\n影响服务：${service}\n\n时间线：\n${times[0]} 配置变更上线，数据库连接池上限被误改\n${times[1]} 监控告警，值班人员开始排查\n${times[2]} 回滚配置，错误率开始下降\n${times[3]} 服务完全恢复\n\n影响：约 ${plain(users)} 名用户下单失败，持续 ${recovered} 分钟。\n根因：配置变更未经评审，连接池上限从 200 改成了 20。\n改进措施：\n${actions.map(a => `- ${a}`).join('\n')}\n`,
        },
        outputs: ['output/事故复盘.md'],
        fingerprints: [id],
        rubric: [
          { id: 'm', type: 'missing', by: 'check', text: '时间线的 4 个关键时间点都在', feedback: '时间线不全' },
          { id: 'r', type: 'wrong-result', by: 'check', text: '影响时长和受影响用户数正确', feedback: '影响时长或用户数写错了' },
          { id: 'u', type: 'unverified', by: 'review', text: '根因与改进措施对得上，每项措施有负责人和期限', feedback: '改进措施和根因对不上，或者没写负责人' },
          { id: 'f', type: 'format', by: 'review', text: '包含时间线、影响、根因、改进措施四部分', feedback: '复盘缺了某一部分' },
          CONVENTION,
          { id: 't', type: 'taste', by: 'none', text: '改进措施用表格列出', feedback: '这次改进措施我想用表格列' },
        ],
        hidden: { times, users, minutes: recovered, actions, id },
      }
    },
    checks(task) {
      const { times, users, minutes } = /** @type {{ times: string[], users: number, minutes: number }} */ (task.hidden)
      return {
        m: text => {
          const t = normalize(text)
          const missing = times.filter(time => {
            const [h, m] = time.split(':')
            return ![time, `${Number(h)}:${m}`, `${h}点${m}分`, `${Number(h)}点${m}分`, `${Number(h)}点${Number(m)}分`].some(form => t.includes(form))
          })
          return missing.length === 0 ? ok() : no(`缺时间点：${missing.join('、')}`)
        },
        r: text => {
          const t = normalize(text)
          const okUsers = hasAny(t, amountForms(users))
          const okMinutes = [`${minutes}分钟`, `${minutes}min`, `${minutes} min`].some(f => t.includes(f))
          return okUsers && okMinutes ? ok() : no(`${okUsers ? '' : '用户数不对；'}${okMinutes ? '' : '时长不对'}`)
        },
        c: citation(task),
      }
    },
    good(task) {
      const { times, users, minutes, actions, id } = /** @type {{ times: string[], users: number, minutes: number, actions: string[], id: string }} */ (task.hidden)
      return `# ${id} 事故复盘

## 时间线

- ${times[0]} 配置变更上线，连接池上限被误改
- ${times[1]} 监控告警，开始排查
- ${times[2]} 回滚配置，错误率下降
- ${times[3]} 服务完全恢复

## 影响

约 ${plain(users)} 名用户下单失败，持续 ${minutes} 分钟。

## 根因

配置变更未经评审，连接池上限从 200 被改成 20。

## 改进措施

${actions.map(a => `- ${a}`).join('\n')}
${references(task)}`
    },
    bad(task) {
      const good = this.good(task)
      const { times, minutes } = /** @type {{ times: string[], minutes: number }} */ (task.hidden)
      return [
        { point: 'm', text: good.replace(`- ${times[2]} 回滚配置，错误率下降\n`, '') },
        { point: 'r', text: good.replace(`持续 ${minutes} 分钟`, `持续 ${minutes + 10} 分钟`) },
        { point: 'c', text: good.slice(0, good.indexOf('\n## 引用资料')) + '\n' },
      ]
    },
    taste(task, text) {
      return /^\s*\|.*\|\s*$/m.test(text)
    },
  },

  // ⑦（holdout）根据 5 份访谈稿写需求摘要
  'interview-summary': {
    build(seed) {
      const p = picker(seed)
      const people = p.shuffle(PEOPLE).slice(0, 5)
      const common = p.shuffle([
        { key: '离线使用', line: '出差时没网也想能看资料' },
        { key: '批量审批', line: '每天几十个审批，一个个点太慢' },
        { key: '权限分级', line: '外包同事不该看到全部内容' },
        { key: '移动端编辑', line: '手机上只能看不能改' },
      ]).slice(0, 2)
      const singles = p.shuffle([
        { key: '深色主题', line: '想要深色主题' },
        { key: '语音输入', line: '开车时想用语音记录' },
        { key: '自定义字段', line: '表单字段想自己加' },
        { key: '日历同步', line: '希望和日历同步' },
        { key: '水印', line: '导出的文件想加水印' },
      ])
      /** @type {Record<string, string>} */
      const files = {}
      /** @type {Record<string, string[]>} */
      const mentions = Object.fromEntries(common.map(c => [c.key, []]))
      people.forEach((person, i) => {
        const said = []
        common.forEach((c, k) => {
          if ((i + k) % 5 < 3) { said.push(`${c.line}。`); mentions[c.key].push(person) }
        })
        said.push(`${singles[i].line}。`)
        files[`materials/访谈-${person}.txt`] = `访谈对象：${person}（${p.pick(['销售', '财务', '运营', '客服', '采购'])}）\n\n问：日常使用中最大的不便是什么？\n答：${said.join('另外，')}\n`
      })
      return {
        message: '请根据 materials/ 下 5 份用户访谈稿写一份需求摘要，保存为 output/需求摘要.md。',
        files,
        outputs: ['output/需求摘要.md'],
        fingerprints: people.map(person => `访谈对象：${person}（`),
        rubric: [
          { id: 'm', type: 'missing', by: 'check', text: '被 3 位以上受访者提到的需求都写进去了', feedback: '大家都提到的需求漏了' },
          { id: 'u', type: 'unverified', by: 'check', text: '每条共性需求都注明了提到它的受访者', feedback: '没写清楚哪些人提了这些需求，看不出是否核对过' },
          { id: 'r', type: 'wrong-result', by: 'review', text: '没有把只有一个人提到的需求说成多数人的共识', feedback: '把个别人的想法写成了大家的需求' },
          { id: 'f', type: 'format', by: 'review', text: '按提到的人数或重要性排序，结构清楚', feedback: '需求没有主次，看不出先做哪个' },
          CONVENTION,
          { id: 't', type: 'taste', by: 'none', text: '用 P0 / P1 标优先级', feedback: '这次我想用 P0、P1 标一下优先级' },
        ],
        hidden: { common: common.map(c => ({ key: c.key, people: mentions[c.key] })), singles: singles.map(s => s.key) },
      }
    },
    checks(task) {
      const common = /** @type {Array<{ key: string, people: string[] }>} */ (task.hidden.common)
      return {
        m: text => {
          const missing = common.filter(c => !text.includes(c.key)).map(c => c.key)
          return missing.length === 0 ? ok() : no(`漏了：${missing.join('、')}`)
        },
        u: text => {
          // Material file names carry the interviewees' names; they do not count as noting who said what.
          const body = materialNames(task).reduce((t, name) => t.replaceAll(name, ''), text)
          const missing = common.flatMap(c => c.people.filter(person => !body.includes(person)).map(person => `${c.key}/${person}`))
          return missing.length === 0 ? ok() : no(`没注明：${missing.join('、')}`)
        },
        c: citation(task),
      }
    },
    good(task) {
      const common = /** @type {Array<{ key: string, people: string[] }>} */ (task.hidden.common)
      const singles = /** @type {string[]} */ (task.hidden.singles)
      return `# 需求摘要

## 共性需求（按提到人数排序）

${common.map((c, i) => `${i + 1}. ${c.key}：${c.people.length} 位受访者提到（${c.people.join('、')}）。`).join('\n')}

## 个别需求（各 1 人提到，暂不作为共识）

${singles.map(s => `- ${s}`).join('\n')}
${references(task)}`
    },
    bad(task) {
      const good = this.good(task)
      const common = /** @type {Array<{ key: string, people: string[] }>} */ (task.hidden.common)
      return [
        { point: 'm', text: good.split('\n').filter(l => !l.startsWith('2. ')).join('\n') },
        { point: 'u', text: good.replace(`（${common[0].people.join('、')}）`, '') },
        { point: 'c', text: good.slice(0, good.indexOf('\n## 引用资料')) + '\n' },
      ]
    },
    taste(task, text) {
      return /P0|P1/.test(text)
    },
  },

  // ⑧（holdout，dev 里没有的变体）根据会议记录写决议与待办清单
  'decisions-todos': {
    build(seed) {
      const p = picker(seed)
      const people = p.shuffle(PEOPLE).slice(0, 5)
      const project = p.pick(['春季新品发布', '华南仓启用', 'CRM 升级'])
      const decisions = p.shuffle([`${project}定在 11 月第二周`, '预算上限维持不变', '外包团队续约一年', '先在两个城市试点']).slice(0, 3)
      const discussed = p.shuffle(['是否更换物流商', '要不要请代言人', '是否推迟官网改版']).slice(0, 2)
      const tasks = p.shuffle(['整理竞品价格表', '确认场地合同', '更新培训材料', '提交采购申请', '约见三家供应商', '准备试点数据看板'])
      const todos = people.map((owner, i) => ({ what: tasks[i], owner, due: `2026-${p.pick(['10', '11'])}-${pad(p.int(5, 28))}` }))
      const id = `${project}推进会`
      return {
        message: '请根据 materials/ 下的会议记录整理一份决议与待办清单，保存为 output/决议与待办.md。',
        files: {
          [`materials/会议记录-${id}.txt`]: `${id} 会议记录\n日期：2026-10-${pad(p.int(1, 9))}\n参会：${people.join('、')}\n\n讨论：\n${discussed.map(d => `- ${d}：意见不一，下次再议。`).join('\n')}\n\n决议：\n${decisions.map(d => `- ${d}`).join('\n')}\n\n待办：\n${todos.map(t => `- ${t.what}：${t.owner} 负责，${t.due} 前完成`).join('\n')}\n`,
        },
        outputs: ['output/决议与待办.md'],
        fingerprints: [`${id} 会议记录`],
        rubric: [
          { id: 'm', type: 'missing', by: 'check', text: '每个待办的负责人和截止日期都在', feedback: '有的待办没写负责人或截止日期' },
          { id: 'f', type: 'format', by: 'check', text: '待办逐条列出，每条同一行写明负责人和截止日期', feedback: '待办没有逐条列清楚负责人和截止日期' },
          { id: 'u', type: 'unverified', by: 'check', text: '每个待办对应的负责人正确', feedback: '有的待办负责人写错了人' },
          { id: 'r', type: 'wrong-result', by: 'review', text: '没有把只讨论、未决定的事项写成决议', feedback: '把还没定的事写成了决议' },
          CONVENTION,
          { id: 't', type: 'taste', by: 'none', text: '日期写成“X月X日”', feedback: '这次日期我想写成“10月12日”这样' },
        ],
        hidden: { todos, decisions, discussed },
      }
    },
    checks(task) {
      const todos = /** @type {Array<{ what: string, owner: string, due: string }>} */ (task.hidden.todos)
      return {
        m: text => {
          const owners = todos.filter(t => !text.includes(t.owner)).map(t => t.owner)
          const dues = missingDates(text, todos.map(t => t.due))
          return owners.length === 0 && dues.length === 0 ? ok() : no(`缺负责人 ${owners.join('、') || '无'}；缺日期 ${dues.join('、') || '无'}`)
        },
        f: text => {
          const bad = todos.filter(t => !lines(text).some(l => l.includes(t.owner) && hasAny(l, dateForms(t.due))))
          return bad.length === 0 ? ok() : no(`${bad.length} 个待办没有在同一行写明负责人和日期`)
        },
        u: text => {
          const wrong = todos.filter(t => !lines(text).some(l => l.includes(t.what) && l.includes(t.owner)))
          return wrong.length === 0 ? ok() : no(`负责人不对或没写：${wrong.map(t => t.what).join('、')}`)
        },
        c: citation(task),
      }
    },
    good(task) {
      const { todos, decisions } = /** @type {{ todos: Array<{ what: string, owner: string, due: string }>, decisions: string[] }} */ (task.hidden)
      return `# 决议与待办

## 决议

${decisions.map(d => `- ${d}`).join('\n')}

## 待办

| 事项 | 负责人 | 截止日期 |
| --- | --- | --- |
${todos.map(t => `| ${t.what} | ${t.owner} | ${t.due} |`).join('\n')}
${references(task)}`
    },
    bad(task) {
      const good = this.good(task)
      const todos = /** @type {Array<{ what: string, owner: string, due: string }>} */ (task.hidden.todos)
      const [x, y] = todos
      return [
        { point: 'm', text: good.replace(`| ${x.what} | ${x.owner} | ${x.due} |`, `| ${x.what} | ${x.owner} | 待定 |`) },
        { point: 'f', text: good.replace(/\| 事项[\s\S]*?(?=\n\n## 引用资料)/, `待办事项：${todos.map(t => t.what).join('、')}。\n负责人：${todos.map(t => t.owner).join('、')}。\n截止日期：${todos.map(t => t.due).join('、')}。`) },
        { point: 'u', text: good.replace(`| ${x.what} | ${x.owner} |`, `| ${x.what} | ${y.owner} |`).replace(`| ${y.what} | ${y.owner} |`, `| ${y.what} | ${x.owner} |`) },
        { point: 'c', text: good.slice(0, good.indexOf('\n## 引用资料')) + '\n' },
      ]
    },
    taste(task, text) {
      const todos = /** @type {Array<{ due: string }>} */ (task.hidden.todos)
      return todos.every(t => { const [, m, d] = t.due.split('-'); return text.includes(`${Number(m)}月${Number(d)}日`) })
    },
  },
}

/** Every case of the family, in plan order. @returns {PilotCase[]} */
export function docsCases() {
  return DOCS_PLAN.map(entry => {
    const built = VARIANTS[entry.variant].build(entry.seed)
    return {
      id: `docs/${entry.set}/${entry.variant}-${entry.seed}`,
      family: /** @type {const} */ ('docs'),
      set: /** @type {CaseSet} */ (entry.set),
      variant: entry.variant,
      seed: entry.seed,
      ...built,
      // Fingerprints for holdout isolation: the case's own phrases plus every material's first line.
      fingerprints: [...built.fingerprints, ...Object.entries(built.files).map(([path, text]) => `${path.slice('materials/'.length)}`), ...Object.values(built.files).map(text => String(text).split('\n').slice(0, 2).join('\n'))],
    }
  })
}

/** @param {PilotCase} task */
const variantOf = task => {
  const variant = VARIANTS[task.variant]
  if (variant === undefined) throw new Error(`unknown docs variant ${task.variant}`)
  return variant
}

/**
 * Deterministic checkers of a case, reading its one output document.
 * @param {PilotCase} task
 * @returns {Record<string, Checker>}
 */
export function docsCheckers(task) {
  const checks = variantOf(task).checks(task)
  const out = task.outputs[0]
  return Object.fromEntries(Object.entries(checks).map(([id, check]) => [id, /** @type {Checker} */ (async dir => {
    const { readFile } = await import('node:fs/promises')
    const { join } = await import('node:path')
    let text
    try {
      text = (await readFile(join(dir, out))).toString('utf8')
    } catch {
      return no(`没有 ${out}`)
    }
    return check(text)
  })]))
}

/** The known good document as an end state. @param {PilotCase} task */
export const docsGood = task => ({ write: { [task.outputs[0]]: variantOf(task).good(task) }, remove: [] })

/** Known bad documents, one per checked point, as end states. @param {PilotCase} task */
export const docsBad = task => variantOf(task).bad(task).map(b => ({ point: b.point, answer: { write: { [task.outputs[0]]: b.text }, remove: [] } }))

/** Whether a document already matches the taste point. @param {PilotCase} task @param {string} text */
export const docsTaste = (task, text) => variantOf(task).taste(task, text)

/**
 * The six known good / bad document pairs of reliability criterion 2, from the dev,
 * selection and guard tasks only (holdout tasks never reach a model before the pilot).
 * @param {PilotCase[]} cases
 * @returns {Array<{ id: string, caseId: string, flaw: string, good: string, bad: string }>}
 */
export function referencePairs(cases) {
  return cases
    .filter(task => task.family === 'docs' && task.set !== 'holdout')
    .flatMap(task => (variantOf(task).pairs?.(task) ?? []).map(pair => ({ ...pair, caseId: task.id })))
}
