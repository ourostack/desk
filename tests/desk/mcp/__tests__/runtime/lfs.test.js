import { test } from "node:test"
import { strict as assert } from "node:assert"
import { createHash } from "node:crypto"
import fs from "node:fs"
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, symlinkSync, writeFileSync } from "node:fs"
import { syncBuiltinESMExports } from "node:module"
import * as path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { mkTempRoot } from "../_temp_roots.js"

const moduleUrl = new URL("../../../../../plugins/desk/mcp/src/runtime/lfs.js", import.meta.url)
let inspectLfs
try {
  ;({ inspectLfs } = await import(moduleUrl))
} catch (error) {
  if (error.code !== "ERR_MODULE_NOT_FOUND") throw error
}
const cli = fileURLToPath(new URL("../../../../../plugins/desk/mcp/scripts/lfs.js", import.meta.url))
// Git for Windows ships system attributes (diff=astextplain for *.pdf); fixtures must not inherit host policy.
process.env.GIT_ATTR_NOSYSTEM = "1"

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex")
const bytes = Buffer.from([0, 1, 2, 255, 13, 10])
const oid = digest(bytes)
const pointer = `version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize ${bytes.length}\n`

function git(root, ...args) {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: path.join(root, "no-global-config") } })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.trim()
}

function write(root, file, content) {
  const target = path.join(root, file)
  mkdirSync(path.dirname(target), { recursive: true })
  writeFileSync(target, content)
}

async function fixture(files = {}) {
  const root = await mkTempRoot("desk-lfs-inspect-")
  git(root, "init", "-q")
  git(root, "config", "maintenance.auto", "false")
  git(root, "config", "gc.auto", "0")
  git(root, "config", "user.name", "Fixture")
  git(root, "config", "user.email", "fixture@example.invalid")
  for (const [file, content] of Object.entries(files)) write(root, file, content)
  if (Object.keys(files).length > 0) {
    git(root, "add", "--all")
    git(root, "commit", "-qm", "fixture")
  }
  return root
}

function snapshot(root) {
  const result = {}
  const walk = (dir, prefix = "") => {
    for (const name of readdirSync(dir).sort()) {
      const rel = `${prefix}${name}`
      const file = path.join(dir, name)
      const stat = lstatSync(file)
      if (stat.isSymbolicLink()) result[rel] = { link: readlinkSync(file), mode: stat.mode }
      else if (stat.isDirectory()) {
        result[`${rel}/`] = { directory: true, mode: stat.mode }
        walk(file, `${rel}/`)
      }
      else result[rel] = { sha256: digest(readFileSync(file)), mode: stat.mode }
    }
  }
  walk(root)
  return result
}

function inspect(root, options = {}) {
  assert.equal(typeof inspectLfs, "function", "the read-only inspectLfs API is missing")
  return inspectLfs({ repo: root, ...options })
}

const fileAt = (result, name) => {
  const found = result.files.find((file) => file.path === name)
  assert.ok(found, `no observation for ${name}: ${JSON.stringify(result)}`)
  return found
}

function observeOpened(run) {
  const original = fs.openSync
  const opened = []
  fs.openSync = (file, ...args) => {
    opened.push(String(file))
    return original(file, ...args)
  }
  syncBuiltinESMExports()
  try {
    return { result: run(), opened }
  } finally {
    fs.openSync = original
    syncBuiltinESMExports()
  }
}

test("GivenEmptyRepository_WhenInspected_ReportsScopeWithoutClaimingTransferReadiness", async () => {
  const root = await fixture()
  const before = snapshot(root)
  const result = inspect(root)
  assert.equal(result.schema_version, 1)
  assert.equal(result.state, "inspected")
  assert.equal(result.repository.kind, "unknown")
  assert.equal(result.repository.has_origin, false)
  assert.deepEqual(result.files, [])
  assert.deepEqual(result.qualification, { remote_publication: "not_checked", network_auth: "not_checked", installed_payload: "not_checked" })
  assert.deepEqual(snapshot(root), before)
})

