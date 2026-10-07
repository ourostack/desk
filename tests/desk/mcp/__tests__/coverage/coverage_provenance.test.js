import { test } from "node:test"
import { strict as assert } from "node:assert"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { readdirSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import TestExclude from "test-exclude"
import { DETECT_CHILD_SOURCE } from "../../../../../plugins/desk/mcp/src/coverage/detect-child.js"
import { parseMigration, pendingMigrations } from "../../../../../plugins/desk/mcp/src/runtime/pending-migrations.js"
import { runCoverageCommand } from "../../../../../plugins/desk/mcp/src/coverage/runner.js"

const mcpRoot = fileURLToPath(new URL("../../../../../plugins/desk/mcp/", import.meta.url))
const sourceFile = "plugins/desk/mcp/src/covered.js"
const nativeFileRow = `# ${sourceFile} | 100.00 | 100.00 | 100.00 |`
const nativeOutput = [
  "# file | line % | branch % | funcs % | uncovered lines",
  nativeFileRow,
  "# all files | 100.00 | 100.00 | 100.00 |",
].join("\n")

function metrics(statements = 100) {
  return {
    lines: { pct: 100 },
    branches: { pct: 100 },
    functions: { pct: 100 },
    statements: { pct: statements },
  }
}

function runFixture(t, summary, options = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "desk-coverage-provenance-"))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const repoRoot = path.join(root, "repo")
  const reportDirectory = path.join(root, "report")
  const write = (relative, body) => {
    const file = path.join(repoRoot, relative)
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, body)
    return file
  }
  const configPath = write("plugins/desk/mcp/config/coverage-gate.json", JSON.stringify({
    thresholds: { lines: 100, branches: 100, functions: 100, statements: 100 },
    exclusions: options.exclusions ?? [],
  }))
  const packageJsonPath = write("plugins/desk/mcp/package.json", JSON.stringify({
    scripts: { "test:coverage": "node scripts/run-coverage.js" },
  }))
  const workflowPath = write(".github/workflows/desk-mcp-tests.yml", [
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
  ].join("\n"))
  write(sourceFile, "export const covered = true\n")
  for (const file of options.additionalFiles ?? []) write(file, "module.exports = true\n")
  const output = { stdout: "", stderr: "" }
  let invocation
  let reportBytes
  let producerConfig
  const execute = () => runCoverageCommand({
    paths: {
      repoRoot,
      mcpRoot: path.join(repoRoot, "plugins/desk/mcp"),
      configPath,
      packageJsonPath,
      workflowPath,
    },
    env: options.env ?? {},
    io: {
      stdout: { write: text => { output.stdout += text } },
      stderr: { write: text => { output.stderr += text } },
    },
    fsOps: {
      makeTempDir: () => {
        mkdirSync(reportDirectory)
        return reportDirectory
      },
      removeDir: directory => {
        const report = path.join(directory, "coverage-summary.json")
        if (existsSync(report)) reportBytes = readFileSync(report, "utf8")
        rmSync(directory, { recursive: true, force: true })
      },
      readText: file => readFileSync(file, "utf8"),
      writeText: (file, text) => {
        if (options.writeError) throw options.writeError
        writeFileSync(file, text)
      },
    },
    spawn: (command, args, spawnOptions) => {
      if (command === process.execPath) {
        invocation = { command, args, options: spawnOptions }
        const configIndex = args.indexOf("--nycrc-path")
        if (configIndex !== -1) {
          producerConfig = JSON.parse(readFileSync(args[configIndex + 1], "utf8"))
        }
        if (options.spawnError) throw options.spawnError
        if (summary !== undefined || options.reportText !== undefined) {
          writeFileSync(
            path.join(reportDirectory, "coverage-summary.json"),
            options.reportText ?? JSON.stringify(summary),
          )
        }
        return { status: 0, stdout: nativeOutput, stderr: "" }
      }
      assert.equal(command, "git")
      if (args.join(" ") === "merge-base origin/main HEAD") {
        return { status: 0, stdout: "base\n", stderr: "" }
      }
      if (args.join(" ") === "diff --name-only --diff-filter=AM base..HEAD") {
        const changedFiles = options.changedFiles ?? [sourceFile, ...(options.additionalFiles ?? [])]
        return { status: 0, stdout: changedFiles.join("\n"), stderr: "" }
      }
      return { status: 0, stdout: "", stderr: "" }
    },
  })
  let result
  if (options.expectedError) {
    assert.throws(execute, options.expectedError)
  } else {
    result = execute()
  }
  assert.equal(existsSync(reportDirectory), false, "owned temporary report must be cleaned")
  return { result, output, invocation, reportBytes, producerConfig, repoRoot, canonicalRepoRoot: realpathSync(repoRoot), reportDirectory }
}

