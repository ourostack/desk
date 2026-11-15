"use strict";

// The boot-check registry both session-start hooks run after building their
// existing output (Claude through resolve-desk-root.js --boot-checks, Copilot
// through copilot-session-start.cjs).
//
// Each check is `{ id, budgetMs, run(ctx) -> { line?, repair?: { command } } }`
// and they run in order under one 300 ms wall-clock deadline, including index
// snapshots; a check gets the smaller of its own work budget and what is left.
// A check is skipped for this start, its
// line and repair discarded, when its budget timer fires, when it took longer
// than its budget (a check that blocks synchronously settles before its timer
// can fire), when it throws, or when it stops itself at `ctx.deadline` by
// throwing an error whose code is `boot_check_budget`. Repairs start detached with
// ignored stdio after every check has run. The hook appends exactly one line,
// `Desk boot pre-checks: <line>; <line>`, addressed to the agent, and nothing at all when
// no check has a line, so its output is then byte-identical to the output it
// built before the registry ran.
//
// Index tracing (spec.md §3): none of the checks below is designed to touch
// the Git index, so a `git diff --cached --name-only` snapshot taken
// immediately before and after each `check.run(...)` call — against the same
// desk root `deskHealthCheck` already resolves, only when it is
// itself a Git repository — catches a check that stages a path it never
// should. A drift appends a `Desk problem: index-drift — ...`
// block (`mcp/src/runtime/index-drift.js`) to the same output; it names the
// check and the exact paths, never undoes the staging, and never blocks.
//
// The registry, in order:
//   1. desk-health: the bound root's last Desk start, and a detached
//      fast-forward of a clean state branch (mcp/src/runtime/desk-health.js);
//   2. workspace-tidy: stale worktree listing with its own detached repair
//      (mcp/src/runtime/workspace-tidy.js). It launches that repair itself and
//      keeps a soft deadline inside its budget; an unfinished inspection is
//      skipped for this start (the next start runs it again), and the check says
//      nothing unless it has something for the agent: leftovers, an issue or a
//      repair that could not start.
//
// The factory runs nothing at session start: no check, no line and no delivery worker.
// Its store and its tools stay, and run when someone asks (`mcp/scripts/factory.js`, `desk_doctor`).
//
// The hook runs in whatever `node` the host puts first on PATH, so all of
// this keeps to what Node 16 has, and the boot path never searches for a
// Node. Every detached child that loads Desk's MCP code starts in the hook's
// own Node as a Node 16-safe launcher in this file: `--repair`
// (`startRepair`) for the workspace tidy, and `--compatible <script> ...`
// (`runCompatible`) for the rest. The launcher finds a Node that satisfies
// the MCP's engines range and runs the real work there.

const fs = require("node:fs/promises");
const path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");
const { spawn, spawnSync } = require("node:child_process");
// Loaded only by the detached launchers, never on the boot path.
const compatibleNode = (options) => require("../compatible-node.cjs").compatibleNode(options);
// A headless evaluator session hears nothing from the boot checks and starts nothing (mcp/src/factory/headless-flag.js).
const isHeadless = (env) => { try { return require("../../mcp/src/factory/headless-flag.cjs").isHeadlessFactorySession(env); } catch { const v = String(env?.DESK_FACTORY_HEADLESS ?? ""); return v !== "" && v !== "0"; } };
// Set on the repair a launcher re-executes in a compatible Node, so it runs the repair itself.
const REPAIR_NODE_ENV = "DESK_TIDY_REPAIR_NODE";
// The launcher may spend the bootstrap's full probe budget: nothing waits on it.
const LAUNCHER_PROBE_BUDGET_MS = 3000;
const NODE_STATUS_MAX_BYTES = 4096;
const oneLine = (value) => String(value).replace(/[\x00-\x1f\x7f]/gu, " ").slice(0, 480);
// This file's own installed path, so a boot line that names "the repair" can give the exact, copy-pasteable
// command instead of leaving the agent to guess it (docs/workspace-tidy.md's own worked example).
const HOOKS_DIR = path.join(__dirname, "..");
const PLUGIN_ROOT_DIR = path.join(__dirname, "..", "..");
const REPAIR_ENTRY_POINT = path.join(HOOKS_DIR, "boot-checks.cjs");
const TOTAL_BUDGET_MS = 300;
// Read by the session-start hooks when they run, never when this module loads, so the test-only boot fixture can relax them for one
// hook process (tests/desk/mcp/__tests__/_boot_fixture_preload.cjs). Production values only; nothing here reads the environment.
const timing = {
  // Copilot drops a sessionStart hook's whole output when the hook passes its 5 s limit, foundation included. So the optional lines
  // (boot pre-checks, migrations, the Copilot setting notes) get until this many milliseconds after the process started; past it the
  // hook prints the startup line and the foundation without them and does not start factory delivery. The boot script runs the
  // migration checks again; the pre-checks and the delivery wait for the next session start.
  optionalLinesDeadlineMs: 3500,
};
const TIDY_SOFT_MARGIN_MS = 20;
const DESK_PROBLEM_SCRIPT = path.join(PLUGIN_ROOT_DIR, "mcp", "scripts", "file-desk-problem.js");
const BOOT_CHECK_FIX_ATTEMPT = "not auto-repaired -- reinstall Desk or inspect this check's own code.";
const INDEX_DRIFT_FIX_ATTEMPT = "not auto-repaired -- staged paths are left as-is for inspection.";
const MIGRATIONS_FIX_ATTEMPT = "not auto-repaired -- the migration registry itself needs investigation.";

