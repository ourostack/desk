import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

if (process.env.DESK_RUNTIME_WORKER !== "1") {
  const launching = job.action === "launch";
  const child = spawn(process.execPath, launching ? job.args : [fileURLToPath(import.meta.url)], {
    cwd: launching ? env.DESK : root,
    env: launching ? env : { ...env, DESK_RUNTIME_JOB: JSON.stringify(job), DESK_RUNTIME_WORKER: "1" },
    stdio: ["inherit", "inherit", "inherit", "ipc"],
  });
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
} else {
  process.env = env;
  const git = args => runGit(args, { cwd: env.DESK, env });
  try {
    let result;
    switch (job.action) {
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
              if (command !== "git" || args[0] !== "-C" || args[1] !== env.DESK) throw new Error("Invalid desk push context.");
              return spawnSync("git", args.slice(2), { ...options, cwd: env.DESK, env, timeout: Math.max(1, deadline - Date.now()) });
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
    if (job.action !== "broker") {
      process.send({ result }, () => process.exit(0));
    }
  } catch (error) {
    const message = error.message.replaceAll(root, "[realm]").replaceAll(job.repo ?? "\0", "[repo]");
    process.stderr.write(`Owning-UID desk ${job.action} failed: ${message}\n`);
    process.exit(1);
  }
}
