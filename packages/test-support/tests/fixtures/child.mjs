// Test child for process.spec.ts. Usage: node child.mjs <mode> [arg]
//   echo            print argv/env/stdin then exit 0
//   hang <dir>      spawn a grandchild, write pids to <dir>/pids.json, print "ready", hang
//   exit <code>     print to stderr and exit with <code>
//   file <path>     write <path> after a short delay, then hang
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

const [mode, arg] = process.argv.slice(2)
const hang = () => setInterval(() => {}, 1000)

if (mode === 'echo') {
  let input = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (d) => { input += d })
  process.stdin.on('end', () => {
    process.stdout.write(`argv=${arg} env=${process.env.TS_FIXTURE ?? ''} stdin=${input}\n`)
  })
} else if (mode === 'hang') {
  const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  writeFileSync(join(arg, 'pids.json'), JSON.stringify({ child: process.pid, grandchild: grandchild.pid }))
  process.stdout.write('ready\n')
  hang()
} else if (mode === 'exit') {
  process.stderr.write('bye\n')
  process.exit(Number(arg))
} else if (mode === 'file') {
  setTimeout(() => writeFileSync(arg, 'done\n'), 50)
  hang()
}