// `root` is the bound desk's canonical identity, its real path, so every
// spelling of one desk (a symlink alias, its real path) shares one report and
// one lock.
function reportPath(root, common) {
  const key = createHash("sha256").update(root).digest("hex").slice(0, 16);
  return path.join(common, `desk-workspace-tidy-${key}.json`);
}

async function location(root) {
  const canonical = await fs.realpath(root);
  const { readInspectionGit } = await import("../../mcp/src/runtime/git-inspection.js");
  const { TIDY_GIT_TIMEOUT_MS } = await import("../../mcp/src/runtime/workspace-tidy.js");
  // The report location serves the detached repair and the CLI, never the boot check's budget.
  const result = await readInspectionGit(canonical, ["rev-parse", "--path-format=absolute", "--git-common-dir"], { timeoutMs: TIDY_GIT_TIMEOUT_MS });
  if (!result.ok) throw Object.assign(new Error("Use a desk that is an inspectable Git repository: bound desk is not an inspectable repository"), { code: "boot_checks.cjs_use_a_desk_that_is" });
  const common = await fs.realpath(result.stdout);
  return { canonical, file: reportPath(canonical, common) };
}

async function readReport(file) {
  const { decodeTidyReport, TIDY_REPORT_MAX_BYTES } = await import("../../mcp/src/runtime/workspace-evidence.js");
  const info = await fs.lstat(file);
  if (!info.isFile() || info.nlink !== 1 || info.size > TIDY_REPORT_MAX_BYTES) throw Object.assign(new Error("Run the workspace tidy again: unsafe workspace-tidy report"), { code: "boot_checks.cjs_run_the_workspace_tidy_again_3" });
  return decodeTidyReport(await fs.readFile(file, "utf8"));
}

/** Starts `command` detached with ignored stdio and lets this process exit without waiting for it. */
async function launchCommand(command, env, spawnImpl = spawn) {
  await new Promise((resolve, reject) => {
    const child = spawnImpl(command[0], command.slice(1), { detached: true, stdio: "ignore", windowsHide: true, env });
    child.once("error", reject);
    child.once("spawn", () => { child.unref(); resolve(); });
  });
}

// The no-Node status the repair launcher leaves beside the report when it
// found no compatible Node, so the next boot line can say so.
function nodeStatusPath(file) {
  return `${file}.node.json`;
}

async function readNodeStatus(file) {
  const info = await fs.lstat(nodeStatusPath(file));
  if (!info.isFile() || info.nlink !== 1 || info.size > NODE_STATUS_MAX_BYTES) throw Object.assign(new Error("Run the workspace tidy again: unsafe workspace-tidy node status"), { code: "boot_checks.cjs_run_the_workspace_tidy_again_2" });
  const status = JSON.parse(await fs.readFile(nodeStatusPath(file), "utf8"));
  if (typeof status?.range !== "string") throw Object.assign(new Error("Run the workspace tidy again: invalid workspace-tidy node status"), { code: "boot_checks.cjs_run_the_workspace_tidy_again" });
  return status;
}

