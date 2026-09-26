import { test, beforeEach, afterEach } from "node:test"
import { strict as assert } from "node:assert"
import * as path from "node:path"
import { tmpdir } from "node:os"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { resolveWriteTarget } from "../../src/util/paths.js"

let fixtureRoot
beforeEach(() => {
  fixtureRoot = mkdtempSync(path.join(tmpdir(), "superpowers-context-"))
  mkdirSync(path.join(fixtureRoot, "desk", "desks", "member"), { recursive: true })
  seedCanonicalFiles(context())
})
afterEach(() => rmSync(fixtureRoot, { recursive: true, force: true }))

async function loadResolver() {
  const { resolveSuperpowersContext } = await import("../../src/activation/superpowers-context.js")
  return resolveSuperpowersContext
}

async function resolve(input) {
  const before = snapshotTree()
  try {
    return await (await loadResolver())(input)
  } finally {
    assert.deepEqual(snapshotTree(), before, "context resolution must preserve the complete existing tree and file bytes")
  }
}

function snapshotTree() {
  return readdirSync(fixtureRoot, { recursive: true, withFileTypes: true })
    .map((entry) => {
      const file = path.join(entry.parentPath, entry.name)
      return [path.relative(fixtureRoot, file), entry.isDirectory() ? null : readFileSync(file)]
    })
    .sort(([left], [right]) => left.localeCompare(right))
}

function seedCanonicalFiles(input) {
  for (const [file, bytes] of [
    [path.join(input.taskPath, "task.md"), `---\ntitle: ${path.basename(input.taskPath)}\nstatus: doing\n---\n`],
    [input.planPath, "# Fixture plan\n\nPreserve the approved fixture scope.\n"],
    [path.join(input.iterationPath, "doing.md"), "# Fixture progress\n\nRetain the recorded ruling.\n"],
  ]) {
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, bytes)
  }
}

function context(overrides = {}) {
  const deskRoot = path.join(fixtureRoot, "desk")
  const taskPath = path.join(deskRoot, "desks", "member", "track", "outcome")
  const iterationPath = path.join(taskPath, "repository", "2026-09-09-initial-impl")
  return {
    deskRoot,
    person: "member",
    taskPath,
    iterationPath,
    planPath: path.join(iterationPath, "planning.md"),
    evidenceRoot: path.join(fixtureRoot, "protected-evidence"),
    step: 1,
    attempt: 1,
    ...overrides,
  }
}

test("Superpowers context prints exact paths without introducing a second progress or ruling store", async () => {
  const input = context()
  const output = await resolve(input)
  const artifactDirectory = path.join(input.evidenceRoot, path.relative(input.deskRoot, input.iterationPath), "superpowers", "step-1", "attempt-1")
  assert.deepEqual(output, {
    taskCardPath: path.join(input.taskPath, "task.md"),
    iterationPath: input.iterationPath,
    planPath: input.planPath,
    progressPath: path.join(input.iterationPath, "doing.md"),
    rulingsPath: path.join(input.iterationPath, "doing.md"),
    artifactDirectory,
    briefPath: path.join(artifactDirectory, "brief.md"),
    implementationReportPath: path.join(artifactDirectory, "implementation-report.md"),
    reviewPackagePath: path.join(artifactDirectory, "review.patch"),
    reviewReportPath: path.join(artifactDirectory, "review-report.md"),
    briefRules: [
      "verify or validate in your own worktree; never in a checkout your task does not own",
      "on return list every created worktree and branch, its exact repository/path/ref, current state, owner and verified disposition in the mapped Resources record; close out only exact-owned safe resources through desk:git-hygiene",
    ],
    cleanupPaths: [],
  })
  assert.equal(JSON.stringify(output).includes(".superpowers"), false)
})

test("optional plan maps task-card-only work without creating provider files", async () => {
  const input = context()
  delete input.planPath
  rmSync(path.join(input.iterationPath, "doing.md"))
  const output = await resolve(input)
  assert.equal(output.planPath, null)
  assert.equal(output.progressPath, path.join(input.taskPath, "task.md"))
  assert.equal(output.rulingsPath, path.join(input.taskPath, "task.md"))
  assert.deepEqual(output.cleanupPaths, [])
})

test("empty optional artifact paths are refused rather than silently rebound", async () => {
  for (const key of ["planPath", "progressPath"]) {
    for (const value of ["", 42]) {
      await assert.rejects(resolve({ ...context(), [key]: value }), /must be a non-empty path/)
    }
  }
})

