import { test } from "node:test"
import { strict as assert } from "node:assert"
import { createHash } from "node:crypto"
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, renameSync, symlinkSync, writeFileSync } from "node:fs"
import * as path from "node:path"
import { spawn, spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { deflateSync } from "node:zlib"
import { mkTempRoot } from "../_temp_roots.js"

let planLfsDesk, createLfsDesk
try {
  ;({ planLfsDesk, createLfsDesk } = await import("../../../../../plugins/desk/mcp/src/runtime/lfs-create.js"))
} catch (error) {
  if (error.code !== "ERR_MODULE_NOT_FOUND") throw error
}
const cli = fileURLToPath(new URL("../../../../../plugins/desk/mcp/scripts/lfs.js", import.meta.url))
const digest = (data) => createHash("sha256").update(data).digest("hex")
function pdfFixture() {
  const stream = "BT /F1 12 Tf 20 40 Td (Synthetic storage fixture) Tj ET\n"
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`,
  ]
  let text = "%PDF-1.4\n"
  const offsets = []
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(text))
    text += `${index + 1} 0 obj\n${object}\nendobj\n`
  }
  const xref = Buffer.byteLength(text)
  text += `xref\n0 6\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(text)
}

function pngFixture() {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data])
    let crc = 0xffffffff
    for (const byte of body) {
      crc ^= byte
      for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0)
    }
    const result = Buffer.alloc(data.length + 12)
    result.writeUInt32BE(data.length)
    body.copy(result, 4)
    result.writeUInt32BE((crc ^ 0xffffffff) >>> 0, result.length - 4)
    return result
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(1, 0)
  header.writeUInt32BE(1, 4)
  header[8] = 8
  header[9] = 6
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(Buffer.from([0, 17, 34, 51, 255]))), chunk("IEND", Buffer.alloc(0))])
}

const pdf = pdfFixture()
const png = pngFixture()
const hooks = ["post-checkout", "post-commit", "post-merge", "pre-push"]

function write(file, data) {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, data)
}

async function fixture() {
  const base = await mkTempRoot("lfs-create-")
  const home = path.join(base, "home")
  const parent = path.join(base, "parent")
  mkdirSync(home)
  mkdirSync(parent)
  const env = {
    ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, "config"),
    GIT_CONFIG_GLOBAL: path.join(home, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1",
  }
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_TEMPLATE_DIR", "GIT_CONFIG", "GIT_CONFIG_SYSTEM", "GIT_CONFIG_COUNT", "GIT_CONFIG_PARAMETERS", "GIT_ATTR_SOURCE"]) delete env[key]
  return { base, home, parent, repo: path.join(parent, "new-desk"), env }
}

function git(ctx, args, cwd = ctx.parent) {
  const result = spawnSync("git", args, { cwd, env: ctx.env, encoding: "utf8", timeout: 10_000, killSignal: "SIGKILL" })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.trim()
}

function plan(ctx, options = {}) {
  assert.equal(typeof planLfsDesk, "function", "the read-only new-desk planning API is missing")
  return planLfsDesk({ repo: ctx.repo, env: ctx.env, ...options })
}

function create(ctx, planned = plan(ctx), options = {}) {
  assert.equal(typeof createLfsDesk, "function", "the owned new-desk creator API is missing")
  assert.equal(planned.state, "plan", JSON.stringify(planned))
  return createLfsDesk({ repo: ctx.repo, env: ctx.env, expectedPlan: planned.plan_sha256, ...options })
}

function snapshot(root) {
  const files = {}
  const walk = (dir, prefix = "") => {
    for (const name of readdirSync(dir).sort()) {
      const rel = `${prefix}${name}`
      const file = path.join(dir, name)
      const stat = lstatSync(file)
      files[rel] = { mode: stat.mode, ...(stat.isSymbolicLink() ? { link: readlinkSync(file) } : stat.isFile() ? { hash: digest(readFileSync(file)) } : {}) }
      if (stat.isDirectory()) walk(file, `${rel}/`)
    }
  }
  walk(root)
  return files
}

const posix = (t) => {
  if (process.platform !== "win32") return true
  t.skip("initial creator qualification is POSIX only")
  return false
}

test("GivenAbsentGitDirectory_WhenReadingConfiguration_GitResolvesInheritedPolicyWithoutCreatingIt", async () => {
  const ctx = await fixture()
  git(ctx, ["config", "--global", "core.hooksPath", "custom-hooks"])
  const result = spawnSync("git", [`--git-dir=${path.join(ctx.repo, ".git")}`, "config", "--null", "--get-regexp", "^core\\.hookspath$"], { cwd: ctx.parent, env: ctx.env, encoding: "utf8" })
  assert.equal(result.status, 0, result.stderr)
  assert.ok(result.stdout.includes("custom-hooks"))
  assert.equal(existsSync(ctx.repo), false)
})

test("GivenAbsentRoot_WhenPlanned_LeavesAllBytesUnchangedAndRemoteGatesUnchecked", async (t) => {
  if (!posix(t)) return
  const ctx = await fixture()
  const before = snapshot(ctx.base)
  const result = plan(ctx)
  assert.equal(result.state, "plan")
  assert.match(result.plan_sha256, /^[a-f0-9]{64}$/u)
  assert.equal(result.bound, false)
  assert.deepEqual(result.qualification, {
    remote_availability: "not_checked", authentication: "not_checked", budget: "not_checked", upload: "not_checked", cold_consumer: "not_checked",
  })
  assert.deepEqual(snapshot(ctx.base), before)
  assert.equal(plan(ctx).plan_sha256, result.plan_sha256)
})

