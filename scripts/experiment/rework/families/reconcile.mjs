// @ts-check
/**
 * Family `reconcile`, 多份资料汇总并核对数字: several branches send their monthly expense
 * sheets, finance sends a memo; the task is a per-branch summary table plus a note on the
 * input problems. A case carries 2–3 input problems drawn from the pool below, so what
 * pays off is the habit of checking inputs against each other before adding them up, not
 * any one rule.
 *
 * Linux, macOS and Windows; Node built-ins only.
 */
import { picker } from '../../step6/rng.mjs'
import { amountForms, hasAny, no, normalize, ok, pad, parseCsv, problemLine, readText, sha256, toCsv } from '../common.mjs'

/**
 * @typedef {import('../common.mjs').Family} Family
 * @typedef {import('../common.mjs').InnerCase} InnerCase
 * @typedef {import('../common.mjs').Point} Point
 * @typedef {import('../common.mjs').Answer} Answer
 * @typedef {{ id: string, date: string, item: string, cents: number | null }} Row
 * @typedef {{ name: string, file: string, unit: '元' | '万元', rows: Row[] }} Sheet
 */

/** Input problems a case may carry. */
export const TRAP_POOL = /** @type {const} */ (['duplicate-row', 'unit-wan', 'stated-total', 'missing-value', 'missing-branch'])

const BRANCHES = ['上海', '杭州', '南京', '苏州', '合肥', '宁波', '无锡', '厦门', '青岛', '成都']
const ITEMS = ['差旅', '办公用品', '会议', '培训', '招待', '通讯', '交通', '设备维修']
const MONTHS = ['07', '08', '09', '10', '11']

const yuan = (/** @type {number} */ cents) => (cents / 100).toFixed(2)
const sum = (/** @type {number[]} */ list) => list.reduce((s, x) => s + x, 0)

/** Rows a correct summary counts: duplicates once, blanks out. @param {Sheet} sheet */
function countedRows(sheet) {
  const seen = new Set()
  return sheet.rows.filter(row => {
    if (row.cents === null || seen.has(row.id)) return false
    seen.add(row.id)
    return true
  })
}

/** @param {InnerCase} task @returns {Array<{ name: string, cents: number }>} */
const expected = task => task.hidden.sheets.map((/** @type {Sheet} */ sheet) => ({ name: sheet.name, cents: sum(countedRows(sheet).map(row => /** @type {number} */ (row.cents))) }))

/** The CSV text of a sheet. @param {Sheet} sheet */
function sheetCsv(sheet) {
  const header = ['单号', '日期', '项目', `金额(${sheet.unit})`]
  const cell = (/** @type {number | null} */ cents) => (cents === null ? '' : sheet.unit === '万元' ? (cents / 1_000_000).toFixed(6).replace(/0+$/, '').replace(/\.$/, '') : yuan(cents))
  return toCsv([header, ...sheet.rows.map(row => [row.id, row.date, row.item, cell(row.cents)])])
}

