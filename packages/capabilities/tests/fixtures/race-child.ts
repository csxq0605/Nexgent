/**
 * Child process for the cross-process race tests. Arguments:
 * `<mode> <capabilitiesDir> <barrierDir> <id> [version]`. The child does its
 * preparation, writes `<barrierDir>/ready-<id>`, waits for `<barrierDir>/go`,
 * then acts and prints one JSON line with the outcome.
 * - `commit`: publish revision 1 (adopt `version`) on top of the baseline.
 * - `write`: store the sample bundle.
 */
import { randomUUID } from 'node:crypto'
import { access, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { BASELINE_ACTIVATION, CapabilityStore, commitActivation } from '../../src/index.js'
import { sampleComponents } from '../sample.js'

const [mode, capabilitiesDir, barrierDir, id, version] = process.argv.slice(2)
if (mode === undefined || capabilitiesDir === undefined || barrierDir === undefined || id === undefined) throw new Error('usage')

async function waitForGo(): Promise<void> {
  await writeFile(join(barrierDir!, `ready-${id}`), '')
  for (;;) {
    try {
      await access(join(barrierDir!, 'go'))
      return
    } catch {
      await new Promise(resolve => setTimeout(resolve, 2))
    }
  }
}

const store = new CapabilityStore(capabilitiesDir)
if (mode === 'commit') {
  await waitForGo()
  const result = await commitActivation(store.activationDirectory, BASELINE_ACTIVATION, { type: 'adopt', version: version!, trigger: 'manual', decisionId: randomUUID() })
  process.stdout.write(`${JSON.stringify({ id, committed: result !== null, revision: result?.revision ?? null })}\n`)
} else if (mode === 'write') {
  await waitForGo()
  const bundle = await store.write(sampleComponents())
  process.stdout.write(`${JSON.stringify({ id, version: bundle.version })}\n`)
} else {
  throw new Error(`unknown mode ${mode}`)
}
