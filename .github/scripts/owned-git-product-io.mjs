// No import-time effects. The completion owners use only caller-supplied edges.
import { createHash } from "node:crypto"
import path from "node:path"
import { createRequire } from "node:module"
export const PRODUCT_SELECTOR = "^runtime/windows_owned_git\\.test\\.js$"
export const PRODUCT_TEST_FILE = "runtime/windows_owned_git.test.js"
export const NATIVE_TEST_NAME = "native Windows owned-Git product admission"
const F0_NODE_HASH = "9a4eb5f1c29c6a2e93852ead46b999e284a6a5ca8bab4d4e241d587d025a52de"
const F0_WORKFLOW = 375820044
const F0_DEADLINE = 300000000000n
const f0Require = createRequire(import.meta.url)
const f0Fail = (code = "schema") => { throw Object.assign(new Error(code), { code }) }
const f0Assert = (ok, code = "schema") => { if (!ok) f0Fail(code) }
const f0Hash = (bytes) => createHash("sha256").update(bytes).digest("hex")
const f0Oid = (bytes) => createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex")
function f0DataObject(value, keys) {
  f0Assert(value !== null && typeof value === "object" && !Array.isArray(value))
  const proto = Object.getPrototypeOf(value)
  f0Assert(proto === null || proto === Object.prototype)
  const descriptors = Object.getOwnPropertyDescriptors(value), names = Reflect.ownKeys(descriptors)
  f0Assert(names.length === keys.length && names.every((key) => typeof key === "string" && keys.includes(key)))
  const out = Object.create(null)
  for (const key of keys) {
    const d = descriptors[key]
    f0Assert(d && Object.hasOwn(d, "value") && d.enumerable && !["__proto__", "prototype", "constructor"].includes(key))
    out[key] = d.value
  }
  return out
}
function f0Array(value, min = 0, max = min) {
  f0Assert(Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype)
  const d = Object.getOwnPropertyDescriptors(value), n = d.length?.value
  f0Assert(Number.isSafeInteger(n) && n >= min && n <= max && Reflect.ownKeys(d).length === n + 1)
  const out = []
  for (let i = 0; i < n; i++) {
    f0Assert(d[i] && Object.hasOwn(d[i], "value") && d[i].enumerable)
    out.push(d[i].value)
  }
  return out
}
function f0Text(value, max = 4096, ascii = false) {
  f0Assert(typeof value === "string" && value.length <= max && !value.includes("\0"))
  for (const c of value) f0Assert(c.codePointAt(0) < 0xd800 || c.codePointAt(0) > 0xdfff)
  if (ascii) f0Assert(!/[^\x00-\x7f]/.test(value))
  return value
}
const f0Hex = (n) => (v) => {
  f0Text(v, n, true); f0Assert(v.length === n && !/[^0-9a-f]/.test(v)); return v
}
const f0H = f0Hex(64), f0G = f0Hex(40)
const f0U = (v, max = Number.MAX_SAFE_INTEGER, min = 0) => {
  f0Assert(Number.isSafeInteger(v) && !Object.is(v, -0) && v >= min && v <= max); return v
}
const f0Fixed = (literal) => (v) => { f0Assert(v === literal); return literal }
const f0Enum = (...values) => (v) => { f0Assert(values.includes(v)); return v }
const f0Null = (project) => (v) => v === null ? null : project(v)
const f0Bool = f0Enum(true, false)
function f0Object(value, shape) {
  const raw = f0DataObject(value, Object.keys(shape)), out = {}
  for (const key of Object.keys(shape)) out[key] = shape[key](raw[key])
  return out
}
function f0Abs(v) {
  f0Text(v, 1024); f0Assert(Buffer.byteLength(v) <= 1024 && !/["\r\n]/.test(v) &&
    (path.win32.isAbsolute(v) && /^[A-Za-z]:[\\/]/.test(v) || path.posix.isAbsolute(v)))
  const parts = v.split(/[\\/]/)
  f0Assert(!parts.some((p) => p === "." || p === ".."))
  return v
}
const f0Semver = (v) => {
  f0Text(v, 14, true)
  const match = /^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,6}/.exec(v)
  f0Assert(match?.[0] === v); return v
}
const f0Actor = (v) => f0Object(v, { id: (x) => f0U(x, Number.MAX_SAFE_INTEGER, 1), login: (x) => {
  f0Text(x, 39, true)
  f0Assert(x.length > 0 && /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.exec(x)?.[0] === x); return x
} })
const f0Repo = (v) => f0Object(v, { id: (x) => f0U(x, Number.MAX_SAFE_INTEGER, 1), name: f0Fixed("ourostack/desk") })
const f0Ref = (cap) => (v) => f0Object(v, { oid: f0G, sha256: f0H, bytes: (x) => f0U(x, cap) })
const f0Equal = (a, b) => JSON.stringify(a) === JSON.stringify(b)
function f0Parse(bytes, cap) {
  f0Assert(Buffer.isBuffer(bytes) && bytes.length <= cap)
  const text = bytes.toString("utf8")
  f0Assert(Buffer.from(text, "utf8").equals(bytes))
  let at = 0, tokens = 0, containers = 0, keys = 0, chars = 0
  const space = () => { while (at < text.length && /[ \t\r\n]/.test(text[at])) at++ }
  function string() {
    const begin = at++
    let escaped = false
    while (at < text.length) {
      const c = text[at++]
      if (!escaped && c === '"') {
        const raw = text.slice(begin, at)
        f0Assert(raw.length <= 32768)
        const value = JSON.parse(raw)
        f0Text(value, 32768); chars += value.length; f0Assert(chars <= 262144)
        return value
      }
      if (!escaped && c === "\\") escaped = true
      else escaped = false
    }
    f0Fail()
  }
  function item(depth) {
    space(); f0Assert(++tokens <= 65536 && depth <= 16)
    const c = text[at]
    if (c === '"') return string()
    if (c === "{" || c === "[") {
      f0Assert(++containers <= 4096); at++
      const object = c === "{", out = object ? {} : [], seen = new Set(), end = object ? "}" : "]"
      space()
      if (text[at] === end) { at++; return out }
      for (;;) {
        if (object) {
          space(); f0Assert(text[at] === '"')
          const key = string()
          f0Assert(++keys <= 32768 && !seen.has(key) && !["__proto__", "prototype", "constructor"].includes(key))
          seen.add(key); space(); f0Assert(text[at++] === ":")
          out[key] = item(depth + 1)
        } else out.push(item(depth + 1))
        space()
        if (text[at] === end) { at++; return out }
        f0Assert(text[at++] === ",")
      }
    }
    for (const [literal, value] of [["true", true], ["false", false], ["null", null]]) {
      if (text.startsWith(literal, at)) { at += literal.length; return value }
    }
    const number = /^(?:0|[1-9][0-9]*)/.exec(text.slice(at))
    f0Assert(number && number[0].length <= 16)
    at += number[0].length
    return f0U(Number(number[0]))
  }
  const result = item(0); space(); f0Assert(at === text.length)
  return result
}
export function normalizeF0Selection(raw) {
  const invalid = { kind: "invalid", only: "", elevated: false, phase: "", intentOid: "", intentSha256: "" }
  try {
    f0Assert(raw && typeof raw === "object" && !Array.isArray(raw))
    const keys = ["event", "only", "elevated", "phase", "intentOid", "intentSha256"]
    const d = Object.getOwnPropertyDescriptors(raw)
    f0Assert(Reflect.ownKeys(d).every((key) => keys.includes(key) && Object.hasOwn(d[key], "value")))
    const read = (key) => d[key]?.value
    const empty = (v, fallback = "") => v === undefined || v === null || v === "" ? fallback : v
    const event = read("event"), only = empty(read("only")), phase = empty(read("phase"), "legacy")
    const intentOid = empty(read("intentOid")), intentSha256 = empty(read("intentSha256"))
    for (const v of [event, only, phase, intentOid, intentSha256]) f0Assert(typeof v === "string")
    const rendered = read("elevated"), normalized = empty(rendered, "false")
    f0Assert(normalized === "true" || normalized === "false")
    const elevated = normalized === "true"
    let kind = "invalid"
    if (event === "pull_request" && only.length === 0 && phase === "legacy" && !elevated &&
      intentOid.length === 0 && intentSha256.length === 0) kind = "legacy"
    if (event === "workflow_dispatch" && phase === "legacy" && only !== PRODUCT_SELECTOR &&
      intentOid.length === 0 && intentSha256.length === 0) kind = "legacy"
    if (event === "workflow_dispatch" && phase === "f0-inventory" && only === PRODUCT_SELECTOR &&
      rendered === "false") {
      f0G(intentOid); f0H(intentSha256); kind = "f0"
    }
    return { kind, only, elevated, phase, intentOid, intentSha256 }
  } catch { return invalid }
}
export function decodeF0BlobResponse(body, expected) {
  const e = f0DataObject(expected, ["oid", "sha256", "maxDecoded", "expectedBytes"])
  f0G(e.oid); f0H(e.sha256); f0Assert(e.maxDecoded === 4096 || e.maxDecoded === 16384)
  if (e.expectedBytes !== null) f0U(e.expectedBytes, e.maxDecoded)
  const raw = f0DataObject(f0Parse(body, e.maxDecoded === 4096 ? 12288 : 32768),
    ["sha", "node_id", "size", "url", "content", "encoding"])
  f0Assert(raw.sha === e.oid && raw.encoding === "base64")
  f0Text(raw.node_id, 256, true); f0Assert(raw.node_id.length > 0)
  f0Assert(raw.url === `https://api.github.com/repos/ourostack/desk/git/blobs/${e.oid}`)
  f0U(raw.size, e.maxDecoded); f0Text(raw.content, 32768, true)
  const base64 = raw.content.replace(/\r\n|\n/g, "")
  f0Assert(!/[^A-Za-z0-9+/=]/.test(base64) && base64.length % 4 === 0 &&
    base64.length <= Math.ceil(e.maxDecoded / 3) * 4)
  const bytes = Buffer.from(base64, "base64")
  f0Assert(bytes.toString("base64") === base64 && bytes.length <= e.maxDecoded &&
    bytes.length === raw.size && (e.expectedBytes === null || bytes.length === e.expectedBytes) &&
    f0Hash(bytes) === e.sha256 && f0Oid(bytes) === e.oid)
  return { bytes, ref: { oid: e.oid, sha256: e.sha256, bytes: bytes.length } }
}
let f0Catalogue
export function getF0Catalogue() {
  if (f0Catalogue) return f0Catalogue
  const { SOURCE_PATHS } = f0Require("../../tests/desk/mcp/__tests__/runtime/fixtures/windows_owned_git_retention.cjs")
  f0Assert(SOURCE_PATHS.length === 17)
  const vs = ["v22c", "v22e", "v22p", "v22b", "v18c", "v18e", "v18p", "v18b"]
  const roots = ["repo", "os", "ps", "rtc", "n24", "g64", "g32", ...vs, "sdk", "vsdb"].map((id) => ({ id }))
  const selectors = [], files = []
  const add = (id, root, parts, kind, selector = null, rank = 0, insertAt = 0) =>
    files.push({ id, root, parts, kind, selector, rank, insertAt })
  const select = (id, root, parts, type, limit) => selectors.push({ id, root, parts, type, limit })
  add("node20", "rtc", ["node", "20.0.0", "x64", "node.exe"], "pe")
  add("node22", "rtc", ["node", "22.23.3", "x64", "node.exe"], "pe")
  add("node24", "n24", ["node.exe"], "pe")
  for (const [id, name] of [["pwsh", "pwsh.exe"], ["sma", "System.Management.Automation.dll"],
    ["roslyn", "Microsoft.CodeAnalysis.CSharp.dll"], ["utility", "Microsoft.PowerShell.Commands.Utility.dll"]]) add(`ps.${id}`, "ps", [name], "pe")
  for (const root of ["os", "ps"]) for (const [id, name, kind] of [
    ["manifest", "Microsoft.PowerShell.LocalAccounts.psd1", "manifest"],
    ["assembly", "Microsoft.PowerShell.LocalAccounts.dll", "pe"]]) {
    add(`la.${root}.${id}`, root, [...(root === "os" ? ["System32", "WindowsPowerShell", "v1.0"] : []),
      "Modules", "Microsoft.PowerShell.LocalAccounts", name], kind)
  }
  const git = [
    ["command", "cmd/git.exe", "pe"], ["direct", "mingw64/bin/git.exe", "pe"], ["sh", "usr/bin/sh.exe", "pe"],
    ["env", "usr/bin/env.exe", "pe"], ["msys", "usr/bin/msys-2.0.dll", "pe"], ["gitconfig", "etc/gitconfig", "config"],
    ["fstab", "etc/fstab", "config"], ["userfstab", "etc/fstab.d/deskstd", "config"], ["packages", "etc/package-versions.txt", "metadata"],
    ["release", "etc/git-for-windows-extra-release-notes.md", "metadata"], ["bash", "bin/bash.exe", "pe"], ["mintty", "usr/bin/mintty.exe", "pe"]]
  for (const g of ["g64", "g32"]) for (const [id, p, kind] of git) add(`git.${g}.${id}`, g, p.split("/"), kind)
  for (const g of ["g64", "g32"]) for (const dir of ["mingw", "usr"]) {
    const q = `git.${g}.${dir}`, parts = [dir === "mingw" ? "mingw64" : "usr", "bin"]
    select(q, g, parts, "git", 16)
    for (let rank = 1; rank <= 16; rank++) add(`dll.${g}.${dir}.${String(rank).padStart(2, "0")}`, g, parts, "pe", q, rank, 2)
  }
  for (const v of vs) select(`llvm.${v}`, v, ["VC", "Tools", "Llvm", "x64", "lib", "clang"], "llvm", 8)
  for (const v of vs) select(`msvc.${v}`, v, ["VC", "Tools", "MSVC"], "msvc", 8)
  select("sdk.lib", "sdk", ["Lib"], "sdk", 8); select("vs.instances", "vsdb", [], "instance", 16)
  for (const v of vs) for (const [id, parts, kind] of [
    ["clang", "VC/Tools/Llvm/x64/bin/clang-cl.exe", "pe"], ["lld", "VC/Tools/Llvm/x64/bin/lld-link.exe", "pe"],
    ["readobj", "VC/Tools/Llvm/x64/bin/llvm-readobj.exe", "pe"], ["profdata", "VC/Tools/Llvm/x64/bin/llvm-profdata.exe", "pe"],
    ["cov", "VC/Tools/Llvm/x64/bin/llvm-cov.exe", "pe"], ["devcmd", "Common7/Tools/VsDevCmd.bat", "script"],
    ["toolversion", "VC/Auxiliary/Build/Microsoft.VCToolsVersion.default.txt", "metadata"], ["devenv", "Common7/IDE/devenv.exe", "pe"]]) add(`vs.${v}.${id}`, v, parts.split("/"), kind)
  for (const v of vs) for (let rank = 1; rank <= 8; rank++) add(`profile.${v}.${String(rank).padStart(2, "0")}`, v,
    ["VC", "Tools", "Llvm", "x64", "lib", "clang", "lib", "windows", "clang_rt.profile-x86_64.lib"], "library", `llvm.${v}`, rank, 6)
  for (const v of vs) for (let rank = 1; rank <= 8; rank++) for (const [id, name] of [["cmt", "libcmt.lib"], ["vcruntime", "libvcruntime.lib"]]) {
    add(`crt.${v}.${String(rank).padStart(2, "0")}.${id}`, v, ["VC", "Tools", "MSVC", "lib", "x64", name], "library", `msvc.${v}`, rank, 3)
  }
  for (let rank = 1; rank <= 8; rank++) for (const [id, p] of [["ucrt", "ucrt/x64/libucrt.lib"],
    ["kernel", "um/x64/kernel32.lib"], ["advapi", "um/x64/advapi32.lib"]]) add(`sdk.${String(rank).padStart(2, "0")}.${id}`, "sdk", ["Lib", ...p.split("/")], "library", "sdk.lib", rank, 1)
  for (let rank = 1; rank <= 16; rank++) for (const [id, p] of [["state", "state.json"], ["catalog", "catalog.json"]]) {
    add(`instance.${String(rank).padStart(2, "0")}.${id}`, "vsdb", [p], "metadata", "vs.instances", rank, 0)
  }
  f0Assert(roots.length === 17 && selectors.length === 22 && files.length === 411)
  const sources = SOURCE_PATHS.map((p, i) => Object.freeze({ id: `S${String(i + 1).padStart(2, "0")}`, path: p }))
  for (const row of [...roots, ...selectors, ...files]) { if (row.parts) Object.freeze(row.parts); Object.freeze(row) }
  f0Catalogue = Object.freeze({ sources: Object.freeze(sources), roots: Object.freeze(roots),
    selectors: Object.freeze(selectors), files: Object.freeze(files) })
  return f0Catalogue
}
export function projectF0SourceApproval(value) {
  const out = f0Object(value, { schema: f0Fixed("na1-f0-source/1"), repository: f0Repo, commit: f0G, tree: f0G,
    files: (v) => f0Array(v, 17).map((row, i) => f0Object(row, {
      id: f0Fixed(getF0Catalogue().sources[i].id), path: f0Fixed(getF0Catalogue().sources[i].path),
      bytes: (x) => f0U(x, 2097152), sha256: f0H })),
    specSha256: f0H, sourceReviewSha256: f0H, scope: f0Fixed("F0-only"),
    foundation: (v) => f0Object(v, { nodeVersion: f0Fixed("24.18.0"), nodeSha256: f0Fixed(F0_NODE_HASH) }) })
  f0Assert(Buffer.byteLength(JSON.stringify(out)) <= 16384)
  return out
}
export function projectF0Intent(value) {
  const out = f0Object(value, { schema: f0Fixed("na1-f0-intent/1"), repository: f0Repo,
    workflowId: f0Fixed(F0_WORKFLOW), workflowPath: f0Fixed(".github/workflows/desk-windows-suite.yml"),
    phase: f0Fixed("f0-inventory"), sourceApproval: f0Ref(16384), commit: f0G,
    ref: (v) => f0Text(v, 128, true), actor: f0Actor, nonce: f0H,
    notBefore: (v) => f0U(v, 4294967295), expires: (v) => f0U(v, 4294967295), maxAttempts: f0Fixed(1) })
  f0Assert(out.ref === `refs/heads/diag/windows-owned-git-f0-${out.commit.slice(0, 12)}` &&
    out.expires > out.notBefore && out.expires - out.notBefore <= 3600 &&
    Buffer.byteLength(JSON.stringify(out)) <= 4096)
  return out
}
function f0FoundationEnv(value) {
  const out = f0Object(value, { systemRoot: f0Abs, windir: f0Abs, systemDrive: (v) => {
    f0Text(v, 2, true); f0Assert(/^[A-Za-z]:$/.test(v)); return v
  }, psHome: f0Abs, runnerToolCache: f0Abs })
  for (const key of ["systemRoot", "windir", "psHome", "runnerToolCache"]) {
    f0Assert(/^[A-Za-z]:\\/.test(out[key]) && !out[key].endsWith("\\"))
  }
  f0Assert(out.systemRoot.toLowerCase() === out.windir.toLowerCase() &&
    out.systemRoot.slice(0, 2).toLowerCase() === out.systemDrive.toLowerCase())
  return out
}
function f0Context(value) {
  const out = f0Object(value, { repository: f0Repo, workflowId: f0Fixed(F0_WORKFLOW),
    workflowRef: (v) => f0Text(v, 512, true), workflowSha: f0G, event: f0Fixed("workflow_dispatch"),
    sha: f0G, ref: (v) => f0Text(v, 128, true), runId: (v) => f0U(v, Number.MAX_SAFE_INTEGER, 1),
    attempt: f0Fixed(1), actor: f0Actor, triggeringActor: f0Actor,
    matrix: (v) => f0Object(v, { mode: f0Fixed("standard"), shard: f0Fixed(1), total: f0Fixed(8) }),
    workspace: f0Abs, psHome: f0Abs, runnerToolCache: f0Abs, systemRoot: f0Abs, windir: f0Abs,
    systemDrive: (v) => f0Text(v, 2, true), nodeExecutable: f0Abs, nodeVersion: f0Fixed("24.18.0") })
  f0FoundationEnv({ systemRoot: out.systemRoot, windir: out.windir, systemDrive: out.systemDrive,
    psHome: out.psHome, runnerToolCache: out.runnerToolCache })
  f0Assert(/^[A-Za-z]:\\/.test(out.workspace) && /^[A-Za-z]:\\/.test(out.nodeExecutable), "foundation")
  f0Assert(out.workflowSha === out.sha && out.ref === `refs/heads/diag/windows-owned-git-f0-${out.sha.slice(0, 12)}` &&
    out.workflowRef === `ourostack/desk/.github/workflows/desk-windows-suite.yml@${out.ref}`)
  return out
}
function f0ServiceRun(value) {
  return f0Object(value, { id: (v) => f0U(v, Number.MAX_SAFE_INTEGER, 1), attempt: (v) => f0U(v, Number.MAX_SAFE_INTEGER, 1),
    workflowId: (v) => f0U(v, Number.MAX_SAFE_INTEGER, 1), repositoryId: (v) => f0U(v, Number.MAX_SAFE_INTEGER, 1),
    headRepositoryId: (v) => f0U(v, Number.MAX_SAFE_INTEGER, 1), headSha: f0G,
    headBranch: (v) => f0Text(v, 256, true), event: (v) => f0Text(v, 64, true),
    actor: f0Actor, triggeringActor: f0Actor, displayTitle: (v) => f0Text(v, 256, true) })
}
export function checkF0RunBinding({ intent, sourceApproval, context, serviceRuns, nowUtc }) {
  const d = projectF0Intent(intent), s = projectF0SourceApproval(sourceApproval), c = f0Context(context)
  const runs = f0Array(serviceRuns, 1, 100).map(f0ServiceRun)
  f0U(nowUtc, 4294967295)
  f0Assert(f0Equal(d.repository, s.repository) && f0Equal(d.repository, c.repository) &&
    d.commit === s.commit && d.commit === c.sha && d.ref === c.ref && f0Equal(d.actor, c.actor) &&
    f0Equal(c.actor, c.triggeringActor) && nowUtc >= d.notBefore && nowUtc <= d.expires, "authorization")
  const current = runs.filter((r) => r.id === c.runId)
  f0Assert(current.length === 1, "authorization")
  const observed = current[0], titlePrefix = "NA1-F0 "
  f0Assert(observed.displayTitle.startsWith(titlePrefix), "authorization")
  const intentSha256 = f0H(observed.displayTitle.slice(titlePrefix.length))
  const matches = runs.filter((r) => r.displayTitle === observed.displayTitle)
  f0Assert(matches.length === 1 && observed.attempt === 1 && observed.workflowId === F0_WORKFLOW &&
    observed.repositoryId === c.repository.id && observed.headRepositoryId === c.repository.id &&
    observed.headSha === d.commit && observed.headBranch === d.ref.slice(11) && observed.event === "workflow_dispatch" &&
    f0Equal(observed.actor, d.actor) && f0Equal(observed.triggeringActor, c.triggeringActor), "authorization")
  return { repository: c.repository, workflowId: F0_WORKFLOW, runId: c.runId, attempt: 1, job: "windows-suite",
    matrix: c.matrix, actor: c.actor, intentSha256, nonce: d.nonce }
}
const F0_REASONS = ["none", "missing", "parent-missing", "slot-empty", "not-started", "unsupported-name", "reparse",
  "not-regular", "outside-root", "ambiguous-case", "access", "changed", "file-cap", "aggregate-cap", "count-cap",
  "deadline", "bootstrap", "io", "schema"]
