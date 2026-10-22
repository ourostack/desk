import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chownSync, chmodSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmdirSync, statfsSync } from "node:fs";
import { dirname, isAbsolute, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { assertGatewayKernelBoundary, createUidAllocator, isolatedDeskEnv, isolationArgs } from "./isolation.js";
import { serviceHandle } from "./service-lifetime.js";
import { validRepo } from "./accounts/core.js";

const HELPER = fileURLToPath(new URL("./realm-helper.js", import.meta.url));
const allocateUid = createUidAllocator();
const refused = () => new Error("Hosted desk account authority is unavailable or changed.");
// Session start passes this message to the person (relay.js).
const stillSaving = () => Object.assign(new Error("Hosted Desk is still saving the last changes of your previous desk. Try again in a few minutes."), { code: "DESK_SESSION_REFUSED" });

// Refused while a realm whose operation outlived its retirement still has something running; the next session
// tries again (spec item 20's capacity rules don't apply: this is the account's own earlier work).
const stillFinishing = () => Object.assign(new Error("Hosted Desk is still finishing your last session's work. Try again in a few minutes."), { code: "DESK_SESSION_REFUSED" });

// The processes of `uid` other than `keep` and its descendants.
export function othersRunning(processes, keep) {
  const kept = new Set(keep === null || keep === undefined ? [] : [keep]);
  for (let grew = true; grew;) {
    grew = false;
    for (const { pid, ppid } of processes) if (!kept.has(pid) && kept.has(ppid)) { kept.add(pid); grew = true; }
  }
  return processes.filter(({ pid }) => !kept.has(pid)).map(({ pid }) => pid);
}

// The processes running with `uid` as any of their real, effective, saved or filesystem UIDs, as { pid, ppid }. A
// zombie runs nothing, so it doesn't count, unless it is the gateway's own child (its last messages may not have
// been read yet) or a thread-group leader whose other threads still run.
export function uidProcesses(uid, { procDir = "/proc", list = readdirSync, read = readFileSync, ownPid = process.pid } = {}) {
  const pids = [];
  for (const name of list(procDir)) {
    if (!/^\d+$/.test(name)) continue;
    let status;
    try {
      status = read(join(procDir, name, "status"), "utf8");
    } catch {
      continue;
    }
    const ids = /^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)/m.exec(status);
    if (!ids || !ids.slice(1).some(id => Number(id) === uid)) continue;
    const ppid = Number(/^PPid:\s+(\d+)/m.exec(status)?.[1]);
    const gone = /^State:\s+Z/m.test(status) && ppid !== ownPid && Number(/^Threads:\s+(\d+)/m.exec(status)?.[1] ?? 1) <= 1;
    if (!gone) pids.push({ pid: Number(name), ppid });
  }
  return pids;
}

// Refused when the realm disk is too full for another clone (spec item 20); session start passes it to the person.
const diskFull = () => Object.assign(new Error("Hosted Desk is short of disk space, so it can't set up your desk right now. Please try again later."), { code: "DESK_SESSION_REFUSED" });
const runtimeLog = (message) => process.stderr.write(`desk-hosted runtime: ${message}\n`);

// The share of the disk's usable blocks in use, as df's Use% reports it: blocks reserved for root count as neither.
export function diskUsedFraction(path, statfs = statfsSync) {
  const { blocks, bfree, bavail } = statfs(path);
  const used = blocks - bfree;
  return used + bavail > 0 ? used / (used + bavail) : 1;
}

// Closes every prepared realm at once: each retires its services and pushes its own writes as its own UID, so one
// slow or failing push neither delays nor stops another's. A realm whose close failed is logged by account; its
// realm is on the container's own disk, so writes that its rescue push did not save are lost with the replica.
// Returns the failures.
export async function closeRealms(entries, write = runtimeLog) {
  const results = await Promise.allSettled(entries.map(({ value }) => value.close()));
  const failed = [];
  results.forEach((result, index) => {
    if (result.status === "fulfilled") return;
    const { accountId } = entries[index];
    const code = typeof result.reason?.code === "string" ? result.reason.code : (result.reason?.name ?? "error");
    write(`DESK WRITES NOT PUSHED for account ${accountId} (${code}); any not saved to a rescue branch are lost when this replica stops`);
    failed.push({ accountId, error: result.reason });
  });
  return failed;
}

// A push's time: its usual 65 s, or less when the shutdown deadline is nearer. Zero means there is no time left.
export function pushBudget(now, deadline, max = 65_000) {
  return Math.max(0, Math.min(max, deadline - now));
}

// The end of the shutdown window kept for a rescue push when the desk's own push fails.
export const RESCUE_RESERVE_MS = 10_000;

const rescueStamp = () => `${new Date().toISOString().replace(/[-:]|\.\d+/g, "")}-${randomUUID().slice(0, 8)}`;