test("GivenContextBinary_WhenInspected_ProposesExactTrackingWithoutChangingDirtyState", async () => {
  const root = await fixture({ "_meta/.gitkeep": "", "_archive/.gitkeep": "", "task/report.PDF": bytes, "notes.md": "before\n" })
  write(root, "notes.md", "dirty\n")
  write(root, "staged.md", "staged\n")
  git(root, "add", "--", "staged.md")
  write(root, "untracked.png", bytes)
  const before = snapshot(root)
  const result = inspect(root)
  assert.equal(result.repository.kind, "context")
  assert.equal(result.repository.context, "personal")
  assert.equal(fileAt(result, "task/report.PDF").tracking, "ordinary_git")
  assert.equal(fileAt(result, "task/report.PDF").proposal, "track_exact_path")
  assert.equal(result.files.some((file) => file.path === "untracked.png"), false)
  assert.deepEqual(snapshot(root), before)
  assert.deepEqual(inspect(root), result, "repeat inspection changes neither evidence nor state")
})

test("GivenLfsPointer_WhenObjectMissing_ReportsAbsenceWithoutFetching", async () => {
  const root = await fixture({ "report.pdf": pointer, ".gitattributes": "*.pdf filter=lfs diff=lfs merge=lfs -text\n" })
  const before = snapshot(root)
  const file = fileAt(inspect(root), "report.pdf")
  assert.equal(file.tracking, "lfs_pointer")
  assert.equal(file.local_object, "missing")
  assert.equal(file.materialization, "pointer")
  assert.deepEqual(snapshot(root), before)
})

test("GivenMaterializedPointer_WhenBytesWrong_ReportsMismatchAndChecksLocalObject", async () => {
  const root = await fixture({ "report.pdf": pointer })
  write(root, ".git/lfs/objects/" + oid.slice(0, 2) + "/" + oid.slice(2, 4) + "/" + oid, bytes)
  write(root, "report.pdf", Buffer.from([0, 1, 2, 255, 13, 11]))
  const file = fileAt(inspect(root), "report.pdf")
  assert.equal(file.local_object, "verified")
  assert.equal(file.materialization, "mismatch")
  write(root, "report.pdf", bytes)
  assert.equal(fileAt(inspect(root), "report.pdf").materialization, "verified")
})

test("GivenCorruptLocalObject_WhenInspected_DoesNotRelocateIt", async () => {
  const root = await fixture({ "report.pdf": pointer })
  write(root, ".git/lfs/objects/" + oid.slice(0, 2) + "/" + oid.slice(2, 4) + "/" + oid, "corrupt")
  const before = snapshot(root)
  assert.equal(fileAt(inspect(root), "report.pdf").local_object, "mismatch")
  assert.deepEqual(snapshot(root), before)
})

test("GivenNestedAndInfoAttributes_WhenInspected_UsesEffectivePathPolicy", async () => {
  const root = await fixture({ "_meta/.gitkeep": "", "_archive/.gitkeep": "", "a.pdf": bytes, "nested/b.pdf": bytes, ".gitattributes": "*.pdf filter=lfs diff=lfs merge=lfs -text\n", "nested/.gitattributes": "*.pdf -filter\n" })
  write(root, ".git/info/attributes", "a.pdf filter=custom-private-command\n")
  const result = inspect(root)
  assert.equal(fileAt(result, "a.pdf").attributes.filter, "custom")
  assert.equal(fileAt(result, "a.pdf").proposal, "review_existing_policy")
  assert.equal(fileAt(result, "nested/b.pdf").attributes.filter, "unset")
  assert.equal(fileAt(result, "nested/b.pdf").proposal, "review_existing_policy")
})

test("GivenPackageRoots_WhenInspected_ExemptsRootCustomAndConventionalPayloads", async () => {
  const root = await fixture({
    "_meta/crew.json": '{"tooling":{"path":"team/tools"}}',
    "desks/.gitkeep": "",
    "team/tools/image.png": bytes,
    "plugins/unmanifested/image.png": bytes,
    "custom/plugin.json": "{}",
    "custom/archive.tgz": bytes,
    "task/image.png": bytes,
  })
  const result = inspect(root)
  assert.equal(result.repository.context, "shared")
  for (const name of ["team/tools/image.png", "plugins/unmanifested/image.png", "custom/archive.tgz"]) assert.equal(fileAt(result, name).proposal, "package_exempt")
  assert.equal(fileAt(result, "task/image.png").proposal, "track_exact_path")
  const packageRoot = await fixture({ "plugin.json": "{}", "image.png": bytes })
  assert.equal(inspect(packageRoot).repository.kind, "package")
  assert.equal(fileAt(inspect(packageRoot), "image.png").proposal, "package_exempt")
})

