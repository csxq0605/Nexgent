import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const logPath = fileURLToPath(new URL('../validation-workspace/native-web.log', import.meta.url))
const log = await readFile(logPath, 'utf8')
const authenticatedUrl = log.match(/dsh web: (http:\/\/[^\s]+)/)?.[1]
assert.ok(authenticatedUrl, 'Start the native application and save its startup log first')
const publicUrl = new URL(authenticatedUrl)
publicUrl.search = ''
const anonymous = await fetch(publicUrl)
assert.equal(anonymous.status, 401)
const authenticated = await fetch(authenticatedUrl, { redirect: 'manual' })
let page = authenticated
if (authenticated.status >= 300 && authenticated.status < 400) {
  page = await fetch(new URL(authenticated.headers.get('location'), publicUrl), {
    headers: { cookie: authenticated.headers.getSetCookie().map(value => value.split(';')[0]).join('; ') },
  })
}
assert.equal(page.status, 200)
const html = await page.text()
assert.equal(html.match(/<title>(.*?)<\/title>/)?.[1], 'Nexgent')
assert.ok(html.includes('id="root"'))
const evidence = { passed: true, scope: 'HTTP startup, authentication fence and built page only; UI interaction unverified',
  anonymousStatus: anonymous.status, authenticatedStatus: page.status, title: 'Nexgent',
  pendingActivationWarnings: log.includes('did not activate') }
await writeFile(fileURLToPath(new URL('../validation-workspace/native-web-evidence.json', import.meta.url)), JSON.stringify(evidence, null, 2) + '\n')
console.log(JSON.stringify(evidence))
