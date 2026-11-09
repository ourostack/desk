import { promises as fs } from "node:fs"
import { desk_save } from "../../../../../plugins/desk/mcp/src/tools/desk-save.js"
import { callTool } from "../../../../../plugins/desk/mcp/src/server.js"
import { withWorkspaceClaim } from "../../../../../plugins/desk/mcp/src/runtime/workspace-claim.js"

const [mode, root, repository, branch] = process.argv.slice(2)
try {
  if (mode === "hold") {
    await withWorkspaceClaim({ repository, worktree: root, branch, owner: "fixture-holder" }, async () => {
      process.send({ status: "held" })
      await new Promise(resolve => process.once("message", resolve))
    })
    process.send({ status: "released" })
  } else {
    const input = JSON.parse(await fs.readFile(`${root}.input.json`, "utf8"))
    const result = mode === "server"
      ? await callTool({ deskRoot: root, name: "desk_save", input })
      : await desk_save({
        deskRoot: root, input, schedulePush() {},
        ...(mode === "hold-save" ? { writeContext: { async validate() {
          process.send({ status: "held" })
          await new Promise(resolve => process.once("message", resolve))
        } } } : {}),
      })
    process.send({ result })
  }
} catch (error) {
  process.send({ error: error.message })
} finally {
  process.disconnect()
}