test("GivenMarketplaceSource_WhenInspected_ExemptsDeclaredPayloadWithoutFollowingTraversal", async () => {
  const root = await fixture({ ".claude-plugin/marketplace.json": '{"plugins":[{"source":"./bundle"},{"source":"../private"}]}', "bundle/image.png": bytes })
  const result = inspect(root)
  assert.equal(fileAt(result, "bundle/image.png").proposal, "package_exempt")
  assert.ok(result.findings.some((finding) => finding.code === "package_declaration_invalid"))
})

test("GivenUnknownBinaryAndSensitiveOrIgnoredFiles_WhenInspected_ReportsOnlySafeMetadata", async () => {
  const root = await fixture({ "data.unusual": bytes, "private.key": "DO_NOT_PRINT", "ignored.pdf": bytes })
  write(root, ".gitignore", "ignored.pdf\n")
  const result = inspect(root)
  assert.equal(fileAt(result, "data.unusual").format, "unknown_binary")
  assert.equal(fileAt(result, "data.unusual").proposal, "review_exact_path")
  assert.equal(fileAt(result, "private.key").inspection, "sensitive_path")
  assert.equal(fileAt(result, "ignored.pdf").inspection, "ignored")
  assert.equal(JSON.stringify(result).includes("DO_NOT_PRINT"), false)
})

test("GivenConfiguredHooksFiltersAndFsmonitor_WhenInspected_NeverExecutesThem", async () => {
  const root = await fixture({ "report.pdf": bytes })
  const marker = path.join(root, "should-not-exist")
  const command = `node -e "require('node:fs').writeFileSync('${marker.replaceAll("\\", "\\\\")}', 'executed')"`
  git(root, "config", "filter.lfs.clean", command)
  git(root, "config", "filter.lfs.process", command)
  git(root, "config", "core.fsmonitor", command)
  git(root, "config", "core.hooksPath", "custom-hooks")
  write(root, ".gitattributes", "*.pdf filter=lfs\n")
  write(root, "custom-hooks/pre-push", `#!/bin/sh\n${command}\n`)
  chmodSync(path.join(root, "custom-hooks/pre-push"), 0o755)
  const before = snapshot(root)
  const result = inspect(root)
  assert.equal(result.configuration.filters, "custom_or_incomplete")
  assert.equal(result.configuration.hooks.location, "custom")
  assert.equal(result.configuration.hooks.integration, "not_checked")
  assert.equal(existsSync(marker), false)
  assert.deepEqual(snapshot(root), before)
  assert.equal(JSON.stringify(result).includes(command), false)
})

test("GivenMissingLfsAndInvalidGitConfig_WhenInspected_ReportsRedactedUnknowns", async () => {
  const root = await fixture()
  const spawn = (cmd, args, options) => cmd === "git-lfs" ? { status: null, error: Object.assign(new Error("private secret"), { code: "ENOENT" }) } : spawnSync(cmd, args, options)
  assert.equal(inspect(root, { spawn }).tool.state, "missing")
  write(root, ".git/config", "[invalid secret=https://user:password@example.invalid]\n")
  const result = inspect(root, { spawn })
  assert.equal(result.state, "unavailable")
  assert.equal(result.findings[0].code, "git_metadata_unavailable")
  assert.equal(JSON.stringify(result).includes("password"), false)
})

test("GivenSymlinkedBinaryOrParent_WhenInspected_DoesNotReadOutsideRepository", async (t) => {
  if (process.platform === "win32") return t.skip("fixture symlink creation requires Windows privilege")
  const root = await fixture({ "folder/report.pdf": pointer })
  const outside = await mkTempRoot("desk-lfs-outside-")
  write(outside, "report.pdf", bytes)
  const { unlinkSync, rmdirSync } = await import("node:fs")
  unlinkSync(path.join(root, "folder/report.pdf"))
  rmdirSync(path.join(root, "folder"))
  symlinkSync(outside, path.join(root, "folder"))
  const result = inspect(root)
  assert.equal(fileAt(result, "folder/report.pdf").materialization, "unsafe_path")
  const before = snapshot(root)
  assert.deepEqual(inspect(root), result)
  assert.deepEqual(snapshot(root), before)
})

