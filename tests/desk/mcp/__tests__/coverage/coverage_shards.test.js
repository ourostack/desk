// The sharded coverage gate: CI runs the instrumented suite as parallel shards and admits their combined raw coverage once.
//
// These tests hold the rules that keep a sharded run exactly as strict as one whole-suite run: every test file runs in exactly one shard, every shard of the split passed and measured the same changed files, and the 100% gate applies to the merged result.

import { test } from "node:test"
import { strict as assert } from "node:assert"
import { spawnSync } from "node:child_process"
import { existsSync, globSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import processOnSpawn from "process-on-spawn"
import {
  collectCoverageTestFiles,
  parseCoverageArguments,
  partitionCoverageTestFiles,
  runCoverageCommand,
} from "../../../../../plugins/desk/mcp/src/coverage/runner.js"

const mcpRoot = fileURLToPath(new URL("../../../../../plugins/desk/mcp/", import.meta.url))
const realRepoRoot = path.resolve(mcpRoot, "..", "..", "..")
const sourceFile = "plugins/desk/mcp/src/covered.js"
const testFiles = [
  "tests/desk/mcp/__tests__/a.test.js",
  "tests/desk/mcp/__tests__/nested/b.test.js",
  "tests/desk/mcp/__tests__/nested/deeper/c.test.js",
]

function metrics(pct = 100) {
  return { lines: { pct }, branches: { pct }, functions: { pct }, statements: { pct } }
}

function makeRoot(t, prefix) {
  const root = mkdtempSync(path.join(tmpdir(), prefix))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return root
}

function write(root, relative, body = "") {
  const file = path.join(root, relative)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, body)
  return file
}

/** A fixture repository with the gate's config, package script, workflow, one changed source file and three test files. */
function fixtureRepo(t, { weights, tests = testFiles } = {}) {
  const root = makeRoot(t, "desk-coverage-shards-")
  const repoRoot = path.join(root, "repo")
  const paths = {
    repoRoot,
    mcpRoot: path.join(repoRoot, "plugins/desk/mcp"),
    configPath: write(repoRoot, "plugins/desk/mcp/config/coverage-gate.json", JSON.stringify({
      thresholds: { lines: 100, branches: 100, functions: 100, statements: 100 },
      exclusions: [],
    })),
    packageJsonPath: write(repoRoot, "plugins/desk/mcp/package.json", JSON.stringify({
      scripts: { "test:coverage": "node scripts/run-coverage.js" },
    })),
    workflowPath: write(repoRoot, ".github/workflows/desk-mcp-tests.yml", [
      "on:",
      "  pull_request:",
      "    paths:",
      '      - "scripts/*.cjs"',
      "  push:",
      "    paths:",
      '      - "scripts/*.cjs"',
      "jobs:",
      "  tests:",
      "    steps:",
      "      - run: npm run test:coverage",
    ].join("\n")),
    ...(weights ? { shardWeightsPath: write(repoRoot, "plugins/desk/mcp/config/coverage-shards.json", JSON.stringify(weights)) } : {}),
  }
  write(repoRoot, sourceFile, "export const covered = true\n")
  for (const file of tests) write(repoRoot, file, "")
  return { root, repoRoot, paths }
}

