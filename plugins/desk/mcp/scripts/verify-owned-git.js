import fs from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"
import { createRequire } from "node:module"

const { parseJSON } = createRequire(import.meta.url)("./owned-git-child.cjs")
const sources = ["native/windows-owned-git.c", "scripts/owned-git-child.cjs", "scripts/build-owned-git.ps1", "scripts/verify-owned-git.js"]
const flags = ["/W4", "/WX", "/MT", "/O2", "/fp:precise", "kernel32.lib", "advapi32.lib"]
const hex = /^[0-9a-f]{64}$/
const hashString = (value) => typeof value === "string" && hex.test(value)
function assetError() { const error = new Error("owned_git_assets"); error.code = "owned_git_assets"; return error }
function check(value) { if (!value) throw assetError() }
function closed(value, keys) {
  check(value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key)))
}
export function validateOwnedGitManifest(value) {
  closed(value, ["schema", "protocol", "target", "variant", "sourceRevision", "sources", "toolchain", "files"])
  check(value.schema === "desk.owned-git-assets/1" && value.protocol === "desk.owned-git/1" &&
    value.target === "win32-x64" && value.variant === "production" &&
    typeof value.sourceRevision === "string" && /^[0-9a-f]{40}$/.test(value.sourceRevision))
  check(Array.isArray(value.sources) && value.sources.length === sources.length)
  value.sources.forEach((source, i) => {
    closed(source, ["path", "sha256"]); check(source.path === sources[i] && hashString(source.sha256))
  })
  closed(value.toolchain, ["compiler", "version", "sdkVersion", "flags"])
  check(value.toolchain.compiler === "clang-cl")
  for (const key of ["version", "sdkVersion"]) check(typeof value.toolchain[key] === "string" &&
    value.toolchain[key].length && !value.toolchain[key].includes("\0") && Buffer.byteLength(value.toolchain[key]) <= 1024 &&
    Buffer.from(value.toolchain[key]).toString("utf8") === value.toolchain[key])
  check(JSON.stringify(value.toolchain.flags) === JSON.stringify(flags))
  closed(value.files, ["owner", "shim"])
  for (const [key, filename] of [["owner", "desk-owned-git.exe"], ["shim", "owned-git-child.cjs"]]) {
    closed(value.files[key], ["path", "sha256"])
    check(value.files[key].path === filename && hashString(value.files[key].sha256))
  }
  return structuredClone(value)
}
const within = (root, leaf) => {
  const relative = path.relative(root, leaf)
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
}
async function physical(value, directory) {
  check(typeof value === "string" && path.isAbsolute(value) && !value.includes("\0"))
  const resolved = await fs.realpath(value), stat = await fs.lstat(value)
  check(directory ? stat.isDirectory() : stat.isFile())
  check(!stat.isSymbolicLink() && path.resolve(value) === resolved)
  return resolved
}
export async function resolveOwnedGitTarget({ publicMcpRoot, privateRealmRoot }) {
  try {
    const root = await physical(publicMcpRoot, true), realm = await physical(privateRealmRoot, true)
    check(!within(realm, root))
    const targetDir = path.join(root, "artifacts", "owned-git", "win32-x64")
    await physical(targetDir, true)
    check(!within(realm, targetDir))
    return { publicMcpRoot: root, targetDir }
  } catch { throw assetError() }
}
async function digest(filename) { return createHash("sha256").update(await fs.readFile(filename)).digest("hex") }
export async function verifyOwnedGitAssets({ publicMcpRoot, nodeExecutable, privateRealmRoot }) {
  try {
    const target = await resolveOwnedGitTarget({ publicMcpRoot, privateRealmRoot })
    const realm = await physical(privateRealmRoot, true)
    const node = await physical(nodeExecutable, false)
    check(!within(realm, node))
    const manifestPath = await physical(path.join(target.targetDir, "manifest.json"), false)
    const stat = await fs.stat(manifestPath); check(stat.size > 0 && stat.size <= 16380)
    const manifest = validateOwnedGitManifest(parseJSON(await fs.readFile(manifestPath), 16380))
    const owner = await physical(path.join(target.targetDir, manifest.files.owner.path), false)
    const shim = await physical(path.join(target.targetDir, manifest.files.shim.path), false)
    for (const filename of [owner, shim]) check(!within(realm, filename))
    check(await digest(owner) === manifest.files.owner.sha256 && await digest(shim) === manifest.files.shim.sha256)
    for (const source of manifest.sources) {
      const filename = await physical(path.join(target.publicMcpRoot, source.path), false)
      check(!within(realm, filename) && await digest(filename) === source.sha256)
    }
    return { ...target, owner, shim, manifest, nodeExecutable: node, nodeSha256: await digest(node) }
  } catch { throw assetError() }
}
