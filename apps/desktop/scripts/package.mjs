#!/usr/bin/env node
/**
 * Build the unsigned desktop package (W5).
 *
 *   node scripts/package.mjs stage        # only prepare build/app
 *   node scripts/package.mjs linux        # stage + AppImage into release/
 *   node scripts/package.mjs win          # stage + NSIS installer into release/ (run on Windows)
 *
 * Staging uses `pnpm deploy` to copy the app with its production
 * dependencies (workspace packages included, hoisted, no symlinks) into
 * build/app, then rewrites its package.json to the minimum electron-builder
 * needs. Run `pnpm build` at the repository root first; a renderer built
 * into dist/renderer is packaged as is, otherwise the main process serves
 * its built-in placeholder page. Nothing is signed or published.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const appDir = fileURLToPath(new URL('..', import.meta.url))
const stageDir = join(appDir, 'build', 'app')
const target = process.argv[2] ?? 'stage'
const isWindows = process.platform === 'win32'

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: appDir, stdio: 'inherit', shell: isWindows, ...options })
  if (result.status !== 0) {
    process.stderr.write(`package: ${command} ${args.join(' ')} failed (exit ${result.status ?? result.signal})\n`)
    process.exit(1)
  }
}

function stage() {
  for (const file of ['dist/main/index.js', 'dist/preload/index.cjs']) {
    if (!existsSync(join(appDir, file))) {
      process.stderr.write(`package: ${file} is missing; run \`pnpm build\` at the repository root first\n`)
      process.exit(1)
    }
  }
  rmSync(join(appDir, 'build'), { recursive: true, force: true })
  run('pnpm', ['--filter', '@nexgent/desktop', 'deploy', '--prod', '--legacy', '--config.node-linker=hoisted', stageDir])

  const source = JSON.parse(readFileSync(join(appDir, 'package.json'), 'utf8'))
  const dependencies = {}
  for (const name of Object.keys(source.dependencies ?? {})) {
    dependencies[name] = JSON.parse(readFileSync(join(stageDir, 'node_modules', name, 'package.json'), 'utf8')).version
  }
  const staged = {
    name: 'nexgent-desktop',
    productName: 'Nexgent',
    version: source.version,
    description: source.description,
    author: 'csxq0605',
    license: 'MIT',
    private: true,
    type: 'module',
    main: source.main,
    desktopName: 'nexgent-desktop.desktop',
    dependencies,
    // The staged tree is a plain hoisted node_modules: electron-builder collects it with npm.
    packageManager: 'npm@10.9.4',
  }
  writeFileSync(join(stageDir, 'package.json'), `${JSON.stringify(staged, null, 2)}\n`)
  // pnpm's own bookkeeping is not part of the app.
  rmSync(join(stageDir, 'node_modules', '.pnpm'), { recursive: true, force: true })
  rmSync(join(stageDir, 'node_modules', '.modules.yaml'), { force: true })
  rmSync(join(stageDir, 'node_modules', '.bin'), { recursive: true, force: true })
  process.stderr.write(`package: staged ${stageDir} (renderer ${existsSync(join(stageDir, 'dist', 'renderer', 'index.html')) ? 'included' : 'not built; placeholder page'})\n`)
}

function builder(platformArgs) {
  const require = createRequire(import.meta.url)
  // Build from the staged directory as the project: electron-builder then collects exactly the
  // deployed node_modules (with npm, per the staged package.json), not the pnpm workspace's.
  const args = ['--projectDir', stageDir, '--config', join(appDir, 'electron-builder.yml'), `--config.directories.output=${join(appDir, 'release')}`, `--config.afterPack=${join(appDir, 'scripts', 'after-pack.cjs')}`, ...platformArgs, '--publish', 'never']
  // Reuse the Electron already installed for the host platform instead of downloading it again.
  const electronPkg = require.resolve('electron/package.json')
  const electronDist = join(dirname(electronPkg), 'dist')
  const hostTarget = (platformArgs[0] === '--linux' && process.platform === 'linux') || (platformArgs[0] === '--win' && isWindows)
  if (hostTarget && existsSync(electronDist)) args.push(`--config.electronDist=${electronDist}`)
  run('pnpm', ['exec', 'electron-builder', ...args], { env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' } })
}

stage()
if (target === 'linux') builder(['--linux', 'AppImage'])
else if (target === 'win') builder(['--win', 'nsis'])
else if (target !== 'stage') {
  process.stderr.write(`package: unknown target ${target} (stage | linux | win)\n`)
  process.exit(1)
}