// Written like the report: a new private temporary file renamed into place,
// so no symlink at the path is followed and no reader sees a partial file.
async function writeNodeStatus(file, status) {
  const target = nodeStatusPath(file);
  const temporary = `${target}.${randomUUID()}.tmp`;
  const output = await fs.open(temporary, "wx", 0o600);
  try { await output.writeFile(`${JSON.stringify(status)}\n`); await output.sync(); } finally { await output.close(); }
  try {
    await fs.rename(temporary, target);
  } catch (error) {
    await fs.rm(temporary, { force: true });
    throw Object.assign(new Error(`Check that the folder is writable, then run it again: could not record the workspace-tidy Node status at ${target}: ${error.code ?? error.message}`), { code: "boot_checks.cjs_check_that_the_folder_is" });
  }
}

// Removes a recorded no-Node status. Anything else at that path, such as a
// directory, is left alone: the repair still runs, and the boot line names
// the path as unreadable.
async function clearNodeStatus(file) {
  const target = nodeStatusPath(file);
  let info;
  try { info = await fs.lstat(target); } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  if (info.isFile() || info.isSymbolicLink()) await fs.unlink(target);
}

// The boot path does no Node search: the detached child starts in the hook's
// own Node, which may be old, as the Node 16-safe repair launcher
// (`startRepair`). The launcher finds a compatible Node and re-executes the
// repair in it.
async function launchRepair(root, env, spawnImpl = spawn) {
  await launchCommand([process.execPath, REPAIR_ENTRY_POINT, "--repair", root], env, spawnImpl);
}

// A command that runs `script` and its arguments in a compatible Node,
// through the `--compatible` launcher started in this (possibly old) Node.
function compatibleCommand(script, ...args) {
  return [process.execPath, REPAIR_ENTRY_POINT, "--compatible", script, ...args];
}

async function checkWorkspace({ host, env = process.env, sessionFolder, launch = launchRepair, inspectionBudgetMs }, expired, signal) {
  try {
    const [{ resolveStartupRoot }, { resolveActivationConfigPath }] = await Promise.all([
      import("../../mcp/src/util/startup-direction.js"), import("../../mcp/src/util/paths.js"),
    ]);
    // The server binds the same project folder: Claude's environment passes it, and Copilot's `sessionStart` hook records the session folder for the server.
    const bound = resolveStartupRoot({
      env, activationConfigPath: resolveActivationConfigPath({ env }),
      hostProjectRoot: { claude: env.CLAUDE_PROJECT_DIR, copilot: sessionFolder }[host],
    });
    if (bound.error) return "workspace-tidy deferred; binding configuration unreadable; resolve with desk_status.";
    const { inspectWorkspace, tidyLine, canonicalDeskRoot } = await import("../../mcp/src/runtime/workspace-tidy.js");
    // One identity for the bound desk, resolved once: a symlink alias and its
    // real path are the same desk for the inventory, the report and the lock.
    const root = bound.root ? await canonicalDeskRoot(bound.root) : null;
    if (bound.unavailable) return "workspace-tidy skipped; the bound desk is unavailable; see desk_status.";
    // Nothing to tidy without a bound desk, and nothing for the agent to do about it.
    if (!root) return "";
    const inventory = await inspectWorkspace({ deskRoot: root, signal, budgetMs: inspectionBudgetMs });
    if (expired()) return "";
    let previous = "";
    // Issues the last repair's line already names are not repeated after it.
    let named = [];
    if (inventory.commonDirectory) {
      try {
        const file = reportPath(root, inventory.commonDirectory);
        const report = await readReport(file);
        // A report written before roots were canonical may carry the alias.
        if (await canonicalDeskRoot(report.root) === root) {
          previous = `Last repair: ${tidyLine(report)}; `;
          named = Array.isArray(report.issues) ? report.issues : [];
        }
      } catch (error) {
        if (error.code !== "ENOENT") previous = "Previous workspace-tidy report unreadable; ";
      }
      try {
        const file = reportPath(root, inventory.commonDirectory);
        await fs.lstat(`${file}.lock`);
        previous += `repair lock ${path.basename(file)}.lock; reconcile exact owner if stale; `;
      } catch (error) {
        if (error.code !== "ENOENT") previous += "repair lock unreadable; ";
      }
      try {
        const status = await readNodeStatus(reportPath(root, inventory.commonDirectory));
        previous += `last repair not started: it needs Node ${oneLine(status.range)} and none was found; `;
      } catch (error) {
        if (error.code !== "ENOENT") previous += "repair Node status unreadable; ";
      }
    }
    // No status, ancestry, network or removal in the hook. Detailed checks and
    // mutations run after launch in the detached process, with fresh evidence.
    if (expired()) return "";
    // The repair gets the binding's own spelling and resolves it again itself.
    await launch(bound.root, env);
    const issues = inventory.issues.filter((issue) => !named.includes(issue));
    // A repair that started and found nothing to report is not news for the agent.
    if (previous === "" && issues.length === 0) return "";
    return `workspace-tidy ${oneLine(`${previous}deferred (${inventory.worktrees.length} listed)${issues.length ? `; ${issues.join("; ")}` : ""}`)}`;
  } catch (error) {
    return `workspace-tidy deferred; ${oneLine(error.message)}`;
  }
}

