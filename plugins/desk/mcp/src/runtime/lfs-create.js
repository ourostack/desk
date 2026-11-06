import { createHash } from "node:crypto"
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, realpathSync, writeFileSync } from "node:fs"
import * as path from "node:path"
import { spawnSync } from "node:child_process"
import { EXACT, sameFile } from "../util/file-identity.js"

const HOOKS = ["post-checkout", "post-commit", "post-merge", "pre-push"]
const FILTERS = { clean: "git-lfs clean -- %f", smudge: "git-lfs smudge -- %f", process: "git-lfs filter-process", required: "true" }
const QUALIFICATION = { remote_availability: "not_checked", authentication: "not_checked", budget: "not_checked", upload: "not_checked", cold_consumer: "not_checked" }
const ATTRIBUTES = "# Local PDF/PNG context storage; package payloads remain ordinary Git.\n*.[pP][dD][fF] filter=lfs diff=lfs merge=lfs -text\n*.[pP][nN][gG] filter=lfs diff=lfs merge=lfs -text\n/plugins/**/*.[pP][dD][fF] -filter -diff -merge -text\n/plugins/**/*.[pP][nN][gG] -filter -diff -merge -text\n"
const POLICY_KEYS = "^(core\\.(hookspath|worktree|bare|attributesfile)|init\\.templatedir|filter\\.lfs\\.|lfs\\.(storage|url|pushurl|extension\\.)|extensions\\.|remote\\.)"
const PROBES = ["work/task/report.pdf", "work/task/image.png", "plugins/tool/report.pdf", "plugins/tool/image.png"]

class Stopped extends Error {
  constructor(code) { super(code); this.code = code }
}
const stop = (code) => { throw new Stopped(code) }
const hash = (value) => createHash("sha256").update(value).digest("hex")
const identity = (stat) => ({ dev: stat.dev.toString(), ino: stat.ino.toString(), mode: stat.mode.toString() })
const effects = () => ({ root: "not_created", git: "not_attempted", filters: "not_attempted", hooks: "not_attempted", attributes: "not_attempted" })

function ownedBytes(file, limit, expected = null) {
  const before = lstatSync(file, EXACT)
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size > BigInt(limit)) stop("unsafe_metadata")
  if (expected !== null && (!sameFile(before, expected) || before.mode !== expected.mode)) stop("identity_changed")
  let fd
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW)
    if (!sameFile(fstatSync(fd, EXACT), before)) stop("identity_changed")
    const data = Buffer.alloc(Number(before.size) + 1)
    let length = 0
    while (length < data.length) {
      const read = readSync(fd, data, length, data.length - length, length)
      if (read === 0) break
      length += read
    }
    const after = fstatSync(fd, EXACT)
    const current = lstatSync(file, EXACT)
    if (BigInt(length) !== before.size || after.size !== before.size || after.mtimeNs !== before.mtimeNs || current.isSymbolicLink() || !sameFile(current, before)) stop("metadata_changed")
    return { data: data.subarray(0, length), stat: after }
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

function report(repo) {
  return {
    schema_version: 1, action: "create", state: "refused", repo, bound: false,
    effects: effects(), qualification: { ...QUALIFICATION }, publication: "pending_destination_qualification",
    supported_formats: ["pdf", "png"],
    custody: "The creating caller is the sole cooperating writer until handoff; this is not an OS security fence.",
    future_package_roots: "require_attribute_review_before_staging",
  }
}

function preflightNext(reason) {
  if (reason === "lfs_unavailable") return "Use an already available supported Git LFS client in this process's PATH, then read a fresh plan. This operation does not install software or create an ordinary-Git fallback."
  if (reason === "relative_configuration_source") return "Preserve the inherited environment and policy. Qualify its absolute source through the established provider; this operation will not silently rebase, discard or replace a relative configuration source."
  if (reason === "command_specific_configuration") return "The command-only Git configuration override cannot establish a shared policy context. Preserve it and use the owner's complete, qualified source stack; this operation will not ignore it or create a root."
  if (reason === "already_exists") return "Preserve the existing path and its owner. This creator cannot adopt, convert, recreate or delete it."
  if (["parent_unavailable", "unsafe_path", "invalid_new_path"].includes(reason)) return "Verify the selected absent path and its existing canonical parent with read-only checks. Do not replace symlinked parents or recursively create them."
  return "Inspect the named prerequisite and inherited Git policy locally. Preserve it and use its established owner-supported path; do not unset policy, force installation or initialize ordinary Git as a fallback."
}