const F0_CODES = ["none", "not-admitted", "authorization", "source-mismatch", "source-changed", "foundation", "catalogue",
  "deadline", "transport", "worker", "ownership", "io", "schema"]
function f0Selector(row) {
  const out = f0Object(row, { id: (v) => f0Text(v, 64, true),
    state: f0Enum("listed", "parent-missing", "over-limit", "unsupported-name", "unreadable", "not-collected"),
    names: (v) => f0Array(v, 0, 16).map((x) => f0Text(x, 128, true)), reason: f0Enum(...F0_REASONS) })
  const descriptor = getF0Catalogue().selectors.find((q) => q.id === out.id)
  f0Assert(descriptor)
  if (out.state !== "listed") {
    f0Assert(out.names.length === 0)
    const reasons = { "parent-missing": ["parent-missing"], "over-limit": ["count-cap"],
      "unsupported-name": ["unsupported-name", "reparse", "not-regular", "ambiguous-case"],
      unreadable: ["access", "io", "changed"], "not-collected": F0_REASONS.filter((r) => r !== "none") }
    f0Assert(reasons[out.state].includes(out.reason)); return out
  }
  f0Assert(out.reason === "none" && out.names.length <= descriptor.limit)
  const patterns = { git: /^[A-Za-z0-9._+-]{1,124}\.[dD][lL][lL]$/,
    llvm: /^[0-9]{1,3}(?:\.[0-9]{1,3}){0,2}$/, msvc: /^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,6}$/,
    sdk: /^[0-9]{1,3}(?:\.[0-9]{1,6}){2,3}$/, instance: /^[A-Za-z0-9_-]{1,64}$/ }
  const seen = new Set()
  for (let i = 0; i < out.names.length; i++) {
    const name = out.names[i], match = patterns[descriptor.type].exec(name)
    f0Assert(match?.[0] === name && !seen.has(name.toLowerCase()) && (!i || out.names[i - 1] < name))
    seen.add(name.toLowerCase())
  }
  return out
}
export function boundF0Selector(row) {
  const out = f0Selector(row)
  return Buffer.byteLength(JSON.stringify(out)) <= 2048 ? out :
    { id: out.id, state: "over-limit", names: [], reason: "count-cap" }
}
function f0Component(v) {
  f0Text(v, 128, true)
  f0Assert(v.length > 0 && v !== "." && v !== ".." && !v.startsWith(" ") && !v.endsWith(" ") &&
    !/[^A-Za-z0-9 ._()+-]/.test(v)); return v
}
function f0Locator(value) {
  return f0Object(value, { root: (v) => {
    f0Assert(getF0Catalogue().roots.some((r) => r.id === v)); return v
  }, parts: (v) => {
    const parts = f0Array(v, 1, 12).map(f0Component)
    f0Assert(parts.join("/").length <= 256); return parts
  } })
}
export function projectF0Collection(value) {
  const cat = getF0Catalogue()
  const out = f0Object(value, { basis: f0Fixed("fixed-catalogue-only"),
    roots: (v) => f0Array(v, 17).map((r, i) => {
      const row = f0Object(r, { id: f0Fixed(cat.roots[i].id),
        state: f0Enum("present", "missing", "refused", "error", "not-collected"), reason: f0Enum(...F0_REASONS) })
      const reasons = { present: ["none"], missing: ["missing"], refused: ["reparse", "not-regular", "outside-root", "ambiguous-case"],
        error: ["access", "changed", "io"], "not-collected": F0_REASONS.filter((x) => x !== "none") }
      f0Assert(reasons[row.state].includes(row.reason)); return row
    }),
    selectors: (v) => f0Array(v, 22).map((r, i) => {
      const row = f0Selector(r); f0Assert(row.id === cat.selectors[i].id && f0Equal(row, boundF0Selector(row))); return row
    }),
    files: (v) => f0Array(v, 411).map((r, i) => {
      const row = f0Object(r, { id: f0Fixed(cat.files[i].id), locator: f0Null(f0Locator),
        state: f0Enum("present", "missing", "parent-missing", "slot-empty", "refused", "unreadable", "too-large", "not-collected"),
        kind: f0Fixed(cat.files[i].kind), bytes: f0Null(f0U), sha256: f0Null(f0H), reason: f0Enum(...F0_REASONS) })
      const reasons = { present: ["none"], missing: ["missing"], "parent-missing": ["parent-missing"],
        "slot-empty": ["slot-empty"], refused: ["reparse", "not-regular", "outside-root", "ambiguous-case", "unsupported-name"],
        unreadable: ["access", "changed", "io"], "too-large": ["file-cap", "aggregate-cap"],
        "not-collected": F0_REASONS.filter((x) => x !== "none") }
      f0Assert(reasons[row.state].includes(row.reason) && Buffer.byteLength(JSON.stringify(row)) <= 768)
      if (row.state === "present") { f0U(row.bytes, 536870912); f0H(row.sha256) }
      else { f0Assert(row.sha256 === null); if (row.state !== "too-large") f0Assert(row.bytes === null) }
      return row
    }) })
  const roots = new Map(out.roots.map((r) => [r.id, r])), selectors = new Map(out.selectors.map((r) => [r.id, r]))
  for (let i = 0; i < 22; i++) {
    const root = roots.get(cat.selectors[i].root), row = out.selectors[i]
    if (root.state === "missing") f0Assert(row.state === "parent-missing" || row.state === "not-collected")
    if (root.state !== "present" && root.state !== "missing") f0Assert(row.state === "not-collected")
  }
  for (let i = 0; i < 411; i++) {
    const descriptor = cat.files[i], row = out.files[i], root = roots.get(descriptor.root)
    let expected = null, unavailable = null
    if (root.state === "missing") unavailable = "parent-missing"
    else if (root.state !== "present") unavailable = "not-collected"
    else if (descriptor.selector) {
      const selected = selectors.get(descriptor.selector)
      if (selected.state === "listed") {
        if (descriptor.rank > selected.names.length) unavailable = "slot-empty"
        else expected = { root: descriptor.root, parts: [...descriptor.parts.slice(0, descriptor.insertAt),
          selected.names[descriptor.rank - 1], ...descriptor.parts.slice(descriptor.insertAt)] }
      } else unavailable = selected.state === "parent-missing" ? "parent-missing" : "not-collected"
    } else expected = { root: descriptor.root, parts: [...descriptor.parts] }
    if (unavailable) {
      f0Assert(row.locator === null && (row.state === unavailable || row.state === "not-collected"))
      if (unavailable === "not-collected") f0Assert(row.state !== "slot-empty")
    } else {
      f0Assert(row.state === "not-collected" ? row.locator === null : f0Equal(row.locator, expected))
      f0Assert(!["parent-missing", "slot-empty"].includes(row.state))
    }
  }
  return out
}
function f0Error(value) {
  const out = f0Object(value, { code: f0Enum(...F0_CODES), stage: f0Enum("entry", "fetch", "source", "bootstrap", "collect", "join", "publish", "none"),
    subject: (v) => {
      if (v === null) return null
      f0Text(v, 64, true)
      const c = getF0Catalogue()
      f0Assert([...c.sources, ...c.roots, ...c.selectors, ...c.files].some((r) => r.id === v)); return v
    } })
  f0Assert(out.code === "none" ? out.stage === "none" && out.subject === null : out.stage !== "none")
  return out
}
const f0Version = (v) => f0Object(v, { major: (x) => f0U(x, 65535), minor: (x) => f0U(x, 65535),
  build: f0Null((x) => f0U(x, 65535)), revision: f0Null((x) => f0U(x, 65535)) })