async function runWorkspaceTidy(ctx) {
  let expired = false;
  let timer;
  const cancellation = new AbortController();
  const stopAll = () => { expired = true; cancellation.abort(); };
  ctx.signal?.addEventListener("abort", stopAll);
  try {
    const line = await Promise.race([
      checkWorkspace(ctx, () => expired, cancellation.signal),
      new Promise((resolve, reject) => {
        timer = setTimeout(() => {
          stopAll();
          // Deferred, not stuck: the next session start runs this check fresh and launches the repair itself, so no
          // agent action is required and the line would only be noise.
          reject(Object.assign(new Error("Run the check again: workspace-tidy ran past its budget"), { code: "boot_check_budget" }));
        }, Math.max(1, Math.min(ctx.tidyBudgetMs ?? Infinity, ctx.budgetMs - TIDY_SOFT_MARGIN_MS)));
      }),
    ]);
    return line ? { line } : {};
  } finally {
    clearTimeout(timer);
    ctx.signal?.removeEventListener("abort", stopAll);
  }
}

// ---------------------------------------------------------------------------
// The factory and desk-health checks.
// ---------------------------------------------------------------------------

/**
 * The root the session binds to, resolved the same way as
 * resolve-desk-root.js `resolveHookDeskRoot` (bounded activation reads), and
 * shared by the checks of one start. It imports the resolver's parts rather
 * than that script, which is the Claude hook's entry point and is still
 * running this registry from its top-level await.
 */
async function boundRoot(ctx) {
  ctx.shared.root ??= (async () => {
    const [{ resolveActivationConfigPath, resolveDeskRootWithSource }, { readSmallText }] = await Promise.all([import("../../mcp/src/util/paths.js"), import("../../mcp/src/factory/marker.js")]);
    try {
      return resolveDeskRootWithSource({
        activationConfigPath: resolveActivationConfigPath({ env: ctx.env }),
        env: ctx.env,
        cwd: ctx.host === "copilot" ? ctx.sessionFolder ?? process.cwd() : ctx.env.CLAUDE_PROJECT_DIR || process.cwd(),
        homeDir: ctx.env.HOME || require("node:os").homedir(),
        hostProjectRoot: ctx.host === "copilot" ? ctx.sessionFolder : ctx.env.CLAUDE_PROJECT_DIR,
        readActivationConfig: (file) => readSmallText(file),
      }).root;
    } catch {
      return null;
    }
  })();
  return ctx.shared.root;
}

const deskHealthCheck = {
  id: "desk-health",
  budgetMs: 50,
  async run(ctx) {
    const [{ deskHealthCheck: check }, { isDeskWorkspace }] = await Promise.all([import("../../mcp/src/runtime/desk-health.js"), import("../../mcp/src/util/paths.js")]);
    const roots = [];
    if (ctx.host === "copilot" && isDeskWorkspace(ctx.sessionFolder)) roots.push(path.resolve(ctx.sessionFolder));
    const bound = await boundRoot(ctx);
    if (bound && !roots.includes(bound)) roots.push(bound);
    for (const root of roots) {
      const result = check({ env: ctx.env, root });
      if (result.line) return { line: result.line };
      if (result.fastForward) return { repair: { command: compatibleCommand(REPAIR_ENTRY_POINT, "--fast-forward", root) } };
    }
    return {};
  },
};

const workspaceTidyCheck = { id: "workspace-tidy", budgetMs: 260, run: runWorkspaceTidy };

// ---------------------------------------------------------------------------
// The registry.
// ---------------------------------------------------------------------------

const validRepair = (repair) => Array.isArray(repair?.command) && repair.command.length > 0 && repair.command.every((part) => typeof part === "string" && part !== "");