test("CLI refuses an option without its value before producing a context", () => {
  const result = spawnSync(process.execPath, [
    fileURLToPath(new URL("../../src/activation/superpowers-context.js", import.meta.url)), "--desk-root",
  ], { encoding: "utf8" })
  assert.equal(result.status, 1)
  assert.equal(result.stdout, "")
  assert.match(result.stderr, /value required for --desk-root/)
})

test("explicit provider progress wins without renaming legacy doing", async () => {
  const input = context()
  input.progressPath = path.join(input.iterationPath, "superpowers-progress.md")
  writeFileSync(input.progressPath, "# Provider progress\n")
  const output = await resolve(input)
  assert.equal(output.progressPath, input.progressPath)
  assert.equal(output.rulingsPath, input.progressPath)
  assert.equal(existsSync(path.join(input.iterationPath, "doing.md")), true)
})

test("omitted progress still prefers the existing iteration doing record over the task card", async () => {
  const input = context()
  delete input.progressPath
  const output = await resolve(input)
  assert.equal(output.progressPath, path.join(input.iterationPath, "doing.md"))
  assert.equal(output.rulingsPath, output.progressPath)
})

test("an in-task symlink to a neighbouring task's record is refused as progress", async () => {
  const input = context()
  const otherTask = path.join(input.deskRoot, "desks", "member", "track", "linked-outcome")
  const otherIteration = path.join(otherTask, "repository", "2026-09-09-initial-impl")
  const neighbour = context({ taskPath: otherTask, iterationPath: otherIteration, planPath: path.join(otherIteration, "planning.md") })
  seedCanonicalFiles(neighbour)
  const links = [
    [path.join(input.iterationPath, "linked-task-card.md"), path.join(otherTask, "task.md")],
    [path.join(input.iterationPath, "linked-doing.md"), path.join(otherIteration, "doing.md")],
  ]
  for (const [link, destination] of links) symlinkSync(destination, link, "file")
  const before = snapshotTree()
  const resolveContext = await loadResolver()
  for (const [link, destination] of links) {
    await assert.rejects(() => resolveContext({ ...input, progressPath: link }), {
      message: "Superpowers context: progressPath must be within taskPath",
    })
    assert.equal(realpathSync(link), realpathSync(destination), "the fixture link must really resolve into the neighbouring task")
    assert.equal(statSync(link).isFile(), true, "the fixture link must look like a regular file to a follow-the-link stat")
  }
  assert.deepEqual(snapshotTree(), before, "refusing a task-escaping link must not rewrite the neighbouring task")
})

test("an in-task symlink to this task's own record stays usable as progress", async () => {
  const input = context()
  const link = path.join(input.iterationPath, "superpowers-progress.md")
  symlinkSync(path.join(input.iterationPath, "doing.md"), link, "file")
  const output = await resolve({ ...input, progressPath: link })
  assert.equal(output.progressPath, link)
  assert.equal(output.rulingsPath, link)
})

test("explicit provider progress in another task of the same person is refused", async () => {
  const input = context()
  const otherTask = path.join(input.deskRoot, "desks", "member", "track", "neighbour-outcome")
  const otherIteration = path.join(otherTask, "repository", "2026-09-09-initial-impl")
  const neighbour = context({ taskPath: otherTask, iterationPath: otherIteration, planPath: path.join(otherIteration, "planning.md") })
  seedCanonicalFiles(neighbour)
  const before = snapshotTree()
  const resolveContext = await loadResolver()
  for (const foreign of [path.join(otherIteration, "doing.md"), path.join(otherTask, "task.md")]) {
    await assert.rejects(() => resolveContext({ ...input, progressPath: foreign }), {
      message: "Superpowers context: progressPath must be within taskPath",
    })
  }
  assert.deepEqual(snapshotTree(), before, "refusing a neighbouring task's canonical state must not rewrite it")
})

test("explicit provider progress in another person's desk is refused rather than written", async () => {
  const input = context()
  const foreignIteration = path.join(input.deskRoot, "desks", "other", "track", "outcome", "repository", "2026-09-09-initial-impl")
  mkdirSync(foreignIteration, { recursive: true })
  input.progressPath = path.join(foreignIteration, "superpowers-progress.md")
  writeFileSync(input.progressPath, "# Foreign progress\n")
  const before = snapshotTree()
  const resolveContext = await loadResolver()
  await assert.rejects(() => resolveContext(input), {
    message: "Superpowers context: progressPath must be within the effective Desk scope",
  })
  assert.deepEqual(snapshotTree(), before)
})