/** Run the command against a fixture with a fake Git and a fake producer. `producer` answers the node invocation. */
function run(fixture, argv, { producer = () => ({ status: 0, stdout: "", stderr: "" }), changedFiles = [sourceFile] } = {}) {
  const output = { stdout: "", stderr: "" }
  const invocations = []
  const reportDirectories = []
  const result = runCoverageCommand({
    argv,
    paths: fixture.paths,
    env: {},
    io: {
      stdout: { write: (text) => { output.stdout += text } },
      stderr: { write: (text) => { output.stderr += text } },
    },
    fsOps: {
      makeTempDir: () => {
        const directory = mkdtempSync(path.join(fixture.root, "report-"))
        reportDirectories.push(directory)
        return directory
      },
      removeDir: (directory) => rmSync(directory, { recursive: true, force: true }),
      readText: (file) => readFileSync(file, "utf8"),
      writeText: (file, text) => writeFileSync(file, text),
    },
    spawn: (command, args, options) => {
      if (command === process.execPath) {
        const configPath = args[args.indexOf("--nycrc-path") + 1]
        const invocation = { args, options, config: JSON.parse(readFileSync(configPath, "utf8")) }
        invocations.push(invocation)
        return producer(invocation)
      }
      assert.equal(command, "git")
      if (args.join(" ") === "merge-base origin/main HEAD") return { status: 0, stdout: "base\n", stderr: "" }
      if (args.join(" ") === "diff --name-only --diff-filter=AM base..HEAD") return { status: 0, stdout: changedFiles.join("\n"), stderr: "" }
      return { status: 0, stdout: "", stderr: "" }
    },
  })
  for (const directory of reportDirectories) assert.equal(existsSync(directory), false, "the owned report directory must be removed")
  return { result, output, invocations }
}

/** A producer that behaves like one shard of nyc: raw coverage and process bookkeeping in its temp dir. */
function shardProducer({ status = 0, raw = { "coverage-1.json": "{}" } } = {}) {
  return ({ config }) => {
    mkdirSync(path.join(config.tempDir, "processinfo"), { recursive: true })
    writeFileSync(path.join(config.tempDir, "processinfo", "index.json"), "{}")
    for (const [name, body] of Object.entries(raw)) writeFileSync(path.join(config.tempDir, name), body)
    return { status, stdout: "tap output\n", stderr: "" }
  }
}

/** Write shard manifests the way a real shard would, under one merge input directory. */
function writeShards(fixture, manifests, { raw = true } = {}) {
  const input = path.join(fixture.root, "shards")
  for (const manifest of manifests) {
    const directory = path.join(input, `desk-coverage-shard-${manifest.index}`)
    write(directory, "shard.json", JSON.stringify({ schema_version: 1, status: 0, seconds: 1, required_files: [sourceFile], ...manifest }))
    if (raw) write(directory, `raw/coverage-${manifest.index}.json`, JSON.stringify({ shard: manifest.index }))
  }
  return input
}

function reportProducer(summary, result = { status: 0, stdout: "combined report\n", stderr: "report warnings\n" }) {
  return ({ args, config }) => {
    assert.equal(args[1], "report")
    if (summary) writeFileSync(path.join(config.reportDir, "coverage-summary.json"), JSON.stringify(summary))
    return result
  }
}

test("coverage arguments select a whole run, one shard of a split, or the merge", () => {
  assert.deepEqual(parseCoverageArguments([]), { mode: "full" })
  assert.deepEqual(parseCoverageArguments(["--shard", "2/8", "--output", "out"]), { mode: "shard", index: 2, total: 8, output: "out" })
  assert.deepEqual(parseCoverageArguments(["--merge", "in"]), { mode: "merge", input: "in" })
  for (const value of ["0/4", "5/4", "two/4"]) {
    assert.match(parseCoverageArguments(["--shard", value, "--output", "out"]).error, /--shard needs <index>\/<total>/u)
  }
  assert.match(parseCoverageArguments(["--shard"]).error, /--shard needs <index>\/<total> with 1 <= index <= total; got undefined/u)
  for (const rest of [[], ["--out", "dir"], ["--output", ""], ["--output", "dir", "extra"]]) {
    assert.match(parseCoverageArguments(["--shard", "1/2", ...rest]).error, /--shard needs --output <dir> and nothing else/u)
  }
  for (const argv of [["--merge"], ["--merge", ""], ["--merge", "in", "extra"], ["--whole"]]) {
    assert.match(parseCoverageArguments(argv).error, /unrecognized arguments/u)
  }
})

test("an unrecognized coverage argument measures nothing and claims no pass", (t) => {
  const fixture = fixtureRepo(t)
  const { result, output, invocations } = run(fixture, ["--shard", "3/2", "--output", "out"])
  assert.equal(result, 1)
  assert.equal(invocations.length, 0)
  assert.match(output.stderr, /--shard needs <index>\/<total>.*no coverage was measured/u)
  assert.doesNotMatch(output.stdout, /passed/u)
})