/**
 * Runs the registry (see the header). Options: `host`, `env`, `sessionFolder`,
 * plus for tests `checks`, `totalBudgetMs`, `checkBudgets` ({ id: ms }),
 * `launchRepair(command, env)`, `launch` (the
 * workspace-tidy repair launcher), `loadRedaction`, `loadArgvSafeReason` and
 * `spawnGit` (the index-tracing Git seam; real callers never pass it).
 * Resolves `""` or one `Desk boot pre-checks:` line; never rejects. The line names
 * worktree paths, branches and error messages, so each path segment or word
 * that carries a secret's value is redacted (mcp/src/util/redact.js); if the
 * redaction cannot load, the line is withheld rather than shown unredacted.
 */
async function runBootChecks(options = {}) {
  const {
    checks: registry = checks, totalBudgetMs = TOTAL_BUDGET_MS, checkBudgets = {}, launchRepair: startRepair = launchCommand,
    loadRedaction = () => import("../../mcp/src/util/redact.js"),
    loadArgvSafeReason = () => import("../../mcp/src/runtime/argv-safe-reason.js"),
    spawnGit = spawnSync,
  } = options;
  const env = options.env ?? process.env;
  if (isHeadless(env)) return "";
  const registryDeadline = performance.now() + totalBudgetMs;
  // A check's own timer firing proves its budget elapsed, even when performance.now() reads a little earlier: Node's timers run on libuv's cached loop time.
  let charged = -Infinity;
  const remaining = () => registryDeadline - Math.max(performance.now(), charged);
  const shared = {};
  const lines = [];
  const repairs = [];
  // Index tracing (spec.md §3): resolved once, the same way
  // `deskHealthCheck` resolves its own desk root, and only watched when it
  // is itself a Git repository.
  const { snapshotStagedPaths, diffStagedPaths, formatIndexDriftProblem, formatDeskProblem } = await import("../../mcp/src/runtime/index-drift.js");
  const driftRoot = await boundRoot({ env, host: options.host, sessionFolder: options.sessionFolder, shared });
  const tracksIndex = typeof driftRoot === "string";
  // A failure's raw text (a staged path, an error message) never becomes an
  // argument on the detached filer's own command line unredacted -- `ps`
  // shows a process's argv to every account on the machine, not just this
  // session. `shouldLaunchFiler` throttles the *spawn* only, never the block
  // this function still shows the operator every time (fix round, spec.md
  // §1 Part 5). `shouldLaunchFiler` fails toward the old, always-filing
  // behavior if it cannot be loaded, since that only affects how often
  // filing happens; `argvSafeReason` fails toward a fixed, unrevealing
  // string instead, since its own job is exactly to keep raw text out of
  // argv -- falling back to the raw text it could not redact would defeat
  // the fix this function exists for.
  const argvSafeReason = await loadArgvSafeReason().then((mod) => mod.argvSafeReason, () => () => "reason unavailable (redactor not loaded)");
  const shouldLaunchFiler = await import("../../mcp/src/runtime/filer-throttle.js").then((mod) => mod.shouldLaunchFiler, () => () => true);
  // Queued the way every check's repair is: a fileProblem
  // closure that only builds the repair command (compatibleCommand,
  // synchronous), returns `file: "filing in background"`, and lets the
  // registry's own post-loop repair loop below do the actual, unawaited
  // detached launch -- never inline, never on this check's own budget.
  const indexDriftFileProblem = async ({ reason }) => {
    const safeReason = argvSafeReason(reason);
    const launch = shouldLaunchFiler({ env, mechanism: "index-drift", signature: safeReason });
    if (launch) repairs.push(compatibleCommand(DESK_PROBLEM_SCRIPT, "--mechanism", "index-drift", "--reason", safeReason || "unknown", "--host", options.host || "unknown", "--fix-attempt", INDEX_DRIFT_FIX_ATTEMPT));
    return { file: launch ? "filing in background" : "filing already queued (within the last hour)" };
  };
  for (const check of registry) {
    let budget = Math.min(checkBudgets[check.id] ?? check.budgetMs, remaining());
    // Timers resolve to whole milliseconds, so less than one left is none left.
    if (budget < 1) {
      if (check.budgetLine) lines.push(oneLine(check.budgetLine));
      continue;
    }
    const cancellation = new AbortController();
    // Snapshots share the registry deadline without consuming the check's own work allowance.
    const beforeStaged = tracksIndex ? snapshotStagedPaths({ root: driftRoot, spawnGit, timeoutMs: remaining() }) : null;
    budget = Math.min(budget, remaining());
    if (budget < 1) {
      if (check.budgetLine) lines.push(oneLine(check.budgetLine));
      continue;
    }
    const checkStarted = performance.now();
    const deadline = checkStarted + budget;
    let timer;
    const outcome = await Promise.race([
      Promise.resolve()
        .then(() => check.run({ ...options, env, budgetMs: budget, deadline, signal: cancellation.signal, shared }))
        .then((value) => ({ value }), (error) => (error?.code === "boot_check_budget" ? { overrun: true } : { failed: true, error })),
      new Promise((resolve) => { timer = setTimeout(resolve, Math.ceil(budget), { overrun: true, timer: true }); }),
    ]);
    clearTimeout(timer);
    if (outcome.timer) charged = Math.max(charged, deadline);
    // A check that blocks synchronously settles before its timer can fire, so the real elapsed time decides: past the budget, its line and repair are discarded like a timed-out check's.
    const elapsed = performance.now() - checkStarted;
    if (outcome.overrun || elapsed > budget) cancellation.abort();
    // The after-snapshot is taken (and its own cost incurred) only once the
    // check's own elapsed time is already settled, and only when the before-
    // snapshot itself succeeded: a failed or timed-out "before" makes any
    // diff meaningless, and trying again risks the same hang twice.
    if (tracksIndex && beforeStaged !== null && remaining() >= 1) {
      const afterStaged = snapshotStagedPaths({ root: driftRoot, spawnGit, timeoutMs: remaining() });
      if (afterStaged !== null) {
        const drift = diffStagedPaths(beforeStaged, afterStaged);
        if (drift.length > 0) lines.push(await formatIndexDriftProblem({ kind: "boot check", label: check.id, drift, env, host: options.host, fileProblem: indexDriftFileProblem }));
      }
    }
    if (outcome.overrun || elapsed > budget || remaining() < 1) {
      cancellation.abort();
      if (check.budgetLine) lines.push(oneLine(check.budgetLine));
      continue;
    }
    if (outcome.failed) {
      const reason = oneLine(outcome.error?.message ?? String(outcome.error ?? "unknown error"));
      const safeReason = argvSafeReason(reason);
      const launch = shouldLaunchFiler({ env, mechanism: check.id, signature: safeReason });
      lines.push(formatDeskProblem({
        mechanism: check.id,
        symptom: "the check failed internally at startup",
        broke: reason,
        means: `Desk's "${check.id}" boot check could not report its status this session`,
        fix: "not fixable automatically -- the check itself needs investigation",
        file: launch ? "filing in background" : "filing already queued (within the last hour)",
        tell: `Desk's "${check.id}" boot check failed internally this session (${reason}). Filing this now so it gets fixed.`,
      }));
      if (launch) repairs.push(compatibleCommand(DESK_PROBLEM_SCRIPT, "--mechanism", check.id, "--reason", safeReason, "--host", options.host || "unknown", "--fix-attempt", BOOT_CHECK_FIX_ATTEMPT));
      continue;
    }
    const { line, repair } = outcome.value ?? {};
    if (typeof line === "string" && line.trim() !== "") lines.push(oneLine(line.trim()));
    if (validRepair(repair)) repairs.push(repair.command);
  }
  for (const command of repairs) {
    try {
      await startRepair(command, env);
    } catch {
      // A repair that cannot start is retried at the next session start.
    }
  }
  if (lines.length === 0) return "";
  try {
    const { redactCredentialLikeText } = await loadRedaction();
    return redactCredentialLikeText(`Desk boot pre-checks: ${lines.join("; ")}`);
  } catch {
    return "";
  }
}

