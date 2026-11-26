// Test preload: records each Desk process that starts, as one JSON line, in the file DESK_TEST_PROCESS_LOG names.
const { appendFileSync } = require("node:fs")
if (process.env.DESK_TEST_PROCESS_LOG) {
  appendFileSync(process.env.DESK_TEST_PROCESS_LOG, `${JSON.stringify({ pid: process.pid, argv1: process.argv[1] ?? null, ipc: typeof process.send === "function" })}\n`)
}