test("coverage admission refuses missing producer JSON despite perfect stdout percentages", t => {
  const run = runFixture(t)
  assert.equal(run.result, 1)
  assert.match(run.output.stderr, /coverage report is missing/)
})

test("malformed producer JSON propagates without a success message and removes the owned report", t => {
  const run = runFixture(t, undefined, {
    reportText: "{not-json",
    expectedError: SyntaxError,
  })
  assert.ok(run.invocation, "the producer must have run before its malformed result is read")
  assert.equal(run.reportBytes, "{not-json", "the failed result must not be rewritten")
  assert.doesNotMatch(run.output.stdout, /passed/)
})

test("a producer configuration write failure propagates before spawn and removes the owned report", t => {
  const failure = new Error("fixture configuration write failed")
  const run = runFixture(t, undefined, {
    writeError: failure,
    expectedError: error => error === failure,
  })
  assert.equal(run.invocation, undefined, "a failed configuration must never launch tests")
  assert.doesNotMatch(run.output.stdout, /passed/)
})

test("a producer spawn exception propagates and removes the owned report", t => {
  const failure = new Error("fixture producer spawn failed")
  const run = runFixture(t, undefined, {
    spawnError: failure,
    expectedError: error => error === failure,
  })
  assert.ok(run.invocation, "the configured producer spawn must have been attempted")
  assert.doesNotMatch(run.output.stdout, /passed/)
})

test("coverage admission uses producer statement metrics instead of overwriting them from stdout", t => {
  const run = runFixture(t, { [sourceFile]: metrics(75), total: metrics(75) })
  assert.equal(run.result, 1)
  assert.match(run.output.stderr, /covered\.js statements coverage 75 is below 100/)
})

test("coverage admission cannot fill a missing producer statement metric from native line coverage", t => {
  const observed = metrics()
  delete observed.statements
  const run = runFixture(t, { [sourceFile]: observed })
  assert.equal(run.result, 1)
  assert.match(run.output.stderr, /statements coverage undefined is below 100/)
})

test("coverage admission retains a complete independently supplied metric report", t => {
  const run = runFixture(t, { [sourceFile]: metrics(), total: metrics() })
  assert.equal(run.result, 0)
  assert.match(run.output.stdout, /passed for 1 changed production file/)
})

test("the producer's non-perfect aggregate is preserved rather than replaced with 100 percent", t => {
  const summary = { [sourceFile]: metrics(), total: metrics(75) }
  const run = runFixture(t, summary)
  assert.equal(run.result, 0)
  assert.deepEqual(JSON.parse(run.reportBytes), summary)
})