test("explicit provider progress that escapes the person root through a symlink is refused", async () => {
  const input = context()
  const elsewhere = path.join(fixtureRoot, "elsewhere")
  mkdirSync(elsewhere, { recursive: true })
  writeFileSync(path.join(elsewhere, "superpowers-progress.md"), "# Escaped progress\n")
  symlinkSync(elsewhere, path.join(input.iterationPath, "escape"), "dir")
  input.progressPath = path.join(input.iterationPath, "escape", "superpowers-progress.md")
  const resolveContext = await loadResolver()
  await assert.rejects(() => resolveContext(input), /write target resolves outside/u)
})

test("same-basename provider progress in different tasks never shares a ruling store", async () => {
  const first = context()
  first.progressPath = path.join(first.iterationPath, "superpowers-progress.md")
  writeFileSync(first.progressPath, "# First provider progress\n")
  const taskPath = path.join(first.deskRoot, "desks", "member", "track", "second-outcome")
  const iterationPath = path.join(taskPath, "repository", "2026-09-09-initial-impl")
  const second = context({ taskPath, iterationPath, planPath: path.join(iterationPath, "planning.md") })
  seedCanonicalFiles(second)
  second.progressPath = path.join(iterationPath, "superpowers-progress.md")
  writeFileSync(second.progressPath, "# Second provider progress\n")
  const left = await resolve(first)
  const right = await resolve(second)
  assert.equal(path.basename(left.progressPath), path.basename(right.progressPath))
  assert.notEqual(left.progressPath, right.progressPath)
  assert.notEqual(left.rulingsPath, right.rulingsPath)
  assert.notEqual(left.artifactDirectory, right.artifactDirectory)
})

test("same-basename planning files in different tasks never share artifacts", async () => {
  const first = context()
  const taskPath = path.join(first.deskRoot, "desks", "member", "track", "other-outcome")
  const iterationPath = path.join(taskPath, "repository", "2026-09-09-initial-impl")
  const second = context({ taskPath, iterationPath, planPath: path.join(iterationPath, "planning.md") })
  seedCanonicalFiles(second)
  const left = await resolve(first)
  const right = await resolve(second)
  assert.equal(path.basename(left.planPath), path.basename(right.planPath))
  assert.notEqual(left.artifactDirectory, right.artifactDirectory)
  assert.notEqual(left.progressPath, right.progressPath)
})

test("different iterations of one task retain distinct same-basename plans and evidence", async () => {
  const first = context()
  const iterationPath = path.join(first.taskPath, "repository", "2026-09-09-review-pass-1")
  const second = context({ iterationPath, planPath: path.join(iterationPath, "planning.md") })
  seedCanonicalFiles(second)
  assert.notEqual((await resolve(first)).artifactDirectory, (await resolve(second)).artifactDirectory)
})

test("interruption recovery keeps canonical progress and preserves the earlier attempt's evidence", async () => {
  const input = context()
  const priorDirectory = path.join(input.evidenceRoot, path.relative(input.deskRoot, input.iterationPath), "superpowers", "step-1", "attempt-1")
  mkdirSync(priorDirectory, { recursive: true })
  writeFileSync(path.join(priorDirectory, "implementation-report.md"), "Preserved earlier attempt.\n")
  const first = await resolve(input)
  assert.deepEqual(await resolve(context()), first)
  const resumed = await resolve(context({ attempt: 2 }))
  assert.equal(resumed.progressPath, first.progressPath)
  assert.equal(resumed.rulingsPath, first.rulingsPath)
  assert.notEqual(resumed.artifactDirectory, first.artifactDirectory)
  assert.deepEqual(resumed.cleanupPaths, [])
})

test("an explicit cross-repository Desk plan is preserved rather than rebound by basename", async () => {
  const input = context()
  input.planPath = path.join(input.deskRoot, "desks", "member", "track", "_planning", "planning.md")
  seedCanonicalFiles(input)
  assert.equal((await resolve(input)).planPath, input.planPath)
})