// After a failed shutdown push, pushes the desk's HEAD to a new branch `desk-rescue/<UTC time>-<random>` on the
// account's own repository. A new branch can't be rejected by a newer commit on the desk's branch, and the person
// can see it and merge it. Its name carries no account id, so no argv does. A rebase a killed push left half done is
// aborted first, so HEAD is the desk's branch with every unpushed commit. Never throws: returns the branch, "" when
// nothing needed saving, or null when the rescue failed, which it logs by account.
export async function rescueDeskWrites({ run, accountId, deadline, now = Date.now, stamp = rescueStamp, write = runtimeLog }) {
  const left = () => Math.min(RESCUE_RESERVE_MS, deadline - now());
  if (!(left() > 0)) {
    write(`DESK WRITES NOT RESCUED for account ${accountId} (no time left)`);
    return null;
  }
  try {
    await run({ action: "git", args: ["rebase", "--abort"] }, left());
  } catch {
    // No rebase was under way.
  }
  let ahead = true;
  try {
    ahead = Boolean((await run({ action: "git", args: ["rev-list", "@{u}..HEAD"] }, left())).trim());
  } catch {
    // The count can't be read: push anyway rather than risk losing writes.
  }
  if (!ahead) return "";
  const branch = `desk-rescue/${stamp()}`;
  try {
    if (!(left() > 0)) throw Object.assign(new Error("no time left"), { code: "no time left" });
    await run({ action: "git", args: ["push", "--quiet", "origin", `HEAD:refs/heads/${branch}`] }, left());
  } catch (error) {
    write(`DESK WRITES NOT RESCUED for account ${accountId} (${typeof error?.code === "string" ? error.code : "error"})`);
    return null;
  }
  write(`DESK WRITES RESCUED for account ${accountId}: pushed to branch ${branch} on its desk repository`);
  return branch;
}

// Recovers a realm after a preservation failure: saves its writes (its own push, or a rescue branch when that
// fails), closes its token broker and empties its root. `current()` is true while the failure being recovered is
// still the account's recorded one: a step of the recovery that can't itself be proved stopped records a new failure,
// which ends this attempt. `quiet()` is true while nothing of the realm runs but its broker. Both are checked before
// each step that pushes, rescues or closes the broker (`rescue(deadline, run)` gets a `run` that refuses once they
// no longer hold), and `current()` again before the root is emptied (the broker's
// own processes may take a moment to go once it closed). `markSaved()` records that nothing is left to push, so a
// later attempt doesn't push again. Returns true once the root was emptied; false leaves the next session to try again.
export async function recoverRealm({ current, quiet, unsaved, run, rescue, markSaved, closeBroker, pluginDir, deadline: shutdownDeadline = Infinity, now = Date.now }) {
  const still = () => current() && quiet();
  if (!still()) return false;
  if (unsaved()) {
    const budget = pushBudget(now(), shutdownDeadline);
    if (budget === 0) return false;
    const deadline = now() + budget;
    await run({ action: "git", args: ["rebase", "--abort"] }, Math.min(RESCUE_RESERVE_MS, budget)).catch(() => {});
    if (!still()) return false;
    // A discard asked for meanwhile (a desk init rolled back) withholds the push: unsaved() is checked before each.
    let saved = false;
    if (unsaved()) {
      try {
        await run({ action: "push", pluginDir }, budget);
        saved = !(await run({ action: "git", args: ["rev-list", "@{u}..HEAD"] }, Math.max(1, deadline - now()))).trim();
      } catch {
        // The rescue below saves them instead.
      }
    }
    if (!still()) return false;
    // The rescue's own steps run only while the realm is still quiet and the failure still current.
    const guarded = (job, timeoutMs) => still()
      ? run(job, timeoutMs)
      : Promise.reject(Object.assign(new Error("The realm is no longer quiet."), { code: "DESK_RECOVERY_INTERRUPTED" }));
    if (!saved && unsaved()) saved = (await rescue(Math.min(shutdownDeadline, now() + RESCUE_RESERVE_MS), guarded)) !== null;
    if ((!saved && unsaved()) || !still()) return false;
    if (saved) markSaved();
  }
  await closeBroker();
  if (!current()) return false;
  await run({ action: "purge" });
  return true;
}