/** @type {Family['build']} */
function build(seed, { convention }) {
  const p = picker(`reconcile:${seed}`)
  const month = p.pick(MONTHS)
  const n = p.int(4, 5)
  const names = p.shuffle(BRANCHES).slice(0, n + 1)
  const present = names.slice(0, n)
  const traps = p.shuffle(TRAP_POOL).slice(0, p.int(2, 3)).sort((a, b) => TRAP_POOL.indexOf(a) - TRAP_POOL.indexOf(b))
  // Ids carry a code derived from the seed, never the seed itself (it names the split).
  const code = sha256(seed).slice(0, 4).toUpperCase()
  let serial = 0
  /** @type {Sheet[]} */
  const sheets = present.map((name, b) => ({
    name,
    file: `data/${name}-2026${month}.csv`,
    unit: /** @type {'元'} */ ('元'),
    rows: Array.from({ length: p.int(5, 8) }, () => {
      serial += 1
      // Whole yuan in the 万元 sheet stays exact (four decimals of 万 are one yuan).
      return { id: `BX${code}${b}${pad(serial)}`, date: `2026-${month}-${pad(p.int(1, 28))}`, item: p.pick(ITEMS), cents: p.int(120, 9800) * 100 + (p.next() < 0.5 ? 0 : p.int(1, 99)) }
    }),
  }))
  /** @type {Record<string, any>} */
  const trap = {}
  const other = (/** @type {number} */ k) => sheets[(k + traps.length) % sheets.length]
  if (traps.includes('duplicate-row')) {
    const sheet = other(0)
    const row = sheet.rows[p.int(0, sheet.rows.length - 1)]
    sheet.rows.splice(p.int(0, sheet.rows.length), 0, { ...row })
    trap.duplicate = { branch: sheet.name, id: row.id }
  }
  if (traps.includes('unit-wan')) {
    const sheet = other(1)
    sheet.unit = '万元'
    for (const row of sheet.rows) if (row.cents !== null) row.cents = Math.round(row.cents / 100) * 100
    trap.wan = { branch: sheet.name }
  }
  if (traps.includes('missing-value')) {
    const sheet = other(2)
    const candidates = sheet.rows.filter(r => r.id !== trap.duplicate?.id)
    const row = candidates[p.int(0, candidates.length - 1)]
    row.cents = null
    trap.blank = { branch: sheet.name, id: row.id }
  }
  const totals = sheets.map(sheet => sum(countedRows(sheet).map(row => /** @type {number} */ (row.cents))))
  const total = sum(totals)
  const memoBranches = traps.includes('missing-branch') ? names : present
  if (traps.includes('missing-branch')) trap.missing = { branch: names[n] }
  const stated = traps.includes('stated-total') ? total + p.pick([-1, 1]) * p.int(30, 900) * 100 : null
  if (stated !== null) trap.stated = { cents: stated }
  const memo = [
    `# 2026 年 ${Number(month)} 月费用汇总说明（财务部）`,
    '',
    `本月需要汇总的分部：${memoBranches.join('、')}。各分部的明细表在 data/ 目录下，一个分部一个文件。`,
    stated === null ? '汇总后请把各分部金额和总额报给财务。' : `财务这边初步算的各分部合计为 ${yuan(stated)} 元，请以明细为准复核。`,
    '',
  ].join('\n')
  const summaryPath = p.pick(['output/summary.csv', 'output/branch-totals.csv'])
  const notePath = p.pick(['output/notes.md', 'output/check-notes.md'])
  const ask = p.pick([
    `请把 data/ 下各分部 ${Number(month)} 月的费用明细汇总成一张表，写到 ${summaryPath}：两列，表头是“部门,金额”，每个分部一行，金额单位为元，最后一行是“合计”。财务的说明在 data/memo.md。`,
    `财务要一份 ${Number(month)} 月各分部费用的汇总：请读 data/memo.md 和各分部的明细，生成 ${summaryPath}（表头“部门,金额”，一分部一行，金额按元，末行“合计”）。`,
  ])
  const files = Object.fromEntries([...sheets.map(sheet => [sheet.file, sheetCsv(sheet)]), ['data/memo.md', memo]])
  /** @type {Point[]} */
  const rubric = [
    { id: '', type: 'wrong-result', by: 'check', weight: 3, text: `${summaryPath} 里每个分部的金额等于该分部明细按元计的合计（重复的单号只算一次，空金额不算）`, feedback: '有分部的金额和明细对不上' },
    { id: '', type: 'format', by: 'check', weight: 1, text: `${summaryPath} 表头是“部门,金额”，最后一行是“合计”，合计等于上面各行之和`, feedback: '汇总表的表头或合计行不对' },
  ]
  if (trap.duplicate !== undefined) rubric.push({ id: '', type: 'unverified', by: 'check', weight: 2, text: `${notePath} 指出 ${trap.duplicate.branch} 的明细里有重复的单号（${trap.duplicate.id}）`, feedback: '明细里有重复记录，说明里没提' })
  if (trap.wan !== undefined) rubric.push({ id: '', type: 'unverified', by: 'check', weight: 2, text: `${notePath} 指出 ${trap.wan.branch} 的明细以万元为单位、已换算成元`, feedback: '有一份明细的单位和别的不一样，说明里没提' })
  if (trap.stated !== undefined) rubric.push({ id: '', type: 'unverified', by: 'check', weight: 2, text: `${notePath} 指出财务说明里的合计 ${yuan(trap.stated.cents)} 元与明细合计不符`, feedback: '财务说明里的数和明细对不上，说明里没提' })
  if (trap.blank !== undefined) rubric.push({ id: '', type: 'unverified', by: 'check', weight: 2, text: `${notePath} 指出 ${trap.blank.branch} 的单号 ${trap.blank.id} 金额为空、没有计入`, feedback: '有一条明细金额是空的，说明里没提' })
  if (trap.missing !== undefined) rubric.push({ id: '', type: 'unverified', by: 'check', weight: 2, text: `${notePath} 指出说明里列了 ${trap.missing.branch} 但没有它的明细`, feedback: '有个分部缺明细，说明里没提' })
  if (convention) rubric.push({ id: '', type: 'convention', by: 'check', weight: 1, text: `${summaryPath} 的金额一律保留两位小数`, feedback: '金额的小数位数不统一' })
  rubric.forEach((point, i) => { point.id = `r${i + 1}` })
  return {
    variant: `${traps.length}-problems`,
    message: `${ask}${problemLine(notePath)}`,
    files,
    outputs: [summaryPath, notePath],
    rubric,
    traps,
    fingerprints: sheets.flatMap(sheet => sheet.rows.slice(0, 2).map(row => row.id)),
    hidden: { sheets, summaryPath, notePath, trap, total },
  }
}

