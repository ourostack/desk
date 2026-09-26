#!/usr/bin/env node
"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");
const { spawn } = require("node:child_process");
const { pathToFileURL } = require("node:url");
const runtime = (name) => import(pathToFileURL(path.join(__dirname, "..", "mcp", "src", name)).href);
const oneLine = (value) => String(value).replace(/[\x00-\x1f\x7f]/gu, " ").slice(0, 480);

function reportPath(root, common) {
  const key = createHash("sha256").update(root).digest("hex").slice(0, 16);
  return path.join(common, `desk-workspace-tidy-${key}.json`);
}

async function location(root) {
  const { readInspectionGit } = await runtime("runtime/git-inspection.js");
  const result = await readInspectionGit(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"], {});
  if (!result.ok) throw new Error("bound desk is not an inspectable repository");
  const common = await fs.realpath(result.stdout);
  return reportPath(await fs.realpath(root), common);
}

async function readReport(file) {
  const info = await fs.lstat(file);
  if (!info.isFile() || info.nlink !== 1 || info.size > 1024 * 1024) throw new Error("unsafe workspace-tidy report");
  return JSON.parse(await fs.readFile(file, "utf8"));
}

async function launchRepair(root, env) {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [__filename, "--repair", root], {
      detached: true, stdio: "ignore", windowsHide: true, env,
    });
    child.once("error", reject);
    child.once("spawn", () => { child.unref(); resolve(); });
  });
}

async function checkWorkspace({ host, env = process.env, sessionFolder, launch = launchRepair }, expired) {
  try {
    const [{ resolveStartupRoot }, { resolveActivationConfigPath, isDeskWorkspace }] = await Promise.all([
      runtime("util/startup-direction.js"), runtime("util/paths.js"),
    ]);
    const bound = resolveStartupRoot({
      env, activationConfigPath: resolveActivationConfigPath({ env }),
      hostProjectRoot: host === "claude" ? env.CLAUDE_PROJECT_DIR : undefined,
    });
    if (bound.error) return "Desk boot: workspace-tidy deferred; binding configuration unreadable; resolve with desk_status.";
    if (host === "copilot" && isDeskWorkspace(sessionFolder) && path.resolve(sessionFolder) !== bound.root) {
      return "Desk boot: workspace-tidy deferred; binding is ambiguous; use desk_status root before requesting repair.";
    }
    if (!bound.root) return "Desk boot: workspace-tidy skipped; no bound desk.";
    const { inspectWorkspace, tidyLine } = await runtime("runtime/workspace-tidy.js");
    const inventory = await inspectWorkspace({ deskRoot: bound.root });
    if (expired()) return "";
    let previous = "";
    if (inventory.commonDirectory) {
      try {
        const file = reportPath(bound.root, inventory.commonDirectory);
        const report = await readReport(file);
        if (report.root === bound.root) previous = `Last repair: ${tidyLine(report)}; `;
      } catch (error) {
        if (error.code !== "ENOENT") previous = "Previous workspace-tidy report unreadable; ";
      }
      try {
        const file = reportPath(bound.root, inventory.commonDirectory);
        await fs.lstat(`${file}.lock`);
        previous += `repair lock ${path.basename(file)}.lock; reconcile exact owner if stale; `;
      } catch (error) {
        if (error.code !== "ENOENT") previous += "repair lock unreadable; ";
      }
    }
    // No status, ancestry, network or removal in the hook. Detailed checks and
    // mutations run after launch in the detached process, with fresh evidence.
    if (expired()) return "";
    await launch(bound.root, env);
    return `Desk boot: workspace-tidy ${oneLine(`${previous}deferred (${inventory.worktrees.length} listed)${inventory.issues.length ? `; ${inventory.issues.join("; ")}` : ""}`)}`;
  } catch (error) {
    return `Desk boot: workspace-tidy deferred; ${oneLine(error.message)}`;
  }
}

async function runBootChecks(options = {}) {
  let expired = false;
  let timer;
  try {
    return await Promise.race([
      checkWorkspace(options, () => expired),
      new Promise((resolve) => {
        timer = setTimeout(() => {
          expired = true;
          resolve("Desk boot: workspace-tidy budget exceeded; deferred; run the repair with the desk_status root.");
        }, options.budgetMs ?? 500);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function runRepair(root) {
  const file = await location(root);
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
    const { repairWorkspace, tidyLine } = await runtime("runtime/workspace-tidy.js");
    const result = await repairWorkspace({ deskRoot: root });
    result.line = tidyLine(result);
    result.root = root;
    result.updated = new Date().toISOString();
    // Exclusive temporary file plus rename never follows a pre-existing leaf.
    const temporary = `${file}.${token}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(result)}\n`, { flag: "wx", mode: 0o600 });
    await fs.rename(temporary, file);
    return result;
  } finally {
    await handle.close();
    if (JSON.parse(await fs.readFile(lock, "utf8")).token === token) await fs.unlink(lock);
  }
}

module.exports = { runBootChecks, runRepair, reportPath, readReport };

if (require.main === module) {
  const run = process.argv[2] === "--repair" && process.argv[3]
    ? runRepair(process.argv[3])
    : Promise.reject(new Error("usage: boot-checks.cjs --repair <bound-desk-root>"));
  run.then((result) => process.stdout.write(`${JSON.stringify(result)}\n`)).catch((error) => {
    process.stderr.write(`workspace-tidy: ${oneLine(error.message)}\n`);
    process.exitCode = 1;
  });
}