test("test-file discovery follows the whole-suite glob and adds the offline suite only when it is selected", (t) => {
  const root = makeRoot(t, "desk-coverage-discovery-")
  for (const file of [
    ...testFiles,
    "tests/desk/mcp/__tests__/helper.js",
    "tests/desk/mcp/__tests__/.hidden/d.test.js",
    "tests/desk/mcp/__tests__/node_modules/e.test.js",
    "evals/offline/__tests__/offline.test.mjs",
    "evals/offline/__tests__/helper.mjs",
    "scripts/test-skill-evals.cjs",
  ]) write(root, file)
  assert.deepEqual(collectCoverageTestFiles({ repoRoot: root, offline: { selected: false } }), testFiles)
  assert.deepEqual(collectCoverageTestFiles({ repoRoot: root, offline: { selected: true } }), [
    "evals/offline/__tests__/offline.test.mjs",
    ...testFiles,
    "scripts/test-skill-evals.cjs",
  ].sort())

  const bare = makeRoot(t, "desk-coverage-discovery-bare-")
  assert.deepEqual(collectCoverageTestFiles({ repoRoot: bare, offline: { selected: true } }), [])
})

test("test-file discovery finds exactly the files the whole-suite glob runs in this repository", () => {
  const globbed = globSync("tests/desk/mcp/__tests__/**/*.test.js", { cwd: realRepoRoot }).map((file) => file.replaceAll(path.sep, "/")).sort()
  assert.ok(globbed.length > 100, "the real suite must be found")
  assert.deepEqual(collectCoverageTestFiles({ repoRoot: realRepoRoot, offline: { selected: false } }), globbed)
})

test("the partition runs every file in exactly one shard and balances the recorded durations", () => {
  const files = ["a", "b", "c", "d", "e", "f"]
  const weights = { default_seconds: 2, file_seconds: { a: 10, b: 6, c: 5 } }
  const shards = partitionCoverageTestFiles({ files, total: 3, weights })
  assert.deepEqual(shards, [["a"], ["b", "e"], ["c", "d", "f"]])
  assert.deepEqual(shards.flat().sort(), files)
  assert.deepEqual(partitionCoverageTestFiles({ files: [...files].reverse(), total: 3, weights }), shards, "the input order does not change the split")

  // Without weights every file counts the same, so the split is by name.
  assert.deepEqual(partitionCoverageTestFiles({ files: ["c", "a", "b"], total: 2 }), [["a", "c"], ["b"]])
  assert.deepEqual(partitionCoverageTestFiles({ files: ["b", "a"], total: 2, weights: { file_seconds: {} } }), [["a"], ["b"]])
  // More shards than files leaves the extra shards empty rather than dropping or repeating a file.
  assert.deepEqual(partitionCoverageTestFiles({ files: ["a"], total: 3, weights: {} }), [["a"], [], []])
})

test("the committed shard weights are expected seconds per repository-relative test file", () => {
  const weights = JSON.parse(readFileSync(path.join(mcpRoot, "config", "coverage-shards.json"), "utf8"))
  assert.equal(weights.schema_version, 1)
  assert.equal(typeof weights.default_seconds, "number")
  assert.ok(Object.keys(weights.file_seconds).length > 100, "the weights must come from a real run")
  for (const [file, seconds] of Object.entries(weights.file_seconds)) {
    assert.match(file, /^(?:tests\/desk\/mcp\/__tests__\/.+\.test\.js|evals\/offline\/__tests__\/[^/]+\.test\.mjs|scripts\/test-skill-evals\.cjs)$/u, file)
    assert.ok(typeof seconds === "number" && seconds >= 0, file)
  }
})