for (const selector of ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM", "GIT_CONFIG"]) {
  test(`GivenRelative${selector}_WhenCreating_RefusesBeforeAnyExternalHookOrRootWrite`, async (t) => {
    if (!posix(t)) return
    const ctx = await fixture()
    const external = path.join(ctx.base, "external-hooks")
    write(path.join(external, "keep.txt"), "preserve external policy\n")
    write(path.join(ctx.base, "policy.gitconfig"), "[user]\n\tname = Safe Reader Context\n")
    write(path.join(ctx.parent, "policy.gitconfig"), `[core]\n\thooksPath = ${external}\n`)
    const env = { ...ctx.env, [selector]: "../policy.gitconfig" }
    if (selector === "GIT_CONFIG_SYSTEM") delete env.GIT_CONFIG_NOSYSTEM
    const before = snapshot(external)
    const planned = plan(ctx, { env })
    const result = createLfsDesk({ repo: ctx.repo, env, expectedPlan: planned.plan_sha256 ?? "0".repeat(64) })
    const added = Object.keys(snapshot(external)).filter((name) => !Object.hasOwn(before, name))
    assert.deepEqual({
      plan_state: planned.state, create_state: result.state, root_exists: existsSync(ctx.repo), external_added: added,
    }, { plan_state: "refused", create_state: "refused", root_exists: false, external_added: [] })
    assert.deepEqual(snapshot(external), before)
    assert.equal(result.recovery, undefined)
  })
}

for (const selector of ["HOME", "XDG_CONFIG_HOME"]) {
  test(`GivenRelative${selector}PolicyOrigin_WhenCreating_RefusesBeforeCreation`, async (t) => {
    if (!posix(t)) return
    const ctx = await fixture()
    const external = path.join(ctx.base, "external-hooks")
    write(path.join(external, "keep.txt"), "preserve\n")
    const relative = selector === "HOME" ? "../relative-home" : "../relative-xdg"
    const suffix = selector === "HOME" ? ".gitconfig" : path.join("git", "config")
    write(path.join(ctx.base, relative.slice(3), suffix), "[user]\n\tname = Safe Reader Context\n")
    write(path.join(ctx.parent, relative.slice(3), suffix), `[core]\n\thooksPath = ${external}\n`)
    const env = { ...ctx.env, [selector]: relative }
    delete env.GIT_CONFIG_GLOBAL
    const before = snapshot(external)
    const planned = plan(ctx, { env })
    const result = createLfsDesk({ repo: ctx.repo, env, expectedPlan: planned.plan_sha256 ?? "0".repeat(64) })
    assert.deepEqual({
      plan_state: planned.state, create_state: result.state, root_exists: existsSync(ctx.repo),
      external_added: Object.keys(snapshot(external)).filter((name) => !Object.hasOwn(before, name)),
    }, { plan_state: "refused", create_state: "refused", root_exists: false, external_added: [] })
    assert.deepEqual(snapshot(external), before)
  })
}

test("GivenAbsoluteCommandOnlyConfigSelector_WhenPlanning_DoesNotMaskInheritedPolicy", async (t) => {
  if (!posix(t)) return
  const ctx = await fixture()
  const external = path.join(ctx.base, "external-hooks")
  write(path.join(external, "keep.txt"), "preserve\n")
  write(ctx.env.GIT_CONFIG_GLOBAL, `[core]\n\thooksPath = ${external}\n`)
  const safe = path.join(ctx.home, "safe-command-config")
  write(safe, "[user]\n\tname = Command-Only Context\n")
  const before = snapshot(ctx.base)
  assert.equal(plan(ctx, { env: { ...ctx.env, GIT_CONFIG: safe } }).state, "refused")
  assert.equal(existsSync(ctx.repo), false)
  assert.deepEqual(snapshot(ctx.base), before)
})

for (const selector of ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM"]) {
  test(`GivenAbsolute${selector}WithRelativeInclude_WhenPlanning_PreservesFileRelativePolicy`, async (t) => {
    if (!posix(t)) return
    const ctx = await fixture()
    const external = path.join(ctx.base, "external-hooks")
    write(path.join(external, "keep.txt"), "preserve\n")
    const directory = path.join(ctx.home, selector.toLowerCase())
    write(path.join(directory, "config"), "[include]\n\tpath = policy.gitconfig\n")
    write(path.join(directory, "policy.gitconfig"), `[core]\n\thooksPath = ${external}\n`)
    const env = { ...ctx.env, [selector]: path.join(directory, "config") }
    if (selector === "GIT_CONFIG_SYSTEM") delete env.GIT_CONFIG_NOSYSTEM
    const before = snapshot(ctx.base)
    const result = plan(ctx, { env })
    assert.equal(result.state, "refused")
    assert.equal(result.reason, "inherited_hooks_path")
    assert.equal(existsSync(ctx.repo), false)
    assert.deepEqual(snapshot(ctx.base), before)
  })
}

