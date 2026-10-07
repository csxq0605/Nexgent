// Refresh the workflow portion of imported request pins from an accepted native
// process capture. Platform-specific shell contracts keep their existing owner.
import assert from 'node:assert/strict'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const capture = resolve(process.argv[2] ?? '')
assert.ok(process.argv[2], 'Provide the directory produced by test-native-architecture.mjs')
assert.equal(JSON.parse(await readFile(resolve(capture, 'evidence.json'), 'utf8')).passed, true)
const requests = JSON.parse(await readFile(resolve(capture, 'requests.json'), 'utf8'))
const request = requests.find(request => request.tools?.some(tool => tool.function?.name === 'workflow'))
const current = request.tools.find(tool => tool.function?.name === 'workflow').function
assert.ok(current.parameters.properties.architecture.description.includes('schema?'))
const system = request.messages.find(message => message.role === 'system').content
const guidance = system.split('\n').find(line => line.startsWith('Choose the workflow tool '))
assert.ok(guidance)
const closing = ' The run executes in the foreground'
// Imported default profiles do not enable the application's definition store.
const storeGuidance = ' Graph definitions are saved independently of the Session. To reuse a saved graph, supply architectureVersion instead of script or architecture. Saving or executing a graph does not approve, adopt or activate it for future tasks.'
const body = current.description.split(closing)[0]
  .replace('Supply exactly one of script, architecture or architectureVersion.', 'Supply exactly one of script or architecture.')
  .replace(storeGuidance, '')
const snapshots = resolve(root, 'runtime/snapshots/session')
const advanced = await readFile(process.argv[3] ?? resolve(snapshots, 'cordis-inspect-jsdoc/system-prompt.expected.md'), 'utf8')
const inputPattern = /  workflow: \{\n(?=\s*\/\*\* The plain-JS)[\s\S]*?\n  \} & Record<string, JsonValue>;/g
const input = advanced.match(inputPattern)?.[0]
assert.ok(input?.includes('schema?'), 'Refresh cordis-inspect-jsdoc through test:snapshot:refresh first')
assert.ok(!input.includes('interface '), 'The captured declaration must contain only workflow input')
let count = 0
function refresh(value) {
  if (value === null || typeof value !== 'object') return
  if (value.name === 'workflow' && value.parameters?.properties?.script) {
    const suffix = value.description.includes(closing) ? closing + value.description.split(closing).slice(1).join(closing) : ''
    value.description = body + suffix
    value.parameters.properties.architecture = structuredClone(current.parameters.properties.architecture)
    value.parameters.required = value.parameters.required.filter(field => field !== 'script')
  }
  for (const nested of Object.values(value)) refresh(nested)
}
for (const directory of await readdir(snapshots, { withFileTypes: true })) {
  if (!directory.isDirectory()) continue
  for (const filename of await readdir(resolve(snapshots, directory.name))) {
    const path = resolve(snapshots, directory.name, filename)
    let before, after
    if (/^tool-schemas(?:\.\d+)?\.expected\.json$/.test(filename)) {
      before = await readFile(path, 'utf8')
      const schemas = JSON.parse(before)
      refresh(schemas)
      after = JSON.stringify(schemas, null, 2) + '\n'
    } else if (/^system-prompt(?:\.\d+)?\.expected\.md$/.test(filename)) {
      before = await readFile(path, 'utf8')
      after = before.replace(/^Use the workflow tool ONLY[^\n]*$/gm, guidance)
      after = after.replace(/^([ \t]*)\/\*\* Run (?:a JavaScript workflow script|a workflow that orchestrates subagents)[^\n]* \*\/$/gm, (line, indent) => {
        const suffix = line.includes(closing) ? closing + line.split(closing).slice(1).join(closing).replace(/ \*\/$/, '') : ''
        return `${indent}/** ${(body + suffix).replace(/\s+/g, ' ')} */`
      })
      after = after.replace(inputPattern, prior => prior.includes('run_in_background') ? input : input.replace(/^    \/\*\* Run as a background job:[^\n]*\n    run_in_background\?: boolean;\n/m, ''))
    } else continue
    if (after !== before) { await writeFile(path, after); count += 1 }
  }
}
console.log(JSON.stringify({ refreshedWorkflowContractFiles: count, capture }))