const f0Foundation = (v) => f0Object(v, { node: (x) => f0Object(x, { version: f0Semver, sha256: f0Null(f0H) }),
  powershell: (x) => f0Object(x, { edition: f0Null(f0Fixed("Core")), version: f0Null(f0Version) }),
  dotnet: (x) => f0Object(x, { version: f0Null(f0Version) }), os: (x) => f0Object(x, { platform: f0Fixed("win32"), version: f0Null(f0Version) }),
  scope: f0Fixed("R0-R1-bootstrap-assumed") })
const F0_LOCAL_SHAPE = { workerExit: f0Null(f0U), workerExitObserved: f0Bool, workerStdoutEOF: f0Bool,
  workerStderrEOF: f0Bool, jobActive: f0Null(f0U), ioReaped: f0Bool, criticalHandlesClosed: f0Bool,
  ownership: f0Enum("closed", "unknown", "not-created") }
const f0Joined = (c) => c.ownership === "closed" && c.workerExit === 0 && c.workerExitObserved &&
  c.workerStdoutEOF && c.workerStderrEOF && c.jobActive === 0 && c.ioReaped && c.criticalHandlesClosed
function f0Local(value) {
  const out = f0Object(value, F0_LOCAL_SHAPE)
  if (out.ownership === "closed") f0Assert(f0Joined(out))
  if (out.ownership === "not-created") f0Assert(out.workerExit === null && !out.workerExitObserved && out.jobActive === null)
  return out
}
function f0Host(value) {
  return f0Object(value, { schema: f0Fixed("na1-f0-host/1"), worker: f0Null((v) => f0Object(v, {
    schema: f0Fixed("na1-f0-worker/1"), foundation: f0Foundation, collection: projectF0Collection, error: f0Error,
    visited: (x) => f0Object(x, { files: (n) => f0U(n, 411), selectors: (n) => f0U(n, 22), bytes: (n) => f0U(n, 8589934592) }),
  })), completion: f0Local })
}
export function createF0HostFrameReader() {
  let total = 0, length = null, ended = false, failed = false
  const prefix = Buffer.alloc(4), chunks = []
  return Object.freeze({
    push(bytes) {
      try {
        f0Assert(!ended && !failed && Buffer.isBuffer(bytes) && total + bytes.length <= 524292, "transport")
        let at = 0
        while (total < 4 && at < bytes.length) prefix[total++] = bytes[at++]
        if (total === 4 && length === null) {
          length = prefix.readUInt32LE(0); f0Assert(length > 0 && length <= 524288, "transport")
        }
        if (at < bytes.length) { chunks.push(Buffer.from(bytes.subarray(at))); total += bytes.length - at }
        if (length !== null) f0Assert(total <= length + 4, "transport")
      } catch { failed = true; f0Fail("transport") }
    },
    end() {
      f0Assert(!failed && !ended && length !== null && total === length + 4, "transport"); ended = true
      const bytes = Buffer.concat(chunks, length), host = f0Host(f0Parse(bytes, 524288))
      if (host.worker) f0Assert(Buffer.byteLength(JSON.stringify(host.worker)) <= 458752, "transport")
      return host
    },
  })
}
export function composeF0Completion(local, observed) {
  const c = f0Local(local), o = f0DataObject(observed,
    ["actualChild", "closedChild", "rootExit", "signal", "errorLatched", "deadlineLatched"])
  f0Bool(o.errorLatched); f0Bool(o.deadlineLatched)
  const rootClose = o.actualChild !== null && typeof o.actualChild === "object" && o.actualChild === o.closedChild
  const rootExit = rootClose && Number.isSafeInteger(o.rootExit) && o.rootExit >= 0 ? o.rootExit : null
  const closed = rootClose && rootExit === 0 && o.signal === null && !o.errorLatched && !o.deadlineLatched && f0Joined(c)
  const notCreated = c.ownership === "not-created" && (o.actualChild === null || rootClose) &&
    !o.errorLatched && !o.deadlineLatched
  return { rootExit, rootClose, ...c, ownership: closed ? "closed" : notCreated ? "not-created" : "unknown" }
}
function f0Observed(value, i) {
  const row = f0Object(value, { id: f0Fixed(getF0Catalogue().sources[i].id), bytes: f0Null((v) => f0U(v, 2097152)),
    sha256: f0Null(f0H), state: f0Enum("match", "mismatch", "missing", "unreadable", "not-collected") })
  if (row.state === "match" || row.state === "mismatch") { f0U(row.bytes, 2097152); f0H(row.sha256) }
  else f0Assert(row.bytes === null && row.sha256 === null)
  f0Assert(Buffer.byteLength(JSON.stringify(row)) <= 384); return row
}
function f0Basis(value) {
  return f0Object(value, { commitExpected: f0G, treeExpected: f0G, githubShaObserved: f0G,
    treeBasis: f0Fixed("controller-source-review"), checkoutBasis: f0Fixed("trusted-actions-checkout"),
    treeRecomputed: f0Fixed(false), files: (v) => f0Array(v, 17).map(f0Observed) })
}
function f0Run(value) {
  return f0Object(value, { repository: f0Repo, workflowId: f0Fixed(F0_WORKFLOW),
    runId: (v) => f0U(v, Number.MAX_SAFE_INTEGER, 1), attempt: f0Fixed(1), job: f0Fixed("windows-suite"),
    matrix: (v) => f0Object(v, { mode: f0Fixed("standard"), shard: f0Fixed(1), total: f0Fixed(8) }),
    actor: f0Actor, intentSha256: f0H, nonce: f0H })
}
const f0Counters = (v) => f0Object(v, { filesVisited: (x) => f0U(x, 411), selectorsVisited: (x) => f0U(x, 22),
  sourceBytes: (x) => f0U(x, 35651584), fileBytes: (x) => f0U(x, 8589934592),
  stdoutBytes: (x) => f0U(x, 524292), stderrBytes: (x) => f0U(x, 4096), elapsedMs: (x) => f0U(x, 300000) })
