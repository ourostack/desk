#!/usr/bin/env node
"use strict";

// The boot-check registry both session-start hooks run after building their
// existing output (Claude through resolve-desk-root.js --boot-checks, Copilot
// through copilot-session-start.cjs).
//
// Each check is `{ id, budgetMs, run(ctx) -> { line?, repair?: { command } } }`
// and they run in order under one 300 ms total budget; a check gets the
// smaller of its own budget and what is left, and the real time each check
// takes is charged against the total. A check is skipped for this start, its
// line and repair discarded, when its budget timer fires, when it took longer
// than its budget (a check that blocks synchronously settles before its timer
// can fire), when it throws, or when it stops itself at `ctx.deadline` by
// throwing an error whose code is `boot_check_budget`. When factory state
// exists the skip and its elapsed milliseconds are recorded in the protected
// status.json (`boot_checks`). Repairs start detached with
// ignored stdio after every check has run. The hook appends exactly one line,
// `Desk boot: <line>; <line>`, addressed to the agent, and nothing at all when
// no check has a line, so its output is then byte-identical to the output it
// built before the registry ran.
//
// Index tracing (spec.md §3): none of the checks below is designed to touch
// the Git index, so a `git diff --cached --name-only` snapshot taken
// immediately before and after each `check.run(...)` call — against the same
// desk root `factoryCheck`/`deskHealthCheck` already resolve, only when it is
// itself a Git repository — catches a check that stages a path it never
// should. A drift appends a `Desk problem: index-drift — ...`
// block (`mcp/src/runtime/index-drift.js`) to the same output; it names the
// check and the exact paths, never undoes the staging, and never blocks.
//
// The registry, in order:
//   1. factory: whether the bound desk's store has a consent decision, and a
//      detached `factory.js finalize` for finished jobs whose facts are not
//      delivered yet (mcp/src/factory/boot-check.js);
//   2. labels: finished jobs whose waste labels are not complete yet, and a
//      detached `factory.js evaluate --pending` that prepares their evaluator
//      briefs again, and finished jobs whose labels are quarantined and will
//      not be delivered, reported without a repair
//      (mcp/src/factory/boot-check.js);
//   3. andon: the open andon issues the last start-time refresh recorded for
//      each contributing store, one line per store, without a repair
//      (mcp/src/factory/boot-check.js, mcp/src/factory/andon-watch.js);
//   4. desk-health: the bound root's last Desk start, and a detached
//      fast-forward of a clean state branch (mcp/src/runtime/desk-health.js);
//   5. workspace-tidy: stale worktree listing with its own detached repair
//      (mcp/src/runtime/workspace-tidy.js). It launches that repair itself so
//      its line can say whether the launch happened, and keeps a soft deadline
//      inside its budget so an unfinished inspection still reports "deferred".
//   6. host-enforcement: whether Claude Code's or Copilot's own deny hook
//      (spec §5) is actually registered in this plugin's own hooks.json or
//      copilot-hooks.json, reported as a Desk problem: block when it is not
//      (mcp/src/runtime/host-enforcement-registration.js). A no-op on every
//      other host -- Codex has no boot-check registry wired in Desk at all.
//
// `startFactory` starts factory-start.cjs (sweep, then flush and refresh andon
// for every consented store) detached; the hooks call it after their output
// is built, and only when a store has `contribute: true`.
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
const { pathToFileURL } = require("node:url");
// Loaded only by the detached launchers, never on the boot path.
const compatibleNode = (options) => require("./compatible-node.cjs").compatibleNode(options);
const runtime = (name) => import(pathToFileURL(path.join(__dirname, "..", "mcp", "src", name)).href);
// Set on the repair a launcher re-executes in a compatible Node, so it runs the repair itself.
const REPAIR_NODE_ENV = "DESK_TIDY_REPAIR_NODE";
// The launcher may spend the bootstrap's full probe budget: nothing waits on it.
const LAUNCHER_PROBE_BUDGET_MS = 3000;
const NODE_STATUS_MAX_BYTES = 4096;
const oneLine = (value) => String(value).replace(/[\x00-\x1f\x7f]/gu, " ").slice(0, 480);
const TOTAL_BUDGET_MS = 300;
const TIDY_SOFT_MARGIN_MS = 20;
const FACTORY_SCRIPT = path.join(__dirname, "..", "mcp", "scripts", "factory.js");
const DESK_PROBLEM_SCRIPT = path.join(__dirname, "..", "mcp", "scripts", "file-desk-problem.js");
const HOST_ENFORCEMENT_FIX_ATTEMPT = "not auto-repaired -- reinstall Desk to restore it.";
const BOOT_CHECK_FIX_ATTEMPT = "not auto-repaired -- reinstall Desk or inspect this check's own code.";
const INDEX_DRIFT_FIX_ATTEMPT = "not auto-repaired -- staged paths are left as-is for inspection.";
const MIGRATIONS_FIX_ATTEMPT = "not auto-repaired -- the migration registry itself needs investigation.";
const PERSON = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;