test("a shard runs only its own files, serially, and records raw coverage, timings and a manifest for the merge", (t) => {
  const fixture = fixtureRepo(t, { weights: { default_seconds: 1, file_seconds: { [testFiles[2]]: 5 } } })
  const output = path.join(fixture.root, "shard-2")
  const { result, output: io, invocations } = run(fixture, ["--shard", "2/2", "--output", output], { producer: shardProducer() })
  assert.equal(result, 0)
  assert.equal(invocations.length, 1)
  const { args, config } = invocations[0]
  const shardFiles = [testFiles[0], testFiles[1]]
  assert.deepEqual(args.slice(-2), shardFiles.map((file) => path.join(realpathSync(fixture.repoRoot), file)))
  assert.ok(args.includes("--test-concurrency=1"), "instrumented files stay serial inside a shard")
  assert.ok(args.includes("--test-reporter=tap") && args.includes("--test-reporter-destination=stdout"), "the shard keeps its TAP log")
  assert.ok(args.includes(`--test-reporter-destination=${path.join(output, "timings.json")}`))
  assert.ok(args.includes(`--test-reporter=${path.join(mcpRoot, "../../../tests/desk/mcp/__tests__/_file_timing_reporter.mjs")}`))
  assert.equal(config.tempDir, path.join(output, "raw"))
  assert.equal(config.silent, true, "a shard reports nothing on its own")
  assert.deepEqual(config.include, [sourceFile])
  assert.deepEqual(readdirSync(path.join(output, "raw")), ["coverage-1.json"], "process bookkeeping does not travel to the merge")
  const manifest = JSON.parse(readFileSync(path.join(output, "shard.json"), "utf8"))
  assert.equal(manifest.schema_version, 1)
  assert.deepEqual({ ...manifest, seconds: 0 }, { schema_version: 1, index: 2, total: 2, status: 0, seconds: 0, required_files: [sourceFile], test_files: shardFiles })
  assert.match(io.stdout, /tap output/u)
  assert.match(io.stdout, /shard 2\/2 ran 2 test file\(s\) in [\d.]+ s with status 0; the merge step owns admission/u)
  assert.doesNotMatch(io.stdout, /passed/u)
})

test("a failing shard returns its status and records it, and an unfinished run is named", (t) => {
  const fixture = fixtureRepo(t)
  const failed = run(fixture, ["--shard", "1/1", "--output", path.join(fixture.root, "failed")], { producer: shardProducer({ status: 3 }) })
  assert.equal(failed.result, 3)
  assert.equal(JSON.parse(readFileSync(path.join(fixture.root, "failed", "shard.json"), "utf8")).status, 3)
  assert.doesNotMatch(failed.output.stderr, /could not finish/u)

  for (const [error, expected] of [[{ code: "ENOBUFS" }, /could not finish \(ENOBUFS\)/u], [{ message: "spawn failed" }, /could not finish \(spawn failed\)/u]]) {
    const output = path.join(fixture.root, `unfinished-${expected.source.length}`)
    const unfinished = run(fixture, ["--shard", "1/1", "--output", output], { producer: () => ({ status: null, error }) })
    assert.equal(unfinished.result, 1)
    assert.match(unfinished.output.stderr, expected)
    assert.equal(JSON.parse(readFileSync(path.join(output, "shard.json"), "utf8")).status, 1)
  }
})

test("an empty shard runs no tests and still reports itself to the merge", (t) => {
  const fixture = fixtureRepo(t, { tests: [testFiles[0]] })
  // A missing weights file only loses balance, never files.
  fixture.paths.shardWeightsPath = path.join(fixture.root, "absent-weights.json")
  const output = path.join(fixture.root, "empty")
  const { result, invocations } = run(fixture, ["--shard", "2/2", "--output", output])
  assert.equal(result, 0)
  assert.equal(invocations.length, 0)
  assert.deepEqual(JSON.parse(readFileSync(path.join(output, "shard.json"), "utf8")).test_files, [])
})

