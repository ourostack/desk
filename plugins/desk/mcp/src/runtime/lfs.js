import { createHash } from "node:crypto"
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs"
import * as path from "node:path"
import { spawnSync } from "node:child_process"
import { exclusionForPath } from "../indexer/exclusions.js"

const LIMITS = { paths: 512, prefix_bytes: 4096, file_bytes: 16 * 1024 * 1024, total_bytes: 64 * 1024 * 1024, command_bytes: 2 * 1024 * 1024, duration_ms: 10_000 }
const EXTENSIONS = new Set("pdf doc docx ppt pptx xls xlsx odt odp ods png jpg jpeg gif webp avif tif tiff bmp heic ico zip 7z tar gz tgz mp3 wav m4a mp4 mov webm".split(" "))
const ATTRIBUTES = ["filter", "diff", "merge", "text"]
const POINTER_HEADER = "version https://git-lfs.github.com/spec/v1\n"
const SENSITIVE = /(?:^|\/)(?:\.env(?:\..*)?|\.ssh|\.aws|\.azure|credentials(?:\.[^/]*)?|secrets?(?:\.[^/]*)?|tokens?(?:\.[^/]*)?)(?:\/|$)|\.(?:key|pem|pfx|p12|kdbx)$/iu
const CONFIG_KEYS = "^(filter\\.lfs\\.|core\\.(hookspath|sparsecheckout)|extensions\\.partialclone|remote\\.origin\\.url|remote\\..*\\.promisor|lfs\\.storage)"

const sensitivePath = (file) => exclusionForPath(file).reason === "sensitive_path" || SENSITIVE.test(file)

function relativePath(value) {
  if (typeof value !== "string" || value === "" || value.includes("\0") || value.includes("\\") || path.posix.isAbsolute(value) || /^[A-Za-z]:/u.test(value)) return null
  const parts = value.split("/")
  if (parts.some((part) => part === ".." || part === ".git")) return null
  return parts.filter((part) => part !== "" && part !== ".").join("/")
}

function directoryRoot(root) {
  if (typeof root !== "string" || !path.isAbsolute(root)) return { state: "unsafe_path" }
  const raw = process.platform === "win32" ? root.replaceAll("/", path.sep) : root
  const anchor = path.parse(raw).root
  let current = anchor
  try {
    const parts = ["", ...raw.slice(anchor.length).split(path.sep)]
    for (const part of parts) {
      if (part === "..") current = path.dirname(current)
      else if (part !== "" && part !== ".") current = path.join(current, part)
      const stat = lstatSync(current)
      if (stat.isSymbolicLink() || !stat.isDirectory()) return { state: "unsafe_path" }
    }
    return path.relative(current, realpathSync(current)) === "" ? { state: "directory", root: current } : { state: "unsafe_path" }
  } catch (error) {
    return { state: error.code === "ENOENT" ? "missing" : "unreadable" }
  }
}

// Check the root and its ancestors too: a symlinked common Git directory must not expose another cache.
function safeStat(root, relative) {
  const rel = relativePath(relative)
  if (rel === null || rel === "") return { state: "unsafe_path" }
  const checked = directoryRoot(root)
  if (checked.state !== "directory") return { state: checked.state }
  let current = checked.root
  try {
    let stat
    for (const part of rel.split("/")) {
      current = path.join(current, part)
      stat = lstatSync(current)
      if (stat.isSymbolicLink()) return { state: "unsafe_path" }
    }
    return stat.isFile() ? { state: "file", file: current, stat } : { state: "unsafe_path" }
  } catch (error) {
    return { state: error.code === "ENOENT" ? "missing" : "unreadable" }
  }
}