// `root` is the bound desk's canonical identity, its real path, so every
// spelling of one desk (a symlink alias, its real path) shares one report and
// one lock.
function reportPath(root, common) {
  const key = createHash("sha256").update(root).digest("hex").slice(0, 16);
  return path.join(common, `desk-workspace-tidy-${key}.json`);
}

async function location(root) {
  const canonical = await fs.realpath(root);
  const { readInspectionGit } = await runtime("runtime/git-inspection.js");
  const { TIDY_GIT_TIMEOUT_MS } = await runtime("runtime/workspace-tidy.js");
  // The report location serves the detached repair and the CLI, never the boot check's budget.
  const result = await readInspectionGit(canonical, ["rev-parse", "--path-format=absolute", "--git-common-dir"], {}, { timeoutMs: TIDY_GIT_TIMEOUT_MS });
  if (!result.ok) throw new Error("bound desk is not an inspectable repository");
  const common = await fs.realpath(result.stdout);
  return { canonical, file: reportPath(canonical, common) };
}

async function readReport(file) {
  const { decodeTidyReport, TIDY_REPORT_MAX_BYTES } = await runtime("runtime/workspace-evidence.js");
  const info = await fs.lstat(file);
  if (!info.isFile() || info.nlink !== 1 || info.size > TIDY_REPORT_MAX_BYTES) throw new Error("unsafe workspace-tidy report");
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
  if (!info.isFile() || info.nlink !== 1 || info.size > NODE_STATUS_MAX_BYTES) throw new Error("unsafe workspace-tidy node status");
  const status = JSON.parse(await fs.readFile(nodeStatusPath(file), "utf8"));
  if (typeof status?.range !== "string") throw new Error("invalid workspace-tidy node status");
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
    throw new Error(`could not record the workspace-tidy Node status at ${target}: ${error.code ?? error.message}`);
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
  await launchCommand([process.execPath, __filename, "--repair", root], env, spawnImpl);
}

// A command that runs `script` and its arguments in a compatible Node,
// through the `--compatible` launcher started in this (possibly old) Node.
function compatibleCommand(script, ...args) {
  return [process.execPath, __filename, "--compatible", script, ...args];
}

