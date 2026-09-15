import fs from "node:fs";
import path from "node:path";

const pause = milliseconds => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds); };

// Test fixtures that intentionally create a detached descendant must own it. The creating parent records the exact PID
// it received, the descendant expires on its own as a backstop, and the caller reconciles that recorded PID in its
// teardown. Ownership is proved by the identity this fixture itself recorded — never by a process name or pattern.
export function ownedDescendant(root, name, { stdio, lifetimeMs = 5000 }) {
  const identity = path.join(root, `${name}-descendant.pid`);
  const child = `setTimeout(()=>process.exit(0),${lifetimeMs});`;
  const source = `const {spawn}=require("node:child_process");const child=spawn(process.execPath,["-e",${JSON.stringify(child)}],{detached:true,stdio:${JSON.stringify(stdio)}});child.unref();require("node:fs").writeFileSync(${JSON.stringify(identity)},String(child.pid));`;
  const reconcile = () => {
    const record = { fixture: name, root, identity: null, alive: false, terminated: false, waitedMs: 0, at: new Date().toISOString() };
    for (let attempt = 0; attempt < 10 && !fs.existsSync(identity); attempt += 1) {
      pause(50);
      record.waitedMs += 50;
    }
    if (fs.existsSync(identity)) {
      const pid = Number(fs.readFileSync(identity, "utf8"));
      if (Number.isSafeInteger(pid) && pid > 0) {
        record.identity = pid;
        try { process.kill(pid, 0); record.alive = true; } catch { record.alive = false; }
        if (record.alive) {
          try { process.kill(pid, "SIGKILL"); record.terminated = true; } catch { record.terminated = false; }
        }
      }
      fs.rmSync(identity, { force: true });
    }
    if (process.env.T13_LINEAGE_LOG) fs.appendFileSync(process.env.T13_LINEAGE_LOG, `${JSON.stringify(record)}\n`);
    return record;
  };
  return { source, identity, reconcile };
}
