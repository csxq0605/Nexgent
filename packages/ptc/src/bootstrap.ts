/**
 * The program side of a PTC run: ES module source the host passes to
 * `node --input-type=module --eval`, so the process needs no file of ours
 * (and, under the permission model, no file read at all).
 *
 * It clears `process.env` before any model code runs, turns `console` and
 * `process.stdout` / `process.stderr` writes into `log` frames, binds each
 * host function as an async function that sends a `call` frame and waits
 * for the `reply`, runs the program body as an async function, and reports
 * the JSON value it returns (or what it threw) in a `done` frame before
 * exiting. Model code runs in this process: nothing here is a security
 * boundary, the host checks every call and the operating system process is
 * what gets killed (`permissions.md` §代码执行进程).
 */

/** Exit code when the host closes stdin before the program finished (literal in {@link BOOTSTRAP_SOURCE}). */
export const HOST_GONE_EXIT = 70

/** The bootstrap module source. Kept free of template-literal syntax. */
export const BOOTSTRAP_SOURCE = String.raw`
import { format } from 'node:util'
const rawWrite = process.stdout.write.bind(process.stdout)
const send = message => rawWrite(JSON.stringify(message) + '\n')
for (const key of Object.keys(process.env)) delete process.env[key]

const decode = (chunk, encoding) => {
  if (typeof chunk === 'string') return chunk
  if (chunk instanceof Uint8Array) return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength).toString(typeof encoding === 'string' ? encoding : 'utf8')
  return String(chunk)
}
const capture = stream => function write(chunk, encoding, callback) {
  const text = decode(chunk, encoding)
  if (text !== '') send({ t: 'log', stream, text })
  const done = typeof encoding === 'function' ? encoding : callback
  if (typeof done === 'function') queueMicrotask(() => done())
  return true
}
process.stdout.write = capture('stdout')
process.stderr.write = capture('stderr')
for (const level of ['log', 'info', 'debug']) console[level] = (...args) => send({ t: 'log', stream: 'stdout', text: format(...args) + '\n' })
for (const level of ['warn', 'error', 'trace']) console[level] = (...args) => send({ t: 'log', stream: 'stderr', text: format(...args) + '\n' })

class HostError extends Error {
  constructor(message) {
    super(message)
    this.name = 'HostError'
  }
}

const pending = new Map()
let nextId = 1
let finished = false
let booted = false

const toJson = (value, what) => {
  let text
  try {
    text = JSON.stringify(value)
  } catch (error) {
    throw new TypeError(what + ' is not JSON-serializable: ' + error.message)
  }
  return text === undefined ? undefined : JSON.parse(text)
}

const call = (fn, args) => new Promise((resolve, reject) => {
  if (finished) return reject(new HostError('the program already finished'))
  const id = nextId++
  let payload
  try {
    payload = toJson(args, 'the arguments of ' + fn + '()') ?? []
  } catch (error) {
    return reject(error)
  }
  pending.set(id, { resolve, reject })
  send({ t: 'call', id, fn, args: payload })
})

const describe = error => {
  if (error !== null && typeof error === 'object') {
    const name = typeof error.name === 'string' ? error.name : 'Error'
    const message = typeof error.message === 'string' ? error.message : String(error)
    const stack = typeof error.stack === 'string' ? error.stack : undefined
    return stack === undefined ? { name, message } : { name, message, stack }
  }
  return { name: 'Error', message: String(error) }
}

const finish = (ok, value) => {
  if (finished) return
  finished = true
  let message
  if (ok) {
    try {
      const json = toJson(value, 'the return value')
      message = json === undefined ? { t: 'done', ok: true } : { t: 'done', ok: true, value: json }
    } catch (error) {
      message = { t: 'done', ok: false, error: describe(error) }
    }
  } else {
    message = { t: 'done', ok: false, error: describe(value) }
  }
  rawWrite(JSON.stringify(message) + '\n', () => process.exit(0))
}

process.on('uncaughtException', error => finish(false, error))
process.on('unhandledRejection', error => finish(false, error))

const AsyncFunction = (async () => {}).constructor

const boot = message => {
  booted = true
  const names = message.functions
  const fns = names.map(name => (...args) => call(name, args))
  let helperNames = []
  let helperValues = []
  try {
    if (typeof message.prelude === 'string') {
      const helpers = new Function(...names, message.prelude)(...fns)
      helperNames = Object.keys(helpers)
      helperValues = helperNames.map(name => helpers[name])
    }
    const globalNames = Object.keys(message.globals)
    const program = new AsyncFunction(...names, ...helperNames, ...globalNames, 'return await (async () => {\n' + message.code + '\n})()')
    program(...fns, ...helperValues, ...globalNames.map(name => message.globals[name])).then(value => finish(true, value), error => finish(false, error))
  } catch (error) {
    finish(false, error)
  }
}

const handle = message => {
  if (message.t === 'boot' && !booted) return boot(message)
  if (message.t !== 'reply') return
  const waiter = pending.get(message.id)
  if (waiter === undefined) return
  pending.delete(message.id)
  if (message.ok) waiter.resolve(message.value)
  else waiter.reject(new HostError(message.error))
}

let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => {
  buffer += chunk
  let index
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index)
    buffer = buffer.slice(index + 1)
    if (line.trim() !== '') handle(JSON.parse(line))
  }
})
process.stdin.on('end', () => {
  if (!finished) process.exit(70)
})
`