test("GivenAbsoluteGlobalSourceWithSafeRelativeInclude_WhenCreating_DoesNotDiscardOrganizationPolicy", async (t) => {
  if (!posix(t)) return
  const ctx = await fixture()
  write(ctx.env.GIT_CONFIG_GLOBAL, "[include]\n\tpath = identity.gitconfig\n")
  write(path.join(ctx.home, "identity.gitconfig"), "[user]\n\tname = Included Fixture Identity\n[commit]\n\tgpgSign = true\n")
  const before = snapshot(ctx.home)
  const nativeContexts = []
  const spawn = (cmd, args, options) => {
    if (cmd === "git-lfs" && ["install", "update"].includes(args[0])) {
      const observed = spawnSync("git", ["config", "--get", "user.name"], { cwd: options.cwd, env: options.env, encoding: "utf8" })
      assert.equal(observed.status, 0)
      nativeContexts.push(observed.stdout.trim())
      assert.equal(options.env.GIT_CONFIG_GLOBAL, ctx.env.GIT_CONFIG_GLOBAL)
    }
    return spawnSync(cmd, args, options)
  }
  assert.equal(create(ctx, plan(ctx, { spawn }), { spawn }).state, "configured_local")
  assert.deepEqual(nativeContexts, ["Included Fixture Identity", "Included Fixture Identity"])
  assert.equal(git(ctx, ["-C", ctx.repo, "config", "user.name"]), "Included Fixture Identity")
  assert.equal(git(ctx, ["-C", ctx.repo, "config", "commit.gpgSign"]), "true")
  assert.deepEqual(snapshot(ctx.home), before)
})

test("GivenDisabledRelativeSystemSelector_WhenCreating_PreservesItsExplicitDisabledSemantics", async (t) => {
  if (!posix(t)) return
  const ctx = await fixture()
  const external = path.join(ctx.base, "external-hooks")
  write(path.join(external, "keep.txt"), "preserve disabled policy\n")
  write(path.join(ctx.parent, "disabled-policy.gitconfig"), `[core]\n\thooksPath = ${external}\n`)
  const before = snapshot(external)
  const env = { ...ctx.env, GIT_CONFIG_SYSTEM: "../disabled-policy.gitconfig", GIT_CONFIG_NOSYSTEM: "1" }
  assert.equal(create(ctx, plan(ctx, { env }), { env }).state, "configured_local")
  assert.deepEqual(snapshot(external), before)
})

for (const origin of ["count", "parameters"]) {
  test(`GivenCommandLineRelativeInclude${origin}_WhenPlanning_RefusesUnqualifiedInclude`, async (t) => {
    if (!posix(t)) return
    const ctx = await fixture()
    const env = origin === "count"
      ? { ...ctx.env, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "include.path", GIT_CONFIG_VALUE_0: "../policy.gitconfig" }
      : { ...ctx.env, GIT_CONFIG_PARAMETERS: "'include.path=../policy.gitconfig'" }
    const before = snapshot(ctx.base)
    const result = plan(ctx, { env })
    assert.equal(result.state, "refused")
    assert.equal(existsSync(ctx.repo), false)
    assert.deepEqual(snapshot(ctx.base), before)
  })
}

test("GivenApprovedAbsentRoot_WhenCreated_ConfiguresOnlyOwnedLocalRepository", async (t) => {
  if (!posix(t)) return
  const ctx = await fixture()
  const home = snapshot(ctx.home)
  const result = create(ctx)
  assert.equal(result.state, "configured_local", JSON.stringify(result))
  assert.equal(result.bound, false)
  assert.equal(result.effects.root, "created")
  assert.equal(result.effects.git, "verified")
  assert.equal(result.effects.filters, "verified")
  assert.equal(result.effects.hooks, "verified")
  assert.equal(result.effects.attributes, "verified")
  assert.equal(result.plan?.attributes, readFileSync(path.join(ctx.repo, ".gitattributes"), "utf8"))
  assert.deepEqual(result.plan?.hooks, hooks)
  assert.equal(result.publication, "pending_destination_qualification")
  assert.equal(git(ctx, ["-C", ctx.repo, "config", "--local", "--get", "filter.lfs.clean"]), "git-lfs clean -- %f")
  assert.equal(git(ctx, ["-C", ctx.repo, "config", "--local", "--get", "filter.lfs.process"]), "git-lfs filter-process")
  assert.deepEqual(readdirSync(path.join(ctx.repo, ".git", "hooks")).filter((name) => !name.endsWith(".sample")).sort(), hooks)
  assert.ok((lstatSync(path.join(ctx.repo, ".git", "hooks", "pre-push")).mode & 0o111) !== 0)
  assert.deepEqual(readdirSync(ctx.repo).sort(), [".git", ".gitattributes"])
  assert.equal(git(ctx, ["-C", ctx.repo, "ls-files"]), "", "creator stages or commits no files")
  assert.equal(git(ctx, ["-C", ctx.repo, "remote"]), "", "creator sets no destination")
  assert.equal(git(ctx, ["-C", ctx.repo, "symbolic-ref", "--short", "HEAD"]), "main", "the fresh Desk starts on its state channel")
  assert.deepEqual(snapshot(ctx.home), home)
  assert.deepEqual(result.qualification, plan(ctx, { repo: path.join(ctx.parent, "another-new-desk") }).qualification)
})

