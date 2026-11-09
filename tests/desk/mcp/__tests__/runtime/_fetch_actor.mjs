import fs from "node:fs"
import { runFetchOwner } from "../../../../../plugins/desk/mcp/src/runtime/fetch-owner.js"

const job = JSON.parse(fs.readFileSync(process.argv[2], "utf8"))
try {
  const result = await runFetchOwner({ ...job, onProgress: value => process.send({ type: "progress", value }) })
  process.send({ type: "result", result })
} catch (error) {
  process.send({ type: "failed", error: error.name })
  process.exitCode = 1
} finally {
  process.disconnect()
}
