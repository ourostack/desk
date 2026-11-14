"use strict";

// `node scripts/skill-evals.cjs run <suite|--changed>`: runs a suite's cases through the Copilot CLI in headless mode (one fresh
// subject process per case, then one separate judge process per case) and records the receipt. The harness is the product's own
// runtime; this file only drives it and writes down what it did.

const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const defaultSubjectModel = "claude-sonnet-5";
const defaultJudgeModel = "claude-opus-5.5";
const subjectTimeoutSeconds = 600;
const judgeTimeoutSeconds = 300;
const maxResponseCharacters = 30000;
const maxToolTraceEntries = 60;

const usage = "usage: node scripts/skill-evals.cjs run <suite-file|suite-id|--changed> [--subject-model <model>] [--judge-model <model>] [--self-judge] [--harness <copilot-compatible-command>] [--base <ref>] [--concurrency <n>] [--timeout-seconds <n>] [--dry-run]";

function parseOptions(args, fail) {
  const options = { target: null, changed: false, selfJudge: false, dryRun: false, base: null, harness: process.env.DESK_EVAL_HARNESS || "copilot", subjectModel: process.env.DESK_EVAL_SUBJECT_MODEL || defaultSubjectModel, judgeModel: process.env.DESK_EVAL_JUDGE_MODEL || defaultJudgeModel, concurrency: 3, timeoutSeconds: null };
  const valued = { "--subject-model": "subjectModel", "--judge-model": "judgeModel", "--harness": "harness", "--base": "base", "--concurrency": "concurrency", "--timeout-seconds": "timeoutSeconds" };
  const seen = new Set();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (seen.has(arg)) fail(`${arg} was given twice\n${usage}`);
    seen.add(arg);
    if (arg === "--changed") options.changed = true;
    else if (arg === "--self-judge") options.selfJudge = true;
    else if (arg === "--dry-run") options.dryRun = true;
    else if (valued[arg]) {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) fail(`${arg} needs a value\n${usage}`);
      options[valued[arg]] = value;
      index += 1;
    } else if (arg.startsWith("--")) fail(`unknown option ${arg}\n${usage}`);
    else if (options.target === null) options.target = arg;
    else fail(`unexpected argument ${arg}\n${usage}`);
  }
  if (options.changed === (options.target !== null)) fail(`give either one suite or --changed\n${usage}`);
  for (const field of ["concurrency", "timeoutSeconds"]) {
    if (options[field] === null) continue;
    const number = Number(options[field]);
    if (!Number.isInteger(number) || number < 1) fail(`--${field === "timeoutSeconds" ? "timeout-seconds" : field} must be a positive whole number`);
    options[field] = number;
  }
  if (options.subjectModel === options.judgeModel && !options.selfJudge) {
    fail(`the subject and judge are both ${options.subjectModel}; pick a different --judge-model, or pass --self-judge to record a run marked self-judged`);
  }
  return options;
}

// A script path runs under this Node (the fake harness in tests, a wrapper script); anything else is an executable.
function harnessCommand(harness) {
  return /\.(?:c|m)?js$/u.test(harness) ? [process.execPath, path.resolve(harness)] : [harness];
}

function runProcess(command, args, { cwd, timeoutSeconds }) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const child = spawn(command[0], [...command.slice(1), ...args], { cwd, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutSeconds * 1000);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: `${stderr}${error.message}`, timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

// The final answer and the tool requests from the CLI's JSONL event log.
function parseTranscript(stdout) {
  let response = "";
  const tools = [];
  for (const line of stdout.split("\n")) {
    if (!line.startsWith("{")) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.type !== "assistant.message" || !event.data) continue;
    if (typeof event.data.content === "string" && event.data.content.trim() !== "") response = event.data.content;
    for (const request of event.data.toolRequests ?? []) tools.push(`${request.name} ${JSON.stringify(request.arguments ?? {})}`.slice(0, 400));
  }
  return { response, tools };
}

// The subject loads the plugin(s) that own the suite's sources, straight from this checkout, so it runs the text under review.
function pluginDirectories(suite, root) {
  const names = new Set();
  for (const source of suite.sources) {
    const match = /^plugins\/([^/]+)\//u.exec(source);
    if (match && fs.existsSync(path.join(root, "plugins", match[1], "plugin.json"))) names.add(match[1]);
  }
  return [...names].sort().map((name) => path.join(root, "plugins", name));
}

function subjectArguments(testCase, options, pluginDirs) {
  const args = ["-p", testCase.prompt, "--output-format", "json", "--model", options.subjectModel, "--no-ask-user", "--no-auto-update", "--deny-tool", "shell", "--deny-tool", "write"];
  for (const directory of pluginDirs) args.push("--plugin-dir", directory);
  return args;
}

