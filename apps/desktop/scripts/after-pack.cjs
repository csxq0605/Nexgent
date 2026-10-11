// electron-builder afterPack hook: the Electron distribution reused from node_modules
// (scripts/package.mjs sets electronDist) still carries Electron's default app; drop it.
const { rmSync } = require('node:fs')
const { join } = require('node:path')

exports.default = async function afterPack(context) {
  rmSync(join(context.appOutDir, 'resources', 'default_app.asar'), { force: true })
}