// The migration Detect scripts run under a fixed production budget; instrumenting them makes a startup test depend on how many files the change touches.
test("the registration skips only a migration Detect child, and registers the maintained loader for every other process", t => {
  const run = runFixture(t, { [sourceFile]: metrics(), total: metrics() })
  const { args } = run.invocation
  const registrationUrl = args[args.indexOf("--import") + 1]
  const dir = mkdtempSync(path.join(tmpdir(), "desk-coverage-registration-"))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const marker = path.join(dir, "registered")
  const fakeLoader = path.join(dir, "loader.mjs")
  const script = path.join(dir, "script.mjs")
  writeFileSync(fakeLoader, `import { writeFileSync } from "node:fs"\nexport async function initialize() { writeFileSync(${JSON.stringify(marker)}, "x") }\n`)
  writeFileSync(script, "")
  const registration = decodeURIComponent(registrationUrl.replace("data:text/javascript,", "")).replace(/register\(".*"\);$/u, `register(${JSON.stringify(pathToFileURL(fakeLoader).href)});`)
  const registers = (argv, env) => {
    rmSync(marker, { force: true })
    const { status, stderr } = spawnSync(process.execPath, ["--import", `data:text/javascript,${encodeURIComponent(registration)}`, script, ...argv], { env: { PATH: process.env.PATH, ...env }, encoding: "utf8" })
    assert.equal(status, 0, stderr)
    return existsSync(marker)
  }
  assert.equal(registers(["--detect"], { DESK_PLUGIN_ROOT: dir }), false, "a migration Detect child run by the driver is not instrumented")
  assert.equal(registers(["--detect"], {}), true, "a direct --detect run by its own test is still instrumented")
  assert.equal(registers([], { DESK_PLUGIN_ROOT: dir }), true, "a process that is not Detect is still instrumented")
})

test("the gate hands its test process no DESK_PLUGIN_ROOT, so only the migration driver can mark a Detect child", t => {
  const run = runFixture(t, { [sourceFile]: metrics(), total: metrics() }, { env: { DESK_PLUGIN_ROOT: "/exported/by/the/caller", KEPT: "yes" } })
  assert.equal(Object.hasOwn(run.invocation.options.env, "DESK_PLUGIN_ROOT"), false)
  assert.equal(run.invocation.options.env.KEPT, "yes")
})

test("the offline registration helper leaves a migration Detect child uninstrumented and registers every other process", t => {
  const helper = pathToFileURL(path.join(mcpRoot, "../../../evals/offline/__tests__/helpers/register-coverage.mjs")).href
  const dir = mkdtempSync(path.join(tmpdir(), "desk-offline-registration-"))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const detect = spawnSync(process.execPath, ["--input-type=module", "-e", "import(process.argv[1]).then(() => console.log(process.env.NODE_OPTIONS ?? \"\"))", helper, "--detect"], {
    env: { PATH: process.env.PATH, OFFLINE_COVERAGE_PACKAGE_ROOT: mcpRoot, DESK_PLUGIN_ROOT: dir }, encoding: "utf8",
  })
  assert.equal(detect.status, 0, detect.stderr)
  assert.doesNotMatch(detect.stdout, /register-coverage\.mjs/u, "a Detect child neither re-adds the helper to NODE_OPTIONS nor registers the hooks")
  const other = spawnSync(process.execPath, ["--input-type=module", "-e", "import(process.argv[1]).then(() => console.log(process.env.NODE_OPTIONS ?? \"\"))", helper], {
    env: { PATH: process.env.PATH, OFFLINE_COVERAGE_PACKAGE_ROOT: mcpRoot, DESK_PLUGIN_ROOT: dir }, encoding: "utf8",
  })
  assert.equal(other.status, 0, other.stderr)
  assert.match(other.stdout, /--import=\S*register-coverage\.mjs/u, "any other process is still instrumented")
})

