import { test } from "node:test"
import assert from "node:assert/strict"
import * as fs from "node:fs"
import * as crypto from "node:crypto"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

const repoRoot = path.resolve(fileURLToPath(new URL("../../../../..", import.meta.url)))
const vendor = path.join(repoRoot, "plugins", "desk", "mcp", "src", "lib", "ouro-actions")
const sha256 = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex")

test("the vendored action generator and claims are the ones core's release manifest names", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(vendor, "dist-manifest.json"), "utf8"))
  assert.match(manifest.coreTag, /^v\d+\.\d+\.\d+$/)
  for (const [key, file] of [["dist/actions/ouro-actions.mts", "ouro-actions.mts"], ["dist/ax/actions.claims.json", "actions.claims.json"]]) {
    assert.equal(sha256(path.join(vendor, file)), manifest.files[key], `${file} differs from ${key} in core ${manifest.coreTag}`)
  }
})

/** Each module of the vendored AX kit Desk's code reaches: what its own files import, and what those import in turn. */
function kitModules() {
  const plugin = path.join(repoRoot, "plugins", "desk")
  const kit = path.join(plugin, "mcp", "src", "lib", "ouro-ui", "registry", "ouro", "ax")
  const IMPORT = /\bfrom\s+["'](\.{1,2}\/[^"']+)["']|\bimport\s*\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)/g
  const importsOf = (file) => [...fs.readFileSync(file, "utf8").matchAll(IMPORT)].map((match) => path.resolve(path.dirname(file), match[1] ?? match[2]))
  const inKit = (file) => file.startsWith(`${kit}${path.sep}`)
  const own = fs.readdirSync(plugin, { recursive: true }).map((name) => path.join(plugin, name)).filter((file) => /\.[cm]?[jt]s$/.test(file) && !inKit(file) && !file.includes(`${path.sep}node_modules${path.sep}`) && fs.statSync(file).isFile())
  const reached = new Set()
  const queue = own.flatMap(importsOf).filter(inKit)
  while (queue.length) {
    const file = queue.shift()
    if (reached.has(file) || !fs.existsSync(file)) continue
    reached.add(file)
    queue.push(...importsOf(file).filter(inKit))
  }
  return [...reached].map((file) => path.relative(repoRoot, file).split(path.sep).join("/")).sort()
}

test("the AX kit modules Desk's command and MCP surfaces import are vendored byte for byte", () => {
  const lock = JSON.parse(fs.readFileSync(path.join(repoRoot, "upstream-sources.lock.json"), "utf8"))
  const source = lock.sources.find((item) => item.id === "ourostack-ouro-ui-ax")
  const modules = kitModules()
  assert.ok(modules.some((file) => file.endsWith("/cli.ts")), `Desk's commands import the kit's cli.ts (found ${modules.join(", ")})`)
  for (const file of modules) assert.ok(source.files.some((item) => item.generatedPath === file), `${file}, which Desk imports, is in the lock`)
  for (const entry of source.files) assert.equal(sha256(path.join(repoRoot, entry.generatedPath)), entry.sha256, `${entry.generatedPath} is ${entry.sourcePath} byte for byte`)
})