function chain(directory) {
  if (!path.isAbsolute(directory) || path.resolve(directory) !== directory) stop("unsafe_path")
  let current = path.parse(directory).root
  const found = []
  for (const part of ["", ...directory.slice(current.length).split(path.sep).filter(Boolean)]) {
    if (part !== "") current = path.join(current, part)
    const stat = lstatSync(current, EXACT)
    if (!stat.isDirectory() || stat.isSymbolicLink()) stop("unsafe_path")
    found.push({ path: current, stat })
  }
  if (realpathSync(directory) !== directory) stop("unsafe_path")
  return found
}

function assertChain(record) {
  for (const entry of record) {
    let stat
    try { stat = lstatSync(entry.path, EXACT) } catch { stop("identity_changed") }
    if (!stat.isDirectory() || stat.isSymbolicLink() || !sameFile(stat, entry.stat) || stat.mode !== entry.stat.mode) stop("identity_changed")
  }
}

function absent(target) {
  try { lstatSync(target, EXACT) } catch (error) {
    if (error.code === "ENOENT") return
    throw error
  }
  stop("already_exists")
}

function environment(env) {
  const result = { ...env, GIT_TERMINAL_PROMPT: "0", GIT_NO_LAZY_FETCH: "1", GIT_OPTIONAL_LOCKS: "0", GIT_ALLOW_PROTOCOL: "", GIT_PROTOCOL_FROM_USER: "0", GIT_LFS_SKIP_SMUDGE: "1" }
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_ATTR_SOURCE", "GIT_NAMESPACE", "GIT_PREFIX"]) delete result[key]
  return result
}

function configurationContext(env) {
  if (env.GIT_CONFIG !== undefined) stop("command_specific_configuration")
  const sources = ["GIT_CONFIG_GLOBAL", "HOME", "XDG_CONFIG_HOME"]
  if (!/^(?:true|yes|on|1)$/iu.test(env.GIT_CONFIG_NOSYSTEM ?? "")) sources.push("GIT_CONFIG_SYSTEM")
  // Git -C and native LFS use different working directories; source filenames must not change meaning between them.
  for (const key of sources) {
    const value = env[key]
    if (value !== undefined && value !== "" && (typeof value !== "string" || !path.isAbsolute(value))) stop("relative_configuration_source")
  }
}

function runner({ repo, parent, env, spawn }) {
  const deadline = performance.now() + 30_000
  const options = { env: environment(env), windowsHide: true, encoding: "utf8", killSignal: "SIGKILL", maxBuffer: 1024 * 1024 }
  const invoke = (command, args, extra = {}) => {
    const remaining = Math.ceil(deadline - performance.now())
    if (remaining <= 0) stop("operation_timeout")
    return spawn(command, args, { ...options, ...extra, timeout: Math.min(10_000, remaining) })
  }
  const git = (args) => invoke("git", [
    "-c", "core.fsmonitor=false", "-c", "protocol.allow=never", "-c", "attr.tree=",
    "-C", parent,
    `--git-dir=${path.join(repo, ".git")}`, `--work-tree=${repo}`,
    ...args,
  ])
  const lfs = (args, cwd = repo) => invoke("git-lfs", args, { cwd })
  return { git, lfs }
}

function config(answer) {
  if (answer.error || ![0, 1].includes(answer.status)) stop("configuration_unavailable")
  const values = new Map()
  for (const line of String(answer.stdout ?? "").split("\0")) {
    const at = line.indexOf("\n")
    if (at > 0) values.set(line.slice(0, at).toLowerCase(), line.slice(at + 1))
  }
  return values
}