function f0CatalogueFailure(collection) {
  for (const row of collection.roots) if (!["present", "missing"].includes(row.state)) return row.id
  for (const row of collection.selectors) if (!["listed", "parent-missing"].includes(row.state)) return row.id
  for (const row of collection.files) if (!["present", "missing", "parent-missing", "slot-empty"].includes(row.state)) return row.id
  return null
}
function f0Inventory(value) {
  const out = f0Object(value, { schema: f0Fixed("na1-f0-inventory/1"), phase: f0Fixed("f0-inventory"),
    run: f0Run, source: f0Basis, foundation: f0Foundation, collection: projectF0Collection,
    completion: (v) => f0Object(v, { rootExit: f0Null(f0U), rootClose: f0Bool, ...F0_LOCAL_SHAPE }),
    result: (v) => f0Object(v, { operation: f0Enum("completed", "failed"), catalogue: f0Enum("complete", "incomplete") }),
    error: f0Error, counters: f0Counters, claims: (v) => f0Object(v, { qualificationTupleComplete: f0Fixed(false),
      toolSemanticsApproved: f0Fixed(false), nativeExecution: f0Fixed(false), q1Authorized: f0Fixed(false) }) })
  const c = out.completion
  if (c.ownership === "closed") f0Assert(c.rootClose && c.rootExit === 0 && f0Joined(c))
  if (c.ownership === "not-created") f0Assert(c.workerExit === null && !c.workerExitObserved && c.jobActive === null)
  const sourceBytes = out.source.files.reduce((sum, row) => sum + (row.bytes ?? 0), 0)
  f0Assert(sourceBytes <= 35651584 && out.counters.sourceBytes >= sourceBytes)
  f0Assert(out.counters.fileBytes >= out.collection.files.reduce((sum, row) => sum + (row.state === "present" ? row.bytes : 0), 0))
  const issue = f0CatalogueFailure(out.collection)
  if (out.error.code === "catalogue") f0Assert(issue !== null && out.error.stage === "collect" && out.error.subject === issue)
  if (out.result.catalogue === "complete") f0Assert(issue === null && out.error.code === "none" &&
    out.counters.filesVisited === 411 && out.counters.selectorsVisited === 22)
  else f0Assert(out.error.code !== "none")
  if (out.result.operation === "completed") {
    f0Assert(c.ownership === "closed" && out.source.githubShaObserved === out.source.commitExpected &&
      out.source.files.every((row) => row.state === "match") &&
      out.foundation.node.version === "24.18.0" && out.foundation.node.sha256 === F0_NODE_HASH &&
      out.foundation.powershell.edition === "Core" && out.foundation.powershell.version?.major >= 7 &&
      out.foundation.dotnet.version !== null && out.foundation.os.version !== null &&
      ["repo", "os", "ps", "rtc", "n24"].every((id) => out.collection.roots.find((row) => row.id === id)?.state === "present") &&
      ["node24", "ps.pwsh", "ps.sma", "ps.roslyn", "ps.utility"].every((id) =>
        out.collection.files.find((row) => row.id === id)?.state === "present") &&
      ["none", "catalogue"].includes(out.error.code) && out.counters.filesVisited === 411 &&
      out.counters.selectorsVisited === 22)
    if (issue !== null) f0Assert(out.error.code === "catalogue" && out.error.stage === "collect" && out.error.subject === issue)
  } else f0Assert(out.error.code !== "none" && c.ownership !== "closed")
  return out
}
export function finishF0Inventory({ init, host, observed, sourceAfter, counters }) {
  const h = f0Host(host), source = f0Basis(init.sourceBasis), after = f0Array(sourceAfter, 17).map(f0Observed)
  let drift = null
  for (let i = 0; i < 17; i++) {
    const expected = init.sourceApproval.files[i], row = after[i]
    if (row.state !== "match" || row.bytes !== expected.bytes || row.sha256 !== expected.sha256 ||
      !f0Equal(row, source.files[i])) { if (drift === null) drift = row.id }
    if (row.bytes !== null) row.state = row.bytes === expected.bytes && row.sha256 === expected.sha256 ? "match" : "mismatch"
  }
  source.files = after
  const completion = composeF0Completion(h.completion, { ...observed, errorLatched: observed.errorLatched || drift !== null })
  const worker = h.worker
  f0Assert(worker !== null, "worker")
  let error = worker.error
  if (drift !== null) error = { code: "source-changed", stage: "source", subject: drift }
  else if (completion.ownership !== "closed") error = { code: "ownership", stage: "join", subject: null }
  const issue = f0CatalogueFailure(worker.collection)
  if (error.code === "none" && issue !== null) error = { code: "catalogue", stage: "collect", subject: issue }
  if (!["none", "catalogue"].includes(error.code)) completion.ownership = "unknown"
  const completed = completion.ownership === "closed" && ["none", "catalogue"].includes(error.code)
  return f0Inventory({ schema: "na1-f0-inventory/1", phase: "f0-inventory", run: init.run, source,
    foundation: worker.foundation, collection: worker.collection, completion,
    result: { operation: completed ? "completed" : "failed", catalogue: error.code === "none" ? "complete" : "incomplete" },
    error, counters, claims: { qualificationTupleComplete: false, toolSemanticsApproved: false, nativeExecution: false, q1Authorized: false } })
}
export function encodeF0Inventory(value) {
  const bytes = Buffer.from(JSON.stringify(f0Inventory(value)), "utf8")
  f0Assert(bytes.length <= 524288 && !bytes.some((b) => b > 127)); return bytes
}
export function decodeF0Inventory(bytes) {
  const out = f0Inventory(f0Parse(bytes, 524288))
  f0Assert(encodeF0Inventory(out).equals(bytes)); return out
}
export function createF0Writer({ root, io, stillLive }) {
  f0Abs(root); f0Assert(typeof io?.exclusiveOpen === "function" && typeof stillLive === "function")
  const caps = { "source-approval.json": 16384, "intent.json": 4096, "inventory.json": 524288, "result.json": 4096 }
  const created = new Set()
  let reserved = 0, published = false
  const live = () => f0Assert(stillLive() === true, "deadline")
  async function write(name, bytes) {
    live(); f0Assert(Buffer.isBuffer(bytes) && Object.hasOwn(caps, name) && bytes.length <= caps[name] &&
      !created.has(name) && created.size < 4 && reserved + bytes.length <= 548864, "io")
    const buffer = Buffer.from(bytes)
    created.add(name); reserved += buffer.length
    const handle = await io.exclusiveOpen(name)
    let closed = false, closeAttempted = false
    try {
      live()
      for (let offset = 0; offset < buffer.length;) {
        live()
        const count = await handle.write(buffer, offset, buffer.length - offset)
        live(); f0U(count, buffer.length - offset, 1); offset += count
      }
      live(); await handle.flush(); live(); closeAttempted = true; await handle.close(); closed = true; live()
    } finally {
      if (!closed && !closeAttempted && stillLive() === true) {
        try { await handle.close() } catch { /* No failed close gets success credit or a retry. */ }
      }
    }
  }
  return Object.freeze({
    async writeControl(name, bytes) {
      f0Assert(name === "source-approval.json" || name === "intent.json", "io")
      await write(name, bytes)
    },
    async publish(value) {
      live(); f0Assert(!published, "io")
      const inventory = f0Inventory(value), bytes = encodeF0Inventory(inventory)
      published = true
      await write("inventory.json", bytes); live()
      const result = { schema: "na1-f0-result/1", intentSha256: inventory.run.intentSha256,
        runId: inventory.run.runId, attempt: 1, exitCode: inventory.result.operation === "completed" ? 0 : 1,
        packet: { bytes: bytes.length, sha256: f0Hash(bytes) },
        completion: inventory.completion.ownership === "closed" ? "closed" : "unknown", code: inventory.error.code }
      const encoded = Buffer.from(JSON.stringify(result))
      f0Assert(encoded.length <= 4096, "io")
      await write("result.json", encoded); live(); return result
    },
  })
}
const F0_READER_LIMITS = { zipBytes: 1048576, packetBytes: 524288, recordBytes: 65536, apiBodyBytes: 1048576,
  centralBytes: 4096, entries: 1, depth: 16, tokens: 65536, keys: 32768, containers: 4096,
  stringChars: 262144, phaseSeconds: 120, workingBytes: 134217728 }