// The test above sees only the NODE_OPTIONS re-add. This one watches the two `register` calls, with fake loaders in a copy of the helper's folder layout, so dropping the guard from either call fails here.
test("the offline registration helper registers neither hook for a migration Detect child, and both for every other process", t => {
  const dir = mkdtempSync(path.join(tmpdir(), "desk-offline-register-guard-"))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const marker = path.join(dir, "registered.txt")
  const put = (relative, body) => {
    const file = path.join(dir, relative)
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, body)
    return file
  }
  const repoRoot = path.join(mcpRoot, "../../..")
  const helperDir = "evals/offline/__tests__/helpers"
  const copy = relative => put(relative, readFileSync(path.join(repoRoot, relative), "utf8"))
  const helper = copy(`${helperDir}/register-coverage.mjs`)
  copy("plugins/desk/mcp/src/coverage/detect-child.js")
  const recorder = name => `import { appendFileSync } from "node:fs"\nexport function initialize() { appendFileSync(${JSON.stringify(marker)}, "${name}\\n") }\n`
  put(`${helperDir}/coverage-format.mjs`, recorder("format"))
  put("pkg/package.json", JSON.stringify({ name: "fake-package-root", type: "module" }))
  put("pkg/node_modules/@istanbuljs/esm-loader-hook/package.json", JSON.stringify({ name: "@istanbuljs/esm-loader-hook", type: "module", exports: "./index.js" }))
  put("pkg/node_modules/@istanbuljs/esm-loader-hook/index.js", recorder("instrumentation"))
  const registered = (argv) => {
    rmSync(marker, { force: true })
    const run = spawnSync(process.execPath, ["--import", pathToFileURL(helper).href, put("script.mjs", ""), ...argv], {
      env: { PATH: process.env.PATH, OFFLINE_COVERAGE_PACKAGE_ROOT: path.join(dir, "pkg"), DESK_PLUGIN_ROOT: dir }, encoding: "utf8",
    })
    assert.equal(run.status, 0, run.stderr)
    return existsSync(marker) ? readFileSync(marker, "utf8").split("\n").filter(Boolean).sort() : []
  }
  assert.deepEqual(registered(["--detect"]), [], "a Detect child registers no hook")
  assert.deepEqual(registered([]), ["format", "instrumentation"], "any other process registers both")
})

