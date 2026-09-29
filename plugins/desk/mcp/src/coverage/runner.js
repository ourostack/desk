import { spawnSync } from "node:child_process"
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { createRequire } from "node:module"
import { fileURLToPath, pathToFileURL } from "node:url"
import {
  assertCoverageCommandParity,
  collectCoverageRequiredFiles,
  evaluateCoverageReport,
  isOfflineEvaluationScope,
} from "./gate.js"

const moduleDir = path.dirname(fileURLToPath(import.meta.url))
const defaultMcpRoot = path.resolve(moduleDir, "..", "..")
const defaultRepoRoot = path.resolve(defaultMcpRoot, "..", "..", "..")
// The tests live outside the shipped plugin folder, in tests/desk/mcp, which mirrors plugins/desk/mcp.
const defaultTestRoot = path.join(defaultRepoRoot, "tests", "desk", "mcp", "__tests__")
const require = createRequire(import.meta.url)

export function runCoverageCommand(options = {}) {
  const env = options.env ?? process.env
  const spawn = options.spawn ?? spawnSync
  const io = options.io ?? {
    stdout: process.stdout,
    stderr: process.stderr,
  }
  if (env.DESK_COVERAGE_RUNNER_CHILD === "1") {
    io.stderr.write("[coverage-gate] refusing nested coverage invocation; no coverage was measured\n")
    return 1
  }

  const request = parseCoverageArguments(options.argv ?? [])
  if (request.error) {
    io.stderr.write(`[coverage-gate] ${request.error}; no coverage was measured\n`)
    return 1
  }

  const paths = options.paths ?? defaultPaths()
  const repoRoot = realpathSync(paths.repoRoot)
  const fsOps = options.fsOps ?? defaultFsOps()
  const config = JSON.parse(fsOps.readText(paths.configPath))
  const requiredFiles = collectChangedCoverageFiles({
    repoRoot,
    spawn,
    env,
  })
  const coverageIncludeFiles = filterCoverageIncludeFiles({
    requiredFiles,
    exclusions: config.exclusions,
  })
  const tmp = fsOps.makeTempDir()

  try {
    if (request.mode === "shard") {
      return runCoverageShard({
        repoRoot,
        request,
        requiredFiles,
        coverageIncludeFiles,
        weights: readShardWeights(paths.shardWeightsPath),
        reportDirectory: tmp,
        fsOps,
        spawn,
        env,
        io,
      })
    }
    if (request.mode === "merge") {
      const merged = mergeCoverageShards({
        repoRoot,
        request,
        requiredFiles,
        coverageIncludeFiles,
        reportDirectory: tmp,
        fsOps,
        spawn,
        env,
      })
      io.stdout.write(merged.stdout ?? "")
      io.stderr.write(merged.stderr ?? "")
      if (merged.issues.length) {
        io.stderr.write("[coverage-gate] failed\n")
        for (const issue of merged.issues) io.stderr.write(`- ${issue}\n`)
        return 1
      }
    } else {
      const testResult = runInstrumentedTests({
        repoRoot,
        requiredFiles: coverageIncludeFiles,
        reportDirectory: tmp,
        fsOps,
        spawn,
        env,
      })
      io.stdout.write(testResult.stdout ?? "")
      io.stderr.write(testResult.stderr ?? "")
      if (testResult.status !== 0) {
        if (testResult.error) io.stderr.write(`[coverage-gate] the instrumented test run could not finish (${testResult.error.code ?? testResult.error.message})\n`)
        return testResult.status ?? 1
      }
    }

    const reportPath = path.join(tmp, "coverage-summary.json")
    const coverage = evaluateCoverageReport({
      repoRoot,
      reportPath,
      requiredFiles,
      exclusions: config.exclusions,
      thresholds: config.thresholds,
    })
    const parity = assertCoverageCommandParity({
      packageJsonPath: paths.packageJsonPath,
      workflowPath: paths.workflowPath,
    })
    const issues = [...coverage.issues, ...parity.issues]
    if (issues.length) {
      io.stderr.write("[coverage-gate] failed\n")
      for (const issue of issues) io.stderr.write(`- ${issue}\n`)
      return 1
    }

    io.stdout.write(
      `[coverage-gate] passed for ${coverage.checkedFiles.length} changed production file(s)\n`,
    )
    return 0
  } finally {
    fsOps.removeDir(tmp)
  }
}

