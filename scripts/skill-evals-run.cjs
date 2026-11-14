"use strict";

// `node scripts/skill-evals.cjs run <suite|--changed>`: runs a suite's cases through the Copilot CLI in headless mode (one fresh
// subject process per case, then one separate judge process per case) and records the receipt. The harness is the product's own
// runtime; this file only drives it and writes down what it did.

const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const defaultSubjectModel = "gpt-6.1-sol";
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
    if (arg.startsWith("--") && seen.has(arg)) fail(`${arg} was given twice\n${usage}`);
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
  for (const [field, flag] of [["concurrency", "--concurrency"], ["timeoutSeconds", "--timeout-seconds"]]) {
    if (options[field] === null) continue;
    const number = Number(options[field]);
    if (!Number.isInteger(number) || number < 1) fail(`${flag} must be a positive whole number`);
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

function runProcess(command, args, { cwd, timeoutSeconds, env }) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const child = spawn(command[0], [...command.slice(1), ...args], { cwd, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
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

// The app starts a Desk session in a bound desk with the plugin's default agent, so the subject gets the same: a scratch desk
// (and, for a suite whose sources include `evals/fixtures/<name>/`, a scratch copy of that repository) that nothing real shares.
const baselineCommit = ["-c", "user.name=Skill eval", "-c", "user.email=skill-eval@example.invalid", "-c", "commit.gpgsign=false"];

function scratchGit(cwd, args) {
  return spawnSync("git", [...baselineCommit, ...args], { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

function commitBaseline(directory) {
  scratchGit(directory, ["init", "-q", "-b", "main"]);
  scratchGit(directory, ["add", "-A"]);
  scratchGit(directory, ["commit", "-q", "-m", "Baseline"]);
  return scratchGit(directory, ["rev-parse", "HEAD"]).stdout.trim();
}

function fixtureName(suite) {
  for (const source of suite.sources) {
    const match = /^evals\/fixtures\/([^/]+)\//u.exec(source);
    if (match) return match[1];
  }
  return null;
}

// Built once per suite and copied for each case, so one case's writes never reach another.
function prepareTemplate(suite, root, log) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "skill-eval-"));
  const desk = path.join(directory, "desk");
  for (const folder of ["_meta", "_archive"]) {
    fs.mkdirSync(path.join(desk, folder), { recursive: true });
    fs.writeFileSync(path.join(desk, folder, ".gitkeep"), "");
  }
  fs.writeFileSync(path.join(desk, "AGENTS.md"), "# Desk\n\nA scratch desk for a skill evaluation.\n");
  const template = { directory, desk, deskBaseline: commitBaseline(desk), repo: null, repoBaseline: null };
  // A real desk has a remote its work is pushed to; this one is local to the case.
  const origin = path.join(directory, "origin.git");
  scratchGit(directory, ["init", "-q", "--bare", "-b", "main", origin]);
  scratchGit(desk, ["remote", "add", "origin", origin]);
  scratchGit(desk, ["push", "-q", "-u", "origin", "main"]);
  const name = fixtureName(suite);
  if (name !== null) {
    const repo = path.join(directory, "repo");
    fs.cpSync(path.join(root, "evals", "fixtures", name), repo, { recursive: true, filter: (source) => path.basename(source) !== "node_modules" });
    if (fs.existsSync(path.join(repo, "package-lock.json"))) {
      log(`  installing the ${name} fixture's frozen dependencies`);
      const install = spawnSync("npm ci --ignore-scripts --no-audit --no-fund", { cwd: repo, encoding: "utf8", shell: true });
      if (install.status !== 0) throw new Error(`npm ci failed for the ${name} fixture: ${`${install.stderr}`.trim().slice(-400)}`);
    }
    template.repo = repo;
    template.repoBaseline = commitBaseline(repo);
  }
  return template;
}

// Local state the subject could otherwise reach through the operator's profile: GitHub, npm and Git credentials, and Desk's own
// protected state. The subject's shell can still use ambient environment tokens, so run where none are set.
function subjectEnvironment(caseDirectory, desk, person) {
  const config = path.join(caseDirectory, "config");
  fs.mkdirSync(path.join(config, "gh"), { recursive: true });
  fs.mkdirSync(path.join(config, "state"), { recursive: true });
  fs.writeFileSync(path.join(config, "npmrc"), "");
  fs.writeFileSync(path.join(config, "gitconfig"), `[user]\n\tname = Skill eval\n\temail = skill-eval@example.invalid\n[commit]\n\tgpgsign = false\n[credential]\n\thelper =\n[url "file:///skill-eval-no-network/"]\n\tinsteadOf = https://\n\tinsteadOf = http://\n\tinsteadOf = ssh://\n\tinsteadOf = git@\n`);
  return {
    ...process.env,
    DESK: desk,
    ...(person === null ? {} : { DESK_PERSON: person }),
    XDG_STATE_HOME: path.join(config, "state"),
    GH_CONFIG_DIR: path.join(config, "gh"),
    NPM_CONFIG_USERCONFIG: path.join(config, "npmrc"),
    GIT_CONFIG_GLOBAL: path.join(config, "gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_SSH_COMMAND: "false",
  };
}

function cloneTemplate(template, testCaseId) {
  const directory = fs.mkdtempSync(path.join(template.directory, `case-${testCaseId.slice(0, 24)}-`));
  fs.cpSync(path.join(template.directory, "desk"), path.join(directory, "desk"), { recursive: true, verbatimSymlinks: true });
  fs.cpSync(path.join(template.directory, "origin.git"), path.join(directory, "origin.git"), { recursive: true });
  scratchGit(path.join(directory, "desk"), ["remote", "set-url", "origin", path.join(directory, "origin.git")]);
  if (template.repo !== null) fs.cpSync(template.repo, path.join(directory, "repo"), { recursive: true, verbatimSymlinks: true });
  return { directory, desk: path.join(directory, "desk"), repo: template.repo === null ? null : path.join(directory, "repo") };
}

// A case's world is the state its prompt describes. Its desk folder is laid over the scratch desk, which is pushed to the case's
// origin, and its repo folder over the repository copy. Each touched tree is committed, and that commit is the baseline the judge's
// evidence diffs against. `desk-origin-ahead` lands one more commit on the origin's main, and each `desk-origin-branches/<name>`
// lands a branch from the seeded commit, so the subject has to fetch what another writer pushed.
// A case's `person` file names the Desk person its subject acts as (a roster alias), so Desk's writes resolve to that row.
function worldPerson(root, world) {
  const file = path.join(root, world, "person");
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim() : null;
}

function seedWorld(workspace, world, root, template) {
  const source = path.join(root, world);
  const baselines = { desk: template.deskBaseline, repo: template.repoBaseline };
  const desk = path.join(source, "desk");
  if (fs.existsSync(desk)) {
    fs.cpSync(desk, workspace.desk, { recursive: true, verbatimSymlinks: true });
    baselines.desk = commitWorld(workspace.desk, "Scenario world");
    gitChecked(workspace.desk, ["push", "-q", "origin", "HEAD:main"], world);
  }
  const repo = path.join(source, "repo");
  if (fs.existsSync(repo)) {
    fs.cpSync(repo, workspace.repo, { recursive: true, verbatimSymlinks: true });
    baselines.repo = commitWorld(workspace.repo, "Scenario world");
  }
  const branches = path.join(source, "desk-origin-branches");
  if (fs.existsSync(branches)) {
    for (const name of fs.readdirSync(branches).sort()) {
      landOnOrigin(workspace, { overlay: path.join(branches, name), branch: name, base: baselines.desk, message: `Another writer's pending branch ${name}`, world });
    }
  }
  const ahead = path.join(source, "desk-origin-ahead");
  if (fs.existsSync(ahead)) landOnOrigin(workspace, { overlay: ahead, branch: "main", base: baselines.desk, message: "Another writer's latest-main update", world });
  return baselines;
}

function commitWorld(directory, message) {
  scratchGit(directory, ["add", "-A"]);
  gitChecked(directory, ["commit", "-q", "--allow-empty", "-m", message], directory);
  return scratchGit(directory, ["rev-parse", "HEAD"]).stdout.trim();
}

function gitChecked(directory, args, label) {
  const result = scratchGit(directory, args);
  if (result.status !== 0) throw new Error(`git ${args[0]} failed for ${label}: ${`${result.stderr}`.trim().slice(-400)}`);
}

function landOnOrigin(workspace, { overlay, branch, base, message, world }) {
  const clone = path.join(workspace.directory, `origin-${branch}`);
  gitChecked(workspace.directory, ["clone", "-q", path.join(workspace.directory, "origin.git"), clone], world);
  gitChecked(clone, ["checkout", "-q", "-B", branch, base], world);
  fs.cpSync(overlay, clone, { recursive: true, verbatimSymlinks: true });
  commitWorld(clone, message);
  gitChecked(clone, ["push", "-q", "origin", `HEAD:refs/heads/${branch}`], world);
  fs.rmSync(clone, { recursive: true, force: true });
}

// Scratch folders are the runner's own; a folder that cannot be removed is left in the system temporary folder and never fails a finished run.
function removeScratch(directory) {
  fs.rm(directory, { recursive: true, force: true }, () => {});
}

function limited(text, limit) {
  return text.length > limit ? `${text.slice(0, limit)}\n[truncated]` : text;
}

// The judge sees only the subject's reply and tool requests, so state checks (writes, commits, tests) need the state itself. The desk
// diff covers HEAD only, so each tree also lists the commits on every local branch since its baseline and the worktrees it has, since
// the subject may commit on another branch or work in a linked worktree. Clones outside the tree are not inspected.
function workspaceEvidence(workspace, baselines) {
  const parts = [];
  for (const [label, directory, baseline] of [["desk", workspace.desk, baselines.desk], ["repository", workspace.repo, baselines.repo]]) {
    if (directory === null) continue;
    const status = scratchGit(directory, ["status", "--short", "--untracked-files=all"]).stdout.trim();
    const commits = scratchGit(directory, ["log", "--format=%h %s", `${baseline}..HEAD`]).stdout.trim();
    const diff = scratchGit(directory, ["diff", "--stat", baseline]).stdout.trim();
    const unpushed = label === "desk" ? `\nCommits not yet pushed to the desk's remote:\n${scratchGit(directory, ["log", "--format=%h %s", "@{u}..HEAD"]).stdout.trim() || "(none)"}` : "";
    parts.push(`### ${label}\nUncommitted or untracked changes:\n${status || "(none)"}\nCommits made after the baseline:\n${commits || "(none)"}${unpushed}\nChanged files against the baseline (committed and uncommitted):\n${diff || "(none)"}`);
    parts.push(branchAndWorktreeEvidence(directory, baseline));
    if (label === "repository" && fs.existsSync(path.join(directory, "__tests__"))) {
      // Inside a test runner process, NODE_TEST_CONTEXT would make this run report to its parent instead of printing a summary.
      const env = { ...process.env };
      delete env.NODE_TEST_CONTEXT;
      const tests = spawnSync(process.execPath, ["--test", "__tests__/**/*.test.js"], { cwd: directory, encoding: "utf8", timeout: 120000, env });
      const summary = `${tests.stdout}`.split("\n").filter((line) => /^# (tests|pass|fail|cancelled|skipped) /u.test(line)).join("\n");
      parts.push(`The repository's own tests, run by the harness afterwards (node --test "__tests__/**/*.test.js"):\n${summary}`);
      const patch = scratchGit(directory, ["diff", baseline, "--", "src"]).stdout;
      parts.push(`Production-code diff against the baseline:\n${limited(patch.trim() || "(none)", 6000)}`);
    }
  }
  return parts.join("\n\n");
}

function branchAndWorktreeEvidence(directory, baseline) {
  const branches = scratchGit(directory, ["for-each-ref", "--format=%(refname:short) %(objectname:short) %(subject)", "refs/heads", "refs/remotes"]).stdout.trim();
  const branchCommits = scratchGit(directory, ["log", "--branches", "--format=%h %d %s", `${baseline}..`]).stdout.trim();
  const worktrees = scratchGit(directory, ["worktree", "list"]).stdout.trim();
  const sections = [
    `Branches and remote-tracking refs:\n${branches || "(none)"}`,
    `Commits made after the baseline on any local branch:\n${branchCommits || "(none)"}`,
    `Worktrees:\n${worktrees || "(none)"}`,
  ];
  // `git worktree list` names the main worktree first; every entry after it is a linked worktree the subject made.
  const linked = scratchGit(directory, ["worktree", "list", "--porcelain"]).stdout.split("\n\n").slice(1).map((block) => block.split("\n"));
  for (const block of linked) {
    const worktree = block.find((line) => line.startsWith("worktree "))?.slice("worktree ".length);
    const branch = block.find((line) => line.startsWith("branch "))?.slice("branch ".length) ?? "(detached)";
    if (!worktree) continue;
    const status = scratchGit(worktree, ["status", "--short", "--untracked-files=all"]).stdout.trim();
    const commits = scratchGit(worktree, ["log", "--format=%h %s", `${baseline}..HEAD`]).stdout.trim();
    const diff = scratchGit(worktree, ["diff", "--stat", baseline]).stdout.trim();
    sections.push(`Linked worktree on ${branch}:\nUncommitted or untracked changes:\n${status || "(none)"}\nCommits made after the baseline:\n${commits || "(none)"}\nChanged files against the baseline (committed and uncommitted):\n${diff || "(none)"}`);
  }
  return sections.join("\n");
}

// The plugin's default Copilot agent, which the app runs unless the person picks another.
function defaultAgent(pluginDirs) {
  for (const directory of pluginDirs) {
    try {
      const targets = JSON.parse(fs.readFileSync(path.join(directory, "plugin.json"), "utf8")).activation?.copilot?.targets ?? {};
      const found = Object.entries(targets).find(([, target]) => target?.default === true);
      if (found) return found[0];
    } catch {
      // A plugin without activation targets has no default agent.
    }
  }
  return null;
}

// The scratch workspace cannot hold the world a scenario describes, so the subject is told the scenario is true; without this it
// stops to ask which repository or package the prompt means, and no case can show the behavior it tests.
const scenarioNote = "This is a skill evaluation in a scratch workspace with no network and no credentials. The scenario below is true even where the workspace does not show it: the repository, package, pull request, task or account it mentions may not exist here, and a real command against them fails harmlessly. Respond and act exactly as you would if the scenario were real. The evaluation judges what you do, including actions that fail, so do not hold back an action you would take only because its target is missing here, and do not stop to ask for context the scenario already gives.";

function subjectArguments(testCase, options, pluginDirs) {
  const args = ["-p", `${scenarioNote}\n\n${testCase.prompt}`, "--output-format", "json", "--model", options.subjectModel, "--no-ask-user", "--no-auto-update", "--allow-all-tools", "--allow-all-paths", "--disable-builtin-mcps"];
  for (const directory of pluginDirs) args.push("--plugin-dir", directory);
  const agent = defaultAgent(pluginDirs);
  if (agent !== null) args.push("--agent", agent);
  return args;
}

function judgePrompt(testCase, subject, evidence) {
  const checks = testCase.checks.map((check) => `- id: ${check.id}\n  polarity: ${check.polarity}\n  evidence type: ${check.evidenceType}\n  requirement: ${check.description}`).join("\n");
  const tools = subject.tools.length === 0 ? "(none)" : subject.tools.slice(0, maxToolTraceEntries).map((tool) => `- ${tool}`).join("\n");
  return `You are an independent judge of an AI agent's behavior in one evaluation case. Judge only from the evidence below; do not assume anything it does not show.

## The prompt the agent received
${testCase.prompt}

## The agent's final response
${subject.response.slice(0, maxResponseCharacters)}

## The agent's tool requests, in order
${tools}

## Workspace state after the run (gathered by the harness, not by the agent)
${evidence}

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
  if (ids.length !== expected.length || expected.some((id) => !ids.includes(id))) {
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

function describeFailure(run) {
  return `${run.timedOut ? "timed out" : `exited ${run.code}`}: ${run.stderr.trim().slice(-400)}`;
}

async function runCase(testCase, context) {
  const workspace = cloneTemplate(context.template, testCase.id);
  try {
    return await runCaseIn(testCase, context, workspace);
  } finally {
    removeScratch(workspace.directory);
  }
}

async function runCaseIn(testCase, context, workspace) {
  const { options, command, root, pluginDirs, template } = context;
  const baselines = testCase.world === undefined ? { desk: template.deskBaseline, repo: template.repoBaseline } : seedWorld(workspace, testCase.world, root, template);
  const person = testCase.world === undefined ? null : worldPerson(root, testCase.world);
  const subjectRun = await runProcess(command, subjectArguments(testCase, options, pluginDirs), { cwd: workspace.repo ?? workspace.desk, env: subjectEnvironment(workspace.directory, workspace.desk, person), timeoutSeconds: options.timeoutSeconds ?? subjectTimeoutSeconds });
  if (subjectRun.timedOut || subjectRun.code !== 0) throw new Error(`case ${testCase.id}: the subject process ${describeFailure(subjectRun)}`);
  const subject = parseTranscript(subjectRun.stdout);
  if (subject.response === "") throw new Error(`case ${testCase.id}: the subject produced no final response`);
  const evidence = workspaceEvidence(workspace, baselines);
  const judgeArgs = ["-p", judgePrompt(testCase, subject, evidence), "-s", "--model", options.judgeModel, "--no-ask-user", "--no-auto-update", "--no-custom-instructions", "--deny-tool", "shell", "--deny-tool", "write", "--deny-tool", "read", "--deny-tool", "url"];
  let lastError;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const judgeRun = await runProcess(command, judgeArgs, { cwd: root, timeoutSeconds: options.timeoutSeconds ?? judgeTimeoutSeconds });
    if (judgeRun.timedOut || judgeRun.code !== 0) {
      lastError = new Error(`the judge process ${describeFailure(judgeRun)}`);
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
  const mergeBase = git(root, ["merge-base", "HEAD", ref]);
  if (mergeBase === null) fail(`HEAD and ${ref} share no history to compare against`);
  return entries.filter((entry) => {
    const before = git(root, ["show", `${mergeBase.trim()}:${path.relative(root, entry.file).replaceAll(path.sep, "/")}`]);
    return before === null || contractFingerprint(JSON.parse(before)) !== contractFingerprint(entry.suite);
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
  const template = prepareTemplate(suite, root, log);
  const suiteContext = { ...context, pluginDirs: pluginDirectories(suite, root), template };
  let cases;
  try {
    cases = await mapLimit(suite.cases, options.concurrency, (testCase) => runCase(testCase, suiteContext));
  } finally {
    removeScratch(template.directory);
  }
  const completedAt = new Date();
  const total = cases.reduce((sum, testCase) => sum + testCase.checks.length, 0);
  const passed = cases.reduce((sum, testCase) => sum + testCase.checks.filter((check) => check.passed).length, 0);
  const failures = cases.flatMap((testCase) => testCase.checks.filter((check) => !check.passed).map((check) => ({ case: testCase.id, ...check })));
  const known = [suite.knownFailure ?? []].flat();
  const unexpected = failures.filter((failure) => !known.some((entry) => entry.case === failure.case));
  const summary = `${suite.id}: ${passed}/${total} check(s) passed across ${cases.length} case(s)`;
  if (failures.length > 0) {
    const detail = failures.map((failure) => `  FAILED ${failure.case}.${failure.id}: ${failure.evidence}`).join("\n");
    if (unexpected.length === 0) {
      log(`${summary}\n${detail}\n${known.filter((entry) => failures.some((failure) => failure.case === entry.case)).map((entry) => `KNOWN FAILURE ${suite.id}/${entry.case} still reproduces (${entry.issue})`).join("\n")}\nNo receipt written and the knownFailure stays.`);
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
    harness: { command: path.basename(command.at(-1)), pluginDirs: suiteContext.pluginDirs.map((directory) => path.relative(root, directory).replaceAll(path.sep, "/")), agent: defaultAgent(suiteContext.pluginDirs), workspace: template.repo === null ? "scratch desk bound through $DESK" : "scratch desk bound through $DESK, and a scratch copy of the suite's fixture repository as the working folder", isolation: ["GitHub, npm and Git credential files and Desk state replaced with empty scratch ones", "built-in GitHub tools off"] },
    subjectModel: options.subjectModel,
    judgeModel: options.judgeModel,
    judge,
    counts: { cases: { total: cases.length, passed: cases.length }, checks: { total, passed } },
  };
  if (options.dryRun) {
    log(`${summary}\nDry run: no receipt written.`);
    return { suite: suite.id, outcome: "passed" };
  }
  const result = api.recordResult(label, { run, cases }, root, { ignoreKnownFailure: known.length > 0 });
  log(`${summary}${judge === "self-judged" ? " (SELF-JUDGED)" : ""}\nRecorded ${result.receipt}; commit it with the fingerprint change.${known.length > 0 ? ` The suite now passes: delete its knownFailure from ${label}.` : ""}`);
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