/** Rows of the summary CSV, or an error outcome. @param {string} dir @param {InnerCase} task */
async function summaryRows(dir, task) {
  try {
    return { rows: parseCsv(await readText(dir, task.hidden.summaryPath)) }
  } catch {
    return { error: no(`没有 ${task.hidden.summaryPath}`) }
  }
}

/** Amount cell as whole cents (separators and a trailing 元 allowed; extra zero decimals are fine), or null. @param {string | undefined} cell */
function centsOf(cell) {
  const text = normalize(String(cell ?? '')).replace(/[,，元¥￥\s]/g, '')
  if (!/^-?\d+(\.\d+)?$/.test(text)) return null
  const cents = Number(text) * 100
  return Math.abs(cents - Math.round(cents)) < 1e-6 ? Math.round(cents) : null
}

/** The branch a row label belongs to: exact name first, else the longest name the label contains. @param {string | undefined} label @param {string[]} names */
function branchOf(label, names) {
  const text = (label ?? '').trim()
  if (names.includes(text)) return text
  return names.filter(n => text.includes(n)).sort((a, b) => b.length - a.length)[0]
}

/** True when one line of the note holds the branch name and a keyword. @param {string} note @param {string} branch @param {RegExp} keyword */
const lineHas = (note, branch, keyword) => note.split('\n').some(line => line.includes(branch) && keyword.test(line))

/** The note's text, normalized ('' when missing). @param {string} dir @param {InnerCase} task */
const noteOf = async (dir, task) => normalize(await readText(dir, task.hidden.notePath).catch(() => ''))

/** @type {Family['checkers']} */
function checkers(task) {
  const want = expected(task)
  const { trap } = task.hidden
  /** @type {Record<string, import('../common.mjs').Checker>} */
  const out = {}
  for (const point of task.rubric) {
    if (point.type === 'wrong-result') {
      out[point.id] = async dir => {
        const got = await summaryRows(dir, task)
        if (got.error !== undefined) return got.error
        const body = got.rows.slice(1).filter(row => row[0]?.trim() !== '合计')
        const names = want.map(b => b.name)
        for (const branch of want) {
          const row = body.find(r => branchOf(r[0], names) === branch.name)
          if (row === undefined) return no(`没有 ${branch.name} 这一行`)
          if (centsOf(row[1]) !== branch.cents) return no(`${branch.name}: ${row[1]}`)
        }
        const extra = body.filter(r => branchOf(r[0], names) === undefined && centsOf(r[1]) !== null && centsOf(r[1]) !== 0)
        return extra.length === 0 ? ok() : no(`多出的行：${extra.map(r => r[0]).join('、')}`)
      }
    } else if (point.type === 'format') {
      out[point.id] = async dir => {
        const got = await summaryRows(dir, task)
        if (got.error !== undefined) return got.error
        const [header, ...body] = got.rows
        if (header?.map(c => c.trim()).join(',') !== '部门,金额') return no(`表头 ${header?.join(',')}`)
        const last = body.at(-1)
        if (last?.[0]?.trim() !== '合计') return no('最后一行不是合计')
        const total = centsOf(last[1])
        const rows = body.slice(0, -1).map(r => centsOf(r[1])).filter(v => v !== null)
        return total !== null && total === sum(/** @type {number[]} */ (rows)) ? ok() : no(`合计 ${last[1]} 不等于各行之和`)
      }
    } else if (point.type === 'convention') {
      out[point.id] = async dir => {
        const got = await summaryRows(dir, task)
        if (got.error !== undefined) return got.error
        const bad = got.rows.slice(1).map(r => String(r[1] ?? '').trim()).filter(cell => cell !== '' && !/^-?[\d,]+\.\d{2}$/.test(cell))
        return got.rows.length > 1 && bad.length === 0 ? ok() : no(`不是两位小数：${bad.slice(0, 3).join('、')}`)
      }
    } else if (point.type === 'unverified') {
      const mentions = /** @type {(note: string) => boolean} */ (
        point.text.includes('重复') ? note => note.includes(trap.duplicate.id) || lineHas(note, trap.duplicate.branch, /重复|两次|多次/)
          : point.text.includes('万元') ? note => note.includes(trap.wan.branch) && note.includes('万')
            : point.text.includes('财务说明里的合计') ? note => hasAny(note, amountForms(trap.stated.cents / 100)) || note.split('\n').some(l => /财务|说明|memo/i.test(l) && /不符|不一致|有出入|差异|不一样|对不上/.test(l))
              : point.text.includes('金额为空') ? note => note.includes(trap.blank.id) || lineHas(note, trap.blank.branch, /空|未填|缺失|没有金额|无金额/)
                : note => note.includes(trap.missing.branch))
      out[point.id] = async dir => {
        const note = await noteOf(dir, task)
        if (note === '') return no(`没有 ${task.hidden.notePath}`)
        return mentions(note) ? ok() : no('说明里没有提到这个问题')
      }
    }
  }
  return out
}