test("GivenCreatedRepository_WhenPdfAndPngAreFirstAdded_StoresRealPointersAndLocalObjectsWithoutChangingBytes", async (t) => {
  if (!posix(t)) return
  const ctx = await fixture()
  assert.equal(create(ctx).state, "configured_local")
  const originals = { "work/task/report.pdf": pdf, "work/task/image.png": png }
  for (const [file, data] of Object.entries(originals)) write(path.join(ctx.repo, file), data)
  write(path.join(ctx.repo, "plugins/tool/examples/image.png"), png)
  git(ctx, ["-C", ctx.repo, "add", "--", ".gitattributes", ...Object.keys(originals), "plugins/tool/examples/image.png"])
  for (const [file, data] of Object.entries(originals)) {
    const pointer = git(ctx, ["-C", ctx.repo, "show", `:${file}`])
    assert.equal(pointer, `version https://git-lfs.github.com/spec/v1\noid sha256:${digest(data)}\nsize ${data.length}`)
    assert.deepEqual(readFileSync(path.join(ctx.repo, file)), data)
    const oid = digest(data)
    assert.deepEqual(readFileSync(path.join(ctx.repo, ".git", "lfs", "objects", oid.slice(0, 2), oid.slice(2, 4), oid)), data)
  }
  const ordinary = spawnSync("git", ["-C", ctx.repo, "show", ":plugins/tool/examples/image.png"], { env: ctx.env })
  assert.equal(ordinary.status, 0)
  assert.deepEqual(ordinary.stdout, png, "plugin payload stays ordinary Git bytes")
})

test("GivenExistingRootOrPartialRoot_WhenCreateIsRepeated_RefusesWithoutAdoptingOrDeleting", async (t) => {
  if (!posix(t)) return
  const ctx = await fixture()
  const planned = plan(ctx)
  mkdirSync(ctx.repo)
  write(path.join(ctx.repo, "another-writer.txt"), "preserve this\n")
  const before = snapshot(ctx.base)
  const result = createLfsDesk({ repo: ctx.repo, env: ctx.env, expectedPlan: planned.plan_sha256 })
  assert.equal(result.state, "refused")
  assert.equal(result.reason, "already_exists")
  assert.deepEqual(snapshot(ctx.base), before)
})

test("GivenChangedParentIdentity_WhenApplyingOldPlan_RefusesBeforeCreation", async (t) => {
  if (!posix(t)) return
  const ctx = await fixture()
  const planned = plan(ctx)
  renameSync(ctx.parent, path.join(ctx.base, "old-parent"))
  mkdirSync(ctx.parent)
  const result = createLfsDesk({ repo: ctx.repo, env: ctx.env, expectedPlan: planned.plan_sha256 })
  assert.equal(result.state, "refused")
  assert.equal(result.reason, "stale_plan")
  assert.equal(existsSync(ctx.repo), false)
})

test("GivenAnotherCreatorWinsBeforeMkdir_WhenApplying_ClaimsNoRecoveryOwnership", async (t) => {
  if (!posix(t)) return
  const ctx = await fixture()
  const planned = plan(ctx)
  let created = false
  const spawn = (cmd, args, options) => {
    const result = spawnSync(cmd, args, options)
    if (!created && cmd === "git" && args.includes("check-attr")) {
      created = true
      mkdirSync(ctx.repo)
      write(path.join(ctx.repo, "theirs.txt"), "not your partial root\n")
    }
    return result
  }
  const result = create(ctx, planned, { spawn })
  assert.equal(result.state, "refused")
  assert.equal(result.reason, "already_exists")
  assert.equal(result.effects.root, "not_created")
  assert.equal(result.recovery, undefined)
  assert.deepEqual(readdirSync(ctx.repo), ["theirs.txt"])
})

test("GivenMissingLfsOrInvalidPlan_WhenCreating_DoesNotInitializeOrdinaryGitAsFallback", async (t) => {
  if (!posix(t)) return
  const ctx = await fixture()
  const missing = (cmd, args, options) => cmd === "git-lfs"
    ? { status: null, error: Object.assign(new Error("private-token"), { code: "ENOENT" }) }
    : spawnSync(cmd, args, options)
  const result = plan(ctx, { spawn: missing })
  assert.equal(result.state, "refused")
  assert.equal(result.reason, "lfs_unavailable")
  assert.equal(existsSync(ctx.repo), false)
  assert.doesNotMatch(JSON.stringify(result), /private-token/u)
  const stale = createLfsDesk({ repo: ctx.repo, env: ctx.env, expectedPlan: "0".repeat(64) })
  assert.equal(stale.state, "refused")
  assert.equal(stale.reason, "stale_plan")
  assert.equal(existsSync(ctx.repo), false)
})

test("GivenInvalidOrMissingParent_WhenPlanned_NeverFallsBackOrCreatesParents", async (t) => {
  if (!posix(t)) return
  const ctx = await fixture()
  for (const repo of [undefined, null, "", "relative-desk", path.parse(ctx.repo).root]) {
    assert.equal(planLfsDesk({ repo, env: ctx.env }).state, "refused")
  }
  const missing = path.join(ctx.parent, "absent-parent", "new-desk")
  assert.equal(plan(ctx, { repo: missing }).reason, "parent_unavailable")
  assert.equal(existsSync(path.dirname(missing)), false)
})