/** The most test output the gate collects from the instrumented suite. */
export const COVERAGE_OUTPUT_MAX_BYTES = 256 * 1024 * 1024

export function collectChangedCoverageFiles({ repoRoot, spawn = spawnSync, env = process.env }) {
  const changed = new Set(collectChangedFiles({ repoRoot, spawn, env }))
  return collectCoverageRequiredFiles({ repoRoot })
    .filter((file) => changed.has(file))
}

export function filterCoverageIncludeFiles({ requiredFiles, exclusions = [] }) {
  const excludedPaths = new Set(
    exclusions
      .map((exclusion) => normalizePath(exclusion.path ?? ""))
      .filter(Boolean),
  )
  return requiredFiles.filter((file) => !excludedPaths.has(normalizePath(file)))
}

export function collectChangedFiles({ repoRoot, spawn = spawnSync, env = process.env }) {
  return unique([
    ...changedSinceMergeBase({ repoRoot, spawn, env }),
    ...gitLines({ repoRoot, spawn, args: ["diff", "--name-only", "--diff-filter=AM"] }),
    ...gitLines({ repoRoot, spawn, args: ["diff", "--cached", "--name-only", "--diff-filter=AM"] }),
    ...gitLines({ repoRoot, spawn, args: ["ls-files", "--others", "--exclude-standard"] }),
  ].map(normalizePath))
}

export function changedSinceMergeBase({ repoRoot, spawn = spawnSync, env = process.env }) {
  const base = resolveCoverageBase({ repoRoot, spawn, env })
  return gitLines({ repoRoot, spawn, args: ["diff", "--name-only", "--diff-filter=AM", `${base}..HEAD`] })
}

export function resolveCoverageBase({ repoRoot, spawn = spawnSync, env = process.env }) {
  for (const candidate of coverageBaseCandidates({ repoRoot, spawn, env })) {
    const base = gitText({ repoRoot, spawn, args: ["merge-base", candidate, "HEAD"] })
    if (base) return base
  }
  throw new Error("coverage baseline could not be resolved safely")
}

function coverageBaseCandidates({ repoRoot, spawn, env }) {
  const candidates = []
  pushIfSet(candidates, env.DESK_COVERAGE_BASE_REF)
  const pullRequestBase = cleanText(env.GITHUB_BASE_REF)
  if (pullRequestBase) {
    pushIfSet(candidates, `origin/${pullRequestBase}`)
    pushIfSet(candidates, pullRequestBase)
  }
  const localUpstream = gitText({
    repoRoot,
    spawn,
    args: ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
  })
  const currentBranch = localUpstream
    ? gitText({ repoRoot, spawn, args: ["rev-parse", "--abbrev-ref", "HEAD"] })
    : ""
  if (!isSelfUpstream(localUpstream, currentBranch)) pushIfSet(candidates, localUpstream)
  pushIfSet(candidates, "origin/main")
  pushIfSet(candidates, "main")
  return unique(candidates)
}

/** Parse the coverage command's arguments: none for one whole-suite run, `--shard <index>/<total> --output <dir>` for one shard of the suite, or `--merge <dir>` to admit the combined shards. */
export function parseCoverageArguments(argv) {
  if (!argv.length) return { mode: "full" }
  const [flag, value, ...rest] = argv
  if (flag === "--shard") {
    const match = /^(\d+)\/(\d+)$/u.exec(value ?? "")
    const index = match ? Number(match[1]) : 0
    const total = match ? Number(match[2]) : 0
    if (index < 1 || index > total) return { error: `--shard needs <index>/<total> with 1 <= index <= total; got ${value}` }
    if (rest.length !== 2 || rest[0] !== "--output" || !rest[1]) return { error: "--shard needs --output <dir> and nothing else" }
    return { mode: "shard", index, total, output: rest[1] }
  }
  if (flag === "--merge" && value && !rest.length) return { mode: "merge", input: value }
  return { error: `unrecognized arguments: ${argv.join(" ")}` }
}

/**
 * The test files one whole-suite run executes, as sorted repository-relative paths: every `tests/desk/mcp/__tests__/**\/*.test.js`, plus the offline evaluation tests and CLI contract when the offline scope is selected.
 * It follows the whole-suite glob's rules: dot entries and node_modules are never entered.
 */