function f0ReaderLimits(value) {
  return f0Object(value, Object.fromEntries(Object.entries(F0_READER_LIMITS).map(([k, v]) => [k, f0Fixed(v)])))
}
const f0Tool = (v) => f0Object(v, { path: f0Abs, sha256: f0H, version: f0Semver })
function f0ReaderTools(v) {
  return f0Object(v, { python: f0Tool, node: f0Tool, foundationReviewSha256: f0H, helperSha256: f0H,
    adapterSha256: f0H, localRepo: f0Abs, validatorFiles: (rows) => f0Array(rows, 17).map((row, i) =>
      f0Object(row, { id: f0Fixed(getF0Catalogue().sources[i].id), path: f0Fixed(getF0Catalogue().sources[i].path), sha256: f0H })) })
}
export function projectF0ReaderPolicy(value) {
  const out = f0Object(value, { schema: f0Fixed("na1-f0-reader-policy/1"), repository: f0Repo,
    workflowId: f0Fixed(F0_WORKFLOW), workflowPath: f0Fixed(".github/workflows/desk-windows-suite.yml"),
    sourceApproval: f0Ref(16384), intent: f0Ref(4096), authorizationSha256: f0H, dispatchSha256: f0H,
    run: (v) => f0Object(v, { id: (x) => f0U(x, Number.MAX_SAFE_INTEGER, 1), attempt: f0Fixed(1),
      commit: f0G, ref: (x) => f0Text(x, 128, true), actor: f0Actor }),
    artifactName: f0Fixed("owned-git-f0-standard-shard-1-attempt-1"), tools: f0ReaderTools, qualificationSha256: f0H, limits: f0ReaderLimits })
  f0Assert(out.run.ref === `refs/heads/diag/windows-owned-git-f0-${out.run.commit.slice(0, 12)}` &&
    Buffer.byteLength(JSON.stringify(out)) <= 32768)
  return out
}
export function projectF0QualificationPolicy(value) {
  const out = f0Object(value, { schema: f0Fixed("na1-f0-qualify-policy/1"), sourceApproval: f0Ref(16384),
    tools: f0ReaderTools, limits: f0ReaderLimits, fixtureDescriptionSha256: f0H })
  f0Assert(Buffer.byteLength(JSON.stringify(out)) <= 32768); return out
}
const F0_ENV_KEYS = ["SystemRoot", "WINDIR", "SystemDrive", "PSHOME", "PSModulePath", "PSModuleAnalysisCachePath",
  "POWERSHELL_TELEMETRY_OPTOUT", "DOTNET_EnableDiagnostics", "F0_RUNNER_TOOL_CACHE",
  "HOMEDRIVE", "HOMEPATH", "LOGONSERVER", "PATH", "TEMP", "USERDOMAIN", "USERNAME", "USERPROFILE"]