// The gate exempts a process by `--detect` plus DESK_PLUGIN_ROOT. If the driver or a Detect block stops using them, the exemption silently stops applying and startup tests depend on PR size again.
test("every migration Detect block that runs node passes --detect under $DESK_PLUGIN_ROOT, and the driver sets DESK_PLUGIN_ROOT for it", async t => {
  const migrations = path.join(mcpRoot, "..", "migrations")
  const files = readdirSync(migrations).filter(file => /^\d.*\.md$/u.test(file))
  let nodeDetects = 0
  for (const file of files) {
    const migration = parseMigration(readFileSync(path.join(migrations, file), "utf8"), file.replace(/\.md$/u, ""))
    assert.ok(migration, `${file} parses`)
    const nodeLines = migration.blocks.Detect.split("\n").filter(line => /^\s*node\s/u.test(line))
    for (const line of nodeLines) {
      nodeDetects += 1
      assert.match(line, /"\$DESK_PLUGIN_ROOT\//u, `${file}: Detect runs a script under $DESK_PLUGIN_ROOT`)
      assert.match(line, /\s--detect(\s|$)/u, `${file}: Detect passes --detect`)
    }
  }
  assert.ok(nodeDetects >= 2, "the tidy and status-normalize Detect blocks are present")
  const root = mkdtempSync(path.join(tmpdir(), "desk-detect-driver-"))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(path.join(root, "migrations"))
  const seen = path.join(root, "seen")
  writeFileSync(path.join(root, "migrations", "01-probe.md"), [
    "---", "id: 01-probe", "description: probe", "safety: safe", "needs_restart: false", "---", "", "## Detect", "", "```bash",
    `printf '%s' "$DESK_PLUGIN_ROOT" > '${seen}'; exit 1`, "```", "", "## Safety check", "", "```bash", "exit 0", "```", "", "## Migrate", "", "```bash", "exit 0", "```", "", "## Announce", "", "Done.", "",
  ].join("\n"))
  await pendingMigrations({ pluginRoot: root, env: { PATH: process.env.PATH }, cwd: root, budgetMs: 30_000 })
  assert.equal(readFileSync(seen, "utf8"), root)
})

test("an absent producer aggregate is not manufactured from native output", t => {
  const run = runFixture(t, { [sourceFile]: metrics() })
  assert.equal(run.result, 0)
  assert.equal(Object.hasOwn(JSON.parse(run.reportBytes), "total"), false)
})

test("the actual producer invocation binds the maintained loader, dependency cwd, source cwd and report", t => {
  const run = runFixture(t, { [sourceFile]: metrics(), total: metrics() })
  const { args, options } = run.invocation
  assert.match(args[0].replaceAll(path.sep, "/"), /\/nyc\/bin\/nyc\.js$/)
  assert.equal(path.resolve(options.cwd), path.resolve(mcpRoot))
  assert.equal(args[args.indexOf("--cwd") + 1], run.canonicalRepoRoot)
  assert.equal(args[args.indexOf("--nycrc-path") + 1], path.join(run.reportDirectory, "nyc.json"))
  assert.equal(run.producerConfig.cwd, run.canonicalRepoRoot)
  assert.equal(run.producerConfig.reportDir, run.reportDirectory)
  assert.equal(run.producerConfig.tempDir, path.join(run.reportDirectory, "raw"))
  assert.deepEqual(run.producerConfig.reporter, ["json-summary", "json", "text"])
  const importIndex = args.indexOf("--import")
  assert.notEqual(importIndex, -1)
  assert.equal(args[importIndex - 1], process.execPath)
  const registration = decodeURIComponent(args[importIndex + 1].replace("data:text/javascript,", ""))
  const loader = pathToFileURL(path.join(mcpRoot, "node_modules", "@istanbuljs", "esm-loader-hook", "index.js")).href
  assert.equal(registration, `import { register } from "node:module"; const isMigrationDetectChild = ${DETECT_CHILD_SOURCE}; if (!isMigrationDetectChild(process.argv, process.env)) register(${JSON.stringify(loader)});`)
  assert.equal(options.env.NODE_OPTIONS, `--import=${args[importIndex + 1]}`)
  assert.equal(options.env.NODE_PATH, path.join(mcpRoot, "node_modules"))
  // The second preload is the global test setup: a temporary HOME and XDG folders for every test process.
  assert.deepEqual(args.slice(importIndex + 2, importIndex + 4), ["--import", pathToFileURL(path.join(mcpRoot, "../../../tests/desk/mcp/__tests__/_isolated_env.mjs")).href])
  assert.deepEqual(args.slice(importIndex + 4), [
    "--test",
    "--test-concurrency=1",
    path.join(run.canonicalRepoRoot, "tests/desk/mcp/__tests__/**/*.test.js"),
  ])
})

test("instrumented test-file execution stays serial on small and large hosts", async t => {
  const { default: os } = await import("node:os")
  const { syncBuiltinESMExports } = await import("node:module")
  for (const cpus of [1, 2, 4, 5, 12]) {
    await t.test(`${cpus} available CPUs use one test worker`, child => {
      const mocked = child.mock.method(os, "availableParallelism", () => cpus)
      syncBuiltinESMExports()
      try {
        const run = runFixture(child, { [sourceFile]: metrics(), total: metrics() })
        assert.equal(run.result, 0)
        assert.deepEqual(
          run.invocation.args.filter(arg => arg.startsWith("--test-concurrency=")),
          ["--test-concurrency=1"],
        )
        assert.doesNotMatch(run.invocation.options.env.NODE_OPTIONS, /test-concurrency/u)
      } finally {
        mocked.mock.restore()
        syncBuiltinESMExports()
      }
    })
  }
})

test("the loader reaches descendants without replacing caller Node options or mutating the parent environment", t => {
  const env = { NODE_OPTIONS: "--trace-warnings", NODE_PATH: "caller-modules", RETAINED_VALUE: "original" }
  const run = runFixture(t, { [sourceFile]: metrics(), total: metrics() }, { env })
  const { args, options } = run.invocation
  assert.equal(run.result, 0)
  assert.equal(options.env.NODE_OPTIONS, `--trace-warnings --import=${args[args.indexOf("--import") + 1]}`)
  assert.equal(options.env.NODE_PATH, `${path.join(mcpRoot, "node_modules")}${path.delimiter}caller-modules`)
  assert.equal(options.env.RETAINED_VALUE, "original")
  assert.deepEqual(env, { NODE_OPTIONS: "--trace-warnings", NODE_PATH: "caller-modules", RETAINED_VALUE: "original" })
})

test("the maintained producer measures the selected files without owning coverage thresholds", t => {
  const excludedFile = "scripts/audit-work-suite-runtime.cjs"
  const run = runFixture(t, { [sourceFile]: metrics(), total: metrics(75) }, {
    additionalFiles: [excludedFile],
    exclusions: [{ path: excludedFile, owner: "fixture", reason: "separate maintained command" }],
  })
  assert.ok(run.producerConfig, "an explicit producer config must reach the child")
  assert.deepEqual(run.producerConfig.include, [sourceFile])
  assert.deepEqual(run.producerConfig.extension, [".js", ".cjs"])
  assert.deepEqual(run.producerConfig.exclude, [
    "tests/desk/mcp/__tests__/**",
    "plugins/desk/mcp/node_modules/**",
  ])
  assert.equal(run.producerConfig.all, true)
  assert.equal(run.producerConfig.cache, false)
  assert.equal(run.producerConfig.checkCoverage, false)
  for (const metric of ["lines", "branches", "functions", "statements"]) {
    assert.equal(Object.hasOwn(run.producerConfig, metric), false)
  }
  assert.equal(run.invocation.args.some(arg => arg.startsWith("--check-coverage")), false)
  assert.equal(run.result, 0, "the existing per-file gate, not a global aggregate, owns admission")
})

test("an empty changed-source selection still runs tests without expanding measurement to the entire repository", t => {
  const run = runFixture(t, { total: metrics() }, { changedFiles: [] })
  assert.ok(run.invocation, "the maintained tests must still execute")
  assert.ok(run.producerConfig, "the empty selection must be explicit")
  assert.deepEqual(run.producerConfig.include, [])
  assert.deepEqual(run.producerConfig.exclude, ["**"])
  assert.equal(run.result, 0)
  assert.match(run.output.stdout, /passed for 0 changed production file/)
})

test("an inherited recursion marker cannot report an unmeasured coverage pass", t => {
  const run = runFixture(t, undefined, { env: { DESK_COVERAGE_RUNNER_CHILD: "1" } })
  assert.equal(run.result, 1)
  assert.equal(run.invocation, undefined)
  assert.match(run.output.stderr, /nested coverage invocation.*no coverage was measured/i)
  assert.doesNotMatch(run.output.stdout, /passed/)
})

test("the package pins the qualified AST producer without changing runtime dependencies", () => {
  const manifest = JSON.parse(readFileSync(path.join(mcpRoot, "package.json"), "utf8"))
  assert.equal(manifest.devDependencies.nyc, "18.0.0")
  assert.equal(manifest.devDependencies["@istanbuljs/esm-loader-hook"], "0.3.0")
  assert.equal(manifest.overrides["test-exclude"], "8.0.0")
  for (const name of ["nyc", "@istanbuljs/esm-loader-hook", "test-exclude", "c8"]) {
    assert.equal(Object.hasOwn(manifest.dependencies, name), false)
  }
  assert.equal(Object.hasOwn(manifest.devDependencies, "c8"), false)
})

test("the public package lock retains only public registry acquisition URLs", () => {
  const lock = JSON.parse(readFileSync(path.join(mcpRoot, "package-lock.json"), "utf8"))
  for (const [name, entry] of Object.entries(lock.packages)) {
    if (!entry.resolved) continue
    assert.equal(new URL(entry.resolved).origin, "https://registry.npmjs.org", name)
    assert.match(entry.integrity, /^sha(?:1|256|384|512)-[A-Za-z0-9+/]+=*$/, name)
  }
})

test("the reviewed test-exclude override honors the actual configured source selectors", t => {
  const cjsFile = "scripts/covered.cjs"
  const run = runFixture(t, {
    [sourceFile]: metrics(),
    [cjsFile]: metrics(),
    total: metrics(),
  }, { additionalFiles: [cjsFile] })
  const selector = new TestExclude(run.producerConfig)
  for (const file of [sourceFile, cjsFile]) {
    assert.equal(selector.shouldInstrument(path.join(run.canonicalRepoRoot, file)), true, file)
  }
  for (const file of [
    "tests/desk/mcp/__tests__/covered.test.js",
    "plugins/desk/mcp/node_modules/dependency/index.js",
    "plugins/desk/mcp/src/covered.mjs",
    "scripts/unselected.cjs",
    "../outside.js",
  ]) {
    assert.equal(selector.shouldInstrument(path.resolve(run.canonicalRepoRoot, file)), false, file)
  }
})
