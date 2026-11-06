import { createHash, randomUUID } from "node:crypto"
import { spawnSync } from "node:child_process"
import { promises as fs, constants, mkdtempSync, lstatSync } from "node:fs"
import path from "node:path"
import os from "node:os"
import { producerExecution, validateExecution, assertExecution, producerCommandOutcome, assertFirstCommandEnvironment } from "./producer-state.js"
import { prepareDeskSaveInput } from "../tools/desk-save.js"
import { isLiveCardPath } from "../desk/card-commit-guard.js"
import { personPrefix, isPathContained, resolveWriteTarget } from "../util/paths.js"

const fault = (code) => Object.assign(new Error(code), { code })
const hash = (content) => createHash("sha256").update(content).digest("hex")
const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u
// Failed handles must not be finalized before the owned process settles.
const pendingFileHandles = new Set()
const identity = (stat) => ({ dev: String(stat.dev), ino: String(stat.ino), mode: String(stat.mode) })
function canonicalSaveValidationInput(payload, producerDeadline) {
  const check = () => { if (Date.now() >= producerDeadline) throw fault("producer_deadline") }
  check()
  if (payload === null || typeof payload !== "object" || Array.isArray(payload) ||
    Reflect.ownKeys(payload).length !== 4 ||
    !["paths", "files", "message", "tidy"].every(key => Object.hasOwn(payload, key)) ||
    !Array.isArray(payload.paths) || !Array.isArray(payload.files) ||
    payload.paths.length + payload.files.length === 0 ||
    typeof payload.message !== "string" || payload.message.length === 0 || typeof payload.tidy !== "boolean") {
    throw fault("producer_payload_unqualified")
  }
  for (let index = 0; index < payload.paths.length; index++) {
    check()
    if (!Object.hasOwn(payload.paths, index) || typeof payload.paths[index] !== "string") throw fault("producer_payload_unqualified")
  }
  for (let index = 0; index < payload.files.length; index++) {
    check()
    if (!Object.hasOwn(payload.files, index)) throw fault("producer_payload_unqualified")
    const file = payload.files[index]
    if (file === null || typeof file !== "object" || Array.isArray(file) ||
      !Object.hasOwn(file, "path") || !Object.hasOwn(file, "content") ||
      typeof file.path !== "string" || typeof file.content !== "string") throw fault("producer_payload_unqualified")
  }
  check()
  return { message: payload.message, tidy: payload.tidy,
    ...(payload.paths.length ? { paths: payload.paths } : {}),
    ...(payload.files.length ? { files: payload.files } : {}) }
}
function parseIndex(text) {
  return text.split("\0").filter(Boolean).map((record) => {
    const split = record.indexOf("\t"), [mode, sha, stage] = record.slice(0, split).split(" ")
    if (!OID.test(sha) || stage !== "0") throw fault("producer_index_unqualified")
    return { mode, sha, stage, path: record.slice(split + 1) }
  })
}
export async function commitAcceptedPaths({ executionCapability, root, paths, entries, message, stateBranch }) {
  const execution = producerExecution(executionCapability)
  await validateExecution(executionCapability)
  if (Date.now() >= execution.producerDeadline) throw fault("producer_deadline")
  const plan = execution.commitPlan
  if (!plan || plan.dispatched || root !== execution.authority.root || message !== plan.message ||
    JSON.stringify(paths) !== JSON.stringify(plan.proof.exactPaths) ||
    (stateBranch !== undefined && stateBranch !== execution.authority.binding.branch.slice("refs/heads/".length)) ||
    (entries !== undefined && JSON.stringify(entries) !== JSON.stringify(plan.proof.expected))) throw fault("producer_commit_plan_refused")
  plan.dispatched = true
  const result = await plan.commit()
  return { ok: result.status === 0 && !result.error, stderr: result.status === 0 && !result.error ? "" : result.error?.code ?? "producer_commit_failed",
    provisional: { status: result.status, error: result.error?.code ?? null, proof: plan.proof, attribution: "provisional" } }
}