test("GivenSparsePartialRepository_WhenInspected_DisablesLazyFetchAndLeavesMissingBytesUnknown", async () => {
  const root = await fixture({ "report.pdf": pointer })
  git(root, "config", "core.sparseCheckout", "true")
  git(root, "remote", "add", "origin", "https://user:password@example.invalid/private.git")
  git(root, "config", "remote.origin.promisor", "true")
  const calls = []
  const spawn = (cmd, args, options) => {
    calls.push({ cmd, args, env: options.env })
    return spawnSync(cmd, args, options)
  }
  const result = inspect(root, { spawn })
  assert.equal(result.repository.partial, true)
  assert.equal(result.repository.sparse, true)
  assert.equal(result.repository.has_origin, true)
  assert.equal(JSON.stringify(result).includes("password"), false)
  for (const call of calls.filter((entry) => entry.cmd === "git")) {
    assert.equal(call.env.GIT_NO_LAZY_FETCH, "1")
    assert.equal(call.env.GIT_OPTIONAL_LOCKS, "0")
    assert.equal(call.env.GIT_ALLOW_PROTOCOL, "")
    assert.ok(call.args.includes("protocol.allow=never"))
    assert.equal(["status", "diff", "fetch", "pull", "fsck"].includes(call.args[call.args.indexOf("-C") + 2]), false)
  }
})

test("GivenOversizedObject_WhenInspected_ReportsBoundRatherThanClaimingVerified", async () => {
  const root = await fixture({ "report.pdf": `version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize 999999999\n` })
  write(root, "report.pdf", Buffer.alloc(17 * 1024 * 1024))
  assert.equal(fileAt(inspect(root), "report.pdf").materialization, "mismatch")
  const large = Buffer.alloc(17 * 1024 * 1024)
  const largeOid = digest(large)
  write(root, "large.pdf", `version https://git-lfs.github.com/spec/v1\noid sha256:${largeOid}\nsize ${large.length}\n`)
  git(root, "add", "--", "large.pdf")
  write(root, "large.pdf", large)
  assert.equal(fileAt(inspect(root), "large.pdf").materialization, "not_checked_limit")
})

test("GivenCustomLfsStorage_WhenInspected_DoesNotFollowItsPath", async () => {
  const root = await fixture({ "report.pdf": pointer })
  git(root, "config", "lfs.storage", "../private-cache")
  const result = inspect(root)
  assert.equal(fileAt(result, "report.pdf").local_object, "not_checked_custom_storage")
  assert.equal(JSON.stringify(result).includes("private-cache"), false)
})

test("GivenCustomDiffOrMergePolicy_WhenInspected_DoesNotProposeReplacingIt", async () => {
  const root = await fixture({ "_meta/.gitkeep": "", "_archive/.gitkeep": "", "report.pdf": bytes, ".gitattributes": "*.pdf diff=private-diff merge=private-merge\n" })
  const file = fileAt(inspect(root), "report.pdf")
  assert.equal(file.attributes.diff, "custom")
  assert.equal(file.attributes.merge, "custom")
  assert.equal(file.proposal, "review_existing_policy")
})

test("GivenTruncatedInventory_WhenInspected_DoesNotProposeTrackingUnknownPackagePayload", async () => {
  const files = { "_meta/.gitkeep": "", "_archive/.gitkeep": "", "a/image.png": bytes }
  for (let i = 0; i < 515; i += 1) files[`b/${String(i).padStart(4, "0")}.md`] = "same blob\n"
  files["z/plugin.json"] = "{}"
  const root = await fixture(files)
  const result = inspect(root)
  assert.equal(result.state, "limited")
  assert.equal(fileAt(result, "a/image.png").proposal, "review_incomplete_inventory")
  assert.ok(result.findings.some((finding) => finding.code === "path_limit"))
})