function readPolicy(run) {
  const values = config(run.git(["config", "--includes", "--null", "--get-regexp", POLICY_KEYS]))
  if (values.has("core.hookspath")) stop("inherited_hooks_path")
  if (values.has("init.templatedir")) stop("inherited_template_policy")
  if (values.has("core.worktree") || [...values.keys()].some((key) => key.startsWith("remote.")) || /^(?:true|yes|on|1)$/iu.test(values.get("core.bare") ?? "")) stop("inherited_repository_policy")
  if (values.has("core.attributesfile") || [...values.keys()].some((key) => key.startsWith("lfs.") || key.startsWith("extensions."))) stop("inherited_storage_policy")
  for (const [key, value] of values) {
    if (key.startsWith("filter.lfs.") && FILTERS[key.slice("filter.lfs.".length)] !== value) stop("conflicting_filter_policy")
  }
  return values
}

function templateSnapshot(repo, allowLfsHooks = false) {
  const directory = path.join(repo, ".git")
  const files = []
  const inspect = (rel) => {
    const file = path.join(directory, rel)
    if (files.length >= 64) stop("template_policy_unsupported")
    let stat
    try { stat = lstatSync(file, EXACT) } catch (error) {
      if (error.code === "ENOENT") return
      throw error
    }
    if (stat.isSymbolicLink()) stop("template_policy_unsupported")
    if (stat.isDirectory()) {
      files.push({ path: rel, identity: identity(stat) })
      for (const name of readdirSync(file).sort()) {
        const nested = `${rel}/${name}`
        if (rel === "hooks" && allowLfsHooks && HOOKS.includes(name)) continue
        if (!(rel === "hooks" && name.endsWith(".sample") || nested === "info/exclude")) stop("template_policy_unsupported")
        inspect(nested)
      }
    } else {
      if (!stat.isFile() || stat.nlink !== 1n || stat.size > 65536n) stop("template_policy_unsupported")
      files.push({ path: rel, identity: identity(stat), hash: hash(ownedBytes(file, 65536, stat).data) })
    }
  }
  for (const name of readdirSync(directory)) {
    if (!["HEAD", "config", "description", "hooks", "info", "objects", "refs", "branches", "lfs"].includes(name)) stop("template_policy_unsupported")
    if (name === "lfs" && !allowLfsHooks) stop("template_policy_unsupported")
    if (["HEAD", "config", "objects", "refs", "branches"].includes(name)) {
      const file = path.join(directory, name)
      const stat = lstatSync(file, EXACT)
      if (stat.isSymbolicLink()) stop("template_policy_unsupported")
      if (["HEAD", "config"].includes(name) && (!stat.isFile() || stat.nlink !== 1n)) stop("template_policy_unsupported")
      if (["objects", "refs", "branches"].includes(name)) {
        if (!stat.isDirectory()) stop("template_policy_unsupported")
        files.push({ path: name, identity: identity(stat) })
        const allowed = name === "objects" ? ["info", "pack"] : name === "refs" ? ["heads", "tags"] : []
        for (const child of readdirSync(file).sort()) {
          const nested = path.join(file, child)
          const childStat = lstatSync(nested, EXACT)
          if (!allowed.includes(child) || !childStat.isDirectory() || childStat.isSymbolicLink() || readdirSync(nested).length !== 0) stop("template_policy_unsupported")
          files.push({ path: `${name}/${child}`, identity: identity(childStat) })
        }
      }
    }
  }
  for (const name of ["description", "hooks", "info"]) inspect(name)
  return files
}

function probeAttributes(run, required = false) {
  const answer = run.git(["check-attr", "-z", "filter", "diff", "merge", "text", "--", ...PROBES])
  if (answer.error || answer.status !== 0) {
    if (required) stop("attributes_unavailable")
    return null
  }
  const parts = String(answer.stdout ?? "").split("\0")
  const values = {}
  for (let i = 0; i + 2 < parts.length; i += 3) {
    if (!values[parts[i]]) values[parts[i]] = {}
    values[parts[i]][parts[i + 1]] = parts[i + 2]
  }
  return values
}

