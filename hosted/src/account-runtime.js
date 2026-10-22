import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chownSync, chmodSync, lstatSync, mkdirSync, readFileSync, rmdirSync, statfsSync } from "node:fs";
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
// slow or failing push neither delays nor stops another's. A realm whose close failed is logged by account and kept
// on disk, writes and all. Returns the failures.
export async function closeRealms(entries, write = runtimeLog) {
  const results = await Promise.allSettled(entries.map(({ value }) => value.close()));
  const failed = [];
  results.forEach((result, index) => {
    if (result.status === "fulfilled") return;
    const { accountId } = entries[index];
    const code = typeof result.reason?.code === "string" ? result.reason.code : (result.reason?.name ?? "error");
    write(`DESK WRITES NOT PUSHED for account ${accountId} (${code}); its realm is kept on disk`);
    failed.push({ accountId, error: result.reason });
  });
  return failed;
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
export function createRealmLifecycle({ services, operations, failure, preserve, stop, push, closeBroker, purgeRoot }) {
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
  const preservationFailures = new Map();
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

  async function prepare(accountId) {
    if (preservationFailures.has(accountId)) throw preservationFailures.get(accountId).error;
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
    const run = (job, timeoutMs) => {
      const child = launch(realm, env, job);
      child.stderr.pipe(process.stderr, { end: false });
      const done = completion(child, timeoutMs, true);
      operations.add(done);
      done.then(() => operations.delete(done), error => {
        if (error.quiescent !== true) {
          stopped = true;
          preservationFailures.set(accountId, { error, child });
        }
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
    try {
      await run({ action: "init" });
      broker = launch(realm, env, { action: "broker" });
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
    const push = async () => {
      const deadline = Date.now() + 65_000;
      await run({ action: "push", pluginDir }, 65_000);
      const remaining = deadline - Date.now();
      if (remaining <= 0 || (await run({ action: "git", args: ["rev-list", "@{u}..HEAD"] }, remaining)).trim()) {
        throw Object.assign(new Error("Desk writes were not verified pushed after operation retirement."), {
          code: "DESK_PUSH_UNPRESERVED", quiescent: true,
        });
      }
    };
    const lifecycle = createRealmLifecycle({
      services: children, operations,
      failure: () => preservationFailures.get(accountId)?.error,
      preserve(error, child) {
        stopped = true;
        preservationFailures.set(accountId, { error, child });
      },
      stop: () => { stopped = true; },
      push, closeBroker, purgeRoot: () => run({ action: "purge" }),
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
        const guardian = launch(realm, env, { action: "launch", args });
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
      discard: lifecycle.discard,
      withholdPush: lifecycle.withholdPush,
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
      if (preservationFailures.has(accountId)) throw preservationFailures.get(accountId).error;
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
      if (preservationFailures.has(accountId)) throw preservationFailures.get(accountId).error;
      if (discard) prepared.get(accountId)?.withholdPush();
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
    close() {
      closed = true;
      closing ??= (async () => {
        await Promise.allSettled([...preparing.values()]);
        const results = await closeRealms([...prepared].map(([accountId, value]) => ({ accountId, value })), write);
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
