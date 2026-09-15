import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const pause = milliseconds => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds); };

// A stable per-process identity the parent can record at creation and re-read later. Start time distinguishes a
// recycled PID number from the process this fixture actually created. Absence and unreadability are tagged apart:
// an observation that failed is never reported as an exit.
export function processIdentity(pid) {
  try {
    const started = execFileSync("ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8", timeout: 5000 }).trim();
    return started.length > 0 ? { started, absent: false, unreadable: false } : { started: null, absent: true, unreadable: false };
  } catch (error) {
    // `ps` exits 1 with no output when no process matches; anything else is a failed observation, not an exit.
    const absent = error.status === 1 && String(error.stdout ?? "").trim().length === 0;
    return { started: null, absent, unreadable: !absent };
  }
}

// Test fixtures that intentionally create a detached descendant must own it. The creating parent records the exact PID
// *and* that process's start-time identity at creation. Teardown reconciles against that exact identity, prefers a
// cooperative stop that needs no signal at all, signals only the exact recorded PID as a last resort, and then
// observes bounded retirement. Ownership is never inferred from a process name; a recycled PID is never signalled;
// an unreadable observation or an unproved retirement fails the teardown instead of being assumed gone.
export function ownedDescendant(root, name, { stdio, lifetimeMs = 5000, retirementMs = 3000, ignoreStop = false } = {}) {
  const identity = path.join(root, `${name}-descendant.json`);
  const stop = path.join(root, `${name}-descendant.stop`);
  const watch = ignoreStop
    ? `const started=Date.now();setInterval(()=>{if(Date.now()-started>${lifetimeMs})process.exit(0);},25);`
    : `const fs=require("node:fs");const started=Date.now();setInterval(()=>{if(fs.existsSync(${JSON.stringify(stop)})||Date.now()-started>${lifetimeMs})process.exit(0);},25);`;
  const record = `{const {spawnSync}=require("node:child_process");const started=spawnSync("ps",["-p",String(child.pid),"-o","lstart="],{encoding:"utf8"}).stdout.trim();require("node:fs").writeFileSync(${JSON.stringify(identity)},JSON.stringify({pid:child.pid,started,createdAt:Date.now()}));}`;
  const source = `const {spawn}=require("node:child_process");const child=spawn(process.execPath,["-e",${JSON.stringify(watch)}],{detached:true,stdio:${JSON.stringify(stdio)}});child.unref();${record}`;
  const reconcile = () => {
    const outcome = { fixture: name, root, identity: null, recordedIdentity: null, currentIdentity: null, state: "unknown", signals: [], retirementObservedMs: null, waitedMs: 0 };
    const write = () => { if (process.env.T13_LINEAGE_LOG) fs.appendFileSync(process.env.T13_LINEAGE_LOG, `${JSON.stringify({ ...outcome, at: new Date().toISOString() })}\n`); };
    const fail = message => { write(); throw new Error(message); };
    for (let attempt = 0; attempt < 20 && !fs.existsSync(identity); attempt += 1) {
      pause(50);
      outcome.waitedMs += 50;
    }
    if (!fs.existsSync(identity)) {
      outcome.state = "identity-missing";
      fail(`Owned descendant ${name} never recorded a creation-time identity`);
    }
    const recorded = JSON.parse(fs.readFileSync(identity, "utf8"));
    fs.rmSync(identity, { force: true });
    outcome.identity = recorded.pid;
    outcome.recordedIdentity = recorded.started;
    const observe = () => {
      const current = processIdentity(recorded.pid);
      if (current.unreadable) {
        outcome.state = "identity-unreadable";
        fail(`Owned descendant ${name} (pid ${recorded.pid}) could not be observed; retirement is unproved`);
      }
      return current;
    };
    const current = observe();
    outcome.currentIdentity = current.started;
    if (current.absent) {
      outcome.state = "already-retired";
      write();
      return outcome;
    }
    if (current.started !== outcome.recordedIdentity) {
      // The PID number was recycled, so this fixture's own process is already gone and this one is not ours to touch.
      outcome.state = "pid-reused";
      write();
      return outcome;
    }
    const started = Date.now();
    const settle = budgetMs => {
      for (let waited = 0; waited < budgetMs; waited += 50) {
        const seen = observe();
        if (seen.absent || seen.started !== outcome.recordedIdentity) return true;
        pause(50);
      }
      return false;
    };
    // Cooperative shutdown first: the descendant watches for its own stop marker, so the ordinary path signals nothing
    // and cannot race a recycled PID at all.
    fs.writeFileSync(stop, `${Date.now()}\n`);
    if (settle(retirementMs)) {
      outcome.state = "retired-cooperatively";
      outcome.retirementObservedMs = Date.now() - started;
      fs.rmSync(stop, { force: true });
      write();
      return outcome;
    }
    for (const signal of ["SIGTERM", "SIGKILL"]) {
      // Re-verify immediately before signalling, and detect a PID recycled inside that window rather than reporting success.
      const before = observe();
      if (before.absent || before.started !== outcome.recordedIdentity) break;
      try { process.kill(recorded.pid, signal); outcome.signals.push(signal); } catch { /* raced its own exit; settled below */ }
      if (settle(retirementMs / 2)) {
        const after = processIdentity(recorded.pid);
        if (!after.absent && after.started !== outcome.recordedIdentity) {
          outcome.state = "pid-recycled-during-signal";
          fail(`Owned descendant ${name} (pid ${recorded.pid}) had its PID recycled while being signalled`);
        }
        outcome.state = "retired-after-signal";
        outcome.retirementObservedMs = Date.now() - started;
        fs.rmSync(stop, { force: true });
        write();
        return outcome;
      }
    }
    outcome.state = "retirement-unproved";
    fail(`Owned descendant ${name} (pid ${recorded.pid}) could not be proved retired after ${outcome.signals.join(", ") || "cooperative stop"}`);
  };
  return { source, identity, stop, reconcile };
}