test("GivenInheritedRepositorySelectors_WhenCreating_NeverUsesAnotherRepository", async (t) => {
  if (!posix(t)) return
  const ctx = await fixture()
  const other = path.join(ctx.base, "other")
  mkdirSync(other)
  git(ctx, ["init", "--quiet", other])
  write(path.join(other, "keep.txt"), "other owner's work\n")
  const before = snapshot(other)
  const env = {
    ...ctx.env, GIT_DIR: path.join(other, ".git"), GIT_WORK_TREE: other,
    GIT_COMMON_DIR: path.join(other, ".git"), GIT_INDEX_FILE: path.join(other, ".git", "index"),
    GIT_OBJECT_DIRECTORY: path.join(other, ".git", "objects"),
  }
  const planned = plan(ctx, { env })
  assert.equal(create(ctx, planned, { env }).state, "configured_local")
  assert.deepEqual(snapshot(other), before)
})

for (const policy of ["core.hooksPath", "init.templateDir", "filter.lfs.clean", "lfs.storage"]) {
  test(`GivenInherited${policy}_WhenPlanned_RefusesBeforeCreatingOrChangingPolicy`, async (t) => {
    if (!posix(t)) return
    const ctx = await fixture()
    git(ctx, ["config", "--global", policy, "private-policy-value"])
    const before = snapshot(ctx.base)
    const result = plan(ctx)
    assert.equal(result.state, "refused")
    assert.equal(existsSync(ctx.repo), false)
    assert.deepEqual(snapshot(ctx.base), before)
    assert.doesNotMatch(JSON.stringify(result), /private-policy-value/u)
  })
}

test("GivenConfiguredTemplateWithActiveHook_WhenPlanned_RefusesBeforeEffects", async (t) => {
  if (!posix(t)) return
  const ctx = await fixture()
  const template = path.join(ctx.base, "template")
  write(path.join(template, "hooks", "pre-push"), "#!/bin/sh\nexit 1\n")
  const result = plan(ctx, { env: { ...ctx.env, GIT_TEMPLATE_DIR: template } })
  assert.equal(result.state, "refused")
  assert.equal(result.reason, "inherited_template_policy")
  assert.equal(existsSync(ctx.repo), false)
})

test("GivenActiveHookCopiedByNativeInit_WhenCreating_RetainsItAndStopsBeforeLfsMutation", async (t) => {
  if (!posix(t)) return
  const ctx = await fixture()
  const planned = plan(ctx)
  const policy = "#!/bin/sh\nprintf 'identity policy must survive' >&2\nexit 1\n"
  const spawn = (cmd, args, options) => {
    const result = spawnSync(cmd, args, options)
    if (cmd === "git" && args.includes("init")) write(path.join(ctx.repo, ".git", "hooks", "pre-push"), policy)
    return result
  }
  const result = create(ctx, planned, { spawn })
  assert.equal(result.state, "partial")
  assert.equal(result.reason, "template_policy_unsupported")
  assert.equal(result.effects.filters, "not_attempted")
  assert.equal(result.bound, false)
  assert.equal(readFileSync(path.join(ctx.repo, ".git", "hooks", "pre-push"), "utf8"), policy)
})

test("GivenRefsCopiedByNativeInit_WhenCreating_DoesNotAdoptASeededHistory", async (t) => {
  if (!posix(t)) return
  const ctx = await fixture()
  const planned = plan(ctx)
  const ref = "a".repeat(40) + "\n"
  const spawn = (cmd, args, options) => {
    const result = spawnSync(cmd, args, options)
    if (cmd === "git" && args.includes("init")) write(path.join(ctx.repo, ".git", "refs", "heads", "seed"), ref)
    return result
  }
  const result = create(ctx, planned, { spawn })
  assert.equal(result.state, "partial")
  assert.equal(result.reason, "template_policy_unsupported")
  assert.equal(result.effects.filters, "not_attempted")
  assert.equal(readFileSync(path.join(ctx.repo, ".git", "refs", "heads", "seed"), "utf8"), ref)
})

test("GivenHooksPathCopiedIntoInitialConfig_WhenCreating_StopsBeforeLfsMutation", async (t) => {
  if (!posix(t)) return
  const ctx = await fixture()
  const planned = plan(ctx)
  const policy = path.join(ctx.base, "inherited-hooks")
  write(path.join(policy, "pre-push"), "preserve inherited identity policy\n")
  const before = snapshot(policy)
  const spawn = (cmd, args, options) => {
    const result = spawnSync(cmd, args, options)
    if (cmd === "git" && args.includes("init")) git(ctx, [`--git-dir=${path.join(ctx.repo, ".git")}`, "config", "--local", "core.hooksPath", policy])
    return result
  }
  const result = create(ctx, planned, { spawn })
  assert.equal(result.state, "partial")
  assert.equal(result.reason, "inherited_hooks_path")
  assert.equal(result.effects.filters, "not_attempted")
  assert.deepEqual(snapshot(policy), before)
})