test("a shard refuses an output directory that already has content", (t) => {
  const fixture = fixtureRepo(t)
  const output = path.join(fixture.root, "occupied")
  write(output, "keep.txt", "keep")
  const { result, output: io, invocations } = run(fixture, ["--shard", "1/1", "--output", output])
  assert.equal(result, 1)
  assert.equal(invocations.length, 0)
  assert.match(io.stderr, /already has content; no coverage was measured/u)
  assert.equal(readFileSync(path.join(output, "keep.txt"), "utf8"), "keep")
})

test("the merge reports every shard's raw coverage once and applies the gate to the combined result", (t) => {
  const fixture = fixtureRepo(t)
  const input = writeShards(fixture, [
    { index: 1, total: 2, test_files: [testFiles[0], testFiles[2]] },
    { index: 2, total: 2, test_files: [testFiles[1]] },
  ])
  write(input, "stray-file.txt", "not a shard")
  mkdirSync(path.join(input, "not-a-shard"))
  write(input, "desk-coverage-shard-2/raw/notes.txt", "not coverage")
  let merged
  const { result, output, invocations } = run(fixture, ["--merge", input], {
    producer: (invocation) => {
      merged = readdirSync(invocation.config.tempDir).sort()
      return reportProducer({ [sourceFile]: metrics(), total: metrics() })(invocation)
    },
  })
  assert.equal(result, 0, output.stderr)
  assert.equal(invocations.length, 1)
  assert.deepEqual(merged, ["shard-1-coverage-1.json", "shard-2-coverage-2.json"])
  assert.deepEqual(invocations[0].config.include, [sourceFile])
  assert.equal(invocations[0].config.silent, undefined)
  assert.equal(invocations[0].options.env.DESK_COVERAGE_RUNNER_CHILD, "1")
  assert.match(output.stdout, /shard 1\/2: 2 test file\(s\) in 1 s\n.*shard 2\/2: 1 test file\(s\) in 1 s\ncombined report\n/su)
  assert.match(output.stderr, /report warnings/u)
  assert.match(output.stdout, /passed for 1 changed production file/u)
})

test("the merge fails a combined result below the gate", (t) => {
  const fixture = fixtureRepo(t)
  const input = writeShards(fixture, [{ index: 1, total: 1, test_files: testFiles }], { raw: false })
  const { result, output } = run(fixture, ["--merge", input], { producer: reportProducer({ [sourceFile]: metrics(75) }, { status: 0 }) })
  assert.equal(result, 1)
  assert.match(output.stderr, /covered\.js lines coverage 75 is below 100/u)
})

test("the merge refuses a split that is incomplete, repeated or mixed before reporting anything", (t) => {
  const fixture = fixtureRepo(t)
  const cases = [
    [[], /no coverage shard manifests/u],
    [[{ index: 1, total: 2, test_files: testFiles }], /exactly 1\.\.2 of one split; found 1\/2/u],
    [[{ index: 1, total: 2, test_files: testFiles }, { index: 2, total: 3, test_files: [] }], /found 1\/2, 2\/3/u],
    [[{ index: 1, total: 1, schema_version: 2, test_files: testFiles }], /exactly 1\.\.1 of one split/u],
  ]
  for (const [manifests, expected] of cases) {
    const shardFixture = fixtureRepo(t)
    const input = writeShards(shardFixture, manifests)
    const { result, output, invocations } = run(shardFixture, ["--merge", input])
    assert.equal(result, 1)
    assert.equal(invocations.length, 0, "nothing is reported for a refused split")
    assert.match(output.stderr, expected)
  }
  const missing = run(fixture, ["--merge", path.join(fixture.root, "absent")])
  assert.match(missing.output.stderr, /no coverage shard manifests/u)
})

