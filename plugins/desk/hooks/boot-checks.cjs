#!/usr/bin/env node
"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");
const { spawn } = require("node:child_process");
const { pathToFileURL } = require("node:url");
// Loaded only by the detached repair launcher, never on the boot path.
const compatibleNode = (options) => require("./compatible-node.cjs").compatibleNode(options);
// Set on the repair a launcher re-executes in a compatible Node, so it runs the repair itself.
const REPAIR_NODE_ENV = "DESK_TIDY_REPAIR_NODE";
// The launcher may spend the bootstrap's full probe budget: nothing waits on it.
const LAUNCHER_PROBE_BUDGET_MS = 3000;
const NODE_STATUS_MAX_BYTES = 4096;
const runtime = (name) => import(pathToFileURL(path.join(__dirname, "..", "mcp", "src", name)).href);
const oneLine = (value) => String(value).replace(/[\x00-\x1f\x7f]/gu, " ").slice(0, 480);

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

// The no-Node status the repair launcher leaves beside the report when it
// found no compatible Node, so the next boot line can say so.
function nodeStatusPath(file) {
  return `${file}.node.json`;
}

async function readNodeStatus(file) {
  const info = await fs.lstat(nodeStatusPath(file));
  if (!info.isFile() || info.size > NODE_STATUS_MAX_BYTES) throw new Error("unsafe workspace-tidy node status");
  const status = JSON.parse(await fs.readFile(nodeStatusPath(file), "utf8"));
  if (typeof status?.range !== "string") throw new Error("invalid workspace-tidy node status");
  return status;
}

// The boot path does no Node search: the detached child starts in the hook's
// own Node, which may be old, as the Node 16-safe repair launcher
// (`startRepair`). The launcher finds a compatible Node and re-executes the
// repair in it.
async function launchRepair(root, env, spawnChild = spawn) {
  await new Promise((resolve, reject) => {
    const child = spawnChild(process.execPath, [__filename, "--repair", root], {
      detached: true, stdio: "ignore", windowsHide: true, env,
    });
    child.once("error", reject);
    child.once("spawn", () => { child.unref(); resolve(); });
  });
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
    if (bound.error) return "Desk boot: workspace-tidy deferred; binding configuration unreadable; resolve with desk_status.";
    const { inspectWorkspace, tidyLine, canonicalDeskRoot } = await runtime("runtime/workspace-tidy.js");
    // One identity for the bound desk, resolved once: a symlink alias and its
    // real path are the same desk for the inventory, the report and the lock.
    const root = bound.root ? await canonicalDeskRoot(bound.root) : null;
    if (host === "copilot" && isDeskWorkspace(sessionFolder) && await canonicalDeskRoot(path.resolve(sessionFolder)) !== root) {
      return "Desk boot: workspace-tidy deferred; binding is ambiguous; use desk_status root before requesting repair.";
    }
    if (bound.unavailable) return "Desk boot: workspace-tidy skipped; the bound desk is unavailable; see desk_status.";
    if (!root) return "Desk boot: workspace-tidy skipped; no bound desk.";
    const inventory = await inspectWorkspace({ deskRoot: root, signal, budgetMs: inspectionBudgetMs });
    if (expired()) return "";
    let previous = "";
    if (inventory.commonDirectory) {
      try {
        const file = reportPath(root, inventory.commonDirectory);
        const report = await readReport(file);
        // A report written before roots were canonical may carry the alias.
        if (await canonicalDeskRoot(report.root) === root) previous = `Last repair: ${tidyLine(report)}; `;
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
    return `Desk boot: workspace-tidy ${oneLine(`${previous}deferred (${inventory.worktrees.length} listed)${inventory.issues.length ? `; ${inventory.issues.join("; ")}` : ""}`)}`;
  } catch (error) {
    return `Desk boot: workspace-tidy deferred; ${oneLine(error.message)}`;
  }
}

async function runBootChecks(options = {}) {
  let expired = false;
  let timer;
  const cancellation = new AbortController();
  try {
    return await Promise.race([
      checkWorkspace(options, () => expired, cancellation.signal),
      new Promise((resolve) => {
        timer = setTimeout(() => {
          expired = true;
          cancellation.abort();
          resolve("Desk boot: workspace-tidy budget exceeded; deferred; run the repair with the desk_status root.");
        }, options.budgetMs ?? 500);
      }),
    ]);
  } finally {
    clearTimeout(timer);
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
  const status = nodeStatusPath(file);
  if (env[REPAIR_NODE_ENV] === "1") return repair(root);
  const { node, range } = resolveNode({ env, probeBudgetMs: LAUNCHER_PROBE_BUDGET_MS });
  if (!node) {
    await fs.writeFile(status, `${JSON.stringify({ range, recorded: new Date().toISOString() })}\n`, { mode: 0o600 });
    return { started: false, reason: `no Node ${range} found` };
  }
  await fs.rm(status, { force: true });
  if (node === process.execPath) return repair(root);
  const code = await new Promise((resolve, reject) => {
    const child = spawnChild(node, [__filename, "--repair", root], { stdio: "inherit", windowsHide: true, env: { ...env, [REPAIR_NODE_ENV]: "1" } });
    child.once("error", reject);
    child.once("close", (exit) => resolve(exit));
  });
  if (code !== 0) throw new Error(`repair in ${node} exited with ${code}`);
  return { started: true, node };
}

module.exports = { runBootChecks, runRepair, startRepair, launchRepair, acknowledgeRepair, reportPath, readReport, REPAIR_NODE_ENV };

if (require.main === module) {
  const [command, root, id, digest, canonicalEvidence] = process.argv.slice(2);
  const run = command === "--repair" && root
    ? startRepair(root)
    : command === "--ack" && root && id && digest && canonicalEvidence
      ? acknowledgeRepair(root, { id, digest, canonicalEvidence })
      : command === "--revoke" && root && id && digest && canonicalEvidence
        ? runtime("runtime/workspace-tidy.js").then(({ revokeWorkspaceRelease }) => revokeWorkspaceRelease({
          repository: root, worktree: id, branch: digest, owner: canonicalEvidence,
        }))
        : Promise.reject(new Error("usage: boot-checks.cjs --repair <desk> | --ack <desk> <id> <digest> <canonical-evidence> | --revoke <common-git-dir> <worktree> <branch-ref> <owner>"));
  run.then((result) => process.stdout.write(`${JSON.stringify(result)}\n`)).catch((error) => {
    process.stderr.write(`workspace-tidy: ${oneLine(error.message)}\n`);
    process.exitCode = 1;
  });
}