/**
 * The `Desk migrations:` line for this session, or "" when none of Desk's own
 * migrations is pending (mcp/src/runtime/pending-migrations.js). It runs every
 * Detect block itself, alongside the registry and outside its budget, with its
 * own limit, so a pending migration never depends on the agent choosing to run
 * the session-start skill's migration step. `budgetMs` and `pluginRoot` are
 * test seams. Never rejects.
 *
 * Migrated onto the failure contract (spec.md §1, Part 5): when the migration
 * registry itself fails internally, `startupMigrationLine` needs a real
 * filing step -- this wrapper supplies it the same way the index-drift check
 * does its own: `launchRepair` (default `launchCommand`) starts the detached
 * `file-desk-problem.js` run and is never awaited past its own spawn; a
 * launcher that fails leaves the block honestly reporting `file: not filed:
 * filer_unavailable` rather than throwing.
 */
async function migrationLine({ host, env = process.env, sessionFolder, budgetMs, pluginRoot = PLUGIN_ROOT_DIR, launchRepair: startRepair = launchCommand, loadArgvSafeReason = () => import("../../mcp/src/runtime/argv-safe-reason.js") } = {}) {
  try {
    const { startupMigrationLine } = await import("../../mcp/src/runtime/pending-migrations.js");
    // See runBootChecks's own comment above: argvSafeReason fails toward a
    // fixed, unrevealing string, never toward the raw reason it could not
    // redact.
    const argvSafeReason = await loadArgvSafeReason().then((mod) => mod.argvSafeReason, () => () => "reason unavailable (redactor not loaded)");
    const shouldLaunchFiler = await import("../../mcp/src/runtime/filer-throttle.js").then((mod) => mod.shouldLaunchFiler, () => () => true);
    const cwd = host === "copilot" ? sessionFolder || process.cwd() : env.CLAUDE_PROJECT_DIR || process.cwd();
    return await startupMigrationLine({
      pluginRoot, env, cwd, budgetMs, host, quietWhenUnchecked: true,
      fileProblem: async ({ reason }) => {
        const safeReason = argvSafeReason(reason);
        if (!shouldLaunchFiler({ env, mechanism: "pending-migrations", signature: safeReason })) {
          return { file: "filing already queued (within the last hour)" };
        }
        try {
          await startRepair(compatibleCommand(DESK_PROBLEM_SCRIPT, "--mechanism", "pending-migrations", "--reason", safeReason || "unknown", "--host", host || "unknown", "--fix-attempt", MIGRATIONS_FIX_ATTEMPT), env);
          return { file: "filing in background" };
        } catch {
          return { file: "not filed: filer_unavailable" };
        }
      },
    });
  } catch {
    return "";
  }
}