export function projectF0FirstHopEnv(value, foundation) {
  const f = f0FoundationEnv(foundation), raw = f0DataObject(value, F0_ENV_KEYS)
  const expected = [f.systemRoot, f.windir, f.systemDrive, f.psHome, path.win32.join(f.psHome, "Modules"),
    "NUL", "1", "0", f.runnerToolCache, "", "", "", "", "", "", "", ""]
  const out = Object.create(null)
  for (let i = 0; i < F0_ENV_KEYS.length; i++) {
    f0Assert(typeof raw[F0_ENV_KEYS[i]] === "string" && raw[F0_ENV_KEYS[i]] === expected[i], "foundation")
    out[F0_ENV_KEYS[i]] = expected[i]
  }
  return Object.freeze(out)
}
export function buildF0Launch(value) {
  const v = f0DataObject(value, ["repositoryRoot", "sourceRevision", "nodePath", "intentSha256", "remainingMs", "pwshPath", "foundation"])
  const root = f0Abs(v.repositoryRoot), node = f0Abs(v.nodePath), revision = f0G(v.sourceRevision), intent = f0H(v.intentSha256)
  const remaining = f0U(v.remainingMs, 300000, 1), f = f0FoundationEnv(v.foundation), image = f0Abs(v.pwshPath)
  f0Assert(image === path.win32.join(f.psHome, "pwsh.exe") && /^[A-Za-z]:\\/.test(root) && /^[A-Za-z]:\\/.test(node), "foundation")
  const args = Object.freeze(["-NoLogo", "-NoProfile", "-NonInteractive", "-File",
    path.win32.join(root, ".github", "scripts", "run-as-standard-user.ps1"), "-F0Inventory",
    "-F0RepositoryRoot", root, "-F0SourceRevision", revision, "-F0NodePath", node,
    "-F0IntentSha256", intent, "-F0RemainingMs", String(remaining)])
  const env = Object.create(null), values = [f.systemRoot, f.windir, f.systemDrive, f.psHome,
    path.win32.join(f.psHome, "Modules"), "NUL", "1", "0", f.runnerToolCache, "", "", "", "", "", "", "", ""]
  for (let i = 0; i < F0_ENV_KEYS.length; i++) env[F0_ENV_KEYS[i]] = values[i]
  return Object.freeze({ image, args, cwd: root, env: projectF0FirstHopEnv(env, f) })
}
export function spawnF0Child(input) {
  const v = f0DataObject(input, ["launch", "foundation", "readExclusions", "spawn"])
  const read = v.readExclusions, spawn = v.spawn, f = f0FoundationEnv(v.foundation)
  f0Assert(typeof read === "function" && typeof spawn === "function", "foundation")
  const l = f0DataObject(v.launch, ["image", "args", "cwd", "env"]), a = f0Array(l.args, 16)
  for (const item of a) f0Text(item, 1024)
  const rebuilt = buildF0Launch({ repositoryRoot: l.cwd, sourceRevision: a[9], nodePath: a[11],
    intentSha256: a[13], remainingMs: Number(a[15]), pwshPath: l.image, foundation: f })
  f0Assert(a.every((x, i) => x === rebuilt.args[i]) && l.cwd === rebuilt.cwd && l.image === rebuilt.image, "foundation")
  const env = projectF0FirstHopEnv(l.env, f), image = rebuilt.image, args = [...rebuilt.args]
  const options = { cwd: rebuilt.cwd, env, shell: false, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, detached: false }
  const sensed = f0DataObject(read(), ["execArgv", "nodeOptions", "nodePath", "coverage", "compileCache",
    "redirectWarnings", "constructorHasSubscribers", "spawnTraceHasSubscribers"])
  f0Array(sensed.execArgv, 0)
  for (const key of ["nodeOptions", "nodePath", "coverage", "compileCache", "redirectWarnings"]) f0Assert(sensed[key] === undefined, "foundation")
  f0Assert(sensed.constructorHasSubscribers === false && sensed.spawnTraceHasSubscribers === false, "foundation")
  return spawn(image, args, options)
}
export function createF0Completion({ startedNs, nowNs, arm, disarm, persist, terminate }) {
  f0Assert(typeof startedNs === "bigint" && startedNs >= 0n && [nowNs, arm, disarm, persist, terminate].every((v) => typeof v === "function"))
  const deadlineNs = startedNs + F0_DEADLINE, frame = createF0HostFrameReader()
  let phase = "NEW", child = null, timer, stopped = false, errorCode = "none", closed = false, killed = false
  let lastNs = startedNs, stdoutBytes = 0, stderrBytes = 0, host = null, resolve
  const terminal = new Promise((r) => { resolve = r })
  function stop(code) {
    if (stopped) return
    stopped = true; phase = "TERMINAL"
    try { if (timer !== undefined) disarm(timer) }
    finally { try { terminate(code) } finally { resolve(code) } }
  }
  function error(code = "worker") {
    if (stopped || errorCode !== "none") return
    errorCode = F0_CODES.includes(code) && code !== "none" ? code : "schema"
    if (child && !closed && !killed) { killed = true; try { child.kill() } catch { /* Unknown retirement never becomes closed. */ } }
    stop(1)
  }
  function live() {
    if (stopped || errorCode !== "none") return false
    try {
      const now = nowNs()
      if (typeof now === "bigint" && now >= lastNs && now < deadlineNs) { lastNs = now; return true }
    } catch { /* A failed clock cannot extend the owner. */ }
    error("deadline"); return false
  }
  return Object.freeze({
    terminal,
    start() {
      if (phase !== "NEW") { error(); return }
      phase = "FETCHING"
      if (!live()) return
      timer = arm(() => error("deadline"), Number((deadlineNs - lastNs + 999999n) / 1000000n)); live()
    },
    attach(actualChild) {
      if (phase !== "FETCHING" || child || !actualChild || typeof actualChild !== "object") { error(); return }
      // Capture the returned handle before reading a clock that can expire during spawn.
      child = actualChild; phase = "CHILD"; live()
    },
    stdout(bytes) {
      if (!live()) return
      try {
        f0Assert(phase === "CHILD" && !closed && Buffer.isBuffer(bytes), "transport")
        stdoutBytes += bytes.length; f0Assert(stdoutBytes <= 524292, "transport"); frame.push(bytes)
      } catch { error() }
    },
    stderr(bytes) {
      if (!live()) return
      if (phase !== "CHILD" || closed || !Buffer.isBuffer(bytes)) { error(); return }
      stderrBytes += bytes.length; if (stderrBytes > 4096) error()
    },
    error,
    closed(actualChild, code, signal) {
      if (!live()) return
      if (phase !== "CHILD" || child !== actualChild || closed) { error(); return }
      closed = true
      try {
        f0Assert(code === 0 && signal === null, "worker"); host = frame.end()
        f0Assert(f0Joined(host.completion) && host.worker !== null, "ownership")
      } catch { error() }
    },
    async publish(value) {
      if (!live()) return
      if (phase !== "CHILD" || !closed || !host) { error(); return }
      try {
        const inventory = f0Inventory(value)
        f0Assert(inventory.completion.rootClose && inventory.completion.rootExit === 0 &&
          inventory.completion.ownership === "closed", "ownership")
        phase = "PUBLISHING"
        const result = await persist(inventory, live)
        if (!live()) return
        f0Assert(result?.exitCode === 0, "io"); stop(0)
      } catch { error() }
    },
    deadline: () => error("deadline"),
  })
}
export async function initF0Inventory({ selection, context, deadlineNs, edges }) {
  const c = f0Context(context)
  const selected = f0DataObject(selection, ["kind", "only", "elevated", "phase", "intentOid", "intentSha256"])
  f0Assert(selected.kind === "f0" && selected.only === PRODUCT_SELECTOR && selected.elevated === false &&
    selected.phase === "f0-inventory", "not-admitted")
  f0G(selected.intentOid); f0H(selected.intentSha256)
  f0Assert(typeof deadlineNs === "bigint" && deadlineNs >= 0n)
  let last = 0n
  const live = () => {
    const now = edges.nowNs()
    f0Assert(typeof now === "bigint" && now >= last && now < deadlineNs && deadlineNs - now <= F0_DEADLINE, "deadline")
    last = now; return Number((deadlineNs - now + 999999n) / 1000000n)
  }
  const effect = async (name, ...args) => { live(); const result = await edges[name](...args); live(); return result }
  live()
  const dBlob = decodeF0BlobResponse(await effect("getBlob", selected.intentOid, 12288),
    { oid: selected.intentOid, sha256: selected.intentSha256, maxDecoded: 4096, expectedBytes: null })
  const intent = projectF0Intent(f0Parse(dBlob.bytes, 4096))
  const sBlob = decodeF0BlobResponse(await effect("getBlob", intent.sourceApproval.oid, 32768),
    { oid: intent.sourceApproval.oid, sha256: intent.sourceApproval.sha256,
      maxDecoded: 16384, expectedBytes: intent.sourceApproval.bytes })
  const sourceApproval = projectF0SourceApproval(f0Parse(sBlob.bytes, 16384))
  const service = f0ServiceRun(await effect("getRun", c.runId))
  const first = checkF0RunBinding({ intent, sourceApproval, context: c, serviceRuns: [service], nowUtc: edges.nowUtc() })
  f0Assert(first.intentSha256 === selected.intentSha256, "authorization")
  const runs = []
  for (let page = 1; page <= 5; page++) {
    const data = f0DataObject(await effect("getRunsPage", page), ["runs", "hasNext"])
    f0Bool(data.hasNext); runs.push(...f0Array(data.runs, 0, 20).map(f0ServiceRun))
    if (!data.hasNext) break
    f0Assert(page < 5, "authorization")
  }
  const run = checkF0RunBinding({ intent, sourceApproval, context: c, serviceRuns: runs, nowUtc: edges.nowUtc() })
  f0Assert(f0Equal(run, first) && runs.some((r) => r.id === service.id && f0Equal(r, service)), "authorization")
  const files = []
  let sourceBytes = 0
  for (const row of sourceApproval.files) {
    const bytes = await effect("readSource", row.path, 2097152)
    f0Assert(Buffer.isBuffer(bytes) && bytes.length <= 2097152, "source-mismatch")
    sourceBytes += bytes.length
    f0Assert(sourceBytes <= 35651584 && bytes.length === row.bytes && f0Hash(bytes) === row.sha256, "source-mismatch")
    files.push({ id: row.id, bytes: bytes.length, sha256: f0Hash(bytes), state: "match" })
  }
  f0Assert(await effect("hashNode") === F0_NODE_HASH, "foundation")
  await effect("createFreshRoot")
  await effect("writeControl", "source-approval.json", sBlob.bytes)
  await effect("writeControl", "intent.json", dBlob.bytes)
  const sourceBasis = { commitExpected: sourceApproval.commit, treeExpected: sourceApproval.tree,
    githubShaObserved: c.sha, treeBasis: "controller-source-review", checkoutBasis: "trusted-actions-checkout",
    treeRecomputed: false, files }
  const foundation = { systemRoot: c.systemRoot, windir: c.windir, systemDrive: c.systemDrive,
    psHome: c.psHome, runnerToolCache: c.runnerToolCache }
  const launch = buildF0Launch({ repositoryRoot: c.workspace, sourceRevision: sourceApproval.commit,
    nodePath: c.nodeExecutable, intentSha256: selected.intentSha256, remainingMs: live(),
    pwshPath: path.win32.join(c.psHome, "pwsh.exe"), foundation })
  return { sourceApproval, observedIntentRef: dBlob.ref, intent, run, sourceBasis, launch }
}
const LIMIT = 1048576
export function captureProductEnvelope(startedNs) {
  if (typeof startedNs !== "bigint" || startedNs < 0n || startedNs > 18446743953709551615n) throw new Error("deadline")
  return Object.freeze({ startedNs, Hns: startedNs + 120000000000n })
}
export function productEnvelopeRemaining(envelope, nowNs) {
  if (typeof nowNs !== "bigint" || nowNs < envelope.startedNs) throw new Error("deadline")
  const remaining = envelope.Hns - nowNs
  return remaining > 0n ? Number((remaining + 999999n) / 1000000n) : 0
}
export function isOwnedGitProductSelection(only, mode) {
  return only === PRODUCT_SELECTOR && mode === "standard"
}
export function createProductTapCounter() {
  const streams = { stdout: { bytes: [], overflow: false }, stderr: { bytes: [], overflow: false } }
  let total = 0, invalid = false, ended = false, selected = 0, passed = 0, failed = 0, skipped = 0, plan = null
  const summary = new Map()
  function line(bytes, stream) {
    if (stream !== "stdout") return
    const text = Buffer.from(bytes).toString("utf8").replace(/\r$/, "")
    const result = /^(not )?ok ([1-9][0-9]*) - native Windows owned-Git product admission(.*)$/.exec(text)
    if (result) {
      selected++
      if (result[3] !== "" && !/^ # SKIP(?: .*)?$/.test(result[3])) invalid = true
      if (result[3] !== "") skipped++
      else if (result[1]) failed++
      else passed++
      return
    }
    const counts = /^# (tests|pass|fail|skipped) ([0-9]+)$/.exec(text)
    if (counts) {
      const value = Number(counts[2])
      if (!Number.isSafeInteger(value) || value > 15 || summary.has(counts[1])) invalid = true
      summary.set(counts[1], value)
      return
    }
    const planned = /^1\.\.([0-9]+)$/.exec(text)
    if (planned) { if (plan !== null) invalid = true; plan = Number(planned[1]); return }
    // All free-text diagnostics are discarded; no raw text leaves this closure.
    if (/^(?:not )?ok [0-9]+ - /.test(text) && !/^ok [0-9]+ - portable [^\r\n]+ # SKIP(?: .*)?$/.test(text)) invalid = true
  }
  return {
    push(chunk, stream = "stdout") {
      if (ended || !Buffer.isBuffer(chunk) || !Object.hasOwn(streams, stream)) { invalid = true; return }
      total += chunk.length
      if (!Number.isSafeInteger(total) || total > LIMIT) { invalid = true; return }
      const s = streams[stream]
      for (const byte of chunk) {
        if (byte === 10) {
          if (!s.overflow) line(s.bytes, stream)
          s.bytes = []; s.overflow = false
        } else if (!s.overflow) {
          if (s.bytes.length === 256) { s.bytes = []; s.overflow = true; invalid = true }
          else s.bytes.push(byte)
        }
      }
    },
    end() {
      if (ended) invalid = true
      ended = true
      if (Object.values(streams).some((s) => s.bytes.length || s.overflow)) invalid = true
      const filteredSummary = summary.get("tests") === 15 && summary.get("skipped") === 14
      const nativeSummary = summary.get("tests") === 1 && summary.get("skipped") === 0
      const valid = !invalid && selected === 1 && passed === 1 && failed === 0 && skipped === 0 &&
        (plan === 1 || plan === 15) && (filteredSummary || nativeSummary) &&
        summary.size === 4 && summary.get("pass") === 1 && summary.get("fail") === 0
      return Object.freeze({ valid, pass: passed, fail: failed, skipped, selected })
    },
  }
}
export function makeProductResult({ counts, exitCode, timedOut, bytes, ms, code, completion }) {
  const numeric = (v, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(v) && v >= 0 && v <= max
  const envelope = counts && numeric(counts.pass, 1) && numeric(counts.fail, 1) && numeric(counts.skipped, 1) &&
    numeric(bytes?.stdout) && numeric(bytes?.stderr) && numeric(ms, 120000) && typeof timedOut === "boolean"
  const closed = completion === "child-close"
  const ok = envelope && closed && counts.valid === true && exitCode === 0 && !timedOut && code === "none"
  return {
    file: PRODUCT_TEST_FILE, exitCode: ok ? 0 : 1, timedOut: timedOut === true,
    ms: numeric(ms, 120000) ? ms : 120000,
    pass: envelope ? counts.pass : 0, fail: envelope ? counts.fail : 0, skipped: envelope ? counts.skipped : 0,
    failedTests: ok ? [] : [NATIVE_TEST_NAME], failures: [], stuck: "", tail: "", outputTail: "", firstFailures: "",
    product: { selected: 1, filtered: 14, completion: closed ? "child-close" : "incomplete",
      code: ok ? "none" : timedOut ? "deadline" : "ci_envelope",
      stdoutBytes: numeric(bytes?.stdout) ? bytes.stdout : 0, stderrBytes: numeric(bytes?.stderr) ? bytes.stderr : 0 },
  }
}
export function createProductCompletion({ envelope, nowNs, counter, bytes, arm, disarm, persist, terminate }) {
  let phase = "NEW", errorCode = "none", fatal = false, terminalCode = null, timer
  let child = null, closeObserved = false, killRequested = false
  let resolveTerminal
  const terminal = new Promise((resolve) => { resolveTerminal = resolve })
  const snapshot = () => Object.freeze({ phase, errorCode, fatal, terminalCode, closeObserved,
    killRequested, ownershipUnknown: fatal || !closeObserved })
  function stop(code) {
    if (terminalCode !== null) return
    terminalCode = code; phase = "TERMINAL"
    try { if (timer !== undefined) disarm(timer) }
    finally {
      try { terminate(code) }
      finally { resolveTerminal(snapshot()) }
    }
  }
  function requestKill() {
    if (!child || closeObserved || killRequested) return
    killRequested = true
    try { child.kill() } catch { if (errorCode === "none") errorCode = "ci_envelope" }
  }
  function deadline() {
    if (terminalCode !== null || fatal) return
    fatal = true; errorCode = "deadline"; phase = "FATAL_DEADLINE"
    try { requestKill() } finally { stop(1) }
  }
  function live() {
    if (terminalCode !== null || fatal) return false
    try {
      if (productEnvelopeRemaining(envelope, nowNs()) > 0) return true
    } catch { /* A failed/regressing clock cannot authorize more work. */ }
    deadline(); return false
  }
  function error(code = "ci_envelope") {
    if (terminalCode !== null || fatal) return
    if (errorCode === "none") errorCode = code === "quota" ? "quota" : "ci_envelope"
    if (!live()) return
    if (!child) { stop(1); return }
    requestKill()
  }
  function result(counts, exitCode, completion) {
    const elapsed = Number((nowNs() - envelope.startedNs) / 1000000n)
    return makeProductResult({ counts, exitCode, completion, timedOut: false, bytes,
      ms: Math.max(0, Math.min(elapsed, 120000)), code: errorCode })
  }
  async function prepare() {
    if (phase !== "NEW") { error(); return false }
    phase = "PREPARING"
    try {
      if (!live()) return false
      timer = arm(deadline, productEnvelopeRemaining(envelope, nowNs()))
      if (!live()) return false
      errorCode = "ci_envelope"
      const provisional = result({ valid: false, pass: 0, fail: 0, skipped: 0 }, 1, "incomplete")
      errorCode = "none"
      if (!live()) return false
      await persist(provisional)
      if (!live()) return false
      phase = "RUNNING"; return true
    } catch {
      if (terminalCode === null && !fatal) { errorCode = "ci_envelope"; stop(1) }
      return false
    }
  }
  async function close(code) {
    if (!child) { error(); return }
    if (closeObserved) return
    closeObserved = true
    if (!live()) return
    try {
      const counts = counter.end()
      phase = "CHILD_CLOSED"
      const row = result(counts, code, "child-close")
      if (!live()) return
      phase = "PUBLISHING"
      await persist(row)
      if (!live()) return
      stop(errorCode === "none" ? row.exitCode : 1)
    } catch {
      if (terminalCode === null && !fatal) { errorCode = "ci_envelope"; stop(1) }
    }
  }
  function attach(actualChild) {
    if (terminalCode !== null || fatal) return terminal
    if (phase !== "RUNNING" || child) { error(); return terminal }
    child = actualChild
    try {
      child.on("error", () => error())
      child.once("close", (code) => { void close(code) })
      for (const name of ["stdout", "stderr"]) {
        child[name].on("error", () => error())
        child[name].on("data", (chunk) => {
          if (!live() || closeObserved) return
          try {
            if (!Buffer.isBuffer(chunk)) { error(); return }
            bytes[name] += chunk.length
            if (!Number.isSafeInteger(bytes[name]) || bytes.stdout + bytes.stderr > LIMIT) { error("quota"); return }
            counter.push(chunk, name)
          } catch { error() }
        })
      }
      live()
    } catch { error() }
    return terminal
  }
  return Object.freeze({ prepare, attach, error, close, deadline, snapshot })
}