for (const [label, overrides, message] of [
  ["missing protected-evidence root", { evidenceRoot: undefined }, "Superpowers context: evidenceRoot is required"],
  ["invalid step", { step: 0 }, "Superpowers context: step must be a positive integer"],
  ["invalid attempt", { attempt: 0 }, "Superpowers context: attempt must be a positive integer"],
  ["task outside Desk", { taskPath: path.join(tmpdir(), "outside-task") }, "Superpowers context: taskPath must be within the effective Desk scope"],
  ["iteration outside task", { iterationPath: path.join(tmpdir(), "outside-iteration") }, "Superpowers context: iterationPath must be within taskPath"],
  ["plan outside Desk", { planPath: path.join(tmpdir(), "outside-plan.md") }, "Superpowers context: planPath must be within Desk"],
]) {
  test(`context fails closed for ${label}`, async () => {
    const resolveContext = await loadResolver()
    await assert.rejects(() => resolveContext(context(overrides)), { message })
  })
}

test("operational evidence is never mapped into the git-backed Desk", async () => {
  const input = context()
  input.evidenceRoot = path.join(input.deskRoot, "_private-looking-but-tracked")
  const resolveContext = await loadResolver()
  await assert.rejects(() => resolveContext(input), { message: "Superpowers context: evidenceRoot must be outside Desk" })
})

test("context canonical paths agree with existing Desk write-target authority", async () => {
  const input = context()
  const output = await resolve(input)
  const shared = { deskRoot: input.deskRoot, person: input.person, createPersonRoot: false }
  assert.equal(output.taskCardPath, await resolveWriteTarget({ ...shared, segments: ["track", "outcome", "task.md"] }))
  assert.equal(output.planPath, await resolveWriteTarget({ ...shared, segments: ["track", "outcome", "repository", "2026-09-09-initial-impl", "planning.md"] }))
  assert.equal(output.progressPath, await resolveWriteTarget({ ...shared, segments: ["track", "outcome", "repository", "2026-09-09-initial-impl", "doing.md"] }))
  assert.equal(existsSync(input.evidenceRoot), false)
  assert.equal(existsSync(input.taskPath), true)
})

for (const [label, kind, canonicalPath, makeExplicit] of [
  ["task.md", "task card", (input) => path.join(input.taskPath, "task.md"), () => {}],
  ["planning.md", "plan", (input) => input.planPath, () => {}],
  ["doing.md", "progress", (input) => path.join(input.iterationPath, "doing.md"), (input) => {
    input.progressPath = path.join(input.iterationPath, "doing.md")
  }],
]) {
  test(`context refuses missing canonical ${label} without modifying remaining files`, async () => {
    const input = context()
    makeExplicit(input)
    const missing = canonicalPath(input)
    rmSync(missing)
    const before = snapshotTree()
    const resolveContext = await loadResolver()
    await assert.rejects(() => resolveContext(input), { message: `Superpowers context: canonical ${kind} does not exist: ${missing}` })
    assert.deepEqual(snapshotTree(), before)
    assert.equal(existsSync(missing), false)
    assert.equal(existsSync(input.evidenceRoot), false)
  })
}

test("an explicit provider progress path that does not exist is refused instead of defaulted", async () => {
  const input = context()
  input.progressPath = path.join(input.iterationPath, "superpowers-progress.md")
  const before = snapshotTree()
  const resolveContext = await loadResolver()
  await assert.rejects(() => resolveContext(input), {
    message: `Superpowers context: canonical progress does not exist: ${input.progressPath}`,
  })
  assert.deepEqual(snapshotTree(), before)
  assert.equal(existsSync(input.progressPath), false)
})

test("an explicit provider progress directory is refused rather than treated as a record", async () => {
  const input = context()
  input.progressPath = path.join(input.iterationPath, "superpowers-progress.md")
  mkdirSync(input.progressPath)
  const before = snapshotTree()
  const resolveContext = await loadResolver()
  await assert.rejects(() => resolveContext(input), {
    message: `Superpowers context: canonical progress must be a regular file: ${input.progressPath}`,
  })
  assert.deepEqual(snapshotTree(), before)
})

test("context refuses a directory in place of a canonical file", async () => {
  const input = context()
  const notFile = path.join(input.iterationPath, "doing.md")
  rmSync(notFile)
  mkdirSync(notFile)
  const before = snapshotTree()
  const resolveContext = await loadResolver()
  await assert.rejects(() => resolveContext(input), { message: `Superpowers context: canonical progress must be a regular file: ${notFile}` })
  assert.deepEqual(snapshotTree(), before)
  assert.equal(existsSync(input.evidenceRoot), false)
})

test("context refuses a missing person root without provisioning it", async () => {
  const input = context()
  const personRoot = path.join(input.deskRoot, "desks", "member")
  rmSync(personRoot, { recursive: true })
  const resolveContext = await loadResolver()
  await assert.rejects(() => resolveContext(input), { message: `desk-mcp: effective write root does not exist: ${personRoot}` })
  assert.equal(existsSync(personRoot), false)
})