test("GivenInitialSigningAndIdentityPolicy_WhenCreating_PreservesItWithoutExecutingSigner", async (t) => {
  if (!posix(t)) return
  const ctx = await fixture()
  const planned = plan(ctx)
  const spawn = (cmd, args, options) => {
    const result = spawnSync(cmd, args, options)
    if (cmd === "git" && args.includes("init")) {
      git(ctx, [`--git-dir=${path.join(ctx.repo, ".git")}`, "config", "--local", "user.name", "Fixture Identity"])
      git(ctx, [`--git-dir=${path.join(ctx.repo, ".git")}`, "config", "--local", "commit.gpgSign", "true"])
      git(ctx, [`--git-dir=${path.join(ctx.repo, ".git")}`, "config", "--local", "gpg.program", "fixture-signer-not-installed"])
    }
    return result
  }
  assert.equal(create(ctx, planned, { spawn }).state, "configured_local")
  assert.equal(git(ctx, ["-C", ctx.repo, "config", "--local", "user.name"]), "Fixture Identity")
  assert.equal(git(ctx, ["-C", ctx.repo, "config", "--local", "commit.gpgSign"]), "true")
  assert.equal(git(ctx, ["-C", ctx.repo, "config", "--local", "gpg.program"]), "fixture-signer-not-installed")
})

test("GivenUnexpectedEffectiveMergePolicyAtReadback_WhenCreating_DoesNotClaimConfigured", async (t) => {
  if (!posix(t)) return
  const ctx = await fixture()
  const planned = plan(ctx)
  const spawn = (cmd, args, options) => {
    const result = spawnSync(cmd, args, options)
    if (cmd === "git" && args.includes("check-attr") && existsSync(path.join(ctx.repo, ".gitattributes"))) {
      result.stdout = String(result.stdout).replace("work/task/report.pdf\0merge\0lfs\0", "work/task/report.pdf\0merge\0private-merge-policy\0")
    }
    return result
  }
  const result = create(ctx, planned, { spawn })
  assert.equal(result.state, "partial")
  assert.equal(result.reason, "attribute_readback_failed")
  assert.equal(result.bound, false)
  assert.doesNotMatch(JSON.stringify(result), /private-merge-policy/u)
})

test("GivenGitDirectoryReplacedBySymlinkAfterInit_WhenCreating_NeverTouchesItsTarget", async (t) => {
  if (!posix(t)) return
  const ctx = await fixture()
  const foreign = path.join(ctx.base, "foreign-git")
  mkdirSync(foreign)
  write(path.join(foreign, "keep.txt"), "not your metadata\n")
  const before = snapshot(foreign)
  const planned = plan(ctx)
  const spawn = (cmd, args, options) => {
    const result = spawnSync(cmd, args, options)
    if (cmd === "git" && args.includes("init")) {
      renameSync(path.join(ctx.repo, ".git"), path.join(ctx.parent, "original-git"))
      symlinkSync(foreign, path.join(ctx.repo, ".git"))
    }
    return result
  }
  const result = create(ctx, planned, { spawn })
  assert.equal(result.state, "partial")
  assert.equal(result.reason, "identity_changed")
  assert.equal(result.effects.filters, "not_attempted")
  assert.deepEqual(snapshot(foreign), before)
})

test("GivenConditionalInheritedHooksPolicy_WhenPlanned_RefusesBeforeCreation", async (t) => {
  if (!posix(t)) return
  const ctx = await fixture()
  const conditional = path.join(ctx.home, "conditional")
  write(conditional, "[core]\n\thooksPath = outside-policy\n")
  write(ctx.env.GIT_CONFIG_GLOBAL, `[includeIf "gitdir:${path.join(ctx.repo, ".git")}"]\n\tpath = ${conditional}\n`)
  const result = plan(ctx)
  assert.equal(result.state, "refused")
  assert.equal(result.reason, "configuration_unavailable", "Git cannot normalize this conditional source before the root exists; do not infer compatible policy")
  assert.equal(existsSync(ctx.repo), false)
})

test("GivenCompatibleGlobalPackageExemptions_WhenCreating_PreservesTheirIntendedBehavior", async (t) => {
  if (!posix(t)) return
  const ctx = await fixture()
  const attrs = "*.pdf filter=lfs diff=lfs merge=lfs -text\n*.png filter=lfs diff=lfs merge=lfs -text\n/plugins/**/*.pdf -filter -diff -merge -text\n/plugins/**/*.png -filter -diff -merge -text\n"
  write(path.join(ctx.env.XDG_CONFIG_HOME, "git", "attributes"), attrs)
  const before = snapshot(ctx.home)
  const result = create(ctx)
  assert.equal(result.state, "configured_local", JSON.stringify(result))
  assert.deepEqual(snapshot(ctx.home), before)
})

test("GivenInstalledHookChangesBeforeAttributes_WhenCreating_StopsWithoutReplacingIt", async (t) => {
  if (!posix(t)) return
  const ctx = await fixture()
  const planned = plan(ctx)
  let updated = false, reads = 0, changed
  const spawn = (cmd, args, options) => {
    const result = spawnSync(cmd, args, options)
    if (cmd === "git-lfs" && args[0] === "update") updated = true
    if (updated && cmd === "git" && args.includes("config") && args.includes("--includes") && ++reads === 2) {
      const hook = path.join(ctx.repo, ".git", "hooks", "pre-push")
      changed = readFileSync(hook, "utf8") + "\n# a newer writer changed this policy\n"
      writeFileSync(hook, changed)
    }
    return result
  }
  const result = create(ctx, planned, { spawn })
  assert.equal(result.state, "partial")
  assert.equal(result.reason, "hook_changed")
  assert.equal(existsSync(path.join(ctx.repo, ".gitattributes")), false)
  assert.equal(readFileSync(path.join(ctx.repo, ".git", "hooks", "pre-push"), "utf8"), changed)
})

