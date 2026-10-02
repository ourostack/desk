import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { createRequire } from "node:module"

const require = createRequire(import.meta.url)
const { npmCli } = require("../../../../plugins/desk/mcp/web.cjs")

export function spawnNpmSync(args, options) {
  const cli = npmCli(process.execPath, process.platform, existsSync)
  if (cli === null) throw new Error(`npm is missing beside ${process.execPath}`)
  return spawnSync(process.execPath, [cli, ...args], options)
}