test("context rejects a different person's task instead of broadening write authority", async () => {
  const input = context({ person: "other" })
  const resolveContext = await loadResolver()
  await assert.rejects(() => resolveContext(input), { message: "Superpowers context: taskPath must be within the effective Desk scope" })
})

test("person-off context retains the ordinary Desk path authority", async () => {
  const input = context({ person: null })
  input.taskPath = path.join(input.deskRoot, "track", "outcome")
  input.iterationPath = path.join(input.taskPath, "repository", "2026-09-09-initial-impl")
  input.planPath = path.join(input.iterationPath, "planning.md")
  seedCanonicalFiles(input)
  const output = await resolve(input)
  assert.equal(output.taskCardPath, await resolveWriteTarget({
    deskRoot: input.deskRoot,
    person: null,
    createPersonRoot: false,
    segments: ["track", "outcome", "task.md"],
  }))
})

function commandArgs(input) {
  const helper = fileURLToPath(new URL("../../src/activation/superpowers-context.js", import.meta.url))
  const args = [
    helper,
    "--desk-root", input.deskRoot,
    "--person", input.person,
    "--task-path", input.taskPath,
    "--iteration-path", input.iterationPath,
  ]
  if (input.planPath !== undefined) args.push("--plan-path", input.planPath)
  if (input.progressPath !== undefined) args.push("--progress-path", input.progressPath)
  args.push(
    "--evidence-root", input.evidenceRoot,
    "--step", "1",
    "--attempt", "1",
  )
  return args
}

function runCommand(args) {
  return spawnSync(process.execPath, args, {
    cwd: fileURLToPath(new URL("../../../../../", import.meta.url)),
    encoding: "utf8",
  })
}

test("the read-only helper emits the exact bound paths through its command interface", async () => {
  const input = context()
  const before = snapshotTree()
  const result = runCommand(commandArgs(input))
  assert.deepEqual(snapshotTree(), before, "CLI resolution must preserve canonical bytes and create no evidence")
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(JSON.parse(result.stdout), await resolve(input))
})

test("CLI missing evidence root fails with its own diagnostic and no partial output or writes", () => {
  const args = commandArgs(context())
  args.splice(args.indexOf("--evidence-root"), 2)
  const before = snapshotTree()
  const result = runCommand(args)
  assert.deepEqual(snapshotTree(), before)
  assert.equal(result.status, 1)
  assert.equal(result.stdout, "")
  assert.equal(result.stderr.trim(), "Superpowers context: evidenceRoot is required")
})

test("CLI unknown option fails with its own diagnostic and no partial output or writes", () => {
  const before = snapshotTree()
  const result = runCommand([...commandArgs(context()), "--unexpected"])
  assert.deepEqual(snapshotTree(), before)
  assert.equal(result.status, 1)
  assert.equal(result.stdout, "")
  assert.equal(result.stderr.trim(), "Superpowers context: unknown argument --unexpected")
})

test("the CLI prints the same explicit plan and provider progress paths as the resolver", async () => {
  const input = context()
  input.progressPath = path.join(input.iterationPath, "superpowers-progress.md")
  writeFileSync(input.progressPath, "# Provider progress\n")
  const before = snapshotTree()
  const result = runCommand(commandArgs(input))
  assert.deepEqual(snapshotTree(), before, "CLI resolution must preserve canonical bytes and create no evidence")
  assert.equal(result.status, 0, result.stderr)
  const printed = JSON.parse(result.stdout)
  assert.equal(printed.planPath, input.planPath)
  assert.equal(printed.progressPath, input.progressPath)
  assert.equal(printed.rulingsPath, input.progressPath)
  assert.deepEqual(printed, await resolve(input))
})

test("the CLI maps task-card-only work when the plan option is omitted", async () => {
  const input = context()
  delete input.planPath
  rmSync(path.join(input.iterationPath, "doing.md"))
  const before = snapshotTree()
  const result = runCommand(commandArgs(input))
  assert.deepEqual(snapshotTree(), before)
  assert.equal(result.status, 0, result.stderr)
  const printed = JSON.parse(result.stdout)
  assert.equal(printed.planPath, null)
  assert.equal(printed.progressPath, path.join(input.taskPath, "task.md"))
  assert.deepEqual(printed, await resolve(input))
})