export function collectCoverageTestFiles({ repoRoot, offline }) {
  const testRoot = path.join(repoRoot, "tests", "desk", "mcp", "__tests__")
  const files = walkTestFiles(testRoot).filter((file) => file.endsWith(".test.js"))
  if (offline.selected) {
    const offlineTests = path.join(repoRoot, "evals", "offline", "__tests__")
    if (existsSync(offlineTests)) {
      for (const entry of readdirSync(offlineTests)) {
        if (entry.endsWith(".test.mjs")) files.push(path.join(offlineTests, entry))
      }
    }
    const contractTest = path.join(repoRoot, "scripts", "test-skill-evals.cjs")
    if (existsSync(contractTest)) files.push(contractTest)
  }
  return files.map((file) => normalizePath(path.relative(repoRoot, file))).sort()
}

function walkTestFiles(dir) {
  if (!existsSync(dir)) return []
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue
    const file = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walkTestFiles(file))
    else out.push(file)
  }
  return out
}

/**
 * Split the test files into `total` shards of similar expected duration: the longest file first, each onto the shard with the least expected time so far.
 * Weights only balance the shards. Every file lands in exactly one shard whatever the weights say, and a file without a recorded weight counts as `default_seconds`.
 */
export function partitionCoverageTestFiles({ files, total, weights = {} }) {
  const weightOf = (file) => weights.file_seconds?.[file] ?? weights.default_seconds ?? 1
  const shards = Array.from({ length: total }, () => ({ load: 0, files: [] }))
  const ordered = [...files].sort((left, right) => weightOf(right) - weightOf(left) || (left < right ? -1 : 1))
  for (const file of ordered) {
    const target = shards.reduce((lightest, shard) => (shard.load < lightest.load ? shard : lightest))
    target.files.push(file)
    target.load += weightOf(file)
  }
  return shards.map((shard) => shard.files.sort())
}

function readShardWeights(weightsPath) {
  return weightsPath && existsSync(weightsPath) ? JSON.parse(readFileSync(weightsPath, "utf8")) : {}
}

/** The manifest schema each shard writes next to its raw coverage. */
export const COVERAGE_SHARD_SCHEMA_VERSION = 1