function compatibleAttributes(values) {
  if (values === null) return
  for (const [file, attrs] of Object.entries(values)) {
    const compatible = file.startsWith("plugins/") ? ["unspecified", "lfs", "unset"] : ["unspecified", "lfs"]
    for (const key of ["filter", "diff", "merge"]) if (!compatible.includes(attrs[key])) stop("conflicting_attribute_policy")
    if (!["unspecified", "unset", "auto"].includes(attrs.text)) stop("conflicting_attribute_policy")
  }
}

function prepare({ repo, env = process.env, spawn = spawnSync } = {}) {
  const result = report(typeof repo === "string" ? repo : null)
  try {
    if (process.platform === "win32" || typeof constants.O_NOFOLLOW !== "number") stop("unsupported_platform")
    if (typeof repo !== "string" || !path.isAbsolute(repo) || path.resolve(repo) !== repo || repo === path.parse(repo).root) stop("invalid_new_path")
    absent(repo)
    const parent = path.dirname(repo)
    const parents = chain(parent)
    const inheritedEnv = { ...env }
    configurationContext(inheritedEnv)
    if (inheritedEnv.GIT_TEMPLATE_DIR !== undefined) stop("inherited_template_policy")
    if (inheritedEnv.GIT_DEFAULT_HASH && inheritedEnv.GIT_DEFAULT_HASH !== "sha1" || inheritedEnv.GIT_DEFAULT_REF_FORMAT && inheritedEnv.GIT_DEFAULT_REF_FORMAT !== "files") stop("inherited_repository_policy")
    const run = runner({ repo, parent, env: inheritedEnv, spawn })
    const version = run.lfs(["version"], parent)
    const client = /^git-lfs\/(\d+\.\d+\.\d+)(?:\s|$)/u.exec(String(version.stdout ?? ""))
    if (version.error || version.status !== 0 || client === null) stop("lfs_unavailable")
    const policy = readPolicy(run)
    const attributes = probeAttributes(run)
    compatibleAttributes(attributes)
    absent(repo)
    result.plan = {
      parent_identity: identity(parents[parents.length - 1].stat),
      lfs_client: client[1],
      configuration_scope: "new_repository_only",
      initial_branch: "main",
      inherited_attributes: attributes === null ? "not_checked_until_git_init" : "compatible_local_metadata",
      filters: { ...FILTERS }, hooks: [...HOOKS], attributes: ATTRIBUTES,
      template_policy: "configured_sources_refused; native_default_checked_after_init_before_lfs",
      stages_or_commits: false, creates_remote: false, binds_desk: false,
    }
    const plan = {
      repo, parents: parents.map((entry) => ({ path: entry.path, ...identity(entry.stat) })),
      policy: [...policy].sort(), inherited_attributes: attributes, proposed: result.plan,
    }
    result.state = "plan"
    result.plan_sha256 = hash(JSON.stringify(plan))
    result.next_step = "After the existing fresh-create choice, apply this exact plan under the creating caller's exclusive creation ownership."
    return { result, parents, run, repo }
  } catch (error) {
    result.reason = error instanceof Stopped ? error.code : ["ENOENT", "EACCES", "ENOTDIR"].includes(error.code) ? "parent_unavailable" : "preflight_unavailable"
    if (!(error instanceof Stopped)) result.error_code = typeof error.code === "string" && /^[A-Z0-9_]{1,40}$/u.test(error.code) ? error.code : "INTERNAL_ERROR"
    result.next_step = preflightNext(result.reason)
    return { result }
  }
}

/** Plan local creation of an absent root; never initialize a repository or install a client. */
export function planLfsDesk(options) {
  return prepare(options).result
}