async function updateReport(root, operation) {
  const { canonical, file } = await location(root);
  const lock = `${file}.lock`;
  const token = randomUUID();
  let handle;
  try { handle = await fs.open(lock, "wx", 0o600); } catch (error) {
    if (error.code === "EEXIST") return { busy: true, lock };
    throw error;
  }
  try {
    const { readProcessStart } = await import("../../mcp/src/readiness/process-start.js");
    const ownership = JSON.stringify({ token, pid: process.pid, start: await readProcessStart(process.pid) });
    await handle.writeFile(ownership);
    await handle.close();
    const { tidyLine } = await import("../../mcp/src/runtime/workspace-tidy.js");
    const { encodeTidyReport } = await import("../../mcp/src/runtime/workspace-evidence.js");
    let previous = {};
    try { previous = await readReport(file); } catch (error) { if (error.code !== "ENOENT") throw error; }
    const prepare = (result) => {
      result.line = tidyLine(result);
      result.root = canonical;
      result.updated = new Date().toISOString();
      return encodeTidyReport(result);
    };
    const persist = async (result) => {
      const bytes = prepare(result);
      const temporary = `${file}.${token}.tmp`;
      const output = await fs.open(temporary, "wx", 0o600);
      try { await output.writeFile(bytes); await output.sync(); } finally { await output.close(); }
      await fs.rename(temporary, file);
      return result;
    };
    return await operation(previous, persist, prepare, canonical);
  } finally {
    await handle.close();
    if (JSON.parse(await fs.readFile(lock, "utf8")).token === token) await fs.unlink(lock);
  }
}

async function runRepair(root) {
  return updateReport(root, async (previous, persist, prepare, canonical) => {
    const { repairWorkspace } = await import("../../mcp/src/runtime/workspace-tidy.js");
    const { dispositionRecord, mergeTidyEvidence } = await import("../../mcp/src/runtime/workspace-evidence.js");
    let evidence = previous;
    const result = await repairWorkspace({ deskRoot: canonical, onDisposition: async (entry) => {
      const next = mergeTidyEvidence(evidence, {}, entry);
      if (entry.state === "cleanup_pending") {
        for (const branchRemoved of [false, true]) {
          prepare(mergeTidyEvidence(next, {}, dispositionRecord(entry.receipt, "removed", branchRemoved)));
        }
      }
      await persist(next);
      evidence = next;
    } });
    return persist(mergeTidyEvidence(evidence, result));
  });
}

async function acknowledgeRepair(root, acknowledgement) {
  return updateReport(root, async (previous, persist) => {
    const { acknowledgeTidyEvidence } = await import("../../mcp/src/runtime/workspace-evidence.js");
    return persist(acknowledgeTidyEvidence(previous, acknowledgement));
  });
}

