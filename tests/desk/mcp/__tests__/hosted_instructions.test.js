// Hosted Desk's first contact: the MCP instructions that stand in for session start, and the desk sync that starts after the handshake.

import { test } from "node:test"
import { strict as assert } from "node:assert"
import { spawnSync } from "node:child_process"
import { EventEmitter } from "node:events"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { PassThrough } from "node:stream"
import * as path from "node:path"
import { main } from "../../../../plugins/desk/mcp/index.js"
import { startFrontDoor } from "../../../../plugins/desk/mcp/src/runtime/front-door.js"
import {
  HOSTED_SHELL_SKILLS,
  HOSTED_UNAVAILABLE,
  HOSTED_UNAVAILABLE_REPAIRS,
  hostedInstructions,
} from "../../../../plugins/desk/mcp/src/runtime/hosted.js"
import { syncStatusPath } from "../../../../plugins/desk/mcp/src/runtime/sync-worker.js"
import { mkTempRoot } from "./_temp_roots.js"
import { osEnv } from "./_os_env.js"

const SYNC_SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../plugins/desk/mcp/scripts/session-sync.js")
const DESK_STATUS_LINE = "Start by calling desk_status: it is this session's startup status block."

function collect(output) {
  const lines = []
  let buffered = ""
  output.on("data", (chunk) => {
    buffered += chunk.toString("utf8")
    let newline
    while ((newline = buffered.indexOf("\n")) >= 0) {
      lines.push(JSON.parse(buffered.slice(0, newline)))
      buffered = buffered.slice(newline + 1)
    }
  })
  return lines
}