function readLocal(root, rel, budget, { expected, prefix = false } = {}) {
  const found = safeStat(root, rel)
  if (found.state !== "file") return { state: found.state }
  const size = found.stat.size
  if (expected !== undefined && size !== expected.size) return { state: "mismatch" }
  const length = prefix ? Math.min(size, LIMITS.prefix_bytes) : size
  if (length > LIMITS.file_bytes || length > budget.bytes || performance.now() >= budget.deadline) return { state: "not_checked_limit" }
  let fd
  try {
    fd = openSync(found.file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    const before = fstatSync(fd)
    if (!before.isFile() || before.ino !== found.stat.ino || before.dev !== found.stat.dev || before.size !== size) return { state: "changed_during_read" }
    const hash = expected === undefined ? null : createHash("sha256")
    const chunk = Buffer.alloc(Math.min(length, 64 * 1024))
    const parts = []
    let offset = 0
    while (offset < length) {
      if (performance.now() >= budget.deadline) return { state: "not_checked_limit" }
      const read = readSync(fd, chunk, 0, Math.min(chunk.length, length - offset), offset)
      if (read === 0) return { state: "changed_during_read" }
      budget.bytes -= read
      if (hash === null) parts.push(Buffer.from(chunk.subarray(0, read)))
      else hash.update(chunk.subarray(0, read))
      offset += read
    }
    const after = fstatSync(fd)
    const still = safeStat(root, rel)
    if (after.size !== size || after.mtimeMs !== before.mtimeMs || still.state !== "file" || still.stat.ino !== before.ino || still.stat.dev !== before.dev) return { state: "changed_during_read" }
    return hash === null ? { state: "read", data: Buffer.concat(parts), size } : { state: hash.digest("hex") === expected.oid ? "verified" : "mismatch" }
  } catch {
    return { state: "unreadable" }
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

function pointerOf(data) {
  const text = data.toString("utf8")
  if (!text.startsWith(POINTER_HEADER)) return null
  const match = /^version https:\/\/git-lfs.github.com\/spec\/v1\noid sha256:([a-f0-9]{64})\nsize (0|[1-9][0-9]*)\n$/u.exec(text)
  if (match === null || !Number.isSafeInteger(Number(match[2]))) return { invalid: true }
  return { oid: match[1], size: Number(match[2]) }
}

function configuration(data) {
  const values = new Map()
  for (const entry of data.toString("utf8").split("\0")) {
    const split = entry.indexOf("\n")
    if (split > 0) values.set(entry.slice(0, split).toLowerCase(), entry.slice(split + 1))
  }
  return values
}

function attributeValue(value) {
  return ["lfs", "set", "unset", "unspecified"].includes(value) ? value : "custom"
}

function packageRoots(entries, read, findings) {
  const roots = new Set(["plugins"])
  const add = (value) => {
    const rel = relativePath(value)
    if (rel === null) findings.push({ code: "package_declaration_invalid" })
    else roots.add(rel)
  }
  for (const entry of entries) {
    if (/(?:^|\/)(?:plugin\.json|agency\.json)$/u.test(entry.path)) {
      const dir = path.posix.dirname(entry.path)
      add(dir.endsWith("/.claude-plugin") ? path.posix.dirname(dir) : dir === ".claude-plugin" ? "." : dir)
    }
    if (![".claude-plugin/marketplace.json", ".github/plugin/marketplace.json", "_meta/crew.json"].includes(entry.path)) continue
    const content = read(entry.path)
    if (content.state !== "read" || content.size > LIMITS.prefix_bytes) {
      findings.push({ code: "package_declaration_unreadable", path: entry.path })
      continue
    }
    let value
    try {
      value = JSON.parse(content.data.toString("utf8"))
    } catch {
      findings.push({ code: "package_declaration_invalid", path: entry.path })
      continue
    }
    if (entry.path === "_meta/crew.json") {
      if (value?.tooling?.repo == null && typeof value?.tooling?.path === "string") add(value.tooling.path || ".")
    } else if (Array.isArray(value?.plugins)) {
      for (const plugin of value.plugins) {
        if (typeof plugin?.source === "string" && !plugin.source.includes("://")) add(plugin.source)
      }
    }
  }
  return [...roots].sort()
}

/**
 * Inspect local index, attributes and bounded file bytes. Never runs content filters,
 * hooks, network commands or repairs. Remote publication and installed readiness remain unqualified.
 */
export function inspectLfs({ repo = process.cwd(), spawn = spawnSync, env = process.env } = {}) {
  const result = {
    schema_version: 1,
    action: "inspect",
    state: "unavailable",
    repository: { kind: "unknown", context: "unknown", has_origin: "unknown", partial: "unknown", sparse: "unknown", package_roots: [] },
    tool: { state: "not_checked" },
    configuration: { filters: "unknown", hooks: { location: "unknown", pre_push: "not_checked", integration: "not_checked" } },
    policy: { id: "desk-context-binaries-v1", extensions: [...EXTENSIONS].sort() },
    files: [],
    findings: [],
    limits: { ...LIMITS },
    qualification: { remote_publication: "not_checked", network_auth: "not_checked", installed_payload: "not_checked" },
  }
  let cwd
  try {
    if (typeof repo !== "string" || repo.trim() === "") throw new Error("invalid path")
    cwd = realpathSync(repo)
    if (!lstatSync(cwd).isDirectory()) throw new Error("not a directory")
  } catch {
    result.state = "not_git"
    result.findings.push({ code: "repository_unavailable" })
    return result
  }
  const budget = { bytes: LIMITS.total_bytes, deadline: performance.now() + LIMITS.duration_ms }
  const gitEnv = { ...env, GIT_NO_LAZY_FETCH: "1", GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", GIT_LFS_SKIP_SMUDGE: "1", GIT_ALLOW_PROTOCOL: "", GIT_PROTOCOL_FROM_USER: "0" }
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_ATTR_SOURCE"]) delete gitEnv[key]
  const git = (args, input) => {
    if (performance.now() >= budget.deadline) return { status: null, data: Buffer.alloc(0) }
    // An inherited attribute tree can otherwise replace the working-tree/index policy.
    const answer = spawn("git", ["-c", "core.fsmonitor=false", "-c", "protocol.allow=never", "-c", "attr.tree=", "-C", cwd, ...args], {
      env: gitEnv, windowsHide: true, input, timeout: Math.max(1, Math.min(3000, Math.ceil(budget.deadline - performance.now()))), killSignal: "SIGKILL", maxBuffer: LIMITS.command_bytes,
    })
    return { status: answer.error ? null : answer.status, data: Buffer.isBuffer(answer.stdout) ? answer.stdout : Buffer.from(answer.stdout ?? "") }
  }
  const top = git(["rev-parse", "--show-toplevel"])
  if (top.status !== 0) {
    try {
      lstatSync(path.join(cwd, ".git"))
    } catch (error) {
      if (error.code === "ENOENT") result.state = "not_git"
    }
    result.findings.push({ code: "git_metadata_unavailable" })
    return result
  }
  cwd = top.data.toString("utf8").trim()
  const config = git(["config", "--null", "--get-regexp", CONFIG_KEYS])
  const index = git(["ls-files", "--stage", "-z"])
  const ignored = git(["ls-files", "--cached", "--ignored", "--exclude-standard", "-z"])
  if (![0, 1].includes(config.status) || index.status !== 0 || ignored.status !== 0) {
    result.findings.push({ code: "git_metadata_unavailable" })
    return result
  }
  const values = configuration(config.data)
  result.repository.has_origin = values.has("remote.origin.url")
  result.repository.partial = values.has("extensions.partialclone") || [...values].some(([key, value]) => key.endsWith(".promisor") && /^(?:true|yes|on|1)$/iu.test(value))
  result.repository.sparse = /^(?:true|yes|on|1)$/iu.test(values.get("core.sparsecheckout") ?? "")
  const filters = ["clean", "smudge", "process", "required"].map((key) => values.get(`filter.lfs.${key}`))
  result.configuration.filters = filters.every((value) => value === undefined) ? "unconfigured"
    : /^(?:git-lfs|git lfs) clean -- %f$/u.test(filters[0] ?? "") && /^(?:git-lfs|git lfs) smudge -- %f$/u.test(filters[1] ?? "") && /^(?:git-lfs|git lfs) filter-process$/u.test(filters[2] ?? "") && /^(?:true|yes|on|1)$/iu.test(filters[3] ?? "") ? "standard" : "custom_or_incomplete"
  result.configuration.skip_smudge = /^(?:true|yes|on|1)$/iu.test(env.GIT_LFS_SKIP_SMUDGE ?? "") || filters.some((value) => value?.includes("--skip"))
  result.configuration.custom_storage = values.has("lfs.storage")
  const common = git(["rev-parse", "--git-common-dir"])
  const rawCommon = common.data.toString("utf8").trim()
  const commonDir = common.status === 0 && rawCommon !== "" ? path.isAbsolute(rawCommon) ? rawCommon : `${cwd}${path.sep}${rawCommon}` : null
  const hooks = values.get("core.hookspath")
  result.configuration.hooks.location = hooks === undefined ? "default" : "custom"
  if (hooks === undefined && commonDir !== null) result.configuration.hooks.pre_push = safeStat(commonDir, "hooks/pre-push").state
  else if (hooks !== undefined) {
    const rel = relativePath(hooks)
    result.configuration.hooks.pre_push = rel === null ? "not_checked_external" : safeStat(cwd, `${rel}/pre-push`).state
  }
  if (performance.now() < budget.deadline) {
    const tool = spawn("git-lfs", ["version"], { cwd, env: gitEnv, windowsHide: true, timeout: Math.max(1, Math.min(1000, Math.ceil(budget.deadline - performance.now()))), killSignal: "SIGKILL", maxBuffer: 4096 })
    const version = /^git-lfs\/(\d+\.\d+\.\d+)(?:\s|$)/u.exec(String(tool.stdout ?? ""))
    result.tool = tool.error?.code === "ENOENT" ? { state: "missing" } : tool.status === 0 && version !== null ? { state: "available", version: version[1] } : { state: "unavailable" }
  }
  const ignoredPaths = new Set(ignored.data.toString("utf8").split("\0"))
  const entries = []
  for (const line of index.data.toString("utf8").split("\0")) {
    if (line === "") continue
    const match = /^([0-7]{6}) ([a-f0-9]{40,64}) ([0-3])\t([\s\S]*)$/u.exec(line)
    if (match === null || relativePath(match[4]) === null) {
      result.findings.push({ code: "index_entry_unreadable" })
      continue
    }
    entries.push({ mode: match[1], oid: match[2], stage: match[3], path: match[4] })
  }
  if (entries.length > LIMITS.paths) result.findings.push({ code: "path_limit", total: entries.length })
  const scoped = entries.slice(0, LIMITS.paths)
  const skipped = (entry) => ignoredPaths.has(entry.path) ? "ignored" : sensitivePath(entry.path) ? "sensitive_path"
    : entry.mode !== "100644" && entry.mode !== "100755" || entry.stage !== "0" ? "non_regular_or_unmerged" : null
  const read = (file) => sensitivePath(file) ? { state: "sensitive_path" } : readLocal(cwd, file, budget, { prefix: true })
  result.repository.package_roots = packageRoots(scoped, (file) => ignoredPaths.has(file) ? { state: "ignored" } : read(file), result.findings)
  const isPackage = (file) => result.repository.package_roots.some((root) => root === "" || file === root || file.startsWith(`${root}/`))
  const shared = entries.some((entry) => entry.path.startsWith("desks/"))
  const personal = entries.some((entry) => entry.path.startsWith("_meta/")) && entries.some((entry) => entry.path.startsWith("_archive/"))
  result.repository.kind = isPackage("") ? "package" : shared || personal ? "context" : "unknown"
  result.repository.context = shared ? "shared" : personal ? "personal" : "unknown"
  const attributePaths = scoped.filter((entry) => skipped(entry) === null).map((entry) => entry.path)
  const attrs = git(["check-attr", "-z", "--stdin", ...ATTRIBUTES], Buffer.from(attributePaths.join("\0") + (attributePaths.length > 0 ? "\0" : "")))
  const byPath = new Map()
  if (attrs.status === 0) {
    const parts = attrs.data.toString("utf8").split("\0")
    for (let i = 0; i + 2 < parts.length; i += 3) {
      if (!byPath.has(parts[i])) byPath.set(parts[i], {})
      byPath.get(parts[i])[parts[i + 1]] = attributeValue(parts[i + 2])
    }
  } else result.findings.push({ code: "attributes_unavailable" })
  const blobs = new Map()
  const blob = (entry) => {
    if (sensitivePath(entry.path)) return { state: "sensitive_path" }
    if (blobs.has(entry.oid)) return blobs.get(entry.oid)
    const size = git(["cat-file", "-s", entry.oid])
    const count = Number(size.data.toString("utf8").trim())
    let value = { state: "not_checked_limit" }
    if (size.status !== 0 || !Number.isSafeInteger(count) || count < 0) value = { state: "unavailable" }
    else if (count <= LIMITS.prefix_bytes && count <= budget.bytes) {
      const contents = git(["cat-file", "blob", entry.oid])
      if (contents.status === 0 && contents.data.length === count) {
        budget.bytes -= count
        value = { state: "read", data: contents.data }
      } else value = { state: "unavailable" }
    }
    blobs.set(entry.oid, value)
    return value
  }
  for (const entry of scoped) {
    const file = { path: entry.path, inspection: "inspected", attributes: byPath.get(entry.path) ?? { filter: "unknown", diff: "unknown", merge: "unknown", text: "unknown" }, tracking: "unknown", format: "unknown", proposal: "none", local_object: "not_applicable", materialization: "not_checked" }
    result.files.push(file)
    const excluded = skipped(entry)
    if (excluded !== null) {
      file.inspection = excluded
      continue
    }
    const indexed = blob(entry)
    const local = read(entry.path)
    const pointer = indexed.state === "read" ? pointerOf(indexed.data) : null
    const extension = path.posix.extname(entry.path).slice(1).toLowerCase()
    file.format = EXTENSIONS.has(extension) ? "context_binary" : (indexed.data ?? local.data)?.includes(0) ? "unknown_binary" : "not_identified_as_binary"
    file.tracking = pointer?.invalid ? "invalid_pointer" : pointer !== null ? "lfs_pointer" : indexed.state === "unavailable" ? "unknown" : "ordinary_git"
    if (pointer !== null && !pointer.invalid) {
      file.pointer = pointer
      file.materialization = local.state !== "read" ? local.state
        : local.size === indexed.data.length && local.data.equals(indexed.data) ? "pointer"
          : readLocal(cwd, entry.path, budget, { expected: pointer }).state
      const cache = `lfs/objects/${pointer.oid.slice(0, 2)}/${pointer.oid.slice(2, 4)}/${pointer.oid}`
      file.local_object = values.has("lfs.storage") ? "not_checked_custom_storage" : commonDir === null ? "unknown" : readLocal(commonDir, cache, budget, { expected: pointer }).state
    } else if (pointer?.invalid) result.findings.push({ code: "invalid_pointer", path: entry.path })
    if (isPackage(entry.path)) file.proposal = "package_exempt"
    else if (result.findings.some((finding) => ["path_limit", "package_declaration_invalid", "package_declaration_unreadable", "index_entry_unreadable"].includes(finding.code))) file.proposal = "review_incomplete_inventory"
    else if (["unset", "set"].includes(file.attributes.filter) || ATTRIBUTES.some((attribute) => ["custom", "unknown"].includes(file.attributes[attribute]))) file.proposal = "review_existing_policy"
    else if (file.tracking === "ordinary_git" && local.state !== "read") file.proposal = "review_worktree_state"
    else if (file.tracking === "ordinary_git" && file.format === "context_binary") file.proposal = result.repository.kind === "context" ? "track_exact_path" : "review_repository_scope"
    else if (file.tracking === "ordinary_git" && file.format === "unknown_binary") file.proposal = "review_exact_path"
    if (indexed.state === "unavailable") result.findings.push({ code: "index_blob_unavailable", path: entry.path })
    if (local.state !== "read") result.findings.push({ code: `worktree_${local.state}`, path: entry.path })
  }
  if (performance.now() >= budget.deadline || budget.bytes <= 0) result.findings.push({ code: "inspection_limit" })
  result.state = result.findings.length > 0 ? "limited" : "inspected"
  return result
}