test("the merge refuses a failed shard, a different changed-file set, and any test file run twice, never or unknown", (t) => {
  const fixture = fixtureRepo(t)
  const input = writeShards(fixture, [
    { index: 1, total: 3, status: 1, test_files: [testFiles[0], "tests/desk/mcp/__tests__/gone.test.js"] },
    { index: 2, total: 3, required_files: [], test_files: [testFiles[0]] },
    { index: 3, total: 3, test_files: undefined },
  ])
  const { result, output, invocations } = run(fixture, ["--merge", input])
  assert.equal(result, 1)
  assert.equal(invocations.length, 0)
  for (const expected of [
    /coverage shard 1\/3 finished with status 1/u,
    /coverage shard 2\/3 measured a different changed-file set than this merge/u,
    /coverage shard 3\/3 does not list its test files/u,
    /test files ran in more than one shard: tests\/desk\/mcp\/__tests__\/a\.test\.js/u,
    /test files no shard ran: tests\/desk\/mcp\/__tests__\/nested\/b\.test\.js, tests\/desk\/mcp\/__tests__\/nested\/deeper\/c\.test\.js/u,
    /shards ran test files this checkout does not have: tests\/desk\/mcp\/__tests__\/gone\.test\.js/u,
  ]) assert.match(output.stderr, expected)
})

test("the merge fails when the combined report cannot be produced", (t) => {
  for (const [answer, expected] of [
    [{ status: 2, stdout: "", stderr: "" }, /could not be produced \(status 2\)/u],
    [{ status: null, error: { code: "ENOBUFS" } }, /could not be produced \(ENOBUFS\)/u],
    [{ status: null, error: { message: "spawn failed" } }, /could not be produced \(spawn failed\)/u],
  ]) {
    const fixture = fixtureRepo(t)
    const input = writeShards(fixture, [{ index: 1, total: 1, test_files: testFiles }])
    const { result, output } = run(fixture, ["--merge", input], { producer: reportProducer(undefined, answer) })
    assert.equal(result, 1)
    assert.match(output.stderr, expected)
  }
})

