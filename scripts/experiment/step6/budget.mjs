// @ts-check
/**
 * Cost gate of the step-6 real-model experiment (user decision 8: cap 35 USD for the
 * whole step; raised to 40 USD by the user on 2026-10-14 for the second pilot round). Every finished run adds its estimated cost to a spend file; a new run
 * may start only when spent + its estimate stays within the cap. A spend that is not
 * a finite, non-negative number is refused, and a spend file that cannot be read is
 * treated as "unknown", which blocks every new run (unknown is never "within budget").
 *
 * Linux, macOS and Windows; no dependencies.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/** The step-6 real-model cap in USD. */
export const STEP6_CAP_USD = 40

/**
 * @typedef {{ label: string, usd: number, at?: string }} SpendEntry
 * @typedef {{ capUsd: number, entries: SpendEntry[] }} SpendFile
 */

/**
 * Read a spend file; a missing file is an empty one. Throws on a file that exists but
 * is not a valid spend record.
 * @param {string} file
 * @param {number} [capUsd]
 * @returns {Promise<SpendFile>}
 */
export async function readSpend(file, capUsd = STEP6_CAP_USD) {
  let text
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') return { capUsd, entries: [] }
    throw error
  }
  const data = JSON.parse(text)
  if (!Array.isArray(data?.entries) || data.entries.some((/** @type {SpendEntry} */ e) => !validUsd(e?.usd))) throw new Error(`${file}: not a valid spend file`)
  return { capUsd: typeof data.capUsd === 'number' ? data.capUsd : capUsd, entries: data.entries }
}

const validUsd = (/** @type {unknown} */ usd) => typeof usd === 'number' && Number.isFinite(usd) && usd >= 0

/** @param {SpendFile} spend */
export const spentUsd = spend => Math.round(spend.entries.reduce((sum, entry) => sum + entry.usd, 0) * 1e6) / 1e6

/**
 * May a run with this estimate start?
 * @param {SpendFile} spend
 * @param {number} estimateUsd
 * @returns {{ ok: boolean, spentUsd: number, remainingUsd: number, reason: string | null }}
 */
export function canStart(spend, estimateUsd) {
  const spent = spentUsd(spend)
  const remaining = Math.round((spend.capUsd - spent) * 1e6) / 1e6
  if (!validUsd(estimateUsd)) return { ok: false, spentUsd: spent, remainingUsd: remaining, reason: `estimate ${estimateUsd} is not a cost` }
  if (spent + estimateUsd > spend.capUsd) {
    return { ok: false, spentUsd: spent, remainingUsd: remaining, reason: `spent ${spent.toFixed(2)} + estimate ${estimateUsd.toFixed(2)} USD would pass the ${spend.capUsd} USD cap` }
  }
  return { ok: true, spentUsd: spent, remainingUsd: remaining, reason: null }
}

/**
 * Check, against the file on disk, whether a run may start. Unreadable file → refused.
 * @param {string} file
 * @param {number} estimateUsd
 * @param {number} [capUsd]
 */
export async function gate(file, estimateUsd, capUsd = STEP6_CAP_USD) {
  let spend
  try {
    spend = await readSpend(file, capUsd)
  } catch (error) {
    return { ok: false, spentUsd: Number.NaN, remainingUsd: Number.NaN, reason: `spend unknown: ${error instanceof Error ? error.message : String(error)}` }
  }
  return canStart({ ...spend, capUsd: Math.min(spend.capUsd, capUsd) }, estimateUsd)
}

/**
 * Add a finished run's cost to the spend file (written atomically).
 * @param {string} file
 * @param {SpendEntry} entry
 * @param {number} [capUsd]
 */
export async function recordSpend(file, entry, capUsd = STEP6_CAP_USD) {
  if (!validUsd(entry.usd)) throw new Error(`spend for ${entry.label} is not a cost: ${entry.usd}`)
  const spend = await readSpend(file, capUsd)
  spend.entries.push(entry)
  await mkdir(dirname(file), { recursive: true })
  await writeFile(`${file}.tmp`, `${JSON.stringify(spend, null, 2)}\n`)
  await rename(`${file}.tmp`, file)
  return spend
}