test("GivenCreatorRuns_WhenCommandsAreObserved_UsesNoRemoteForceGlobalOrHistoryOperation", async (t) => {
  if (!posix(t)) return
  const ctx = await fixture()
  const requests = []
  const spawn = (cmd, args, options) => {
    requests.push({ cmd, args, env: options.env, killSignal: options.killSignal })
    return spawnSync(cmd, args, options)
  }
  const result = create(ctx, plan(ctx, { spawn }), { spawn })
  assert.equal(result.state, "configured_local")
  for (const request of requests) {
    assert.ok(["git", "git-lfs"].includes(request.cmd))
    assert.equal(request.args.some((arg) => ["fetch", "pull", "push", "clone", "commit", "add", "migrate", "fsck", "--force", "--global", "--system", "--skip-push"].includes(arg)), false)
    assert.equal(request.env.GIT_ALLOW_PROTOCOL, "")
    assert.equal(request.killSignal, "SIGKILL")
  }
})

test("GivenSymlinkedParentOrExistingSymlink_WhenPlanned_RefusesWithoutFollowingIt", async (t) => {
  if (!posix(t)) return
  const ctx = await fixture()
  symlinkSync(ctx.parent, path.join(ctx.base, "alias"))
  assert.equal(plan(ctx, { repo: path.join(ctx.base, "alias", "new-desk") }).state, "refused")
  symlinkSync(path.join(ctx.base, "absent"), ctx.repo)
  const result = plan(ctx)
  assert.equal(result.state, "refused")
  assert.equal(result.reason, "already_exists")
})

test("GivenRootReplacedAfterInit_WhenNextPhaseStarts_PreservesTheReplacementAndStops", async (t) => {
  if (!posix(t)) return
  const ctx = await fixture()
  const planned = plan(ctx)
  let replaced = false
  const spawn = (cmd, args, options) => {
    const result = spawnSync(cmd, args, options)
    if (cmd === "git" && args.includes("init") && !replaced) {
      replaced = true
      renameSync(ctx.repo, path.join(ctx.parent, "creator-original"))
      mkdirSync(ctx.repo)
      write(path.join(ctx.repo, "newer.txt"), "not yours\n")
    }
    return result
  }
  const result = create(ctx, planned, { spawn })
  assert.equal(result.state, "partial")
  assert.equal(result.reason, "identity_changed")
  assert.equal(result.bound, false)
  assert.deepEqual(readdirSync(ctx.repo), ["newer.txt"])
  assert.equal(readFileSync(path.join(ctx.repo, "newer.txt"), "utf8"), "not yours\n")
  assert.equal(existsSync(path.join(ctx.parent, "creator-original", ".git")), true)
})

test("GivenParentReplacedAfterLocalFilterWrite_WhenNextPhaseStarts_DoesNotFollowNewParent", async (t) => {
  if (!posix(t)) return
  const ctx = await fixture()
  const foreign = path.join(ctx.base, "foreign")
  mkdirSync(foreign)
  write(path.join(foreign, "new-desk", "newer.txt"), "preserve\n")
  const planned = plan(ctx)
  const spawn = (cmd, args, options) => {
    const result = spawnSync(cmd, args, options)
    if (cmd === "git-lfs" && args[0] === "install") {
      renameSync(ctx.parent, path.join(ctx.base, "original-parent"))
      symlinkSync(foreign, ctx.parent)
    }
    return result
  }
  const result = create(ctx, planned, { spawn })
  assert.equal(result.state, "partial")
  assert.equal(result.reason, "identity_changed")
  assert.equal(result.bound, false)
  assert.deepEqual(readdirSync(path.join(foreign, "new-desk")), ["newer.txt"])
})

for (const phase of ["init", "install", "update"]) {
  test(`Given${phase}Failure_WhenCreating_RetainsExactPartialRootAndRefusesRepeat`, async (t) => {
    if (!posix(t)) return
    const ctx = await fixture()
    const planned = plan(ctx)
    const spawn = (cmd, args, options) => {
      const result = spawnSync(cmd, args, options)
      return cmd === (phase === "init" ? "git" : "git-lfs") && args.includes(phase)
        ? { status: 1, stderr: "https://user:credential@private.invalid" }
        : result
    }
    const result = create(ctx, planned, { spawn })
    assert.equal(result.state, "partial")
    assert.equal(result.bound, false)
    assert.equal(result.effects.root, "created")
    assert.equal(result.recovery.owner, "creating_caller")
    assert.equal(existsSync(ctx.repo), true)
    assert.doesNotMatch(JSON.stringify(result), /credential|private\.invalid/u)
    write(path.join(ctx.repo, "newer.txt"), "keep\n")
    const before = snapshot(ctx.repo)
    const repeat = createLfsDesk({ repo: ctx.repo, env: ctx.env, expectedPlan: planned.plan_sha256 })
    assert.equal(repeat.state, "refused")
    assert.equal(repeat.reason, "already_exists")
    assert.deepEqual(snapshot(ctx.repo), before)
  })
}