/** Executes inside the already owned native group; never starts or waits for an ancestor owner. */
export async function executeAcceptedDeskSave({ executionCapability }) {
  const execution = producerExecution(executionCapability)
  const { authority, producerDeadline, publicationDeadline, id } = execution
  const root = authority.root, env = { ...authority.env, DESK_TOOL_COMMIT: "1", GIT_TERMINAL_PROMPT: "0" }
  let sequence = 0, privateResource = null, command = null, proof = null
  let activeStep = null, failureStage = "pre-admission"
  const effects = { status: "unknown", applied_paths: [], uncertain_paths: [], open_files: [], dispatches: [], readback_required: true }
  const finish = (outcome) => {
    if (execution.terminalSchema !== 2) return outcome
    const failure = outcome.state === "blocked" ? {
      code: outcome.reason, stage: failureStage, phase: activeStep?.phase ?? null,
      intentSequence: activeStep?.sequence ?? sequence,
      dispatchState: effects.dispatches.some(step => step.sequence === activeStep?.sequence)
        ? effects.dispatches.find(step => step.sequence === activeStep.sequence).state : "not_admitted",
    } : undefined
    return { ...outcome, reason: outcome.reason ?? null, command: outcome.command ?? null, proof: outcome.proof ?? null,
      protocol: { ...execution.protocol }, ...(failure ? { failure } : {}) }
  }
  const check = async (file) => {
    if (Date.now() >= producerDeadline) throw fault("producer_deadline")
    await validateExecution(executionCapability)
    if (Date.now() >= producerDeadline) throw fault("producer_deadline")
    if (file !== undefined) {
      const prefix = path.resolve(personPrefix(root, authority.person)), absolute = path.resolve(root, file)
      if (!isPathContained(prefix, absolute)) throw fault("producer_path_refused")
      const segments = path.relative(prefix, absolute).split(path.sep).filter(Boolean)
      if (segments.length) await resolveWriteTarget({ deskRoot: root, person: authority.person, segments })
      if (Date.now() >= producerDeadline) throw fault("producer_deadline")
      await validateExecution(executionCapability)
      if (Date.now() >= producerDeadline) throw fault("producer_deadline")
    }
  }
  const mutate = async (phase, detail, work) => {
    failureStage = "pre-admission"
    activeStep = { id, sequence: ++sequence, phase, detail, producerDeadline }
    await check(detail.path)
    const step = activeStep
    await execution.approve(step)
    await check(detail.path)
    assertExecution(executionCapability)
    failureStage = "work"
    effects.dispatches.push({ ...step, state: "unknown" })
    const value = await work()
    let fileResource
    if (phase === "open") {
      pendingFileHandles.add(value)
      fileResource = { path: path.resolve(root, detail.path), relativePath: detail.path, descriptor: value.fd, closed: false }
      effects.open_files.push(fileResource)
    }
    effects.dispatches.at(-1).state = "completed"
    failureStage = "report"
    await execution.report({ kind: "phase-result", sequence, phase, status: "completed",
      ...(fileResource ? { file_resource: { path: detail.path, descriptor: fileResource.descriptor } } : {}) })
    return value
  }
  const git = (args, extra = {}) => {
    const remaining = producerDeadline - Date.now()
    if (remaining <= 0) throw fault("producer_deadline")
    if (execution.terminalSchema === 2) assertFirstCommandEnvironment({ executionCapability, env })
    return spawnSync("git", ["-C", root, ...args], { env, encoding: "utf8", timeout: Math.min(10000, remaining),
      maxBuffer: 1024 * 1024, ...extra })
  }
  const read = (args) => {
    const result = git(args)
    if (result.status !== 0 || result.error) throw fault(result.error?.code ?? "producer_inspection_failed")
    return result.stdout
  }
  try {
    if (execution.terminalSchema === 2) await execution.started()
    await check()
    const input = await prepareDeskSaveInput({ deskRoot: root, person: authority.person,
      input: canonicalSaveValidationInput(execution.payload, producerDeadline), deadline: producerDeadline })
    await check()
    for (const { absolute, relativePath, content } of input.checkedFiles) {
      await mutate("mkdir", { path: relativePath }, () => fs.mkdir(path.dirname(absolute), { recursive: true }))
      effects.uncertain_paths = [relativePath]
      const handle = await mutate("open", { path: relativePath }, () =>
        fs.open(absolute, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o644))
      const fileResource = effects.open_files.at(-1)
      await mutate("write", { path: relativePath, descriptor: handle.fd, bytes: Buffer.byteLength(content), sha256: hash(content) },
        () => handle.writeFile(content, "utf8"))
      await mutate("close", { path: relativePath, descriptor: handle.fd }, async () => {
        try {
          await handle.close()
          pendingFileHandles.delete(handle)
          fileResource.closed = true
        }
        catch (error) { fileResource.close_error = { code: error.code ?? "producer_file_close_unknown" }; throw error }
      })
      effects.applied_paths.push(relativePath)
      effects.uncertain_paths = []
    }
    const paths = [...new Set([...input.paths, ...input.files.map((file) => file.path)]
      .map((file) => path.posix.normalize(file).replace(/\/$/u, "")))]
    for (const file of paths) await check(file)
    if (read(["ls-files", "-u", "-z", "--", ...paths]).trim()) throw fault("producer_index_conflicted")
    const head = git(["rev-parse", "--verify", "-q", "HEAD"])
    const parent = head.status === 0 && !head.error ? head.stdout.trim() : null
    if (!parent) {
      const branch = git(["show-ref", "--verify", "--quiet", authority.binding.branch])
      if (head.status !== 1 || head.error || branch.status !== 1 || branch.error) throw fault("producer_parent_unqualified")
    } else if (!OID.test(parent)) throw fault("producer_parent_unqualified")
    const unstaged = [...new Set([
      ...read(["diff", "--name-only", "-z", "--", ...paths]).split("\0").filter(Boolean),
      ...read(["ls-files", "--others", "--exclude-standard", "-z", "--", ...paths]).split("\0").filter(Boolean),
    ])]
    if (input.tidy && unstaged.some(isLiveCardPath)) throw fault("producer_tidy_card_refused")
    if (unstaged.length) {
      for (const file of unstaged) await check(file)
      await mutate("stage", { args: ["add", "-A", "--", ...unstaged] }, () => {
        const result = git(["add", "-A", "--", ...unstaged])
        if (result.status !== 0 || result.error) throw fault(result.error?.code ?? "producer_stage_failed")
      })
    }
    const staged = read(["diff", "--cached", "-M", "--name-status", "-z"])
    const changes = staged.split("\0").filter(Boolean)
    const covered = (file) => paths.some((selection) => selection === "." || file === selection || file.startsWith(`${selection}/`))
    let selectedChanges = 0
    for (let index = 0; index < changes.length;) {
      const status = changes[index++], count = /^[RC]/u.test(status) ? 2 : 1
      const files = changes.slice(index, index + count); index += count
      if (files.some(covered) && !files.every(covered)) throw fault("producer_rename_incomplete")
      if (files.some(covered)) {
        selectedChanges++
        if (input.tidy && files.some(isLiveCardPath) && status !== "R100" && status !== "D") throw fault("producer_tidy_card_refused")
      }
    }
    if (!selectedChanges) return finish({ state: "body_settled", reason: "nothing_to_commit", effects,
      ...(execution.terminalSchema === 2 ? { noOpWitness: { status: 0, error: null, signal: null, selectedChangedPaths: [] } } : {}),
      producerDeadline, publicationDeadline, attribution: "provisional", publication: "not_started" })
    const expected = parseIndex(read(["ls-files", "-s", "-z", "--", ...paths]))
    const parentFiles = parent ? read(["ls-tree", "-r", "--name-only", "-z", parent, "--", ...paths]).split("\0").filter(Boolean) : []
    const exactPaths = [...new Set([...expected.map((entry) => entry.path), ...parentFiles])]
    if (!exactPaths.length) {
      if (execution.terminalSchema === 2) throw fault("producer_index_unqualified")
      return { state: "body_settled", reason: "nothing_to_commit", effects,
        producerDeadline, publicationDeadline, attribution: "provisional", publication: "not_started" }
    }
    for (const file of exactPaths) await check(file)
    const witness = Object.hasOwn(env, "GIT_REFLOG_ACTION") ? null : `desk-publication:${id}`
    if (witness) env.GIT_REFLOG_ACTION = witness
    if (input.tidy) {
      const directory = await mutate("private-index-directory", { resource: "private-index" },
        () => mkdtempSync(path.join(os.tmpdir(), "desk-producer-body-index-")))
      privateResource = { path: directory, identity: null, custody: "unknown-until-outer-settlement", children: [] }
      privateResource.identity = identity(lstatSync(directory, { bigint: true }))
      await execution.report({ kind: "private-resource", private_resource: privateResource })
      env.GIT_INDEX_FILE = path.join(directory, "index")
      if (execution.terminalSchema === 2) execution.commandIndexPath = env.GIT_INDEX_FILE
      await mutate("private-read-tree", { args: parent ? ["read-tree", parent] : ["read-tree", "--empty"], private_resource: privateResource }, () => {
        const result = git(parent ? ["read-tree", parent] : ["read-tree", "--empty"])
        if (result.status !== 0 || result.error) throw fault("producer_private_index_failed")
      })
      privateResource.children.push({ path: path.join(directory, "index"),
        identity: identity(lstatSync(path.join(directory, "index"), { bigint: true })), custody: "native-writer-observation" })
      const held = new Set(expected.map((entry) => entry.path))
      const indexInput = [...expected.map((entry) => `${entry.mode} ${entry.sha}\t${entry.path}\0`),
        ...exactPaths.filter((file) => !held.has(file)).map((file) => `0 ${"0".repeat(parent?.length ?? 40)}\t${file}\0`)].join("")
      await mutate("private-update-index", { args: ["update-index", "-z", "--index-info"], inputSha256: hash(indexInput),
        private_resource: privateResource }, () => {
        const result = git(["update-index", "-z", "--index-info"], { input: indexInput })
        if (result.status !== 0 || result.error) throw fault("producer_private_index_failed")
      })
      privateResource.children[0].laterIdentity = identity(lstatSync(path.join(directory, "index"), { bigint: true }))
    }
    proof = { parent, expected, exactPaths, witness, branch: authority.binding.branch }
    execution.commitPlan = { message: input.message, proof, dispatched: false, commit: () =>
      mutate("commit", { args: ["commit", "-m", input.message, ...(input.tidy ? [] : ["--", ...exactPaths])], proof }, () => {
      const result = git(["commit", "-m", input.message, ...(input.tidy ? [] : ["--", ...exactPaths])])
      command = { ...producerCommandOutcome(result), ...(execution.terminalSchema === 2 ? { signal: result.signal ?? null } : {}) }
      // A native command failure may already have committed: preserve result, never replay.
      return result
    }) }
    const committed = await commitAcceptedPaths({ executionCapability, root, paths: exactPaths, message: input.message,
      stateBranch: authority.binding.branch.slice("refs/heads/".length) })
    if (!committed.ok) return finish({ state: "blocked", reason: "producer_commit_failed", effects, command, proof,
      private_resource: privateResource, producerDeadline, publicationDeadline, attribution: "provisional", publication: "not_started" })
    return finish({ state: "body_settled", effects, command, proof, private_resource: privateResource,
      producerDeadline, publicationDeadline, attribution: "provisional", publication: "not_started" })
  } catch (error) {
    if (error.file_resource) effects.open_files.push(error.file_resource)
    return finish({ state: "blocked", reason: error.code ?? "producer_body_failed",
      close_error: error.close_error, effects, command, proof, private_resource: privateResource,
      producerDeadline, publicationDeadline, attribution: "provisional", publication: "not_started" })
  }
}