/** Create only the caller's new root. Never adopt, stage, commit, bind, publish or delete a path. */
export function createLfsDesk({ expectedPlan, ...options } = {}) {
  const prepared = prepare(options)
  const result = prepared.result
  if (result.state !== "plan") return result
  if (typeof expectedPlan !== "string" || expectedPlan !== result.plan_sha256) {
    return { ...result, state: "refused", reason: "stale_plan", next_step: "Read a fresh plan before creating anything; a plan hash is not writer custody." }
  }
  const { repo, parents, run } = prepared
  let owned = null, gitDirectory = null, hookDirectory = null
  let template = null, attributesFile = null
  const hookRecords = new Map()
  let phase = "create_root"
  const ownedDirectory = (file) => {
    const stat = lstatSync(file, EXACT)
    if (!stat.isDirectory() || stat.isSymbolicLink()) stop("identity_changed")
    return [{ path: file, stat }]
  }
  const assertOwned = () => {
    assertChain(parents)
    if (owned !== null) {
      assertChain(owned)
      const allowed = new Set([
        ...(result.effects.git !== "not_attempted" ? [".git"] : []),
        ...(result.effects.attributes !== "not_attempted" ? [".gitattributes"] : []),
      ])
      if (readdirSync(repo).some((entry) => !allowed.has(entry))) stop("unexpected_root_content")
    }
    if (gitDirectory !== null) {
      assertChain(gitDirectory)
      const current = lstatSync(path.join(repo, ".git", "config"), EXACT)
      if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1n) stop("identity_changed")
    }
    if (hookDirectory !== null) assertChain(hookDirectory)
    for (const [name, expected] of hookRecords) {
      const current = ownedBytes(path.join(repo, ".git", "hooks", name), 16384, expected.stat)
      if (hash(current.data) !== expected.hash) stop("hook_changed")
    }
    if (attributesFile !== null) ownedBytes(path.join(repo, ".gitattributes"), Buffer.byteLength(ATTRIBUTES), attributesFile)
  }
  const guard = () => {
    assertOwned()
    readPolicy(run)
    if (template !== null && hash(JSON.stringify(templateSnapshot(repo, result.effects.hooks !== "not_attempted"))) !== hash(JSON.stringify(template))) stop("template_changed")
    if (gitDirectory !== null && result.effects.attributes === "not_attempted") compatibleAttributes(probeAttributes(run, true))
    assertOwned()
  }
  const successful = (answer, code) => {
    if (answer.error || answer.status !== 0) stop(code)
  }
  try {
    guard()
    absent(repo)
    try { mkdirSync(repo, { recursive: false, mode: 0o700 }) } catch (error) {
      if (error.code === "EEXIST") stop("already_exists")
      throw error
    }
    result.effects.root = "created"
    owned = ownedDirectory(repo)
    result.created_identity = identity(owned[0].stat)
    phase = "git_init"
    guard()
    result.effects.git = "attempted"
    successful(run.git(["init", "--quiet", "--initial-branch=main"]), "git_init_failed")
    assertChain(parents)
    assertChain(owned)
    gitDirectory = ownedDirectory(path.join(repo, ".git"))
    // Preserve native initialization policy; reject unsupported copied policy before any LFS changes.
    template = templateSnapshot(repo)
    guard()
    try { hookDirectory = ownedDirectory(path.join(repo, ".git", "hooks")) } catch (error) {
      if (error.code !== "ENOENT") throw error
      guard()
      mkdirSync(path.join(repo, ".git", "hooks"), { recursive: false, mode: 0o755 })
      hookDirectory = ownedDirectory(path.join(repo, ".git", "hooks"))
      template = templateSnapshot(repo)
    }
    compatibleAttributes(probeAttributes(run, true))
    result.effects.git = "verified"

    phase = "local_filters"
    guard()
    result.effects.filters = "attempted"
    successful(run.lfs(["install", "--local", "--skip-repo"]), "local_filters_failed")
    guard()
    const local = config(run.git(["config", "--local", "--null", "--get-regexp", "^filter\\.lfs\\."]))
    if (!Object.entries(FILTERS).every(([key, value]) => local.get(`filter.lfs.${key}`) === value)) stop("filter_readback_failed")
    result.effects.filters = "verified"

    phase = "local_hooks"
    guard()
    if (readdirSync(path.join(repo, ".git", "hooks")).some((file) => !file.endsWith(".sample"))) stop("conflicting_hook_policy")
    result.effects.hooks = "attempted"
    successful(run.lfs(["update"]), "local_hooks_failed")
    guard()
    const activeHooks = readdirSync(path.join(repo, ".git", "hooks")).filter((file) => !file.endsWith(".sample")).sort()
    if (JSON.stringify(activeHooks) !== JSON.stringify(HOOKS)) stop("hook_readback_failed")
    const hookHashes = {}
    for (const hook of HOOKS) {
      const file = path.join(repo, ".git", "hooks", hook)
      const stat = lstatSync(file, EXACT)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || stat.size > 16384n || (stat.mode & 0o111n) === 0n) stop("hook_readback_failed")
      const current = ownedBytes(file, 16384, stat)
      const text = current.data.toString("utf8")
      if (!text.startsWith("#!/bin/sh\n") || !text.endsWith(`git lfs ${hook} "$@"\n`)) stop("hook_readback_failed")
      hookHashes[hook] = hash(current.data)
      hookRecords.set(hook, { stat: current.stat, hash: hookHashes[hook] })
    }
    result.effects.hooks = "verified"

    phase = "attributes"
    guard()
    result.effects.attributes = "attempted"
    let fd
    try {
      fd = openSync(path.join(repo, ".gitattributes"), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644)
      if (!fstatSync(fd, EXACT).isFile()) stop("attribute_write_failed")
      writeFileSync(fd, ATTRIBUTES)
      attributesFile = fstatSync(fd, EXACT)
    } finally {
      if (fd !== undefined) closeSync(fd)
    }
    guard()
    const attrs = probeAttributes(run, true)
    for (const file of PROBES) {
      const expected = file.startsWith("plugins/") ? "unset" : "lfs"
      if (!attrs[file] || !["filter", "diff", "merge"].every((key) => attrs[file][key] === expected) || attrs[file].text !== "unset") stop("attribute_readback_failed")
    }
    if (ownedBytes(path.join(repo, ".gitattributes"), Buffer.byteLength(ATTRIBUTES), attributesFile).data.toString("utf8") !== ATTRIBUTES) stop("attribute_readback_failed")
    result.effects.attributes = "verified"
    result.state = "configured_local"
    result.phase = "local_readback"
    result.readback = { attributes_sha256: hash(ATTRIBUTES), hooks_sha256: hookHashes, local_filters: "verified" }
    result.next_step = "Return the still-unbound root to the fresh-bootstrap owner for the ordinary scaffold/initial contribution. Binary publication remains pending selected-destination availability, policy and transfer qualification."
  } catch (error) {
    result.state = result.effects.root === "created" ? "partial" : "refused"
    result.reason = error instanceof Stopped ? error.code : "local_creation_failed"
    if (!(error instanceof Stopped)) result.error_code = typeof error.code === "string" && /^[A-Z0-9_]{1,40}$/u.test(error.code) ? error.code : "INTERNAL_ERROR"
    result.phase = phase
    if (result.effects.root === "created") {
      let matched = false
      try {
        assertChain(parents)
        if (owned !== null) { assertChain(owned); matched = true }
      } catch {
        matched = false
      }
      result.recovery = { owner: "creating_caller", path_identity: matched ? "matched" : "changed_or_unverified", action: "retain_created_root_unbound; inspect exact effects; do not recreate or delete it" }
      result.next_step = "Stop before binding or publication. Preserve the partial root and any newer content for the creating caller's recovery; repeating create must refuse the existing path."
    } else {
      result.next_step = "No root was acquired. Preserve the existing path or competing creator's work; do not adopt, recreate or delete it."
    }
  }
  return result
}
