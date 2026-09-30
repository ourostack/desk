// A `t.after(() => child.kill("SIGKILL"))` cleanup sends the signal and returns immediately: node:test moves on to
// the next test (or the whole file's own process exit) without waiting for the OS to actually finish terminating
// that child. Under the instrumented coverage run, a child that inherited `process.env` (the default when a test
// spawns one with no `env` override) is itself coverage-tracked, and its own per-process coverage file can still be
// mid-write in that gap -- racing the coverage runner's cleanup of the shared `processinfo` directory once the whole
// shard reports done (plugins/desk/mcp/src/coverage/runner.js's own comment on this exact race, and the retry it
// already carries for it). Waiting for the real `exit` event closes that gap: once it fires, the child has fully
// terminated, so any exit-time coverage write it made has already happened.

/** Kill `child` and resolve only once it has actually exited (a no-op if it already has). */
export function killAndWait(child, signal = "SIGKILL") {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) { resolve(); return }
    child.once("exit", () => resolve())
    child.kill(signal)
  })
}