function runCoverageShard({ repoRoot, request, requiredFiles, coverageIncludeFiles, weights, reportDirectory, fsOps, spawn, env, io }) {
  const output = path.resolve(request.output)
  if (existsSync(output) && readdirSync(output).length) {
    io.stderr.write(`[coverage-gate] shard output ${output} already has content; no coverage was measured\n`)
    return 1
  }
  mkdirSync(output, { recursive: true })
  const offline = resolveOfflineEvaluationScope({ repoRoot, requiredFiles: coverageIncludeFiles })
  const testFiles = partitionCoverageTestFiles({
    files: collectCoverageTestFiles({ repoRoot, offline }),
    total: request.total,
    weights,
  })[request.index - 1]
  const rawDirectory = path.join(output, "raw")
  const started = Date.now()
  let status = 0
  if (testFiles.length) {
    const result = runInstrumentedTests({
      repoRoot,
      requiredFiles: coverageIncludeFiles,
      reportDirectory,
      rawDirectory,
      testFiles: testFiles.map((file) => path.join(repoRoot, file)),
      timingsPath: path.join(output, "timings.json"),
      fsOps,
      spawn,
      env,
    })
    io.stdout.write(result.stdout ?? "")
    io.stderr.write(result.stderr ?? "")
    if (result.error) io.stderr.write(`[coverage-gate] the instrumented test run could not finish (${result.error.code ?? result.error.message})\n`)
    status = result.status ?? 1
  }
  // Process bookkeeping is not coverage; only the per-process coverage files travel to the merge. Retried rather
  // than a single attempt: nyc/istanbul's own per-process coverage writers (including any instrumented child a test
  // spawned and has already awaited to exit) can still be flushing a file into this same directory in the instant
  // after the instrumented run above reports done, which races Node's own recursive rmdir -- it lists entries, then
  // rmdir's the now-believed-empty directory, and a file that lands in that window fails it with ENOTEMPTY (seen on
  // CI, not locally: ourostack/desk PR #101, runs 36557284368 and prior, shard 2). The same short retry `_fake_real_
  // root.js` already uses for its own fixture cleanup.
  rmSync(path.join(rawDirectory, "processinfo"), { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  const seconds = Math.round((Date.now() - started) / 100) / 10
  writeFileSync(path.join(output, "shard.json"), `${JSON.stringify({
    schema_version: COVERAGE_SHARD_SCHEMA_VERSION,
    index: request.index,
    total: request.total,
    status,
    seconds,
    required_files: requiredFiles,
    test_files: testFiles,
  }, null, 2)}\n`)
  io.stdout.write(`[coverage-gate] shard ${request.index}/${request.total} ran ${testFiles.length} test file(s) in ${seconds} s with status ${status}; the merge step owns admission\n`)
  return status
}

/**
 * Admit the combined shards: every shard of one split is present once and passed, measured the same changed files, and together they ran exactly the test files one whole-suite run would. Their raw coverage is then reported as one run.
 */
function mergeCoverageShards({ repoRoot, request, requiredFiles, coverageIncludeFiles, reportDirectory, fsOps, spawn, env }) {
  const input = path.resolve(request.input)
  const manifests = (existsSync(input) ? readdirSync(input, { withFileTypes: true }) : [])
    .filter((entry) => entry.isDirectory() && existsSync(path.join(input, entry.name, "shard.json")))
    .map((entry) => ({ directory: path.join(input, entry.name), ...JSON.parse(readFileSync(path.join(input, entry.name, "shard.json"), "utf8")) }))
    .sort((left, right) => left.index - right.index)
  if (!manifests.length) return { issues: [`no coverage shard manifests under ${input}`] }
  const total = manifests[0].total
  const indexes = manifests.map((manifest) => manifest.index)
  const expectedIndexes = Array.from({ length: total }, (_, offset) => offset + 1)
  if (manifests.some((manifest) => manifest.schema_version !== COVERAGE_SHARD_SCHEMA_VERSION || manifest.total !== total) ||
    JSON.stringify(indexes) !== JSON.stringify(expectedIndexes)) {
    return { issues: [`coverage shards must be exactly 1..${total} of one split; found ${manifests.map((manifest) => `${manifest.index}/${manifest.total}`).join(", ")}`] }
  }
  const issues = []
  for (const manifest of manifests) {
    if (!Array.isArray(manifest.test_files)) issues.push(`coverage shard ${manifest.index}/${manifest.total} does not list its test files`)
    if (manifest.status !== 0) issues.push(`coverage shard ${manifest.index}/${manifest.total} finished with status ${manifest.status}`)
    if (JSON.stringify(manifest.required_files) !== JSON.stringify(requiredFiles)) {
      issues.push(`coverage shard ${manifest.index}/${manifest.total} measured a different changed-file set than this merge`)
    }
  }
  const offline = resolveOfflineEvaluationScope({ repoRoot, requiredFiles: coverageIncludeFiles })
  const expectedTests = collectCoverageTestFiles({ repoRoot, offline })
  const ranTests = manifests.flatMap((manifest) => manifest.test_files ?? [])
  const counts = new Map()
  for (const file of ranTests) counts.set(file, (counts.get(file) ?? 0) + 1)
  const duplicated = [...counts].filter(([, count]) => count > 1).map(([file]) => file)
  const missing = expectedTests.filter((file) => !counts.has(file))
  const unexpected = [...counts.keys()].filter((file) => !expectedTests.includes(file))
  if (duplicated.length) issues.push(`test files ran in more than one shard: ${duplicated.join(", ")}`)
  if (missing.length) issues.push(`test files no shard ran: ${missing.join(", ")}`)
  if (unexpected.length) issues.push(`shards ran test files this checkout does not have: ${unexpected.join(", ")}`)
  if (issues.length) return { issues }

  const rawDirectory = path.join(reportDirectory, "raw")
  mkdirSync(rawDirectory, { recursive: true })
  for (const manifest of manifests) {
    const shardRaw = path.join(manifest.directory, "raw")
    if (!existsSync(shardRaw)) continue
    for (const entry of readdirSync(shardRaw)) {
      if (entry.endsWith(".json")) copyFileSync(path.join(shardRaw, entry), path.join(rawDirectory, `shard-${manifest.index}-${entry}`))
    }
  }
  const configPath = writeProducerConfig({ repoRoot, requiredFiles: coverageIncludeFiles, offline, reportDirectory, rawDirectory, fsOps })
  const report = spawn(process.execPath, [require.resolve("nyc/bin/nyc.js"), "report", "--cwd", repoRoot, "--nycrc-path", configPath], {
    cwd: defaultMcpRoot,
    encoding: "utf8",
    maxBuffer: COVERAGE_OUTPUT_MAX_BYTES,
    env: { ...env, DESK_COVERAGE_RUNNER_CHILD: "1" },
  })
  const shardLines = manifests.map((manifest) => `[coverage-gate] shard ${manifest.index}/${manifest.total}: ${manifest.test_files.length} test file(s) in ${manifest.seconds} s\n`).join("")
  if (report.status !== 0) {
    issues.push(`the combined coverage report could not be produced (${report.error?.code ?? report.error?.message ?? `status ${report.status}`})`)
  }
  return { issues, stdout: `${shardLines}${report.stdout ?? ""}`, stderr: report.stderr ?? "" }
}

function writeProducerConfig({ repoRoot, requiredFiles, offline, reportDirectory, rawDirectory, silent = false, fsOps }) {
  const configPath = path.join(reportDirectory, "nyc.json")
  fsOps.writeText(configPath, JSON.stringify({
    cwd: repoRoot,
    all: true,
    include: requiredFiles,
    exclude: requiredFiles.length ? [
      "tests/desk/mcp/__tests__/**",
      "plugins/desk/mcp/node_modules/**",
      ...(offline.selected ? ["evals/offline/__tests__/**"] : []),
    ] : ["**"],
    // The maintained offline selection is only parsed and measured when its own extensions are admitted; without them nyc silently reports no entry at all for those production leaves.
    extension: [".js", ".cjs", ...(offline.selected ? [".mjs", ".ts"] : [])],
    ...(offline.requiresTypeScript ? { parserPlugins: ["typescript"] } : {}),
    reporter: ["json-summary", "json", "text"],
    reportDir: reportDirectory,
    tempDir: rawDirectory,
    cache: false,
    checkCoverage: false,
    // A shard only records raw coverage; the merge step reports the combined result once.
    ...(silent ? { silent: true } : {}),
  }))
  return configPath
}

function runInstrumentedTests({
  repoRoot,
  requiredFiles,
  reportDirectory,
  rawDirectory = path.join(reportDirectory, "raw"),
  testFiles,
  timingsPath,
  fsOps,
  spawn,
  env,
}) {
  const offline = resolveOfflineEvaluationScope({ repoRoot, requiredFiles })
  const configPath = writeProducerConfig({ repoRoot, requiredFiles, offline, reportDirectory, rawDirectory, silent: Boolean(testFiles), fsOps })
  const loader = pathToFileURL(require.resolve("@istanbuljs/esm-loader-hook")).href
  const registration = `import { register } from "node:module"; register(${JSON.stringify(loader)});`
  // The repository's own offline registration helper is a superset of this registration: it installs the same maintained hook and additionally gives the source-pinned TypeScript leaves a module format that hook will instrument.
  const registrationUrl = offline.registrationPath
    ? pathToFileURL(offline.registrationPath).href
    : `data:text/javascript,${encodeURIComponent(registration)}`
  const args = [
    require.resolve("nyc/bin/nyc.js"),
    "--cwd", repoRoot,
    "--nycrc-path", configPath,
    process.execPath,
    "--import", registrationUrl,
    // The global test setup: a temporary HOME and XDG folders for every test process, and a guard against writes under the real home.
    "--import", pathToFileURL(path.join(defaultTestRoot, "_isolated_env.mjs")).href,
    "--test",
    // Instrumented fixture children must not compete with other test files for their unchanged startup deadlines.
    "--test-concurrency=1",
    // A shard keeps the TAP output and also records each file's duration for rebalancing the shards.
    ...(timingsPath ? [
      "--test-reporter=tap", "--test-reporter-destination=stdout",
      `--test-reporter=${path.join(defaultTestRoot, "_file_timing_reporter.mjs")}`, `--test-reporter-destination=${timingsPath}`,
    ] : []),
    // A shard names its own files; the whole suite is the glob plus, as separate path arguments that run as separate test workers, the offline suite and the CLI contract with their own hooks.
    ...(testFiles ?? [path.join(repoRoot, "tests/desk/mcp/__tests__/**/*.test.js"), ...offline.testTargets]),
  ]
  return spawn(process.execPath, args, {
    cwd: defaultMcpRoot,
    encoding: "utf8",
    // The whole suite's TAP output passed spawnSync's 1 MiB default once the suite grew; a truncated child is killed and fails the gate with no message.
    maxBuffer: COVERAGE_OUTPUT_MAX_BYTES,
    env: {
      ...env,
      // Ordinary Node descendants do not inherit the parent's execArgv.
      NODE_OPTIONS: `${env.NODE_OPTIONS ?? ""} --import=${registrationUrl}`.trim(),
      NODE_PATH: [path.join(defaultMcpRoot, "node_modules"), env.NODE_PATH].filter(Boolean).join(path.delimiter),
      ...(offline.registrationPath ? { OFFLINE_COVERAGE_PACKAGE_ROOT: defaultMcpRoot } : {}),
      DESK_COVERAGE_RUNNER_CHILD: "1",
    },
  })
}

function resolveOfflineEvaluationScope({ repoRoot, requiredFiles }) {
  const required = requiredFiles.filter(isOfflineEvaluationScope)
  if (!required.length) return { selected: false, requiresTypeScript: false, registrationPath: null, testTargets: [] }
  const testDirectory = path.join(repoRoot, "evals", "offline", "__tests__")
  const hasOfflineTests = existsSync(testDirectory) &&
    readdirSync(testDirectory).some((entry) => entry.endsWith(".test.mjs"))
  const contractTest = path.join(repoRoot, "scripts", "test-skill-evals.cjs")
  const registrationPath = path.join(testDirectory, "helpers", "register-coverage.mjs")
  return {
    selected: true,
    requiresTypeScript: required.some((file) => file.endsWith(".ts")),
    registrationPath: existsSync(registrationPath) ? registrationPath : null,
    // A required production leaf whose tests are absent stays measured and fails the gate; an unmatched selection argument would end the run before any measurement instead.
    testTargets: [
      ...(hasOfflineTests ? [path.join(testDirectory, "*.test.mjs")] : []),
      ...(existsSync(contractTest) ? [contractTest] : []),
    ],
  }
}

function defaultPaths() {
  return {
    repoRoot: defaultRepoRoot,
    mcpRoot: defaultMcpRoot,
    configPath: path.join(defaultMcpRoot, "config", "coverage-gate.json"),
    shardWeightsPath: path.join(defaultMcpRoot, "config", "coverage-shards.json"),
    packageJsonPath: path.join(defaultMcpRoot, "package.json"),
    workflowPath: path.join(defaultRepoRoot, ".github", "workflows", "desk-mcp-tests.yml"),
  }
}

function defaultFsOps() {
  return {
    makeTempDir: () => mkdtempSync(path.join(tmpdir(), "desk-mcp-coverage-")),
    removeDir: (dir) => rmSync(dir, { recursive: true, force: true }),
    readText: (file) => readFileSync(file, "utf8"),
    writeText: (file, text) => writeFileSync(file, text, "utf8"),
  }
}

function gitText({ repoRoot, spawn, args }) {
  const result = spawn("git", args, { cwd: repoRoot, encoding: "utf8" })
  return result.status === 0 ? result.stdout.trim() : ""
}

function gitLines({ repoRoot, spawn, args }) {
  return gitText({ repoRoot, spawn, args }).split("\n").filter(Boolean)
}

function normalizePath(file) {
  return file.replaceAll(path.sep, "/")
}

function pushIfSet(values, value) {
  const text = cleanText(value)
  if (text) values.push(text)
}

function cleanText(value) {
  return typeof value === "string" ? value.trim() : ""
}

function isSelfUpstream(upstream, currentBranch) {
  const cleanUpstream = cleanText(upstream).replace(/^refs\/remotes\//u, "")
  const cleanBranch = cleanText(currentBranch)
  return cleanBranch.length > 0 &&
    cleanBranch !== "HEAD" &&
    (cleanUpstream === cleanBranch || cleanUpstream.endsWith(`/${cleanBranch}`))
}

function unique(values) {
  return [...new Set(values)]
}