// The shutdown close: realms already prepared close at once, without waiting for a preparation still under way (a
// clone can take minutes); a preparation that finishes before `deadline` has its realm closed then. One still running
// at the deadline is logged and left: it is a fresh clone that no session has written to yet.
export async function closeAll({ prepared, preparing, deadline, write = runtimeLog }) {
  const first = new Set(prepared.values());
  const now = closeRealms([...prepared].map(([accountId, value]) => ({ accountId, value })), write);
  const late = (async () => {
    const pending = [...preparing];
    if (pending.length === 0) return [];
    const settledIds = new Set();
    const closes = [];
    // Each preparation's realm is closed as soon as that preparation finishes.
    const tracked = pending.map(([accountId, promise]) => promise.then(() => {}, () => {}).then(() => {
      settledIds.add(accountId);
      const value = prepared.get(accountId);
      if (value && !first.has(value)) closes.push(closeRealms([{ accountId, value }], write));
    }));
    const settled = Promise.allSettled(tracked);
    let timer;
    // Without a deadline (Infinity, which setTimeout would treat as 1 ms), wait for every preparation.
    await (Number.isFinite(deadline)
      ? Promise.race([settled, new Promise((resolve) => { timer = setTimeout(resolve, Math.max(0, deadline - Date.now())); })])
      : settled);
    clearTimeout(timer);
    for (const [accountId] of pending) if (!settledIds.has(accountId)) write(`account ${accountId} was still being prepared at the shutdown deadline; nothing of it was closed`);
    return (await Promise.all(closes)).flat();
  })();
  return [...(await now), ...(await late)];
}

function protectedKey(path) {
  protectedAncestors(path);
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0) {
    throw new Error("Hosted desk gateway secret file is not confined to the gateway UID.");
  }
}

function protectedAncestors(path) {
  if (typeof path !== "string" || !isAbsolute(path) || normalize(path) !== path) throw new Error("Hosted desk path is not protected.");
  for (let parent = dirname(path); ; parent = dirname(parent)) {
    const stat = lstatSync(parent);
    if (!stat.isDirectory() || ![0, process.getuid()].includes(stat.uid) || (stat.mode & 0o022)) {
      throw new Error("Hosted desk path ancestors are not protected.");
    }
    if (parent === "/") break;
  }
}

// One supervisor owns one exact ChildProcess generation. Signals travel over
// its inherited IPC channel, never through a gateway kill(pid) or PID lookup.
function launch(realm, env, job) {
  const supervised = job.action !== "broker";
  const child = spawn("/usr/bin/setpriv", isolationArgs({
    uid: realm.uid,
    command: supervised ? "/usr/bin/tini" : process.execPath,
    args: supervised ? ["-s", "--", process.execPath, HELPER] : [HELPER],
  }), {
    env: { ...env, DESK_RUNTIME_JOB: JSON.stringify(job) },
    stdio: ["pipe", "pipe", "pipe", "ipc"],
  });
  let ended = false;
  child.once("close", () => { ended = true; });
  child.kill = (signal = "SIGTERM") => {
    if (ended || !child.connected) return false;
    if (!["SIGTERM", "SIGKILL"].includes(signal)) throw new Error("Unsupported hosted desk signal.");
    child.send({ signal }, () => {});
    return true;
  };
  return child;
}

export function completion(child, timeoutMs = 60_000, requireRetirement = false) {
  return new Promise((resolve, reject) => {
    let result;
    let retired = !requireRetirement;
    let timedOut = false;
    let retirementTimer;
    const failure = () => Object.assign(new Error(retired
      ? `Owning-UID desk operation ${timedOut ? "timed out" : "failed"}.`
      : "Owning-UID desk operation could not establish quiescence; preservation is required."), {
      code: retired ? (timedOut ? "DESK_OPERATION_TIMEOUT" : "DESK_OPERATION_FAILED") : "DESK_OPERATION_UNQUIESCENT",
      quiescent: retired,
    });
    const stopTimers = () => { clearTimeout(timer); clearTimeout(retirementTimer); };
    const timer = timeoutMs === null ? undefined : setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
      if (requireRetirement) retirementTimer = setTimeout(() => reject(failure()), 5_000);
    }, timeoutMs);
    child.on("message", message => {
      if (!message || typeof message !== "object") return;
      if (Object.hasOwn(message, "result")) result = message.result;
      if (requireRetirement && Object.hasOwn(message, "retired")) {
        retired = message.retired === true && message.quiescent === true;
        if (!retired) {
          stopTimers();
          reject(failure());
        }
      }
    });
    child.once("disconnect", () => {
      if (requireRetirement && !retired) { stopTimers(); reject(failure()); }
    });
    child.once("error", () => { stopTimers(); reject(failure()); });
    child.once("close", code => {
      stopTimers();
      if (code === 0 && retired && !timedOut) resolve(result);
      else reject(failure());
    });
  });
}