const send = (input, message) => input.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`)
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function scratchDesk({ agents = "# Desk Instructions\n\nThe harbor master logs every ferry.\n" } = {}) {
  const root = await mkTempRoot("desk-hosted-instructions-")
  const desk = path.join(root, "desk")
  const pluginRoot = path.join(root, "plugin")
  mkdirSync(desk)
  mkdirSync(path.join(pluginRoot, "skills", "using-desk"), { recursive: true })
  writeFileSync(path.join(pluginRoot, "skills", "using-desk", "SKILL.md"), "---\nname: using-desk\ndescription: \"foundation\"\n---\n\n# Using Desk\n\n## Human and agent\n\nThe human supplies intent.\n")
  if (agents !== null) writeFileSync(path.join(desk, "AGENTS.md"), agents)
  return { root, desk, pluginRoot }
}

test("the front door puts instructions in the initialize result only when given a non-empty string", async () => {
  for (const [instructions, expected] of [["X", "X"], [undefined, undefined], ["", undefined]]) {
    const input = new PassThrough()
    const output = new PassThrough()
    const lines = collect(output)
    const door = startFrontDoor({ input, output, callTool: () => ({}), instructions })
    send(input, { id: 1, method: "initialize", params: {} })
    input.end()
    await door.closed
    assert.equal(lines[0].result.instructions, expected)
    if (expected === undefined) assert.equal(Object.hasOwn(lines[0].result, "instructions"), false)
  }
})

test("hostedInstructions: the foundation without frontmatter, the desk's AGENTS.md, every hosted refusal and the desk_status line", async () => {
  const { desk, pluginRoot } = await scratchDesk()
  const text = hostedInstructions({ root: desk, pluginRoot })
  assert.equal(typeof text, "string")
  assert.match(text, /^# Using Desk$/mu)
  assert.doesNotMatch(text, /^name: using-desk$/mu, "frontmatter is stripped")
  assert.match(text, /The harbor master logs every ferry\./u)
  assert.ok(text.indexOf("# Using Desk") < text.indexOf("The harbor master"), "the foundation comes before AGENTS.md")
  for (const [name, reason] of [...Object.entries(HOSTED_UNAVAILABLE), ...Object.entries(HOSTED_UNAVAILABLE_REPAIRS), ...Object.entries(HOSTED_SHELL_SKILLS)]) {
    assert.ok(text.includes(name), `names ${name}`)
    assert.ok(text.includes(reason), `gives the reason for ${name}`)
  }
  const hostedSection = text.slice(text.indexOf("# Hosted Desk"))
  assert.match(hostedSection, /^# Hosted Desk$/mu)
  assert.match(hostedSection, /Skip session-start \(session boot\) and the skills listed below/u, "the hosted section itself says what to skip")
  assert.match(hostedSection, /call desk_status first/u)
  assert.match(hostedSection, /work through the Desk tools/u)
  assert.ok(text.trimEnd().endsWith(DESK_STATUS_LINE), "ends with the desk_status line")
})

test("hostedInstructions skips a missing AGENTS.md, a missing foundation or a missing root, never failing", async () => {
  const { desk, pluginRoot, root } = await scratchDesk({ agents: null })
  const withoutAgents = hostedInstructions({ root: desk, pluginRoot })
  assert.match(withoutAgents, /^# Using Desk$/mu)
  assert.ok(withoutAgents.trimEnd().endsWith(DESK_STATUS_LINE))
  const bare = hostedInstructions({ root: null, pluginRoot: path.join(root, "nowhere") })
  assert.doesNotMatch(bare, /Using Desk\n/u)
  assert.ok(bare.includes("improvement_next"))
  assert.ok(bare.trimEnd().endsWith(DESK_STATUS_LINE))
})

test("hostedInstructions leaves out an AGENTS.md it cannot read, and takes no paths at all", async () => {
  const { desk, pluginRoot } = await scratchDesk({ agents: null })
  mkdirSync(path.join(desk, "AGENTS.md"))
  const text = hostedInstructions({ root: desk, pluginRoot })
  assert.doesNotMatch(text, /This desk's AGENTS\.md/u)
  assert.match(text, /^# Using Desk$/mu)
  const none = hostedInstructions({})
  assert.match(none, /^# Hosted Desk$/mu)
  assert.ok(none.trimEnd().endsWith(DESK_STATUS_LINE))
})

test("hostedInstructions cuts an AGENTS.md with no line break inside the cap at a character boundary", async () => {
  // 16383 ASCII bytes then a 3-byte character straddles the 16 KiB cap.
  const { desk, pluginRoot } = await scratchDesk({ agents: `${"a".repeat(16 * 1024 - 1)}\u2603${"b".repeat(100)}` })
  const text = hostedInstructions({ root: desk, pluginRoot })
  assert.ok(text.includes(`${"a".repeat(16 * 1024 - 1)}\n`), "the cut falls before the character that crosses the cap")
  assert.doesNotMatch(text, /\u2603|\ufffd|b{100}/u)
})

test("hostedInstructions caps AGENTS.md at 16 KiB, cut at a line break", async () => {
  const line = "Every ferry is logged at the harbor.\n"
  const { desk, pluginRoot } = await scratchDesk({ agents: `${line.repeat(Math.ceil((20 * 1024) / line.length))}TAIL-MARKER\n` })
  const text = hostedInstructions({ root: desk, pluginRoot })
  assert.doesNotMatch(text, /TAIL-MARKER/u)
  assert.ok(text.includes(path.join(desk, "AGENTS.md")), "names the file the rest stays in")
})

function startHosted({ desk, pluginRoot, env = { DESK_HOSTED: "1" }, admissionKickoffMs = 60000 }) {
  const input = new PassThrough()
  const output = new PassThrough()
  const lines = collect(output)
  const syncs = []
  const started = main({
    argv: ["--root", desk],
    env: { DESK_PLUGIN_ROOT: pluginRoot, ...env },
    cwd: desk,
    homeDir: desk,
    stateHome: path.join(desk, "..", "state"),
    input,
    output,
    stderr: { write() { return true } },
    admissionKickoffMs,
    runtimeInspector: null,
    runtimeImporter: async () => ({ connectOrStartController: async () => ({ accepted: true }) }),
    spawnDetached: (command, args, options) => {
      syncs.push({ command, args, options })
      return Object.assign(new EventEmitter(), { unref() { syncs.at(-1).unrefed = true } })
    },
  })
  return { input, lines, syncs, started }
}

test("in hosted mode, main answers initialize with the hosted instructions at once and syncs the desk once, after the first tools/list", async () => {
  const { desk, pluginRoot } = await scratchDesk()
  const { input, lines, syncs, started } = startHosted({ desk, pluginRoot, admissionKickoffMs: 0 })
  const handle = await started
  send(input, { id: 1, method: "initialize", params: {} })
  await wait(20)
  assert.match(lines[0].result.instructions, /The harbor master logs every ferry\./u)
  assert.deepEqual(syncs, [], "admission's own kickoff never starts the sync; only the first tools/list does")
  send(input, { method: "notifications/initialized" })
  send(input, { id: 2, method: "tools/list" })
  send(input, { id: 3, method: "tools/list" })
  await wait(20)
  assert.equal(syncs.length, 1)
  assert.equal(syncs[0].command, process.execPath)
  assert.deepEqual(syncs[0].args, [SYNC_SCRIPT, "--root", desk], "Desk's own session-sync CLI, with --root")
  assert.equal(syncs[0].options.detached, true)
  assert.equal(syncs[0].options.stdio, "ignore")
  assert.equal(syncs[0].options.env.DESK_HOSTED, "1", "the child gets the server's environment")
  assert.equal(syncs[0].unrefed, true, "the sync never keeps the server alive")
  input.end()
  await handle.closed
})

for (const [label, spawnDetached] of [
  ["a spawn that throws", () => { throw new Error("spawn EAGAIN") }],
  ["a child that fails to start", () => {
    const child = Object.assign(new EventEmitter(), { unref() {} })
    setImmediate(() => child.emit("error", new Error("spawn EAGAIN")))
    return child
  }],
]) test(`${label} is reported on stderr and never ends the session`, async () => {
  const { desk, pluginRoot } = await scratchDesk()
  const input = new PassThrough()
  const output = new PassThrough()
  const lines = collect(output)
  const errors = []
  const handle = await main({
    argv: ["--root", desk],
    env: { DESK_PLUGIN_ROOT: pluginRoot, DESK_HOSTED: "1" },
    cwd: desk,
    homeDir: desk,
    stateHome: path.join(desk, "..", "state"),
    input,
    output,
    stderr: { write(text) { errors.push(text); return true } },
    admissionKickoffMs: 60000,
    runtimeInspector: null,
    runtimeImporter: async () => ({ connectOrStartController: async () => ({ accepted: true }) }),
    spawnDetached,
  })
  send(input, { id: 1, method: "tools/list" })
  await wait(20)
  send(input, { id: 2, method: "ping" })
  await wait(20)
  assert.deepEqual(lines[1].result, {})
  assert.ok(errors.some((text) => text.includes("hosted desk sync failed to start: spawn EAGAIN")))
  input.end()
  await handle.closed
})

test("without DESK_HOSTED, main sends no instructions and never syncs", async () => {
  const { desk, pluginRoot } = await scratchDesk()
  const { input, lines, syncs, started } = startHosted({ desk, pluginRoot, env: {} })
  const handle = await started
  send(input, { id: 1, method: "initialize", params: {} })
  send(input, { id: 2, method: "tools/list" })
  await wait(20)
  assert.equal(Object.hasOwn(lines[0].result, "instructions"), false)
  assert.deepEqual(syncs, [])
  input.end()
  await handle.closed
})

test("a hosted session started without --root sends instructions without AGENTS.md and does not sync", async () => {
  const { desk, pluginRoot } = await scratchDesk()
  const input = new PassThrough()
  const output = new PassThrough()
  const lines = collect(output)
  const syncs = []
  const handle = await main({
    argv: [],
    env: { DESK_PLUGIN_ROOT: pluginRoot, DESK_HOSTED: "1" },
    cwd: desk,
    homeDir: desk,
    stateHome: path.join(desk, "..", "state"),
    input,
    output,
    stderr: { write() { return true } },
    admissionKickoffMs: 60000,
    runtimeInspector: null,
    runtimeImporter: async () => assert.fail("not reached"),
    spawnDetached: (...call) => { syncs.push(call) },
  })
  send(input, { id: 1, method: "initialize", params: {} })
  send(input, { id: 2, method: "tools/list" })
  await wait(20)
  assert.match(lines[0].result.instructions, /^# Using Desk$/mu)
  assert.doesNotMatch(lines[0].result.instructions, /This desk's AGENTS\.md/u)
  assert.deepEqual(syncs, [])
  input.end()
  await handle.closed
})

test("by default a hosted session runs Desk's own session-sync CLI after the handshake", async () => {
  const { root, desk, pluginRoot } = await scratchDesk()
  assert.equal(spawnSync("git", ["init", "-q", desk]).status, 0)
  const env = osEnv({ DESK_PLUGIN_ROOT: pluginRoot, DESK_HOSTED: "1", HOME: root, XDG_STATE_HOME: path.join(root, "xdg-state") })
  const input = new PassThrough()
  const output = new PassThrough()
  const handle = await main({
    argv: ["--root", desk],
    env,
    cwd: desk,
    homeDir: root,
    stateHome: path.join(root, "state"),
    input,
    output,
    stderr: { write() { return true } },
    admissionKickoffMs: 60000,
    runtimeInspector: null,
    runtimeImporter: async () => ({ connectOrStartController: async () => ({ accepted: true }) }),
  })
  const status = syncStatusPath({ root: desk, env })
  send(input, { id: 1, method: "tools/list" })
  const deadline = Date.now() + 10000
  while (!existsSync(status) && Date.now() < deadline) await wait(10)
  assert.equal(existsSync(status), true, "the sync recorded its outcome for desk_status")
  input.end()
  await handle.closed
})
