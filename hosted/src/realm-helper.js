import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { assertChildKernelBoundary } from "./isolation.js";
import { ensureClone, runGit } from "./clone.js";
import { serveTokens } from "./token-socket.js";

assertChildKernelBoundary({ status: readFileSync("/proc/self/status", "utf8"), uid: process.getuid(), gid: process.getgid() });
const job = JSON.parse(process.env.DESK_RUNTIME_JOB);
const env = { ...process.env };
delete env.DESK_RUNTIME_JOB;
delete env.DESK_RUNTIME_WORKER;
const root = dirname(env.DESK);
process.chdir(root);

function directChildren(pid) {
  const children = new Set();
  for (const tid of readdirSync(`/proc/${pid}/task`)) {
    let text;
    try {
      text = readFileSync(`/proc/${pid}/task/${tid}/children`, "utf8").trim();
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    if (!/^(?:\d+(?:\s+\d+)*)?$/.test(text)) throw new Error("Unreadable operation descendants.");
    for (const value of text ? text.split(/\s+/) : []) children.add(Number(value));
  }
  return children;
}

function superviseOperation(child, guardian, service = false) {
  // A dedicated subreaper retains even setsid/detached Git descendants when
  // their parent dies. It stays alive until this supervisor certifies silence.
  let result;
  let code = 1;
  let completed = false;
  let cancelled = false;
  let killed = false;
  let released = false;
  let workerClosed = false;
  let failed = false;
  let finishing = false;
  let timer;
  let deadline;
  const alive = () => child.pid !== undefined && child.exitCode === null && child.signalCode === null;
  const only = (pid, expected) => {
    const actual = directChildren(pid);
    return actual.size === expected.length && expected.every(value => actual.has(value));
  };
  const quiescent = () =>
    process.ppid === guardian &&
    only(guardian, [process.pid]) &&
    only(process.pid, alive() ? [child.pid] : []) &&
    (!alive() || directChildren(child.pid).size === 0) &&
    only(guardian, [process.pid]);
  const cancel = () => {
    cancelled = true;
    code = service ? 0 : 1;
    deadline ??= Date.now() + 5_000;
    // Only signal the fresh session while its exact ChildProcess leader is
    // still ours and unreaped. Never retry a numeric group after leader exit.
    if (!killed && alive()) {
      killed = true;
      try { process.kill(-child.pid, "SIGKILL"); } catch {
        // A failed signal is never retirement proof; the watchdog fails closed.
      }
    }
  };
  const check = () => {
    if (finishing) return;
    let quiet = false;
    try { quiet = (!alive() || completed) && quiescent(); } catch {}
    if (quiet && alive()) {
      if (!released) {
        released = true;
        child.send({ release: true }, () => {});
      }
    } else if (quiet && workerClosed) {
      finishing = true;
      clearInterval(timer);
      if (process.connected) process.send({ retired: true, quiescent: true, result }, () => process.exit(code));
      else process.exit(code);
    }
    if (!finishing && Date.now() >= deadline && !failed) {
      failed = true;
      if (process.connected) process.send({ retired: false, quiescent: false });
      cancel();
    }
  };
  const retire = () => {
    if (finishing) return;
    if (!timer) {
      if (!service) deadline = Date.now() + 5_000;
      timer = setInterval(check, 50);
    }
    check();
  };
  child.on("message", message => {
    if (service && message?.serviceClosed === true) {
      if (process.connected) process.send(message);
      completed = true;
      code = 0;
      retire();
      return;
    }
    if (service && message && Object.hasOwn(message, "serviceMessage")) {
      if (process.connected) process.send(message);
      return;
    }
    if (service && (typeof message?.serviceStdout === "string" || typeof message?.serviceStderr === "string")) {
      if (process.connected) process.send(message);
      return;
    }
    if (!message.operationFinished) return;
    completed = true;
    if (!cancelled) code = message.code;
    result = message.result;
    retire();
  });
  child.once("error", () => { workerClosed = true; retire(); });
  child.once("exit", () => retire());
  child.once("close", () => { workerClosed = true; retire(); });
  process.on("message", message => {
    if (["SIGTERM", "SIGKILL"].includes(message.signal)) { cancel(); retire(); }
    else if (service && child.connected) child.send(message, () => {});
  });
  process.once("disconnect", () => { cancel(); retire(); });
}

if (process.env.DESK_RUNTIME_WORKER !== "1") {
  const launching = job.action === "launch";
  const supervised = job.action !== "broker";
  const guardian = process.ppid;
  if (supervised) {
    assertChildKernelBoundary({ status: readFileSync(`/proc/${guardian}/status`, "utf8"), uid: process.getuid() });
    if (readFileSync(`/proc/${guardian}/comm`, "utf8").trim() !== "tini") throw new Error("Missing operation subreaper.");
  }
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url)], {
    cwd: root,
    env: { ...env, DESK_RUNTIME_JOB: JSON.stringify(job), DESK_RUNTIME_WORKER: "1" },
    stdio: ["inherit", "inherit", "inherit", "ipc"],
    detached: supervised,
  });
  if (supervised) {
    superviseOperation(child, guardian, launching);
  } else {
    let ended = false;
    let requestedSignal;
    child.on("message", message => { if (process.connected) process.send(message); });
    child.once("error", () => process.exit(1));
    child.once("close", code => { ended = true; process.exit(code ?? (requestedSignal === "SIGTERM" ? 0 : 1)); });
    process.on("message", message => {
      if (ended) return;
      if (["SIGTERM", "SIGKILL"].includes(message.signal)) {
        requestedSignal = message.signal;
        child.kill(message.signal);
      }
      else if (child.connected) child.send(message);
    });
    process.once("disconnect", () => { if (!ended) child.kill("SIGKILL"); });
  }
} else {
  process.env = env;
  const git = args => runGit(args, { cwd: env.DESK, env });
  let finalCode;
  if (job.action !== "broker") process.on("message", message => {
    if (message.release && finalCode !== undefined) process.exit(finalCode);
  });
  const finish = (code, result) => {
    finalCode = code;
    process.send({ operationFinished: true, code, result });
  };
  try {
    let result;
    switch (job.action) {
      case "launch": {
        const child = spawn(process.execPath, job.args, {
          cwd: env.DESK, env, stdio: ["pipe", "pipe", "pipe", "ipc"],
        });
        process.stdin.pipe(child.stdin);
        child.stdin.on("error", error => {
          if (!["EPIPE", "ERR_STREAM_DESTROYED"].includes(error.code)) throw error;
        });
        child.stdout.on("data", chunk => {
          if (process.connected) process.send({ serviceStdout: chunk.toString("base64") });
        });
        child.stderr.on("data", chunk => {
          if (process.connected) process.send({ serviceStderr: chunk.toString("base64") });
        });
        let ended = false;
        child.on("message", message => {
          if (process.connected) process.send({ serviceMessage: message });
        });
        child.once("error", () => {
          if (process.connected) process.send({ serviceClosed: true, code: 1, signal: null });
        });
        child.once("close", (code, signal) => {
          ended = true;
          finalCode = 0;
          if (process.connected) process.send({ serviceClosed: true, code, signal });
        });
        process.on("message", message => {
          if (ended) return;
          if (["SIGTERM", "SIGKILL"].includes(message.serviceSignal)) child.kill(message.serviceSignal);
          else if (Object.hasOwn(message, "serviceMessage") && child.connected) child.send(message.serviceMessage, () => {});
        });
        break;
      }
      case "init":
        for (const name of ["clone", "home", "tmp", "config", "cache", "data", "state"]) {
          mkdirSync(join(root, name), { mode: 0o700 });
        }
        writeFileSync(env.GIT_CONFIG_GLOBAL, "", { mode: 0o600 });
        break;
      case "broker": {
        let next = 0;
        const requests = new Map();
        process.on("message", message => {
          const pending = requests.get(message.id);
          if (!pending) return;
          requests.delete(message.id);
          if (message.error) pending.reject(new Error(message.error));
          else pending.resolve({ token: message.token });
        });
        const server = serveTokens({
          socketPath: env.DESK_TOKEN_SOCKET,
          mint: () => new Promise((resolve, reject) => {
            const id = ++next;
            requests.set(id, { resolve, reject });
            process.send({ mint: id });
          }),
        });
        await server.ready;
        process.send({ ready: true });
        process.on("SIGTERM", () => server.close(() => process.exit(0)));
        break;
      }
      case "clone":
        await ensureClone({ dir: env.DESK, repo: job.repo, git, privateContext: true });
        break;
      case "git":
        result = await git(job.args);
        break;
      case "push": {
        const { runPushWorker } = await import(pathToFileURL(join(job.pluginDir, "mcp/src/runtime/sync-worker.js")));
        const deadline = Date.now() + 60_000;
        for (;;) {
          const ahead = (await git(["rev-list", "@{u}..HEAD"])).trim();
          if (!ahead) break;
          await runPushWorker({
            root: env.DESK, env, debounceMs: 0,
            spawnGit(command, args, options) {
              if (command !== "git" || options.cwd !== env.DESK) throw new Error("Invalid desk push context.");
              return spawnSync("git", args, { ...options, cwd: env.DESK, env, timeout: Math.max(1, deadline - Date.now()) });
            },
            fileProblem: () => {},
          });
          if (Date.now() >= deadline) throw new Error("Desk writes were not pushed.");
          if ((await git(["rev-list", "@{u}..HEAD"])).trim()) await new Promise(resolve => setTimeout(resolve, 2_000));
        }
        break;
      }
      case "purge":
        for (const name of ["clone", "home", "tmp", "config", "cache", "data", "state", "gitconfig", "git-token.sock"]) {
          rmSync(join(root, name), { force: true, recursive: true });
        }
        break;
      default:
        throw new Error("Unknown owning-UID operation.");
    }
    if (!["broker", "launch"].includes(job.action)) {
      finish(0, result);
    }
  } catch (error) {
    const message = error.message.replaceAll(root, "[realm]").replaceAll(job.repo ?? "\0", "[repo]");
    process.stderr.write(`Owning-UID desk ${job.action} failed: ${message}\n`);
    if (job.action === "broker") process.exit(1);
    else finish(1);
  }
}
