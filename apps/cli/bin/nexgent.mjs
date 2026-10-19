#!/usr/bin/env node
// `nexgent` launcher. The implementation lives in ../src/main.ts and is built to ../dist/main.js.
let main
try {
  ;({ main } = await import('../dist/main.js'))
} catch (error) {
  if (error && error.code === 'ERR_MODULE_NOT_FOUND') {
    process.stderr.write('nexgent: build output not found; run `pnpm build` first\n')
    process.exit(4)
  }
  throw error
}
process.exitCode = await main(process.argv.slice(2))