// The prepared realm's preservation boundary owns both protocol termination
// and real guardian retirement; neither outcome substitutes for the other.
// `saved()` is told when the close's own push succeeded with every service retired and no failure latched: only
// then is nothing of the realm's left to push.
export function createRealmLifecycle({ services, operations, failure, preserve, stop, push, closeBroker, purgeRoot, saved = () => {} }) {
  let closePromise;
  // Set by a discard: a close that has not reached its push yet skips it.
  let withheld = false;
  const healthy = () => {
    const error = failure();
    if (error) throw error;
  };
  const retire = ({ guardian, handle, done, protocol }) => new Promise((resolve, reject) => {
    let retired = false;
    let timedOut = false;
    let grace;
    const clear = () => { clearTimeout(timer); clearTimeout(grace); };
    const failed = error => { clear(); preserve(error, guardian); reject(error); };
    const timeoutFailure = () => Object.assign(new Error(retired
      ? "Owning-UID desk operation timed out."
      : "Owning-UID desk operation could not establish quiescence; preservation is required."), {
      code: retired ? "DESK_OPERATION_TIMEOUT" : "DESK_OPERATION_UNQUIESCENT",
      quiescent: retired,
    });
    // One service-close budget covers both outcomes, followed by the existing
    // retirement acknowledgement grace rather than a separate protocol timer.
    const timer = setTimeout(() => {
      timedOut = true;
      guardian.kill("SIGKILL");
      handle.kill("SIGKILL");
      grace = setTimeout(() => failed(timeoutFailure()), 5_000);
    }, 10_000);
    Promise.all([done.then(() => { retired = true; }), protocol]).then(() => {
      try {
        healthy();
        if (timedOut) throw timeoutFailure();
        clear();
        resolve();
      } catch (error) { failed(error); }
    }, failed);
    guardian.kill("SIGTERM");
  });
  const finish = () => (async () => {
    healthy();
    await Promise.all([...services].map(retire));
    healthy();
    await Promise.all([...operations]);
    healthy();
    if (!withheld) {
      await push();
      healthy();
      saved();
    }
    await closeBroker();
    healthy();
  })();
  const value = Object.freeze({
    service(guardian) {
      healthy();
      if (closePromise) throw new Error("Hosted desk runtime is closed.");
      const done = completion(guardian, null, true);
      const failed = error => preserve(error, guardian);
      const handle = serviceHandle(guardian, failed);
      const protocol = new Promise(resolve => {
        const settled = () => {
          handle.removeListener("close", settled);
          handle.removeListener("error", settled);
          resolve();
        };
        handle.once("close", settled);
        handle.once("error", settled);
      });
      const entry = { guardian, handle, done, protocol };
      services.add(entry);
      // A protocol error has already called preserve when required. Its
      // terminal event is distinct from the independently observed guardian.
      Promise.all([done, protocol]).then(() => services.delete(entry), failed);
      return handle;
    },
    close() {
      try { healthy(); } catch (error) { return Promise.reject(error); }
      if (closePromise) return closePromise;
      stop();
      const closing = finish();
      closePromise = closing;
      // A quiescent failure (the push could not be verified, say) leaves the writes in the realm and nothing
      // running in it, so a later close tries again; a preservation failure stays final.
      closing.catch(error => {
        if (closePromise === closing && error?.quiescent === true && !failure()) closePromise = undefined;
      });
      return closing;
    },
    async purge() {
      healthy();
      await value.close();
      healthy();
      await purgeRoot();
      healthy();
    },
    // Keeps the realm's writes from reaching its repository, even if a close is already retiring its services.
    withholdPush() {
      withheld = true;
    },
    // Retires everything and purges the root without pushing: for a realm whose work must not reach its
    // repository (a desk init that is being rolled back). A clean failure can be retried, as with close.
    async discard() {
      withheld = true;
      await value.purge();
    },
  });
  return value;
}

export function assertAccountRuntimeBoundary(config, baseEnv = process.env) {
  if (process.platform !== "linux") throw new Error("Hosted desk multi-user mode requires Linux.");
  if (!config.identity) throw new Error("Hosted desk multi-user mode requires Ouro account identity.");
  assertGatewayKernelBoundary({ status: readFileSync("/proc/self/status", "utf8"), uid: process.getuid(), gid: process.getgid() });
  protectedKey(config.appKeyFile);
  if (baseEnv.AZURE_FEDERATED_TOKEN_FILE) protectedKey(baseEnv.AZURE_FEDERATED_TOKEN_FILE);
}

