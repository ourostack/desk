import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chownSync, chmodSync, lstatSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { assertGatewayKernelBoundary, createUidAllocator, isolatedDeskEnv, isolationArgs } from "./isolation.js";

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
  const child = spawn("/usr/bin/setpriv", isolationArgs({
    uid: realm.uid, command: process.execPath, args: [HELPER],
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

function completion(child, timeoutMs = 60_000) {
  let result;
  child.on("message", message => { if (Object.hasOwn(message, "result")) result = message.result; });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("close", code => {
      clearTimeout(timer);
      if (code === 0) resolve(result);
      else reject(new Error("Owning-UID desk operation failed."));
    });
  });
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
  const { repo, pluginDir, issuer } = config;
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
  let closed = false;
  let closing;

  async function prepare(accountId) {
    if (closed || typeof accountId !== "string" || !/^[A-Za-z0-9_.-]{1,128}$/.test(accountId)) throw refused();
    const [account, binding] = await Promise.all([store.getAccount(accountId), store.getBinding(accountId)]);
    if (closed || account?.accountId !== accountId || account.deskAccess !== true ||
        binding?.kind !== "github" || binding.repo !== repo || !binding.author ||
        !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(binding.repo)) throw refused();
    const authority = JSON.stringify([binding.kind, binding.repo, binding.installationId ?? null, binding.author.name, binding.author.email]);
    if (authorities.has(accountId) && authorities.get(accountId) !== authority) throw refused();
    authorities.set(accountId, authority);
    if (prepared.has(accountId)) return prepared.get(accountId);
    if (preparing.has(accountId)) return preparing.get(accountId);
    const pending = provision(accountId, structuredClone(binding));
    preparing.set(accountId, pending);
    try {
      const value = await pending;
      prepared.set(accountId, value);
      return value;
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
    let closePromise;
    const run = (job, timeoutMs) => {
      const child = launch(realm, env, job);
      child.stderr.pipe(process.stderr, { end: false });
      const done = completion(child, timeoutMs);
      operations.add(done);
      done.then(() => operations.delete(done), () => operations.delete(done));
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
            Promise.resolve().then(() => mint(binding.repo)).then(
              ({ token }) => { if (broker.connected) broker.send({ token, id: message.mint }, () => {}); },
              () => { if (broker.connected) broker.send({ error: "Desk token unavailable.", id: message.mint }, () => {}); },
            );
          }
        });
      });
      await run({ action: "clone", repo: binding.repo });
    } catch (error) {
      await closeBroker();
      // Remove incomplete contents as the owning UID; the UID remains reserved.
      await run({ action: "purge" }).catch(() => {});
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
    const push = () => run({ action: "push", pluginDir }, 65_000);
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
        const child = launch(realm, env, { action: "launch", args });
        children.add(child);
        child.once("close", () => children.delete(child));
        return child;
      },
      git,
      push() {
        if (stopped || closed) throw new Error("Hosted desk runtime is closed.");
        return push();
      },
      close() {
        if (closePromise) return closePromise;
        stopped = true;
        closePromise = (async () => {
          await Promise.all([...children].map(async child => {
            const done = completion(child, 10_000);
            child.kill("SIGTERM");
            await done;
          }));
          await Promise.all([...operations]);
          await push();
          await closeBroker();
        })();
        return closePromise;
      },
      async purge() {
        await value.close();
        await run({ action: "purge" });
      },
    });
    return value;
  }

  return Object.freeze({
    prepare,
    close() {
      closed = true;
      closing ??= (async () => {
        await Promise.allSettled([...preparing.values()]);
        const results = await Promise.allSettled([...prepared.values()].map(value => value.close()));
        const failed = results.filter(result => result.status === "rejected");
        if (failed.length) throw new AggregateError(failed.map(result => result.reason), "Hosted desk shutdown could not preserve every desk.");
      })();
      return closing;
    },
  });
}