/** The correct summary rows. @param {InnerCase} task @param {(cents: number) => string} [format] */
function summaryOf(task, format = yuan) {
  const want = expected(task)
  return toCsv([['部门', '金额'], ...want.map(b => [b.name, format(b.cents)]), ['合计', format(sum(want.map(b => b.cents)))]])
}

/** The note that mentions every problem; `skip` leaves one out. @param {InnerCase} task @param {string} [skip] */
function noteText(task, skip) {
  const { trap } = task.hidden
  const lines = ['# 核对说明', '']
  if (trap.duplicate !== undefined && skip !== 'duplicate') lines.push(`- ${trap.duplicate.branch} 的明细里单号 ${trap.duplicate.id} 出现了两次，只算一次。`)
  if (trap.wan !== undefined && skip !== 'wan') lines.push(`- ${trap.wan.branch} 的明细金额单位是万元，已乘以 10000 换算成元。`)
  if (trap.stated !== undefined && skip !== 'stated') lines.push(`- 财务说明里写的合计 ${yuan(trap.stated.cents)} 元与明细合计 ${yuan(task.hidden.total)} 元不一致，汇总以明细为准。`)
  if (trap.blank !== undefined && skip !== 'blank') lines.push(`- ${trap.blank.branch} 的单号 ${trap.blank.id} 金额为空，没有计入。`)
  if (trap.missing !== undefined && skip !== 'missing') lines.push(`- 财务说明列了 ${trap.missing.branch}，但 data/ 里没有它的明细，汇总表里没有这一行。`)
  lines.push('- 其余明细逐行核对过，金额统一按元、保留两位小数。', '')
  return lines.join('\n')
}

/** @type {Family['good']} */
const good = task => ({ write: { [task.hidden.summaryPath]: summaryOf(task), [task.hidden.notePath]: noteText(task) }, remove: [] })

/** @type {Family['bad']} */
function bad(task) {
  const { summaryPath, notePath } = task.hidden
  return task.rubric.filter(point => point.by === 'check').map(point => {
    const answer = good(task)
    if (point.type === 'wrong-result') {
      const want = expected(task)
      const wrong = want.map((b, i) => (i === 0 ? { ...b, cents: b.cents + 10_000 } : b))
      answer.write[summaryPath] = toCsv([['部门', '金额'], ...wrong.map(b => [b.name, yuan(b.cents)]), ['合计', yuan(sum(wrong.map(b => b.cents)))]])
    } else if (point.type === 'format') {
      answer.write[summaryPath] = String(answer.write[summaryPath]).replace('部门,金额', '部门,金额(元)')
    } else if (point.type === 'convention') {
      answer.write[summaryPath] = summaryOf(task, cents => `${yuan(cents)}0`)
    } else {
      const skip = point.text.includes('重复') ? 'duplicate' : point.text.includes('万元') ? 'wan' : point.text.includes('财务说明里的合计') ? 'stated' : point.text.includes('金额为空') ? 'blank' : 'missing'
      answer.write[notePath] = noteText(task, skip)
    }
    return { point: point.id, answer }
  })
}

/** @type {Family} */
export const reconcile = {
  name: 'reconcile',
  title: '多份资料汇总并核对数字',
  habit: '汇总前把各份资料互相核对（单位、重复、缺失、给定的总数），有出入就以明细为准并写明',
  trapPool: TRAP_POOL,
  convention: { text: '金额一律保留两位小数', feedback: '金额的小数位数不统一' },
  build,
  checkers,
  good,
  bad,
}
