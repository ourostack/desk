import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chownSync, chmodSync, lstatSync, mkdirSync, readFileSync, rmdirSync } from "node:fs";
import { dirname, isAbsolute, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { assertGatewayKernelBoundary, createUidAllocator, isolatedDeskEnv, isolationArgs } from "./isolation.js";
import { serviceHandle } from "./service-lifetime.js";
import { validRepo } from "./accounts/core.js";

const HELPER = fileURLToPath(new URL("./realm-helper.js", import.meta.url));
const allocateUid = createUidAllocator();
const refused = () => new Error("Hosted desk account authority is unavailable or changed.");

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
      closePromise = (async () => {
        healthy();
        await Promise.all([...services].map(retire));
        healthy();
        await Promise.all([...operations]);
        healthy();
        await push();
        healthy();
        await closeBroker();
        healthy();
      })();
      return closePromise;
    },
    async purge() {
      healthy();
      await value.close();
      healthy();
      await purgeRoot();
      healthy();
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

export function createAccountRuntime({ config, store, mint, baseEnv = process.env, rootDir = "/data/realms" }) {
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
  let closed = false;
  let closing;

  async function prepare(accountId) {
    if (preservationFailures.has(accountId)) throw preservationFailures.get(accountId).error;
    if (closed || typeof accountId !== "string" || !/^[A-Za-z0-9_.-]{1,128}$/.test(accountId)) throw refused();
    const [account, binding] = await Promise.all([store.getAccount(accountId), store.getBinding(accountId)]);
    if (closed || account?.accountId !== accountId || account.deskAccess !== true ||
        binding?.kind !== "github" || !binding.author || !validRepo(binding.repo) ||
        (binding.installationId === undefined && binding.repo.toLowerCase() !== configuredRepo?.toLowerCase())) throw refused();
    // GitHub repository names are case-insensitive.
    const claim = binding.repo.toLowerCase();
    if (claims.has(claim) && claims.get(claim) !== accountId) throw refused();
    const authority = JSON.stringify([binding.kind, claim, binding.installationId ?? null, binding.author.name, binding.author.email]);
    if (authorities.has(accountId) && authorities.get(accountId) !== authority) throw refused();
    authorities.set(accountId, authority);
    claims.set(claim, accountId);
    if (prepared.has(accountId)) return prepared.get(accountId);
    if (preparing.has(accountId)) return preparing.get(accountId);
    const pending = provision(accountId, structuredClone(binding));
    preparing.set(accountId, pending);
    try {
      const value = await pending;
      prepared.set(accountId, value);
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
      await run({ action: "purge" }).catch(() => {});
      if (preservationFailures.has(accountId)) throw preservationFailures.get(accountId).error;
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
    });
    return value;
  }

  // Removes a deleted account's realm, if this replica prepared one: its services retire, its writes are pushed and
  // its root is purged as its own UID. The UID stays reserved; the repository is released.
  async function purgeAccount(accountId) {
    await preparing.get(accountId)?.catch(() => {});
    const value = prepared.get(accountId);
    if (!value) return;
    await value.purge();
    // The owning UID emptied the root; the gateway owns its parent and removes the empty directory, which fails
    // if anything was left in it.
    rmdirSync(value.realm.root);
    prepared.delete(accountId);
    authorities.delete(accountId);
    for (const [claim, owner] of claims) if (owner === accountId) claims.delete(claim);
  }

  return Object.freeze({
    prepare,
    purgeAccount,
    close() {
      closed = true;
      closing ??= (async () => {
        await Promise.allSettled([...preparing.values()]);
        const results = await Promise.allSettled([...prepared.values()].map(value => value.close()));
        const failed = new Set([
          ...results.filter(result => result.status === "rejected").map(result => result.reason),
          ...[...preservationFailures.values()].map(({ error }) => error),
        ]);
        if (failed.size) throw new AggregateError([...failed], "Hosted desk shutdown could not preserve every desk.");
      })();
      return closing;
    },
  });
}