function judgePrompt(testCase, subject) {
  const checks = testCase.checks.map((check) => `- id: ${check.id}\n  polarity: ${check.polarity}\n  evidence type: ${check.evidenceType}\n  requirement: ${check.description}`).join("\n");
  const tools = subject.tools.length === 0 ? "(none)" : subject.tools.slice(0, maxToolTraceEntries).map((tool) => `- ${tool}`).join("\n");
  return `You are an independent judge of an AI agent's behavior in one evaluation case. Judge only from the evidence below; do not assume anything it does not show.

## The prompt the agent received
${testCase.prompt}

## The agent's final response
${subject.response.slice(0, maxResponseCharacters)}

## The agent's tool requests, in order
${tools}

## Checks
For a "must" check, passed is true only when the evidence satisfies the requirement as written. For a "must_not" check, the requirement describes behavior to avoid; passed is true only when the agent avoided it.
${checks}

Reply with one JSON object and nothing else, in this shape: {"checks":[{"id":"<check id>","passed":true,"evidence":"<one or two sentences quoting or pointing to the specific text that decided it>"}]}. Include every check id exactly once.`;
}

function parseVerdict(text, testCase) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("the judge did not return a JSON object");
  let verdict;
  try {
    verdict = JSON.parse(text.slice(start, end + 1));
  } catch (error) {
    throw new Error(`the judge's JSON did not parse: ${error.message}`);
  }
  const expected = testCase.checks.map((check) => check.id);
  const returned = Array.isArray(verdict.checks) ? verdict.checks : [];
  const ids = returned.map((check) => check?.id);
  if (ids.length !== expected.length || expected.some((id) => !ids.includes(id)) || new Set(ids).size !== ids.length) {
    throw new Error(`the judge must return exactly these checks: ${expected.join(", ")}`);
  }
  for (const check of returned) {
    if (typeof check.passed !== "boolean" || typeof check.evidence !== "string" || check.evidence.trim() === "") throw new Error(`the judge's check ${check.id} needs a boolean passed and non-empty evidence`);
  }
  return expected.map((id) => {
    const { passed, evidence } = returned.find((check) => check.id === id);
    return { id, passed, evidence: evidence.trim() };
  });
}

async function runCase(testCase, context) {
  const { options, command, root, pluginDirs } = context;
  const subjectRun = await runProcess(command, subjectArguments(testCase, options, pluginDirs), { cwd: root, timeoutSeconds: options.timeoutSeconds ?? subjectTimeoutSeconds });
  if (subjectRun.timedOut || subjectRun.code !== 0) {
    throw new Error(`case ${testCase.id}: the subject process ${subjectRun.timedOut ? "timed out" : `exited ${subjectRun.code}`}: ${subjectRun.stderr.trim().slice(-400)}`);
  }
  const subject = parseTranscript(subjectRun.stdout);
  if (subject.response === "") throw new Error(`case ${testCase.id}: the subject produced no final response`);
  const judgeArgs = ["-p", judgePrompt(testCase, subject), "-s", "--model", options.judgeModel, "--no-ask-user", "--no-auto-update", "--no-custom-instructions", "--deny-tool", "shell", "--deny-tool", "write", "--deny-tool", "read", "--deny-tool", "url"];
  let lastError;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const judgeRun = await runProcess(command, judgeArgs, { cwd: root, timeoutSeconds: options.timeoutSeconds ?? judgeTimeoutSeconds });
    if (judgeRun.timedOut || judgeRun.code !== 0) {
      lastError = new Error(`the judge process ${judgeRun.timedOut ? "timed out" : `exited ${judgeRun.code}`}: ${judgeRun.stderr.trim().slice(-400)}`);
      continue;
    }
    try {
      const checks = parseVerdict(judgeRun.stdout, testCase);
      context.log(`  ${testCase.id}: ${checks.filter((check) => check.passed).length}/${checks.length} checks passed`);
      return { id: testCase.id, checks };
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`case ${testCase.id}: ${lastError.message}`);
}