async function checkWorkspace({ host, env = process.env, sessionFolder, launch = launchRepair, inspectionBudgetMs }, expired, signal) {
  try {
    const [{ resolveStartupRoot }, { resolveActivationConfigPath, isDeskWorkspace }] = await Promise.all([
      runtime("util/startup-direction.js"), runtime("util/paths.js"),
    ]);
    const bound = resolveStartupRoot({
      env, activationConfigPath: resolveActivationConfigPath({ env }),
      hostProjectRoot: host === "claude" ? env.CLAUDE_PROJECT_DIR : undefined,
    });
    if (bound.error) return "workspace-tidy deferred; binding configuration unreadable; resolve with desk_status.";
    const { inspectWorkspace, tidyLine, canonicalDeskRoot } = await runtime("runtime/workspace-tidy.js");
    // One identity for the bound desk, resolved once: a symlink alias and its
    // real path are the same desk for the inventory, the report and the lock.
    const root = bound.root ? await canonicalDeskRoot(bound.root) : null;
    if (host === "copilot" && isDeskWorkspace(sessionFolder) && await canonicalDeskRoot(path.resolve(sessionFolder)) !== root) {
      return "workspace-tidy deferred; binding is ambiguous; use desk_status root before requesting repair.";
    }
    if (bound.unavailable) return "workspace-tidy skipped; the bound desk is unavailable; see desk_status.";
    if (!root) return "workspace-tidy skipped; no bound desk.";
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
      new Promise((resolve) => {
        timer = setTimeout(() => {
          stopAll();
          resolve("workspace-tidy budget exceeded; deferred; run the repair with the desk_status root.");
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

function personPrefix(env) {
  const alias = typeof env.DESK_PERSON === "string" ? env.DESK_PERSON.trim() : "";
  return PERSON.test(alias) ? `desks/${alias}` : "";
}

/**
 * The root the factory end hook binds sessions to, resolved the same way as
 * resolve-desk-root.js `resolveHookDeskRoot` (bounded activation reads), and
 * shared by the checks of one start. It imports the resolver's parts rather
 * than that script, which is the Claude hook's entry point and is still
 * running this registry from its top-level await.
 */
async function boundRoot(ctx) {
  ctx.shared.root ??= (async () => {
    const [{ resolveActivationConfigPath, resolveDeskRootWithSource }, { readSmallText }] = await Promise.all([runtime("util/paths.js"), runtime("factory/marker.js")]);
    try {
      return resolveDeskRootWithSource({
        activationConfigPath: resolveActivationConfigPath({ env: ctx.env }),
        env: ctx.env,
        cwd: ctx.host === "copilot" ? ctx.sessionFolder ?? process.cwd() : ctx.env.CLAUDE_PROJECT_DIR || process.cwd(),
        homeDir: ctx.env.HOME || require("node:os").homedir(),
        hostProjectRoot: ctx.env.CLAUDE_PROJECT_DIR,
        readActivationConfig: (file) => readSmallText(file),
      }).root;
    } catch {
      return null;
    }
  })();
  return ctx.shared.root;
}

const factoryCheck = {
  id: "factory",
  budgetMs: 100,
  async run(ctx) {
    const root = await boundRoot(ctx);
    if (!root) return {};
    const [{ factoryBootCheck }, { readSmallText }, { PATTERNS }] = await Promise.all([
      runtime("factory/boot-check.js"), runtime("factory/marker.js"), runtime("factory/schema.js"),
    ]);
    const { metadata } = require("./factory-end.cjs");
    const home = ctx.env.HOME || require("node:os").homedir();
    const pluginRoot = ctx.env.PLUGIN_ROOT || path.resolve(__dirname, "..");
    let plugins = { dirs: [], incomplete: true };
    try {
      plugins = metadata({ host: ctx.host === "copilot" ? "copilot" : "claude", pluginRoot, home, env: ctx.env, readSmallText, PATTERNS, deadline: ctx.deadline, sources: false });
    } catch {
      // An unreadable plugin set leaves only the desk's own declaration.
    }
    if (plugins.timedOut) throw Object.assign(new Error("plugin scan past the check's deadline"), { code: "boot_check_budget" });
    const result = factoryBootCheck({
      env: ctx.env, deskRoot: root, personPrefix: personPrefix(ctx.env), pluginDirs: plugins.dirs, pluginScanIncomplete: plugins.incomplete, deadline: ctx.deadline,
    });
    const repair = result.jobs?.length ? { command: compatibleCommand(FACTORY_SCRIPT, "finalize", ...result.jobs.flatMap((job) => ["--job", job])) } : undefined;
    return { line: result.line, repair };
  },
};

const labelsCheck = {
  id: "labels",
  budgetMs: 40,
  async run(ctx) {
    const { labelsBootCheck, labelsLine, labelsQuarantinedLine } = await runtime("factory/boot-check.js");
    const { count, quarantined } = labelsBootCheck({ env: ctx.env });
    const lines = [...(count > 0 ? [labelsLine(count)] : []), ...(quarantined > 0 ? [labelsQuarantinedLine(quarantined)] : [])];
    if (lines.length === 0) return {};
    return { line: lines.join("; "), repair: count > 0 ? { command: compatibleCommand(FACTORY_SCRIPT, "evaluate", "--pending") } : undefined };
  },
};

const andonCheck = {
  id: "andon",
  budgetMs: 20,
  async run(ctx) {
    const { andonBootCheck, andonLine } = await runtime("factory/boot-check.js");
    const found = andonBootCheck({ env: ctx.env });
    return found.length === 0 ? {} : { line: found.map(({ store, issues }) => andonLine(store, issues)).join("; ") };
  },
};

const deskHealthCheck = {
  id: "desk-health",
  budgetMs: 50,
  async run(ctx) {
    const [{ deskHealthCheck: check }, { isDeskWorkspace }] = await Promise.all([runtime("runtime/desk-health.js"), runtime("util/paths.js")]);
    const roots = [];
    if (ctx.host === "copilot" && isDeskWorkspace(ctx.sessionFolder)) roots.push(path.resolve(ctx.sessionFolder));
    const bound = await boundRoot(ctx);
    if (bound && !roots.includes(bound)) roots.push(bound);
    for (const root of roots) {
      const result = check({ env: ctx.env, root });
      if (result.line) return { line: result.line };
      if (result.fastForward) return { repair: { command: compatibleCommand(__filename, "--fast-forward", root) } };
    }
    return {};
  },
};

const workspaceTidyCheck = { id: "workspace-tidy", budgetMs: 260, run: runWorkspaceTidy };

// Desk-only enforcement (spec §5) is only as good as its own registration:
// this check confirms host-enforcement.cjs is actually wired into hooks.json
// for the current host -- hooks.json (Claude Code) or copilot-hooks.json
// (Copilot) -- and reports a missing registration as a `Desk problem:` block
// rather than letting the gap stay silent. A no-op for every other host:
// Codex has no boot-check or session-start hook wired in Desk at all today,
// so `verifyHookRegistered` reports its own "registered but not active"
// story directly through `desk_status` instead (Part 8, docs/host-
// enforcement-live-proof.md).
//
// Filing is never awaited inline: a real filing attempt is an account lookup
// and `gh` calls that can run for tens of seconds on a slow network, and this
// check's own budget is 20 ms. Instead, when the hook is missing, `run` queues
// the same kind of detached repair every other check here already uses --
// `file-desk-problem.js` run through the compatible-Node launcher -- and the
// block reports `file: filing in background`; the registry above launches it,
// detached and unref'd, once every check has run (a fix round after this Part
// first shipped: the inline filer's own process-spawn overhead alone was
// enough to blow this budget on a loaded CI runner, and on a slow network it
// risked losing the SessionStart hook's whole output past its own timeout).
const hostEnforcementCheck = {
  id: "host-enforcement",
  budgetMs: 20,
  async run(ctx) {
    if (ctx.host !== "claude" && ctx.host !== "copilot") return {};
    const { hookRegistrationDeskProblem } = await runtime("runtime/host-enforcement-registration.js");
    const pluginRoot = ctx.env.PLUGIN_ROOT || path.resolve(__dirname, "..");
    let repairCommand = null;
    const fileProblem = async ({ host, reason }) => {
      repairCommand = compatibleCommand(DESK_PROBLEM_SCRIPT, "--mechanism", "host-enforcement", "--reason", reason || "unknown", "--host", host || "unknown", "--fix-attempt", HOST_ENFORCEMENT_FIX_ATTEMPT);
      return { file: "filing in background" };
    };
    const { registered, block } = await hookRegistrationDeskProblem({ host: ctx.host, pluginRoot, env: ctx.env, fileProblem });
    if (registered !== false) return {};
    return { line: block, repair: repairCommand ? { command: repairCommand } : undefined };
  },
};

// ---------------------------------------------------------------------------
// The registry.
// ---------------------------------------------------------------------------

/** Records skipped checks in the protected factory status.json, only when factory state already exists. */
async function recordSkipped(env, skipped) {
  const { factoryStateRoot, writeStatus } = await runtime("factory/outbox.js");
  if (await factoryStateRoot(env, { create: false }) === null) return false;
  await writeStatus(env, { boot_checks: { at: new Date().toISOString(), skipped } });
  return true;
}

const validRepair = (repair) => Array.isArray(repair?.command) && repair.command.length > 0 && repair.command.every((part) => typeof part === "string" && part !== "");

/**
 * Runs the registry (see the header). Options: `host`, `env`, `sessionFolder`,
 * plus for tests `checks`, `totalBudgetMs`, `checkBudgets` ({ id: ms }),
 * `launchRepair(command, env)`, `record(env, skipped)`, `launch` (the
 * workspace-tidy repair launcher), `loadRedaction` and `spawnGit` (the index-
 * tracing Git seam; real callers never pass it). Resolves `""` or one
 * `Desk boot:` line; never rejects. The line names worktree paths, branches
 * and error messages, so each path segment or word that carries a secret's
 * value is redacted (mcp/src/util/redact.js); if the redaction cannot load,
 * the line is withheld rather than shown unredacted.
 */
async function runBootChecks(options = {}) {
  const {
    checks = module.exports.checks, totalBudgetMs = TOTAL_BUDGET_MS, checkBudgets = {}, launchRepair: startRepair = launchCommand, record = recordSkipped,
    loadRedaction = () => runtime("util/redact.js"),
    spawnGit = spawnSync,
  } = options;
  const env = options.env ?? process.env;
  // The real time every check took, charged against the total budget.
  let used = 0;
  const shared = {};
  const lines = [];
  const repairs = [];
  const skipped = [];
  // Index tracing (spec.md §3): resolved once, the same way `factoryCheck`/
  // `deskHealthCheck` resolve their own desk root, and only watched when it
  // is itself a Git repository.
  const { snapshotStagedPaths, diffStagedPaths, formatIndexDriftProblem, formatDeskProblem } = await runtime("runtime/index-drift.js");
  const { isGitRepository } = await runtime("util/git-stage.js");
  const driftRoot = await boundRoot({ env, host: options.host, sessionFolder: options.sessionFolder, shared });
  const tracksIndex = typeof driftRoot === "string" && isGitRepository(driftRoot, spawnGit);
  // A failure's raw text (a staged path, an error message) never becomes an
  // argument on the detached filer's own command line unredacted -- `ps`
  // shows a process's argv to every account on the machine, not just this
  // session. `shouldLaunchFiler` throttles the *spawn* only, never the block
  // this function still shows the operator every time (fix round, spec.md
  // §1 Part 5). Both fail toward the old, always-filing behavior if they
  // cannot be loaded at all.
  const argvSafeReason = await runtime("runtime/argv-safe-reason.js").then((mod) => mod.argvSafeReason, () => (text) => String(text ?? "unknown"));
  const shouldLaunchFiler = await runtime("runtime/filer-throttle.js").then((mod) => mod.shouldLaunchFiler, () => () => true);
  // Queued the same way host-enforcement's own repair is: a fileProblem
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
  for (const check of checks) {
    const budget = Math.min(checkBudgets[check.id] ?? check.budgetMs, totalBudgetMs - used);
    // Timers resolve to whole milliseconds, so less than one left is none left.
    if (budget < 1) {
      skipped.push({ id: check.id, reason: "total_budget" });
      continue;
    }
    const cancellation = new AbortController();
    // Taken outside the check's own timing window, so a snapshot's cost (git
    // is bounded to 1 s, never the check's own budget) is never charged
    // against it — see `mcp/src/runtime/index-drift.js`.
    const beforeStaged = tracksIndex ? snapshotStagedPaths({ root: driftRoot, spawnGit }) : null;
    const checkStarted = performance.now();
    const deadline = checkStarted + budget;
    let timer;
    const outcome = await Promise.race([
      Promise.resolve()
        .then(() => check.run({ ...options, env, budgetMs: budget, deadline, signal: cancellation.signal, shared }))
        .then((value) => ({ value }), (error) => (error?.code === "boot_check_budget" ? { overrun: true } : { failed: true, error })),
      new Promise((resolve) => { timer = setTimeout(resolve, Math.ceil(budget), { overrun: true }); }),
    ]);
    clearTimeout(timer);
    // A check that blocks synchronously settles before its timer can fire, so the real elapsed time decides: past the budget, its line and repair are discarded like a timed-out check's.
    const elapsed = performance.now() - checkStarted;
    used += elapsed;
    // The after-snapshot is taken (and its own cost incurred) only once the
    // check's own elapsed time is already settled, and only when the before-
    // snapshot itself succeeded: a failed or timed-out "before" makes any
    // diff meaningless, and trying again risks the same hang twice.
    if (tracksIndex && beforeStaged !== null) {
      const afterStaged = snapshotStagedPaths({ root: driftRoot, spawnGit });
      if (afterStaged !== null) {
        const drift = diffStagedPaths(beforeStaged, afterStaged);
        if (drift.length > 0) lines.push(await formatIndexDriftProblem({ kind: "boot check", label: check.id, drift, env, host: options.host, fileProblem: indexDriftFileProblem }));
      }
    }
    if (outcome.overrun || elapsed > budget) {
      cancellation.abort();
      skipped.push({ id: check.id, reason: "budget", elapsed_ms: Math.round(elapsed) });
      continue;
    }
    if (outcome.failed) {
      skipped.push({ id: check.id, reason: "error", elapsed_ms: Math.round(elapsed) });
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
  if (skipped.length > 0) {
    try {
      await record(env, skipped);
    } catch {
      // Recording a skip never changes the startup output.
    }
  }
  if (lines.length === 0) return "";
  try {
    const { redactCredentialLikeText } = await loadRedaction();
    return redactCredentialLikeText(`Desk boot: ${lines.join("; ")}`);
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
 * filing step -- this wrapper supplies it the same way `hostEnforcementCheck`
 * does its own: `launchRepair` (default `launchCommand`) starts the detached
 * `file-desk-problem.js` run and is never awaited past its own spawn; a
 * launcher that fails leaves the block honestly reporting `file: not filed:
 * filer_unavailable` rather than throwing.
 */
async function migrationLine({ host, env = process.env, sessionFolder, budgetMs, pluginRoot = path.resolve(__dirname, ".."), launchRepair: startRepair = launchCommand } = {}) {
  try {
    const { startupMigrationLine } = await runtime("runtime/pending-migrations.js");
    const argvSafeReason = await runtime("runtime/argv-safe-reason.js").then((mod) => mod.argvSafeReason, () => (text) => String(text ?? "unknown"));
    const shouldLaunchFiler = await runtime("runtime/filer-throttle.js").then((mod) => mod.shouldLaunchFiler, () => () => true);
    const cwd = host === "copilot" ? sessionFolder || process.cwd() : env.CLAUDE_PROJECT_DIR || process.cwd();
    return await startupMigrationLine({
      pluginRoot, env, cwd, budgetMs, host,
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

/** Starts factory-start.cjs detached when a store has `contribute: true`; resolves whether it started. Never rejects. */
async function startFactory({ env = process.env, launch = launchCommand } = {}) {
  try {
    const { hasContributingStore } = await runtime("factory/boot-check.js");
    if (!hasContributingStore(env)) return false;
    await launch(compatibleCommand(path.join(__dirname, "factory-start.cjs")), env);
    return true;
  } catch {
    return false;
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
    const { readProcessStart } = await runtime("readiness/process-start.js");
    const ownership = JSON.stringify({ token, pid: process.pid, start: await readProcessStart(process.pid) });
    await handle.writeFile(ownership);
    await handle.close();
    const { tidyLine } = await runtime("runtime/workspace-tidy.js");
    const { encodeTidyReport } = await runtime("runtime/workspace-evidence.js");
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
    const { repairWorkspace } = await runtime("runtime/workspace-tidy.js");
    const { dispositionRecord, mergeTidyEvidence } = await runtime("runtime/workspace-evidence.js");
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
    const { acknowledgeTidyEvidence } = await runtime("runtime/workspace-evidence.js");
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
    const child = spawnChild(node, [__filename, "--repair", root], { stdio: "inherit", windowsHide: true, env: { ...env, [REPAIR_NODE_ENV]: "1" } });
    child.once("error", reject);
    child.once("close", (exit) => resolve(exit));
  });
  if (code !== 0) throw new Error(`repair in ${node} exited with ${code}`);
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

module.exports = {
  checks: [factoryCheck, labelsCheck, andonCheck, deskHealthCheck, workspaceTidyCheck, hostEnforcementCheck],
  factoryCheck, labelsCheck, andonCheck, deskHealthCheck, workspaceTidyCheck, hostEnforcementCheck,
  runBootChecks, startFactory, migrationLine, launchCommand, recordSkipped,
  runRepair, startRepair, launchRepair, runCompatible, compatibleCommand, acknowledgeRepair, reportPath, readReport, TOTAL_BUDGET_MS, REPAIR_NODE_ENV,
};

if (require.main === module) {
  const [command, root, id, digest, canonicalEvidence] = process.argv.slice(2);
  const run = command === "--compatible" && root
    ? runCompatible(root, process.argv.slice(4))
    : command === "--fast-forward" && root
    ? runtime("runtime/desk-health.js").then(({ fastForwardStateBranch }) => fastForwardStateBranch({ env: process.env, root }))
    : command === "--repair" && root
    ? startRepair(root)
    : command === "--ack" && root && id && digest && canonicalEvidence
      ? acknowledgeRepair(root, { id, digest, canonicalEvidence })
      : command === "--revoke" && root && id && digest && canonicalEvidence
        ? runtime("runtime/workspace-tidy.js").then(({ revokeWorkspaceRelease }) => revokeWorkspaceRelease({
          repository: root, worktree: id, branch: digest, owner: canonicalEvidence,
        }))
        : Promise.reject(new Error("usage: boot-checks.cjs --compatible <script> [args] | --fast-forward <desk> | --repair <desk> | --ack <desk> <id> <digest> <canonical-evidence> | --revoke <common-git-dir> <worktree> <branch-ref> <owner>"));
  run.then((result) => process.stdout.write(`${JSON.stringify(result)}\n`)).catch((error) => {
    process.stderr.write(`workspace-tidy: ${oneLine(error.message)}\n`);
    process.exitCode = 1;
  });
}
