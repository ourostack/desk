import { spawn } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { argvSafeReason } from "./argv-safe-reason.js"
import { shouldLaunchFiler } from "./filer-throttle.js"
import { namedUntrackedPaths } from "./deliver.js"
import { startOrJoinRecovery } from "./recovery-state.js"

export { classifyPullFailure } from "./deliver.js"

/** Recovery owns native work; boot's waiting budget never owns or cancels that work. */
export function syncWorkspace(options) {
  return startOrJoinRecovery(options)
}

// Retained for callers that parse Git diagnostics; recovery never moves these paths.
export function overwrittenUntrackedPaths(stderr) {
  return [...new Set(namedUntrackedPaths(stderr).filter((relative) =>
    relative !== "" && !path.isAbsolute(relative) && !relative.split(/[\\/]/u).includes("..") &&
    relative !== "_cache" && !relative.startsWith("_cache/")))]
}

export function queueDeskProblemFiling({ root, env, reason, host, spawnImpl = spawn }) {
  const safeReason = argvSafeReason(reason)
  if (!shouldLaunchFiler({ env, mechanism: "session-sync", signature: safeReason })) {
    return { file: "filing already queued (within the last hour)" }
  }
  try {
    const child = spawnImpl(process.execPath, [
      fileURLToPath(new URL("../../scripts/file-desk-problem.js", import.meta.url)),
      "--mechanism", "session-sync", "--reason", safeReason, "--host", host,
      "--fix-attempt", "attempted worker-owned recovery without changing pending files or the shared index",
    ], { cwd: root, detached: true, stdio: "ignore", windowsHide: true, env })
    child.on("error", () => {})
    child.unref()
  } catch {
    return { file: "filing could not be launched" }
  }
  return { file: "filing in background" }
}

/** Legacy native-call seam. Recovery uses its process-group owner instead. */
export function spawnGitAsync(command, args, { timeout, env, spawnImpl = spawn }) {
  return new Promise((resolve) => {
    const stdout = []
    const stderr = []
    let timedOut = false
    const child = spawnImpl(command, args, { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true })
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM") }, timeout)
    child.stdout.on("data", (chunk) => stdout.push(chunk))
    child.stderr.on("data", (chunk) => stderr.push(chunk))
    child.on("error", (error) => {
      clearTimeout(timer)
      resolve({ status: null, signal: null, stdout: "", stderr: "", error })
    })
    child.on("close", (status, signal) => {
      clearTimeout(timer)
      resolve({ status, signal, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8"),
        ...(timedOut ? { error: Object.assign(new Error("git timed out"), { code: "ETIMEDOUT" }) } : {}) })
    })
  })
}

export async function runSessionSyncCli({ argv = process.argv.slice(2), env = process.env, io = process, syncFn = syncWorkspace } = {}) {
  const options = new Map()
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]
    if (typeof key !== "string" || !key.startsWith("--")) throw new Error(`session-sync.js: unexpected argument ${JSON.stringify(key ?? "")}`)
    options.set(key.slice(2), argv[index + 1])
  }
  const root = options.get("root") ?? env.DESK
  if (typeof root !== "string" || root === "") {
    io.stderr.write("session-sync.js: --root <path> (or the DESK env var) is required\n")
    return 0
  }
  const result = await syncFn({ root, env })
  if (result.state === "unresolved") io.stdout.write(`${result.diagnostic ?? `Desk sync unresolved: ${result.reason}; read desk_status before retrying.`}\n`)
  return 0
}
