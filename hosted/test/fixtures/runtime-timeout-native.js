import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, lstatSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createAccountRuntime } from "../../src/account-runtime.js";
import { assertChildKernelBoundary, isolatedDeskEnv, isolationArgs } from "../../src/isolation.js";
import { readProcessStart } from "../../../plugins/desk/mcp/src/readiness/process-start.js";

const SCRIPT = fileURLToPath(import.meta.url);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function probe(realm, env) {
  const child = spawn("/usr/bin/setpriv", isolationArgs({
    uid: realm.uid, command: process.execPath, args: [SCRIPT, "inspect"],
  }), { env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.on("data", chunk => { stderr += chunk; });
  assert.equal((await once(child, "close"))[0], 0, stderr);
  return JSON.parse(stdout);
}

const outcome = promise => promise.then(
  () => ({ status: "fulfilled" }),
  error => ({ status: "rejected", code: error.code, quiescent: error.quiescent, message: error.message }),
);

export async function runTimeoutCases({ config, store, binding, root, waitForSlowFetch, originSubjects }) {
  const bound = setTimeout(() => { console.error("Timeout native fixture exceeded its 100-second bound."); process.exit(1); }, 100_000);
  const rootDir = join(root, "timeout-realms");
  const baseEnv = { PATH: "/data/runtime-native-bin:/usr/local/bin:/usr/bin:/bin" };
  // One repository serves one account at a time in a runtime, so the three accounts of `manager` have three
  // repositories.
  const repos = { "deadline-push": binding.repo, "deadline-a": binding.repo, "deadline-b": "synthetic/second", "deadline-c": "synthetic/third" };
  for (const [accountId, repo] of Object.entries(repos)) {
    await store.putAccount({ accountId, displayName: "Synthetic", deskAccess: true });
    await store.putBinding(accountId, { ...binding, repo });
  }
  const manager = createAccountRuntime({
    config, store, rootDir, baseEnv, mint: async () => ({ token: "synthetic-token" }),
  });
  const pushManager = createAccountRuntime({
    config, store, rootDir: join(root, "push-retirement-realms"), baseEnv,
    mint: async () => ({ token: "synthetic-token" }),
  });
  const pushDesk = await pushManager.prepare("deadline-push");
  await pushDesk.git(["commit", "--quiet", "--allow-empty", "-m", "before retirement push"]);
  const setupPush = pushDesk.launch([SCRIPT, "setup-push-hook"]);
  assert.equal((await once(setupPush, "close"))[0], 0);
  const pushClose = await outcome(pushDesk.close());
  const afterPush = await probe(pushDesk.realm, pushDesk.env);
  const writePushed = originSubjects().includes("post-push retirement write");
  console.log(JSON.stringify({ pushRetirementObservation: { root: pushDesk.realm.root, pushClose, afterPush, writePushed } }));
  assert.match(afterPush.subjects, /post-push retirement write/);
  if (!writePushed) {
    assert.equal(pushClose.status, "rejected", "retirement must not turn a stale push count into a successful close");
    assert.equal(afterPush.socketExists, true, "a retired but unpushed write retains its broker");
    // The realm is quiescent and keeps its broker, so the next close (here, shutdown) pushes the write it missed.
    await pushManager.close();
    assert.ok(originSubjects().includes("post-push retirement write"), "a retried close pushes the write the first push missed");
  } else {
    await pushManager.close();
  }
  const desk = await manager.prepare("deadline-a");
  const setup = desk.launch([SCRIPT, "setup-hook"]);
  assert.equal((await once(setup, "close"))[0], 0);
  const started = Date.now();
  const commit = outcome(desk.git(["commit", "--quiet", "--allow-empty", "-m", "late deadline write"]));
  writeFileSync("/data/runtime-native-slow-fetch", "plain", { mode: 0o644 });
  const plain = outcome(manager.prepare("deadline-b"));
  await waitForSlowFetch("plain");
  writeFileSync("/data/runtime-native-slow-fetch", "escaped");
  const escaped = outcome(manager.prepare("deadline-c"));
  await waitForSlowFetch("escaped");
  unlinkSync("/data/runtime-native-slow-fetch");
  const [commitResult, plainResult, escapedResult] = await Promise.all([commit, plain, escaped]);
  const rejectedAt = Date.now();
  assert.equal(commitResult.status, "rejected");
  assert.equal(plainResult.status, "rejected");
  assert.equal(escapedResult.status, "rejected");
  assert.ok(rejectedAt - started >= 60_000, "production's real 60-second deadlines must be exercised");
  // Deliberately close AFTER the timed-out promise has rejected and left the
  // ordinary in-flight set: this is the independent review's failing order.
  const closeResult = await outcome(desk.close());
  const failedRoots = readdirSync(rootDir).map(name => join(rootDir, name)).filter(path => path !== desk.realm.root);
  const preparations = [];
  for (const path of failedRoots) {
    const uid = lstatSync(path).uid;
    const realm = { root: path, uid, gid: uid };
    const env = isolatedDeskEnv({ realm, baseEnv, author: binding.author });
    preparations.push({ realm, env, before: await probe(realm, env) });
  }
  await pause(Math.max(0, started + 75_000 - Date.now()));
  const afterCommit = await probe(desk.realm, desk.env);
  for (const preparation of preparations) preparation.after = await probe(preparation.realm, preparation.env);
  const observation = {
    elapsedMs: Date.now() - started, commitResult, plainResult, escapedResult, closeResult,
    commit: afterCommit,
    preparations: preparations.map(({ realm, before, after }) => ({ root: realm.root, uid: realm.uid, before, after })),
  };
  console.log(JSON.stringify({ timeoutObservation: observation }));
  assert.equal(afterCommit.commitFinished, false, "the timed-out Git/hook generation must not finish a late commit");
  assert.ok(!afterCommit.subjects.includes("late deadline write"), "no local-only write may appear after successful close");
  assert.equal(afterCommit.actorAlive, false);
  assert.equal(closeResult.status, "fulfilled", "proved retirement permits an honest final push/close");
  const plainPreparation = preparations.find(item => item.after.fetchMode === "plain");
  const escapedPreparation = preparations.find(item => item.after.fetchMode === "escaped");
  assert.ok(plainPreparation && escapedPreparation);
  assert.equal(plainPreparation.after.actorAlive, false, "cleanup must retire the actual fetch generation");
  assert.equal(plainPreparation.after.fetchFinished, false, "cleanup cannot race a surviving fetch wrapper");
  assert.equal(plainPreparation.after.cloneExists, false, "quiescent failed preparation can be purged");
  assert.equal(plainResult.quiescent, true);
  assert.equal(escapedResult.quiescent, false, "an escaped Git generation cannot be silently called retired");
  assert.equal(escapedPreparation.before.cloneExists, true, "uncertain preparation retains its private clone");
  assert.equal(escapedPreparation.before.socketExists, true, "uncertain preparation retains its broker");
  assert.equal(escapedPreparation.before.fetchHead, "", "the delayed fetch has not recorded a result at rejection");
  assert.match(escapedPreparation.after.fetchHead, /^[0-9a-f]{40}\s/m, "the real escaped fetch writes its result after rejection");
  assert.equal(escapedPreparation.after.cloneExists, true);
  assert.equal(escapedPreparation.after.socketExists, true);
  // The escaped fetch has finished, so nothing of deadline-c's uncertain realm runs but its broker: the next
  // preparation empties it and starts afresh instead of refusing the account until the replica restarts.
  assert.equal(escapedPreparation.after.actorAlive, false, "the escaped fetch has exited");
  const recoveredC = await manager.prepare("deadline-c");
  assert.notEqual(recoveredC.realm.root, escapedPreparation.realm.root);
  assert.equal((await probe(escapedPreparation.realm, escapedPreparation.env)).cloneExists, false, "the uncertain realm was emptied once nothing of it ran");
  await recoveredC.close();
  const retried = await manager.prepare("deadline-b");
  assert.equal(retried.realm.uid, plainPreparation.realm.uid);
  await retried.close();
  await manager.close();
  clearTimeout(bound);
  return { defaultDeadlineMs: 60_000, lateCommitPrevented: true, fetchRetiredBeforePurge: true, escapedFetchPreservationRetained: true, recoveredAfterPreservation: true };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  assertChildKernelBoundary({ status: readFileSync("/proc/self/status", "utf8"), uid: process.getuid() });
  const root = dirname(process.env.DESK);
  if (process.argv[2] === "setup-push-hook") {
    writeFileSync(join(process.env.DESK, ".git/hooks/pre-push"), `#!/usr/bin/env node
const fs = require("node:fs"), path = require("node:path");
const marker = path.join(path.dirname(process.env.DESK), "push-hook-once");
if (!fs.existsSync(marker)) {
  fs.writeFileSync(marker, "started");
  require("node:child_process").spawn(process.execPath, [${JSON.stringify(SCRIPT)}, "late-push"], { env: process.env, detached: true, stdio: "ignore" }).unref();
}
`, { mode: 0o700 });
  } else if (process.argv[2] === "late-push") {
    await pause(1500);
    const written = spawnSync("/usr/bin/git", ["commit", "--quiet", "--allow-empty", "-m", "post-push retirement write"], { cwd: process.env.DESK, env: process.env });
    process.exitCode = written.status ?? 1;
  } else if (process.argv[2] === "setup-hook") {
    writeFileSync(join(process.env.DESK, ".git/hooks/pre-commit"), `#!/usr/bin/env node
const fs = require("node:fs"), path = require("node:path");
(async () => {
  const { readProcessStart } = await import("file:///app/plugins/desk/mcp/src/readiness/process-start.js");
  const root = path.dirname(process.env.DESK);
  fs.writeFileSync(path.join(root, "commit-started"), JSON.stringify({ pid: process.pid, start: await readProcessStart(process.pid) }));
  setTimeout(() => fs.writeFileSync(path.join(root, "commit-finished"), "finished"), 65000);
})();
`, { mode: 0o700 });
  } else if (process.argv[2] === "inspect") {
    const read = name => existsSync(join(root, name)) ? JSON.parse(readFileSync(join(root, name), "utf8")) : null;
    const actor = read("fetch-started") ?? read("commit-started");
    let actorAlive = false;
    if (actor && await readProcessStart(actor.pid) === actor.start) {
      try { actorAlive = !/^State:\s+Z/m.test(readFileSync(`/proc/${actor.pid}/status`, "utf8")); } catch {}
    }
    const cloneExists = existsSync(process.env.DESK);
    const log = cloneExists ? spawnSync("/usr/bin/git", ["log", "--format=%s"], { cwd: process.env.DESK, env: process.env, encoding: "utf8" }) : null;
    console.log(JSON.stringify({
      uid: process.getuid(), cloneExists, socketExists: existsSync(process.env.DESK_TOKEN_SOCKET),
      commitFinished: existsSync(join(root, "commit-finished")), fetchFinished: existsSync(join(root, "fetch-finished")),
      fetchMode: actor?.mode, actorAlive, fetched: existsSync(join(process.env.DESK, ".git/FETCH_HEAD")),
      fetchHead: existsSync(join(process.env.DESK, ".git/FETCH_HEAD")) ? readFileSync(join(process.env.DESK, ".git/FETCH_HEAD"), "utf8") : "",
      subjects: log?.stdout ?? "",
    }));
  } else {
    throw new Error("Unknown native timeout fixture mode.");
  }
}