/**
 * The repair launcher: `--repair` runs here first, in whatever Node started
 * it, so it keeps to what Node 16 has. It finds a Node that satisfies the
 * MCP's engines range and runs the repair there: in this process when this
 * Node fits, otherwise by re-executing itself in that Node and waiting for
 * it. With none installed it records the no-Node status beside the report,
 * starts nothing, and the next boot line says so. `resolveNode`,
 * `spawnChild` and `repair` are test seams.
 */
async function startRepair(root, { env = process.env, resolveNode = compatibleNode, spawnChild = spawn, repair = runRepair } = {}) {
  const { file } = await location(root);
  if (env[REPAIR_NODE_ENV] === "1") return repair(root);
  const { node, range } = resolveNode({ env, probeBudgetMs: LAUNCHER_PROBE_BUDGET_MS });
  if (!node) {
    await writeNodeStatus(file, { range, recorded: new Date().toISOString() });
    return { started: false, reason: `no Node ${range} found` };
  }
  await clearNodeStatus(file);
  if (node === process.execPath) return repair(root);
  const code = await new Promise((resolve, reject) => {
    const child = spawnChild(node, [REPAIR_ENTRY_POINT, "--repair", root], { stdio: "inherit", windowsHide: true, env: { ...env, [REPAIR_NODE_ENV]: "1" } });
    child.once("error", reject);
    child.once("close", (exit) => resolve(exit));
  });
  if (code !== 0) throw Object.assign(new Error(`Run the repair again: repair in ${node} exited with ${code}`), { code: "boot_checks.cjs_run_the_repair_again_repair" });
  return { started: true, node };
}

/**
 * The general launcher: `--compatible <script> [args]` runs here first, in
 * whatever Node started it, and runs `script` in a Node that satisfies the
 * MCP's engines range, waiting for it. With none installed it starts nothing,
 * and the work is retried at a later session start. `resolveNode` and
 * `spawnChild` are test seams.
 */
async function runCompatible(script, args, { env = process.env, resolveNode = compatibleNode, spawnChild = spawn } = {}) {
  const { node, range } = resolveNode({ env, probeBudgetMs: LAUNCHER_PROBE_BUDGET_MS });
  if (!node) return { started: false, reason: `no Node ${range} found` };
  const code = await new Promise((resolve, reject) => {
    const child = spawnChild(node, [script, ...args], { stdio: "inherit", windowsHide: true, env });
    child.once("error", reject);
    child.once("close", (exit) => resolve(exit));
  });
  return { started: true, node, code };
}

const checks = [deskHealthCheck, workspaceTidyCheck];

// The command line of the entry file `hooks/boot-checks.cjs`: the spawned repair, fast-forward, compatible-node, acknowledge and revoke runs.
function main(argv = process.argv.slice(2)) {
  const [command, root, id, digest, canonicalEvidence] = argv;
  const run = command === "--compatible" && root
    ? runCompatible(root, argv.slice(2))
    : command === "--fast-forward" && root
    ? import("../../mcp/src/runtime/desk-health.js").then(({ fastForwardStateBranch }) => fastForwardStateBranch({ env: process.env, root }))
    : command === "--repair" && root
    ? startRepair(root)
    : command === "--ack" && root && id && digest && canonicalEvidence
      ? acknowledgeRepair(root, { id, digest, canonicalEvidence })
      : command === "--revoke" && root && id && digest && canonicalEvidence
        ? import("../../mcp/src/runtime/workspace-tidy.js").then(({ revokeWorkspaceRelease }) => revokeWorkspaceRelease({
          repository: root, worktree: id, branch: digest, owner: canonicalEvidence,
        }))
        : Promise.reject(new Error("usage: boot-checks.cjs --compatible <script> [args] | --fast-forward <desk> | --repair <desk> | --ack <desk> <id> <digest> <canonical-evidence> | --revoke <common-git-dir> <worktree> <branch-ref> <owner>"));
  run.then((result) => process.stdout.write(`${JSON.stringify(result)}\n`)).catch((error) => {
    process.stderr.write(`workspace-tidy: ${oneLine(error.message)}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  checks, deskHealthCheck, workspaceTidyCheck,
  runBootChecks, boundRoot, migrationLine, launchCommand,
  runRepair, startRepair, launchRepair, runCompatible, compatibleCommand, acknowledgeRepair, reportPath, readReport, TOTAL_BUDGET_MS, REPAIR_NODE_ENV,
  timing, main,
};