test("GivenLocalSetupProcessIgnoresTermination_WhenTimedOut_RetainsUnboundPartialRoot", async (t) => {
  if (!posix(t)) return
  const ctx = await fixture()
  const planned = plan(ctx)
  let observed
  const spawn = (cmd, args, options) => {
    if (cmd !== "git-lfs" || args[0] !== "install") return spawnSync(cmd, args, options)
    const start = performance.now()
    const result = spawnSync(process.execPath, ["-e", 'process.on("SIGTERM",()=>{});process.stdout.write("armed");setTimeout(()=>process.exit(0),1000)'], { ...options, timeout: 250 })
    observed = { elapsed: performance.now() - start, signal: result.signal, armed: String(result.stdout).includes("armed") }
    return result
  }
  const result = create(ctx, planned, { spawn })
  assert.equal(observed.armed, true)
  assert.equal(observed.signal, "SIGKILL")
  assert.ok(observed.elapsed < 800)
  assert.equal(result.state, "partial")
  assert.equal(result.phase, "local_filters")
  assert.equal(result.effects.filters, "attempted")
  assert.equal(result.effects.hooks, "not_attempted")
  assert.equal(result.bound, false)
  assert.equal(existsSync(ctx.repo), true)
  assert.equal(existsSync(path.join(ctx.repo, ".gitattributes")), false)
})

function child(args, env) {
  return new Promise((resolve, reject) => {
    const process = spawn(globalThis.process.execPath, [cli, ...args], { env, stdio: ["ignore", "pipe", "pipe"] })
    let stdout = "", stderr = ""
    process.stdout.on("data", (chunk) => { stdout += chunk })
    process.stderr.on("data", (chunk) => { stderr += chunk })
    process.once("error", reject)
    process.once("close", (code) => resolve({ code, stdout, stderr }))
  })
}

test("GivenCompetingCreatorProcesses_WhenApplyingSamePlan_OnlyOneCreatesTheRoot", async (t) => {
  if (!posix(t)) return
  const ctx = await fixture()
  const planned = plan(ctx)
  const args = ["create", "--repo", ctx.repo, "--apply", "--expect-plan", planned.plan_sha256]
  const results = await Promise.all([child(args, ctx.env), child(args, ctx.env)])
  const reports = results.map((result) => JSON.parse(result.stdout))
  assert.equal(reports.filter((result) => result.state === "configured_local").length, 1)
  assert.equal(reports.filter((result) => result.state === "refused" && result.reason === "already_exists").length, 1)
  assert.deepEqual(results.map((result) => result.code).sort(), [0, 1])
})

test("GivenCliCreateWithoutApply_WhenInvoked_EmitsPlanAndRequiresExplicitExpectedPlan", async (t) => {
  if (!posix(t)) return
  const ctx = await fixture()
  const result = await child(["create", "--repo", ctx.repo], ctx.env)
  assert.equal(result.code, 0, result.stderr)
  assert.equal(JSON.parse(result.stdout).state, "plan")
  assert.equal(existsSync(ctx.repo), false)
  const invalid = await child(["create", "--repo", ctx.repo, "--apply"], ctx.env)
  assert.equal(invalid.code, 2)
  assert.equal(JSON.parse(invalid.stdout).state, "usage")
  assert.equal(existsSync(ctx.repo), false)
})

test("GivenFreshBootstrapCommandSequence_WhenCreatorReturns_ScaffoldCanMakeItsNormalInitialCommit", async (t) => {
  if (!posix(t)) return
  const ctx = await fixture()
  const planned = await child(["create", "--repo", ctx.repo], ctx.env)
  assert.equal(planned.code, 0)
  const created = await child(["create", "--repo", ctx.repo, "--apply", "--expect-plan", JSON.parse(planned.stdout).plan_sha256], ctx.env)
  assert.equal(created.code, 0, created.stderr)
  assert.equal(JSON.parse(created.stdout).bound, false)
  assert.equal(existsSync(path.join(ctx.repo, ".gitattributes")), true, "tracking policy precedes the caller's first artifact")
  write(path.join(ctx.repo, "_meta", ".gitkeep"), "")
  write(path.join(ctx.repo, "_archive", ".gitkeep"), "")
  write(path.join(ctx.repo, "README.md"), "# Synthetic desk\n")
  git(ctx, ["-C", ctx.repo, "config", "user.name", "Fixture"])
  git(ctx, ["-C", ctx.repo, "config", "user.email", "fixture@example.invalid"])
  git(ctx, ["-C", ctx.repo, "add", "--", ".gitattributes", "_meta/.gitkeep", "_archive/.gitkeep", "README.md"])
  git(ctx, ["-C", ctx.repo, "commit", "--quiet", "-m", "initial scaffold"])
  assert.equal(git(ctx, ["-C", ctx.repo, "rev-list", "--count", "HEAD"]), "1")
  assert.equal(git(ctx, ["-C", ctx.repo, "symbolic-ref", "--short", "HEAD"]), "main")
  assert.equal(git(ctx, ["-C", ctx.repo, "remote"]), "")
  assert.equal(existsSync(path.join(ctx.home, "desk.activation.json")), false)
})