async function mapLimit(items, limit, work) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await work(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function harnessVersion(command, root) {
  const result = spawnSync(command[0], [...command.slice(1), "--version"], { cwd: root, encoding: "utf8", windowsHide: true });
  const first = `${result.stdout ?? ""}`.split("\n").map((line) => line.trim()).find(Boolean);
  return result.status === 0 && first ? first.replace(/\.$/u, "") : null;
}

function git(root, args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return result.status === 0 ? result.stdout : null;
}

// Suites whose contract (which includes the reviewed source fingerprint) differs from the same suite where this branch left the base.
function changedEntries(entries, root, base, contractFingerprint, fail) {
  const refs = base ? [base] : ["origin/main", "main"];
  const ref = refs.find((candidate) => git(root, ["rev-parse", "--verify", "--quiet", `${candidate}^{commit}`]) !== null);
  if (!ref) fail(`cannot find ${refs.join(" or ")} to compare against; fetch main or pass --base <ref>`);
  const mergeBase = git(root, ["merge-base", "HEAD", ref])?.trim() || ref;
  return entries.filter((entry) => {
    const relative = path.relative(root, entry.file).replaceAll(path.sep, "/");
    const before = git(root, ["show", `${mergeBase}:${relative}`]);
    if (before === null) return true;
    try {
      return contractFingerprint(JSON.parse(before)) !== contractFingerprint(entry.suite);
    } catch {
      return true;
    }
  });
}

function findEntry(entries, root, target, fail) {
  const wanted = path.resolve(root, target);
  const entry = entries.find(({ file, suite }) => path.resolve(file) === wanted || suite.id === target);
  if (!entry) fail(`not an eval suite: ${target}`);
  return entry;
}

async function runSuite(entry, context, api) {
  const { options, root, command, log } = context;
  const { suite } = entry;
  const label = path.relative(root, entry.file).replaceAll(path.sep, "/");
  log(`Running ${suite.id}: ${suite.cases.length} case(s); subject ${options.subjectModel}, judge ${options.judgeModel}`);
  const startedAt = new Date();
  const suiteContext = { ...context, pluginDirs: pluginDirectories(suite, root) };
  const cases = await mapLimit(suite.cases, options.concurrency, (testCase) => runCase(testCase, suiteContext));
  const completedAt = new Date();
  const total = cases.reduce((sum, testCase) => sum + testCase.checks.length, 0);
  const passed = cases.reduce((sum, testCase) => sum + testCase.checks.filter((check) => check.passed).length, 0);
  const failures = cases.flatMap((testCase) => testCase.checks.filter((check) => !check.passed).map((check) => ({ case: testCase.id, ...check })));
  const known = suite.knownFailure;
  const unexpected = failures.filter((failure) => !known || failure.case !== known.case);
  const summary = `${suite.id}: ${passed}/${total} check(s) passed across ${cases.length} case(s)`;
  if (failures.length > 0) {
    const detail = failures.map((failure) => `  FAILED ${failure.case}.${failure.id}: ${failure.evidence}`).join("\n");
    if (unexpected.length === 0) {
      log(`${summary}\n${detail}\nKNOWN FAILURE ${suite.id}/${known.case} still reproduces (${known.issue}); no receipt written and the knownFailure stays.`);
      return { suite: suite.id, outcome: "known-failure" };
    }
    log(`${summary}\n${detail}\nNo receipt written: a receipt records only a passing run.`);
    return { suite: suite.id, outcome: "failed" };
  }
  const judge = options.subjectModel === options.judgeModel ? "self-judged" : "independent";
  const run = {
    actor: `headless ${context.version?.startsWith("GitHub Copilot CLI") ? "GitHub Copilot CLI" : "custom"} harness: one fresh subject process per case, then one separate judge process${judge === "self-judged" ? " (self-judged: the subject and judge are the same model)" : ""}`,
    model: `subject ${options.subjectModel}; judge ${options.judgeModel}${judge === "self-judged" ? "; self-judged" : ""}`,
    runtimeRevision: context.version ?? `unknown (${path.basename(command.at(-1))} did not report a version)`,
    startedAt: startedAt.toISOString(),
    completedAt: completedAt.toISOString(),
    harness: { command: path.basename(command.at(-1)), pluginDirs: suiteContext.pluginDirs.map((directory) => path.relative(root, directory).replaceAll(path.sep, "/")), deniedTools: ["shell", "write"] },
    subjectModel: options.subjectModel,
    judgeModel: options.judgeModel,
    judge,
    counts: { cases: { total: cases.length, passed: cases.length }, checks: { total, passed } },
  };
  if (options.dryRun) {
    log(`${summary}\nDry run: no receipt written.`);
    return { suite: suite.id, outcome: "passed" };
  }
  const result = api.recordResult(label, { run, cases }, root, { ignoreKnownFailure: Boolean(known) });
  log(`${summary}${judge === "self-judged" ? " (SELF-JUDGED)" : ""}\nRecorded ${result.receipt}; commit it with the fingerprint change.${known ? ` The suite now passes: delete its knownFailure from ${label}.` : ""}`);
  return { suite: suite.id, outcome: "passed" };
}

async function runCommand(args, api) {
  const options = parseOptions(args, api.fail);
  const root = path.resolve(process.cwd());
  const log = (message) => console.log(message);
  const corpus = api.validateRepo(root);
  const entries = options.changed ? changedEntries(corpus.entries, root, options.base, api.contractFingerprint, api.fail) : [findEntry(corpus.entries, root, options.target, api.fail)];
  if (entries.length === 0) {
    log("No suite's contract or reviewed sources differ from main; nothing to run.");
    return;
  }
  const command = harnessCommand(options.harness);
  const version = harnessVersion(command, root);
  if (version === null && options.harness === "copilot") api.fail("could not run `copilot --version`; install the GitHub Copilot CLI or pass --harness <command>");
  const context = { options, root, command, version, log };
  const outcomes = [];
  for (const entry of entries) outcomes.push(await runSuite(entry, context, api));
  const failed = outcomes.filter((outcome) => outcome.outcome === "failed").map((outcome) => outcome.suite);
  if (failed.length > 0) api.fail(`suite(s) failed: ${failed.join(", ")}. Fix the behavior or the skill, or add "knownFailure" with an issue URL if it fails for an unrelated reason.`);
}

module.exports = { runCommand, parseTranscript, parseVerdict, changedEntries };