export function createAccountRuntime({
  config, store, mint, baseEnv = process.env, rootDir = "/data/realms",
  diskUsage = (path) => diskUsedFraction(path), diskLimit = 0.8, log: write = runtimeLog,
  running = uidProcesses,
}) {
  assertAccountRuntimeBoundary(config, baseEnv);
  // Each account's desk is the repository its own binding names, not DESK_REPO. A binding to any repository other
  // than DESK_REPO (which the operator configured) must name the App installation it was verified through, which
  // every token mint then checks; and a repository serves one account at a time in this replica.
  const { repo: configuredRepo, pluginDir, issuer } = config;
  const childBaseEnv = { PATH: baseEnv.PATH, LANG: baseEnv.LANG, LC_ALL: baseEnv.LC_ALL, TZ: baseEnv.TZ };
  if (!isAbsolute(rootDir)) throw new Error("Hosted desk realm parent must be absolute.");
  protectedAncestors(rootDir);
  mkdirSync(rootDir, { mode: 0o711, recursive: true });
  const parent = lstatSync(rootDir);
  if (!parent.isDirectory() || parent.uid !== process.getuid() || (parent.mode & 0o022)) {
    throw new Error("Hosted desk realm parent is not protected.");
  }
  chmodSync(rootDir, 0o711);
  const authorities = new Map();
  const preparing = new Map();
  const prepared = new Map();
  // Accounts whose realm could not be proved quiescent: { error, child, recover }. The next preparation calls
  // recover, which succeeds once nothing but the realm's token broker runs as its UID.
  const preservationFailures = new Map();
  const recovering = new Map();
  const claims = new Map();
  // Accounts deleted while this replica runs: never prepared again, even by a preparation already reading the store.
  const deleted = new Set();
  const purging = new Map();
  // Bumped by every release or purge: a preparation that read the store before one finishes again from the top,
  // so it can never pin a binding the account no longer has.
  const generations = new Map();
  const generation = accountId => generations.get(accountId) ?? 0;
  const bump = accountId => generations.set(accountId, generation(accountId) + 1);
  // One release in flight per account; one that failed is retried by the next preparation.
  const releasing = new Map();
  const releaseFailures = new Map();
  let closed = false;
  let closing;
  // When the shutdown's pushes must be done by (closeAll); every push in the meantime gets only the time left.
  let shutdownDeadline = Infinity;

  // Retries a realm that could not be proved quiescent: once nothing of it runs, its writes are pushed, it is
  // emptied as its own UID and the account is prepared afresh. Until then the person gets a plain message to try
  // again. Concurrent calls share one attempt.
  async function recoverPreservation(accountId) {
    const entry = preservationFailures.get(accountId);
    if (closed) throw entry.error;
    let attempt = recovering.get(accountId);
    if (!attempt) {
      attempt = (async () => {
        let recovered = false;
        try {
          recovered = (await entry.recover?.()) === true;
        } catch (error) {
          write(`could not recover account ${accountId}'s realm yet (${typeof error?.code === "string" ? error.code : "error"})`);
        }
        if (!recovered || preservationFailures.get(accountId) !== entry) return false;
        preservationFailures.delete(accountId);
        if (prepared.get(accountId)?.realm === entry.realm) prepared.delete(accountId);
        authorities.delete(accountId);
        for (const [claim, owner] of claims) if (owner === accountId) claims.delete(claim);
        bump(accountId);
        write(`recovered account ${accountId}'s realm: its writes were pushed and it was emptied`);
        return true;
      })().finally(() => recovering.delete(accountId));
      recovering.set(accountId, attempt);
    }
    if (!(await attempt)) throw stillFinishing();
  }

  async function prepare(accountId) {
    if (preservationFailures.has(accountId)) await recoverPreservation(accountId);
    if (closed || typeof accountId !== "string" || !/^[A-Za-z0-9_.-]{1,128}$/.test(accountId) || deleted.has(accountId)) throw refused();
    // The realm of an earlier binding could not be released yet: try again before following the new binding.
    if (releaseFailures.has(accountId)) {
      try {
        await release(accountId);
      } catch {
        throw stillSaving();
      }
    }
    await releasing.get(accountId)?.catch(() => {});
    const started = generation(accountId);
    const [account, binding] = await Promise.all([store.getAccount(accountId), store.getBinding(accountId)]);
    if (generation(accountId) !== started) return prepare(accountId);
    if (closed || deleted.has(accountId) || account?.accountId !== accountId || account.deskAccess !== true ||
        binding?.kind !== "github" || binding.suspended === true || !binding.author || !validRepo(binding.repo) ||
        (binding.installationId === undefined && binding.repo.toLowerCase() !== configuredRepo?.toLowerCase())) throw refused();
    // GitHub repository names are case-insensitive.
    const claim = binding.repo.toLowerCase();
    if (claims.has(claim) && claims.get(claim) !== accountId) throw refused();
    const authority = JSON.stringify([binding.kind, claim, binding.installationId ?? null, binding.author.name, binding.author.email]);
    if (authorities.has(accountId) && authorities.get(accountId) !== authority) throw refused();
    // A new realm means a new clone: refused while the disk is too full, before anything is claimed for it.
    if (!prepared.has(accountId) && !preparing.has(accountId)) {
      let used;
      try {
        used = diskUsage(rootDir);
      } catch (error) {
        write(`could not read realm disk use (${error?.code ?? error?.name ?? "error"}); preparing account ${accountId} anyway`);
      }
      if (used > diskLimit) {
        write(`REALM DISK FULL: ${Math.round(used * 100)}% used, over ${Math.round(diskLimit * 100)}%; refused a new clone for account ${accountId}`);
        throw diskFull();
      }
    }
    authorities.set(accountId, authority);
    claims.set(claim, accountId);
    if (prepared.has(accountId)) return prepared.get(accountId);
    // Joining a preparation already under way: if the account was released or deleted meanwhile, that realm was
    // built from a binding the account no longer has, so start again.
    if (preparing.has(accountId)) {
      const value = await preparing.get(accountId);
      return generation(accountId) === started ? value : prepare(accountId);
    }
    const pending = provision(accountId, structuredClone(binding));
    preparing.set(accountId, pending);
    try {
      const value = await pending;
      prepared.set(accountId, value);
      // Deleted while it was being provisioned: purgeAccount found nothing to remove yet, so this removes it.
      if (deleted.has(accountId)) {
        await removePrepared(accountId);
        throw refused();
      }
      // Released while it was being provisioned (the account relinked): it was built from the old binding.
      if (generation(accountId) !== started) {
        await removePrepared(accountId, { discard: true });
        return prepare(accountId);
      }
      return value;
    } catch (error) {
      // A preparation that failed and was purged holds nothing for this repository, so the account may be rebound
      // and the repository bound to another account. An uncertain realm keeps both: it may still hold writes.
      if (!preservationFailures.has(accountId)) {
        authorities.delete(accountId);
        if (claims.get(claim) === accountId) claims.delete(claim);
      }
      throw error;
    } finally {
      preparing.delete(accountId);
    }
  }

  async function provision(accountId, binding) {
    const uid = allocateUid(accountId);
    const realm = Object.freeze({ uid, gid: uid, root: join(rootDir, randomUUID()) });
    const env = Object.freeze({ ...isolatedDeskEnv({ realm, baseEnv: childBaseEnv, author: binding.author, issuer }), GH_REPO: binding.repo });
    mkdirSync(realm.root, { mode: 0o700 });
    chownSync(realm.root, uid, uid);
    const children = new Set();
    const operations = new Set();
    let stopped = false;
    let broker;
    let cloned = false;
    let pushWithheld = false;
    // Set when the realm's close pushed after every service retired, or a recovery saved its writes: nothing is left
    // to push. A push that merely ended after the realm stopped doesn't count: a service may still have been writing.
    let saved = false;
    // Set once a recovery emptied the realm; a late failure report about it changes nothing.
    let recovered = false;
    // Every process the gateway started in this realm, until Node has seen it close.
    const live = new Set();
    const start = job => {
      const child = launch(realm, env, job);
      live.add(child);
      child.once("close", () => live.delete(child));
      return child;
    };
    const preserve = (error, child) => {
      if (recovered) return;
      stopped = true;
      const entry = { error, child, realm, rescue: () => rescueAtShutdown() };
      entry.recover = () => recover(entry);
      preservationFailures.set(accountId, entry);
    };
    const run = (job, timeoutMs) => {
      const child = start(job);
      child.stderr.pipe(process.stderr, { end: false });
      const done = completion(child, timeoutMs, true);
      operations.add(done);
      done.then(() => operations.delete(done), error => {
        if (error.quiescent !== true) preserve(error, child);
        operations.delete(done);
      });
      return done;
    };
    const closeBroker = async () => {
      if (!broker || broker.exitCode !== null || broker.signalCode !== null) return;
      const done = completion(broker, 5_000);
      broker.kill("SIGTERM");
      await done;
    };
    // Nothing of the realm runs but its token broker (a helper and its worker): every process the gateway started
    // in it has closed, and nothing else runs as its UID.
    const quiet = () => {
      if ([...live].some(child => child !== broker)) return false;
      const brokerPid = broker && broker.exitCode === null && broker.signalCode === null ? broker.pid : null;
      return othersRunning(running(uid), brokerPid).length === 0;
    };
    const unsaved = () => cloned && !pushWithheld && !saved;
    // After the preservation failure `entry`: recoverRealm, while `entry` is still the account's recorded failure.
    const recover = async entry => {
      const done = await recoverRealm({
        current: () => preservationFailures.get(accountId) === entry,
        quiet,
        unsaved,
        run,
        pluginDir,
        deadline: shutdownDeadline,
        rescue: (deadline, guarded) => rescueDeskWrites({ run: guarded, accountId, deadline, write }),
        markSaved: () => { saved = true; },
        closeBroker,
      });
      if (!done) return false;
      recovered = true;
      try {
        rmdirSync(realm.root);
      } catch (error) {
        if (error.code !== "ENOENT") write(`account ${accountId}'s emptied realm root could not be removed (${error.code ?? "error"}); it stays on this replica's disk`);
      }
      return true;
    };
    // At shutdown, a realm that could not be proved quiescent and whose work has since stopped gets a rescue push.
    const rescueAtShutdown = async () => {
      if (recovered || !unsaved()) return;
      if (!quiet()) {
        write(`account ${accountId}'s realm still has work running at shutdown; its writes are not rescued`);
        return;
      }
      if (await rescueDeskWrites({ run, accountId, deadline: shutdownDeadline, write }) !== null) saved = true;
    };
    try {
      await run({ action: "init" });
      broker = start({ action: "broker" });
      broker.stderr.pipe(process.stderr, { end: false });
      await new Promise((resolve, reject) => {
        broker.once("error", reject);
        broker.once("close", () => reject(new Error("Desk token socket could not start.")));
        broker.on("message", message => {
          if (message.ready) resolve();
          if (message.mint) {
            Promise.resolve().then(() => mint(binding.repo, binding.installationId)).then(
              ({ token }) => { if (broker.connected) broker.send({ token, id: message.mint }, () => {}); },
              () => { if (broker.connected) broker.send({ error: "Desk token unavailable.", id: message.mint }, () => {}); },
            );
          }
        });
      });
      await run({ action: "clone", repo: binding.repo });
      cloned = true;
    } catch (error) {
      if (preservationFailures.has(accountId)) throw error;
      await closeBroker();
      // Remove incomplete contents as the owning UID; the UID remains reserved.
      const purged = await run({ action: "purge" }).then(() => true, () => false);
      if (preservationFailures.has(accountId)) throw preservationFailures.get(accountId).error;
      if (purged) {
        try { rmdirSync(realm.root); } catch {}
      }
      throw error;
    }
    const git = async args => {
      if (stopped || closed) throw new Error("Hosted desk runtime is closed.");
      if (!Array.isArray(args) || args.some(arg => typeof arg !== "string" || arg.includes("\0") ||
          isAbsolute(arg) || arg.includes("://") || /^(-C|-c|--git-dir|--work-tree|--config-env)/.test(arg))) {
        throw new Error("Git arguments cannot override private desk context.");
      }
      return run({ action: "git", args });
    };
    const deskPush = async () => {
      // At shutdown, the window's last seconds are kept for a rescue push.
      const budget = pushBudget(Date.now(), shutdownDeadline - (closed ? RESCUE_RESERVE_MS : 0));
      if (budget === 0) {
        throw Object.assign(new Error("Desk writes were not pushed before the shutdown deadline."), { code: "DESK_PUSH_UNPRESERVED", quiescent: true });
      }
      const deadline = Date.now() + budget;
      await run({ action: "push", pluginDir }, budget);
      const remaining = deadline - Date.now();
      if (remaining <= 0 || (await run({ action: "git", args: ["rev-list", "@{u}..HEAD"] }, remaining)).trim()) {
        throw Object.assign(new Error("Desk writes were not verified pushed after operation retirement."), {
          code: "DESK_PUSH_UNPRESERVED", quiescent: true,
        });
      }
    };
    // A shutdown push that failed with nothing left running in the realm gets a rescue push; the push still counts
    // as failed, so the shutdown reports it.
    const push = async () => {
      try {
        await deskPush();
      } catch (error) {
        if (closed && error?.quiescent === true && !preservationFailures.has(accountId)) {
          await rescueDeskWrites({ run, accountId, deadline: shutdownDeadline, write });
        }
        throw error;
      }
    };
    const lifecycle = createRealmLifecycle({
      services: children, operations,
      failure: () => preservationFailures.get(accountId)?.error,
      preserve,
      stop: () => { stopped = true; },
      push, closeBroker, purgeRoot: () => run({ action: "purge" }),
      saved: () => { saved = true; },
    });
    const value = Object.freeze({
      realm, env,
      launch(args) {
        if (stopped || closed) throw new Error("Hosted desk runtime is closed.");
        if (!Array.isArray(args) || !isAbsolute(args[0] ?? "") ||
            args.some(arg => typeof arg !== "string" || arg.includes("\0") || arg.includes(`${rootDir}/`) ||
              arg.includes("://") || arg.includes(binding.repo) || arg === accountId ||
              arg === "-C" || arg.startsWith("--root"))) {
          throw new Error("Hosted desk launch arguments must contain public context only.");
        }
        const guardian = start({ action: "launch", args });
        return lifecycle.service(guardian);
      },
      git,
      push() {
        if (stopped || closed) throw new Error("Hosted desk runtime is closed.");
        const done = push();
        operations.add(done);
        done.then(() => operations.delete(done), () => operations.delete(done));
        return done;
      },
      close: lifecycle.close,
      purge: lifecycle.purge,
      discard(...args) {
        pushWithheld = true;
        return lifecycle.discard(...args);
      },
      withholdPush(...args) {
        pushWithheld = true;
        return lifecycle.withholdPush(...args);
      },
    });
    return value;
  }

  // Removes a deleted account's realm, if this replica prepared one: its services retire, its writes are pushed and
  // its root is purged as its own UID. The UID stays reserved; the repository is released.
  // A realm that a release, a purge and its own preparation all remove at once is removed once; the first caller
  // decides whether its writes are pushed.
  const removals = new WeakMap();
  function removePrepared(accountId, options) {
    const value = prepared.get(accountId);
    if (!value) return Promise.resolve();
    if (options?.discard) value.withholdPush();
    if (!removals.has(value)) {
      const removal = removeRealm(accountId, value, options);
      removals.set(value, removal);
      // A removal that failed may be tried again by the next release or purge.
      removal.catch(() => removals.delete(value));
    }
    return removals.get(value);
  }

  async function removeRealm(accountId, value, { discard = false } = {}) {
    await (discard ? value.discard() : value.purge());
    // Writes were pushed (or deliberately discarded) and the root emptied as its own UID; nothing remains for the
    // claim to protect.
    if (prepared.get(accountId) === value) prepared.delete(accountId);
    authorities.delete(accountId);
    for (const [claim, owner] of claims) if (owner === accountId) claims.delete(claim);
    // The gateway owns the parent and removes the empty root, which fails if anything was left in it.
    try {
      rmdirSync(value.realm.root);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }

  // Throws when the account's desk may still be on disk: a preservation failure, or a purge that did not finish.
  // Concurrent calls share one purge.
  function purgeAccount(accountId) {
    deleted.add(accountId);
    bump(accountId);
    if (purging.has(accountId)) return purging.get(accountId);
    const done = (async () => {
      await preparing.get(accountId)?.catch(() => {});
      // A realm that couldn't be proved stopped is recovered first; until then the delete fails and can be retried.
      if (preservationFailures.has(accountId)) await recoverPreservation(accountId);
      await removePrepared(accountId);
    })();
    purging.set(accountId, done);
    done.catch(() => purging.delete(accountId));
    return done;
  }

  // Drops an account's prepared realm after its binding changed (it relinked GitHub): services retire, writes are
  // pushed, the root is purged as its own UID and the old repository and authority are released, so the next
  // preparation follows the new binding. `discard` skips the push (a desk init being rolled back). Concurrent calls
  // share one release. Throws when the old realm may still hold writes; the next preparation retries it.
  function release(accountId, { discard = false } = {}) {
    bump(accountId);
    // A discard asked for while a pushing release is under way still keeps the writes out of the repository.
    if (discard) prepared.get(accountId)?.withholdPush();
    if (releasing.has(accountId)) return releasing.get(accountId);
    const done = (async () => {
      await preparing.get(accountId)?.catch(() => {});
      if (discard) prepared.get(accountId)?.withholdPush();
      if (preservationFailures.has(accountId)) await recoverPreservation(accountId);
      await removePrepared(accountId, { discard });
    })();
    releasing.set(accountId, done);
    done.then(
      () => releaseFailures.delete(accountId),
      error => releaseFailures.set(accountId, error),
    ).finally(() => releasing.delete(accountId));
    return done;
  }

  return Object.freeze({
    prepare,
    release,
    purgeAccount,
    close({ deadline = Infinity } = {}) {
      closed = true;
      shutdownDeadline = Math.min(shutdownDeadline, deadline);
      closing ??= (async () => {
        const results = await closeAll({ prepared, preparing, deadline: shutdownDeadline, write });
        // A recovery under way finishes within the deadline; a preserved realm whose work has stopped gets a rescue.
        let timer;
        const bounded = work => Number.isFinite(shutdownDeadline)
          ? Promise.race([work, new Promise(resolve => { timer = setTimeout(resolve, Math.max(0, shutdownDeadline - Date.now())); })])
          : work;
        await bounded(Promise.allSettled([...recovering.values()]));
        clearTimeout(timer);
        await bounded(Promise.allSettled([...preservationFailures.values()].map(entry => entry.rescue?.())));
        clearTimeout(timer);
        const logged = new Set(results.map(({ accountId }) => accountId));
        for (const [accountId, { error }] of preservationFailures) {
          if (!logged.has(accountId)) write(`DESK WRITES MAY NOT BE PUSHED for account ${accountId} (${typeof error?.code === "string" ? error.code : "error"}); its writes are only on this replica's disk, which is lost when it stops`);
        }
        const failed = new Set([
          ...results.map(({ error }) => error),
          ...[...preservationFailures.values()].map(({ error }) => error),
        ]);
        if (failed.size) throw new AggregateError([...failed], "Hosted desk shutdown could not preserve every desk.");
      })();
      return closing;
    },
  });
}