test("GivenOrdinaryDirectoryOrEmptyInput_WhenInspected_DoesNotUseParentOrCwd", async () => {
  const root = await mkTempRoot("desk-lfs-not-git-")
  assert.equal(inspect(root).state, "not_git")
  assert.equal(inspect("").state, "not_git")
  assert.equal(inspect(null).state, "not_git")
})

test("GivenUnavailableIndexBlob_WhenInspected_DoesNotFetchOrInferOrdinaryTracking", async () => {
  const root = await fixture({ "report.pdf": pointer })
  const blob = git(root, "rev-parse", ":report.pdf")
  const { unlinkSync } = await import("node:fs")
  unlinkSync(path.join(root, ".git", "objects", blob.slice(0, 2), blob.slice(2)))
  git(root, "remote", "add", "origin", "https://user:password@example.invalid/private.git")
  git(root, "config", "remote.origin.promisor", "true")
  const before = snapshot(root)
  const result = inspect(root)
  assert.equal(result.state, "limited")
  assert.equal(fileAt(result, "report.pdf").tracking, "unknown")
  assert.ok(result.findings.some((finding) => finding.code === "index_blob_unavailable"))
  assert.deepEqual(snapshot(root), before)
})

test("GivenInheritedRepositorySelectors_WhenInspected_StaysInRequestedRepository", async () => {
  const root = await fixture({ "_meta/.gitkeep": "", "_archive/.gitkeep": "", "report.pdf": bytes })
  const other = await fixture({ "plugin.json": "{}", "other.png": bytes })
  const result = inspect(root, { env: { ...process.env, GIT_DIR: path.join(other, ".git"), GIT_WORK_TREE: other, GIT_INDEX_FILE: path.join(other, ".git", "index") } })
  assert.equal(result.repository.kind, "context")
  assert.equal(fileAt(result, "report.pdf").proposal, "track_exact_path")
  assert.equal(result.files.some((file) => file.path === "other.png"), false)
})

test("GivenIgnoredPackageDeclaration_WhenInspected_ReportsIncompleteScopeWithoutReadingIt", async () => {
  const root = await fixture({ "_meta/crew.json": '{"tooling":{"path":"SECRET_DO_NOT_READ"}}', "_archive/.gitkeep": "", "report.pdf": bytes })
  write(root, ".gitignore", "_meta/crew.json\n")
  const result = inspect(root)
  assert.equal(result.repository.package_roots.includes("SECRET_DO_NOT_READ"), false)
  assert.ok(result.findings.some((finding) => finding.code === "package_declaration_unreadable"))
  assert.equal(fileAt(result, "report.pdf").proposal, "review_incomplete_inventory")
})

test("GivenUnclassifiedRepository_WhenInspected_RequiresScopeReviewBeforeTracking", async () => {
  const root = await fixture({ "image.png": bytes })
  assert.equal(fileAt(inspect(root), "image.png").proposal, "review_repository_scope")
})

test("GivenCanonicalFilterConfiguration_WhenInspected_ObservesItWithoutRunningIt", async () => {
  const root = await fixture({ "report.pdf": pointer })
  git(root, "config", "filter.lfs.clean", "git-lfs clean -- %f")
  git(root, "config", "filter.lfs.smudge", "git-lfs smudge -- %f")
  git(root, "config", "filter.lfs.process", "git-lfs filter-process")
  git(root, "config", "filter.lfs.required", "true")
  const before = snapshot(root)
  const result = inspect(root)
  assert.equal(result.configuration.filters, "standard")
  assert.equal(result.configuration.hooks.pre_push, "missing")
  assert.deepEqual(snapshot(root), before)
})

test("GivenMalformedPointer_WhenInspected_DoesNotTreatItAsUsableContent", async () => {
  const root = await fixture({ "report.pdf": `version https://git-lfs.github.com/spec/v1\noid sha256:not-a-hash\nsize 6\n` })
  const result = inspect(root)
  assert.equal(fileAt(result, "report.pdf").tracking, "invalid_pointer")
  assert.equal(fileAt(result, "report.pdf").materialization, "not_checked")
  assert.ok(result.findings.some((finding) => finding.code === "invalid_pointer"))
})

