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
// *and* that process's start-time identity at creation. Teardown reconciles against that exact identity and retires the
// descendant cooperatively — a stop marker it watches for, with its own self-expiry backstop behind that. No numeric
// PID is ever signalled, so no identity-check-then-signal race exists at all. Ownership is never inferred from a
// process name; an unreadable observation or an unproved retirement fails the teardown instead of being assumed gone.
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
    // A tagged settle: retirement is either the recorded process disappearing or its PID belonging to something else.
    const settle = budgetMs => {
      // Deadline-based: sleep only up to the next observation, and always observe at or after the deadline before
      // reporting no retirement, so a process that exits inside the final sleep is still seen.
      const deadline = Date.now() + budgetMs;
      for (;;) {
        const seen = observe();
        if (seen.absent) return "absent";
        if (seen.started !== outcome.recordedIdentity) return "replaced";
        const remaining = deadline - Date.now();
        if (remaining <= 0) return null;
        pause(Math.min(50, remaining));
      }
    };
    const finish = (state, reason) => {
      outcome.state = reason === "replaced" ? "pid-reused" : state;
      outcome.retirementObservedMs = Date.now() - started;
      fs.rmSync(stop, { force: true });
      write();
      return outcome;
    };
    // Cooperative shutdown only: the descendant watches for its own stop marker and expires on its own backstop.
    // This helper never signals a numeric PID, so it can never race a recycled PID into signalling an unrelated
    // process. A descendant that retires by neither route fails the teardown instead of being assumed gone.
    fs.writeFileSync(stop, `${Date.now()}\n`);
    const cooperative = settle(retirementMs);
    if (cooperative !== null) return finish("retired-cooperatively", cooperative);
    const backstop = settle(Math.max(0, recorded.createdAt + lifetimeMs + 500 - Date.now()));
    if (backstop !== null) return finish("retired-by-backstop", backstop);
    outcome.state = "retirement-unproved";
    fail(`Owned descendant ${name} (pid ${recorded.pid}) retired by neither its stop marker nor its backstop; this helper never signals a numeric PID`);
  };
  return { source, identity, stop, reconcile };
}
