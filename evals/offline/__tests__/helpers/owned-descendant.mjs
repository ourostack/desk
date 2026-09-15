import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const pause = milliseconds => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds); };

// A stable per-process identity the parent can record at creation and re-read later. Start time distinguishes a
// recycled PID number from the process this fixture actually created.
export function processIdentity(pid) {
  try {
    const started = execFileSync("ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8", timeout: 5000 }).trim();
    return started.length > 0 ? started : null;
  } catch { return null; }
}

// Test fixtures that intentionally create a detached descendant must own it. The creating parent records the exact PID
// *and* that process's start-time identity at creation; teardown reconciles against that exact identity, signals only
// the exact recorded PID, and then observes bounded retirement. Ownership is never inferred from a process name or
// pattern, a reused PID cannot be mistaken for the descendant, and a descendant that cannot be proved retired fails
// the teardown rather than being assumed gone. The descendant also self-expires as a backstop.
export function ownedDescendant(root, name, { stdio, lifetimeMs = 5000, retirementMs = 2000 }) {
  const identity = path.join(root, `${name}-descendant.json`);
  const child = `setTimeout(()=>process.exit(0),${lifetimeMs});`;
  const record = `{const {spawnSync}=require("node:child_process");const started=spawnSync("ps",["-p",String(child.pid),"-o","lstart="],{encoding:"utf8"}).stdout.trim();require("node:fs").writeFileSync(${JSON.stringify(identity)},JSON.stringify({pid:child.pid,started,createdAt:Date.now()}));}`;
  const source = `const {spawn}=require("node:child_process");const child=spawn(process.execPath,["-e",${JSON.stringify(child)}],{detached:true,stdio:${JSON.stringify(stdio)}});child.unref();${record}`;
  const reconcile = () => {
    const outcome = { fixture: name, root, identity: null, recordedIdentity: null, currentIdentity: null, state: "unknown", signals: [], retirementObservedMs: null, waitedMs: 0 };
    for (let attempt = 0; attempt < 20 && !fs.existsSync(identity); attempt += 1) {
      pause(50);
      outcome.waitedMs += 50;
    }
    const write = () => { if (process.env.T13_LINEAGE_LOG) fs.appendFileSync(process.env.T13_LINEAGE_LOG, `${JSON.stringify({ ...outcome, at: new Date().toISOString() })}\n`); };
    if (!fs.existsSync(identity)) {
      outcome.state = "identity-missing";
      write();
      throw new Error(`Owned descendant ${name} never recorded a creation-time identity`);
    }
    const recorded = JSON.parse(fs.readFileSync(identity, "utf8"));
    fs.rmSync(identity, { force: true });
    outcome.identity = recorded.pid;
    outcome.recordedIdentity = recorded.started;
    outcome.currentIdentity = processIdentity(recorded.pid);
    if (outcome.currentIdentity === null) {
      // The descendant exited on its own before teardown: retirement is already observed.
      outcome.state = "already-retired";
      write();
      return outcome;
    }
    if (outcome.currentIdentity !== outcome.recordedIdentity) {
      // The PID number was recycled. The fixture's own process is therefore gone and this one must not be signalled.
      outcome.state = "pid-reused";
      write();
      return outcome;
    }
    const started = Date.now();
    for (const signal of ["SIGTERM", "SIGKILL"]) {
      try { process.kill(recorded.pid, signal); outcome.signals.push(signal); }
      catch { /* Already gone between the identity check and the signal; retirement is confirmed below. */ }
      for (let attempt = 0; attempt < Math.ceil(retirementMs / 2 / 50); attempt += 1) {
        if (processIdentity(recorded.pid) !== outcome.recordedIdentity) {
          outcome.state = "retired";
          outcome.retirementObservedMs = Date.now() - started;
          write();
          return outcome;
        }
        pause(50);
      }
    }
    outcome.state = "retirement-unproved";
    write();
    throw new Error(`Owned descendant ${name} (pid ${recorded.pid}) could not be proved retired after ${outcome.signals.join(", ")}`);
  };
  return { source, identity, reconcile };
}