test("GivenSymlinkedObjectCache_WhenInspected_DoesNotVerifyExternalBytes", async (t) => {
  if (process.platform === "win32") return t.skip("fixture symlink creation requires Windows privilege")
  const root = await fixture({ "report.pdf": pointer })
  const outside = await mkTempRoot("desk-lfs-external-object-")
  write(outside, `objects/${oid.slice(0, 2)}/${oid.slice(2, 4)}/${oid}`, bytes)
  symlinkSync(outside, path.join(root, ".git", "lfs"))
  assert.equal(fileAt(inspect(root), "report.pdf").local_object, "unsafe_path")
})

test("GivenMissingTrackedBinary_WhenInspected_DoesNotProposeTrackingUnavailableBytes", async () => {
  const root = await fixture({ "_meta/.gitkeep": "", "_archive/.gitkeep": "", "report.pdf": bytes })
  const { unlinkSync } = await import("node:fs")
  unlinkSync(path.join(root, "report.pdf"))
  assert.equal(fileAt(inspect(root), "report.pdf").proposal, "review_worktree_state")
})

test("GivenMaintainedSecretExclusion_WhenInspected_NeverRequestsIndexedOrWorkingContent", async () => {
  const root = await fixture({ "_secrets/service.json": '{"credential":"synthetic-private-value"}' })
  const secretOid = git(root, "rev-parse", ":_secrets/service.json")
  const before = snapshot(root)
  const requests = []
  const spawn = (cmd, args, options) => {
    requests.push({ cmd, args, input: String(options.input ?? "") })
    return spawnSync(cmd, args, options)
  }
  const { result, opened } = observeOpened(() => inspect(root, { spawn }))
  assert.deepEqual({
    index_reads: requests.filter((call) => call.cmd === "git" && call.args.includes("cat-file") && call.args.includes(secretOid)).length,
    worktree_reads: opened.filter((file) => file === path.join(root, "_secrets/service.json")).length,
    attribute_queries: requests.filter((call) => call.cmd === "git" && call.args.includes("check-attr") && call.input.includes("_secrets/service.json")).length,
    inspection: fileAt(result, "_secrets/service.json").inspection,
  }, { index_reads: 0, worktree_reads: 0, attribute_queries: 0, inspection: "sensitive_path" })
  assert.deepEqual(snapshot(root), before)
})

for (const kind of ["root", "ancestor"]) {
  test(`GivenSymlinkedMetadata${kind}_WhenInspected_NeverReadsCacheOrQualifiesHook`, async (t) => {
    if (process.platform === "win32") return t.skip("fixture symlink creation requires Windows privilege")
    const root = await fixture({ "report.pdf": pointer })
    const external = await mkTempRoot("desk-lfs-linked-metadata-")
    const metadata = path.join(external, "actual", "metadata")
    mkdirSync(path.dirname(metadata), { recursive: true })
    fs.renameSync(path.join(root, ".git"), metadata)
    if (kind === "root") symlinkSync(metadata, path.join(root, ".git"))
    else {
      symlinkSync(path.join(external, "actual"), path.join(external, "alias"))
      write(root, ".git", `gitdir: ${path.join(external, "alias", "metadata")}\n`)
    }
    write(metadata, `lfs/objects/${oid.slice(0, 2)}/${oid.slice(2, 4)}/${oid}`, bytes)
    write(metadata, "hooks/pre-push", "do not execute\n")
    const common = kind === "root" ? path.join(root, ".git") : path.join(external, "alias", "metadata")
    const before = { root: snapshot(root), metadata: snapshot(external) }
    const spawn = (cmd, args, options) => cmd === "git" && args.includes("--git-common-dir")
      ? { status: 0, stdout: Buffer.from(common) }
      : spawnSync(cmd, args, options)
    const { result, opened } = observeOpened(() => inspect(root, { spawn }))
    assert.deepEqual({
      object: fileAt(result, "report.pdf").local_object,
      hook: result.configuration.hooks.pre_push,
      object_reads: opened.filter((file) => file.endsWith(`${path.sep}${oid}`)).length,
    }, { object: "unsafe_path", hook: "unsafe_path", object_reads: 0 })
    assert.deepEqual({ root: snapshot(root), metadata: snapshot(external) }, before)
  })
}

