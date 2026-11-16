// Node 24 and 26.8+ overflow the heap on a synchronous read of a pipe that returns short reads (nodejs/node#66341), so no tool reads stdin synchronously.
import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { spawn, execFileSync } from "node:child_process"
import { mkTempRoot } from "../_temp_roots.js"
import { recordCopilotSession } from "../../../../../plugins/desk/mcp/src/runtime/copilot-session.js"

const root = fileURLToPath(new URL("../../../../../", import.meta.url))
const sessionId = "11111111-1111-4111-8111-111111111111"

test("the intake hook reads a prompt that arrives in small, delayed chunks", async () => {
  const cwd = await mkTempRoot("no-sync-stdin-")
  const env = { ...process.env, XDG_STATE_HOME: path.join(cwd, "state") }
  assert.equal(recordCopilotSession({ sessionId, folder: cwd, env }), true)
  const payload = JSON.stringify({
    sessionId, timestamp: 1792283246000, cwd, toolName: "skill", toolArgs: { skill: "brainstorming" },
    toolResult: { resultType: "success", textResultForLlm: 'Skill "brainstorming" loaded successfully. Follow the instructions in the skill context.' },
  })
  const child = spawn(process.execPath, [path.join(root, "plugins/desk/hooks/copilot-intake-context.cjs")], { cwd, env })
  let stdout = "", stderr = ""
  child.stdout.on("data", chunk => { stdout += chunk })
  child.stderr.on("data", chunk => { stderr += chunk })
  const closed = new Promise(resolve => child.on("close", resolve))
  for (let at = 0; at < payload.length; at += 40) {
    child.stdin.write(payload.slice(at, at + 40))
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  child.stdin.end()
  assert.equal(await closed, 0, stderr)
  assert.equal(stderr, "")
  assert.match(JSON.parse(stdout).additionalContext, /Desk intake handoff/u)
})

test("no source file reads stdin synchronously", () => {
  const pattern = /\b(?:readFileSync|readSync|openSync)\(\s*(?:0\b|process\.stdin\.fd|["']\/dev\/stdin["'])/u
  const files = execFileSync("git", ["ls-files", "*.js", "*.cjs", "*.mjs", "*.ts"], { cwd: root, encoding: "utf8" }).split("\n").filter(Boolean)
  const offenders = files.filter(file => pattern.test(readFileSync(path.join(root, file), "utf8")))
  assert.deepEqual(offenders, [], "read stdin asynchronously: collect chunks from process.stdin (nodejs/node#66341)")
})