test("real shards each cover part of a file, and only their merged coverage passes the gate", (t) => {
  const root = makeRoot(t, "desk-coverage-shards-real-")
  const repoRoot = path.join(root, "repo")
  const templateDirectory = path.join(root, "empty-template")
  mkdirSync(templateDirectory)
  const env = Object.fromEntries(
    ["PATH", "HOME", "SystemRoot", "WINDIR", "TEMP", "TMP"]
      .filter((name) => process.env[name] !== undefined)
      .map((name) => [name, process.env[name]]),
  )
  Object.assign(env, {
    DESK_COVERAGE_BASE_REF: "HEAD",
    GIT_CONFIG_GLOBAL: write(root, "empty-git-config"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TEMPLATE_DIR: templateDirectory,
  })
  const git = (...args) => {
    const result = spawnSync("git", ["-c", "user.name=Coverage Shards Test", "-c", "user.email=coverage-shards@example.invalid", ...args], { cwd: repoRoot, env, encoding: "utf8" })
    assert.equal(result.status, 0, result.stderr)
  }
  mkdirSync(repoRoot)
  git("init", "--quiet")
  git("commit", "--allow-empty", "--quiet", "-m", "fixture baseline")
  const paths = {
    repoRoot,
    mcpRoot: path.join(repoRoot, "plugins/desk/mcp"),
    configPath: write(repoRoot, "plugins/desk/mcp/config/coverage-gate.json", JSON.stringify({
      thresholds: { lines: 100, branches: 100, functions: 100, statements: 100 },
      exclusions: [],
    })),
    packageJsonPath: write(repoRoot, "plugins/desk/mcp/package.json", JSON.stringify({
      type: "module",
      scripts: { "test:coverage": "node scripts/run-coverage.js" },
    })),
    workflowPath: write(repoRoot, ".github/workflows/desk-mcp-tests.yml", [
      "on:",
      "  pull_request:",
      "    paths:",
      '      - "scripts/*.cjs"',
      "  push:",
      "    paths:",
      '      - "scripts/*.cjs"',
      "jobs:",
      "  tests:",
      "    steps:",
      "      - run: npm run test:coverage",
    ].join("\n")),
  }
  write(repoRoot, sourceFile, [
    "export function choose(flag) {",
    "  if (flag) return \"left\"",
    "  return \"right\"",
    "}",
    "",
  ].join("\n"))
  for (const [name, flag, expected] of [["left", true, "left"], ["right", false, "right"]]) {
    write(repoRoot, `tests/desk/mcp/__tests__/${name}.test.js`, [
      'import { test } from "node:test"',
      'import { strict as assert } from "node:assert"',
      'import { choose } from "../src/covered.js"',
      `test("${name} arm", () => assert.equal(choose(${flag}), "${expected}"))`,
      "",
    ].join("\n"))
  }
  const output = { stdout: "", stderr: "" }
  const command = (argv) => runCoverageCommand({
    argv,
    paths,
    env,
    io: {
      stdout: { write: (text) => { output.stdout += text } },
      stderr: { write: (text) => { output.stderr += text } },
    },
    spawn: (program, args, options) => {
      // A nested nyc process must not inherit the outer test run's measurement configuration.
      const isolateProducer = (child) => {
        if (program === process.execPath) child.env = { ...(options.env ?? env) }
      }
      processOnSpawn.addListener(isolateProducer)
      try {
        return spawnSync(program, args, { env, ...options, timeout: 60_000 })
      } finally {
        processOnSpawn.removeListener(isolateProducer)
      }
    },
  })
  const shards = path.join(root, "shards")
  assert.equal(command(["--shard", "1/2", "--output", path.join(shards, "one")]), 0, output.stderr)
  assert.equal(command(["--shard", "2/2", "--output", path.join(shards, "two")]), 0, output.stderr)
  const ran = ["one", "two"].map((name) => JSON.parse(readFileSync(path.join(shards, name, "shard.json"), "utf8")).test_files)
  assert.deepEqual(ran, [["tests/desk/mcp/__tests__/left.test.js"], ["tests/desk/mcp/__tests__/right.test.js"]])
  const timings = JSON.parse(readFileSync(path.join(shards, "one", "timings.json"), "utf8"))
  // The reporter keys files relative to this repository, so a fixture outside it shows up as a relative path that ends in the shard's one file.
  assert.equal(Object.keys(timings.file_seconds).length, 1)
  assert.ok(Object.keys(timings.file_seconds)[0].endsWith("tests/desk/mcp/__tests__/left.test.js"))
  assert.equal(typeof Object.values(timings.file_seconds)[0], "number")
  assert.match(output.stdout, /ok 1 - left arm/u, "a shard keeps its TAP log")

  output.stdout = ""
  assert.equal(command(["--merge", shards]), 0, output.stderr)
  assert.match(output.stdout, /passed for 1 changed production file/u)

  // Without the second shard's raw coverage the same complete split no longer covers the file.
  rmSync(path.join(shards, "two", "raw"), { recursive: true, force: true })
  output.stderr = ""
  assert.equal(command(["--merge", shards]), 1)
  assert.match(output.stderr, /covered\.js (?:branches|lines|statements) coverage \d+(?:\.\d+)? is below 100/u)
})

test("CI runs the merge after a failed shard, so the aggregate check fails instead of being skipped", () => {
  const workflow = readFileSync(path.join(realRepoRoot, ".github", "workflows", "desk-mcp-tests.yml"), "utf8")
  // A job's block runs from its two-space key to the next two-space key; a step's block from its "- name:" line to the next.
  const job = (name) => workflow.match(new RegExp(`^  ${name}:\\n(?:(?!  \\S).*\\n)*`, "mu"))?.[0] ?? ""
  const step = (block, name) => block.match(new RegExp(`^      - name: ${name}\\n(?:(?!      - ).*\\n)*`, "mu"))?.[0] ?? ""
  const merge = job("desk-mcp-tests")
  assert.match(merge, /^    needs: desk-mcp-coverage-shards$/mu)
  assert.match(merge, /^    if: \$\{\{ !cancelled\(\) \}\}$/mu, "a skipped merge job counts as passing for a required check")
  const upload = step(job("desk-mcp-coverage-shards"), "Retain the shard's raw coverage")
  assert.match(upload, /uses: actions\/upload-artifact@/u)
  assert.match(upload, /^        if: \$\{\{ !cancelled\(\) \}\}$/mu, "a failed shard must still hand its manifest to the merge")
})