for (const selector of ["environment", "configuration"]) {
  test(`GivenInheritedAttribute${selector}_WhenInspected_UsesWorkingTreePolicy`, async () => {
    const root = await fixture({ "_meta/.gitkeep": "", "_archive/.gitkeep": "", "report.pdf": bytes, ".gitattributes": "*.pdf filter=lfs\n" })
    write(root, ".gitattributes", "*.pdf -filter\n")
    const env = selector === "environment" ? { ...process.env, GIT_ATTR_SOURCE: "HEAD" }
      : { ...process.env, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "attr.tree", GIT_CONFIG_VALUE_0: "HEAD" }
    const before = snapshot(root)
    const file = fileAt(inspect(root, { env }), "report.pdf")
    assert.equal(file.attributes.filter, "unset")
    assert.equal(file.proposal, "review_existing_policy")
    assert.deepEqual(snapshot(root), before)
  })
}

test("GivenExternalAttributesFile_WhenInspected_KeepsItsPolicyInEffect", async () => {
  const root = await fixture({ "_meta/.gitkeep": "", "_archive/.gitkeep": "", "report.pdf": bytes })
  const external = path.join(root, "..", `${path.basename(root)}-external-attributes`)
  mkdirSync(external)
  try {
    write(external, "attributes", "*.pdf diff=astextplain\n")
    write(external, "config", `[core]\n\tattributesFile = ${path.join(external, "attributes").replaceAll("\\", "/")}\n`)
    const file = fileAt(inspect(root, { env: { ...process.env, GIT_CONFIG_GLOBAL: path.join(external, "config") } }), "report.pdf")
    assert.equal(file.attributes.diff, "custom")
    assert.equal(file.proposal, "review_existing_policy")
    assert.equal(fileAt(inspect(root), "report.pdf").proposal, "track_exact_path")
  } finally {
    fs.rmSync(external, { recursive: true, force: true })
  }
})

for (const command of ["git", "git-lfs"]) {
  test(`GivenIgnoringOwned${command}_WhenTimeoutExpires_TerminatesWithoutWaitingForSelfExit`, async (t) => {
    if (process.platform === "win32") return t.skip("POSIX ignored-SIGTERM regression; native Windows termination remains unqualified")
    const root = await fixture()
    let observed
    const spawn = (cmd, args, options) => {
      if (cmd !== command || observed !== undefined) return spawnSync(cmd, args, options)
      const start = performance.now()
      const child = spawnSync(process.execPath, ["-e", 'process.on("SIGTERM", () => {}); process.stdout.write("armed"); setTimeout(() => process.exit(0), 8000)'], { ...options, timeout: 2000 })
      observed = { elapsed: performance.now() - start, armed: String(child.stdout).includes("armed"), signal: child.signal }
      return child
    }
    const result = inspect(root, { spawn })
    assert.equal(observed.armed, true, "the child must install its SIGTERM handler before the timeout")
    assert.ok(observed.elapsed < 5000, `timeout waited ${Math.round(observed.elapsed)} ms for a child that ignores SIGTERM`)
    assert.equal(observed.signal, "SIGKILL")
    assert.equal(command === "git" ? result.state : result.tool.state, "unavailable")
  })
}

test("GivenCliInspectAndInvalidArguments_WhenRun_UsesDocumentedExitAndJsonContract", async () => {
  const root = await fixture({ "report.pdf": bytes })
  assert.equal(existsSync(cli), true, "the inspector CLI is missing")
  const before = snapshot(root)
  const result = spawnSync(process.execPath, [cli, "inspect", "--repo", root], { encoding: "utf8" })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(JSON.parse(result.stdout).state, "inspected")
  assert.deepEqual(snapshot(root), before)
  const refused = spawnSync(process.execPath, [cli, "setup", "--repo", root], { encoding: "utf8" })
  assert.equal(refused.status, 2)
  assert.equal(JSON.parse(refused.stdout).state, "usage")
  const absent = spawnSync(process.execPath, [cli, "inspect", "--repo", path.join(root, "missing")], { encoding: "utf8" })
  assert.equal(absent.status, 1)
  assert.equal(JSON.parse(absent.stdout).state, "not_git")
})
