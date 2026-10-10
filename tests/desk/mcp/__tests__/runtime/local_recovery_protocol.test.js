import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdirSync, writeFileSync, symlinkSync, readFileSync, realpathSync } from "node:fs"
import { PassThrough } from "node:stream"
import { EventEmitter } from "node:events"
import * as path from "node:path"
import { runRecovery, launchBootstrap } from "../../../../../plugins/desk/mcp/scripts/local-recovery.js"

const fixturePath = path.resolve(process.env.TMPDIR ?? ".local-recovery-evidence/scratch", `recovery-protocol-${process.pid}`)
mkdirSync(fixturePath, { recursive: true })
const root = realpathSync(fixturePath)
const base = ["--root", root, "--operation", "task_update"]
const status = () => ({
  state: "ready", root: { valid: true, path: root },
  write_scope: { mode: "workspace", person: null, relative_path: "." },
  sync: "no remote configured",
})
function stream(text = "{}") {
  const input = new PassThrough()
  input.end(text)
  return input
}
function mockTransport(answer = () => ({ status: "updated" })) {
  const sent = []
  const launch = async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    input.on("data", (chunk) => {
      const request = JSON.parse(chunk.toString())
      sent.push(request)
      if (request.id === undefined) return
      let result
      if (request.method === "initialize") result = { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "fixture", version: "1" } }
      if (request.method === "tools/list") result = { tools: [{ name: "task_update" }] }
      if (request.params?.name === "desk_status") result = { content: [{ type: "text", text: JSON.stringify(status()) }] }
      if (request.params?.name === "task_update") result = { content: [{ type: "text", text: JSON.stringify(answer()) }] }
      output.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\n")
    })
    return { input, output, close: async () => input.end() }
  }
  return { sent, launch }
}
function recovery(options = {}) {
  return runRecovery({ argv: base, cwd: root, env: {}, input: stream(), timeoutMs: 1000, ...options })
}

test("split UTF-8 stdin preserves exact payload bytes before dispatch", async () => {
  const privateValue = "PRIVATE_caf\u00e9_PAYLOAD"
  const bytes = Buffer.from(JSON.stringify({ note: privateValue }))
  const split = bytes.indexOf(Buffer.from("\u00e9")) + 1
  const input = new PassThrough()
  input.write(bytes.subarray(0, split))
  setImmediate(() => input.end(bytes.subarray(split)))
  const transport = mockTransport(() => ({ status: "nothing_to_commit" }))
  const result = await recovery({ input, launch: transport.launch })
  const call = transport.sent.find((request) => request.params?.name === "task_update")
  assert.equal(call.params.arguments.note, privateValue)
  assert.equal(result.exitCode, 0)
})

test("split UTF-8 MCP frames preserve exact private strings for input redaction", async () => {
  const privateValue = "PRIVATE_caf\u00e9_PAYLOAD"
  const transport = mockTransport(() => ({ status: "nothing_to_commit", note: privateValue }))
  const launch = async () => {
    const connection = await transport.launch()
    const write = connection.output.write.bind(connection.output)
    connection.output.write = (chunk) => {
      const bytes = Buffer.from(chunk)
      const index = bytes.indexOf(Buffer.from("\u00e9"))
      if (index === -1) return write(bytes)
      write(bytes.subarray(0, index + 1))
      setImmediate(() => write(bytes.subarray(index + 1)))
      return true
    }
    return connection
  }
  const result = await recovery({ input: stream(JSON.stringify({ note: privateValue })), launch })
  assert.equal(result.exitCode, 0)
  assert.equal(result.report.result.note, "[input redacted]")
  assert.doesNotMatch(JSON.stringify(result.report), /PRIVATE_/u)
})

for (const bytes of [Buffer.from([0xff]), Buffer.from([0xc3])]) {
  test(`invalid or incomplete UTF-8 input refuses before launch: ${bytes.toString("hex")}`, async () => {
    const input = new PassThrough()
    input.end(bytes)
    const result = await recovery({ input, launch: async () => assert.fail("no launch") })
    assert.equal(result.report.code, "invalid_utf8")
    assert.equal(result.report.effects.mutation, "not_dispatched")
  })
}

for (const bytes of [Buffer.from([0xff]), Buffer.from([0xc3])]) {
  test(`invalid or incomplete UTF-8 protocol refuses before dispatch: ${bytes.toString("hex")}`, async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    input.on("data", () => output.end(bytes))
    const result = await recovery({ launch: async () => ({
      input, output, close: async () => input.end(),
    }) })
    assert.equal(result.report.code, "protocol_parse_error")
    assert.equal(result.report.effects.mutation, "not_dispatched")
  })
}

for (const argv of [
  [], ["--root"], ["--root", root], [...base, "--operation", "task_create"],
  ["--root", root, "--operation", "task_signoff"], [...base, "--override", "yes"],
  [...base, "--person", "--root"], [...base, "--person", ""],
]) {
  test(`argument refusal has no dispatch: ${JSON.stringify(argv)}`, async () => {
    const result = await recovery({ argv, launch: async () => assert.fail("must not launch") })
    assert.equal(result.report.code, "invalid_arguments")
    assert.equal(result.exitCode, 1)
  })
}

test("explicit root that is a file is unavailable", async () => {
  const file = path.join(root, "not-a-directory")
  writeFileSync(file, "")
  const result = await recovery({ argv: ["--root", file, "--operation", "task_update"] })
  assert.equal(result.report.code, "root_unavailable")
})

for (const text of ["null", "[]", '"PRIVATE_JSON_SENTINEL"', "{bad", "x".repeat(1024 * 1024 + 1)]) {
  test(`stdin parse or size refusal never launches (${text.length} bytes)`, async () => {
    const result = await recovery({ input: stream(text), launch: async () => assert.fail("no launch") })
    assert.ok(["invalid_json", "input_too_large"].includes(result.report.code))
    assert.equal(result.report.effects.mutation, "not_dispatched")
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_JSON_SENTINEL/u)
  })
}

test("input-file loads JSON without exposing the contents in child argv", async () => {
  const file = path.join(root, "payload.json")
  writeFileSync(file, '{"note":"PRIVATE_FILE_SENTINEL"}')
  const fixture = mockTransport()
  const result = await recovery({
    argv: [...base, "--input-file", file],
    input: stream("not used"),
    launch: async (options) => {
      assert.doesNotMatch(JSON.stringify(options.argv), /PRIVATE_FILE_SENTINEL/u)
      return fixture.launch(options)
    },
  })
  assert.equal(fixture.sent.filter((request) => request.params?.name === "task_update").length, 1)
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_FILE_SENTINEL/u)
})

for (const [name, setup] of [
  ["missing", () => path.join(root, "missing.json")],
  ["large", () => { const file = path.join(root, "large.json"); writeFileSync(file, " ".repeat(1024 * 1024 + 1)); return file }],
]) {
  test(`${name} input file refuses`, async () => {
    const result = await recovery({ argv: [...base, "--input-file", setup()] })
    assert.equal(result.report.code, "input_file_unavailable")
  })
}

test("commit override environment refuses rather than changing the environment", async () => {
  const env = { DESK_TOOL_COMMIT: "0" }
  const result = await recovery({ env, launch: async () => assert.fail("no launch") })
  assert.equal(result.report.code, "commit_override_refused")
  assert.deepEqual(env, { DESK_TOOL_COMMIT: "0" })
})

for (const [name, mutate, expected] of [
  ["root unavailable", (state) => { state.root.path = path.join(root, "absent") }, "actual_root_unavailable"],
  ["invalid root", (state) => { state.root.valid = false }, "actual_root_unavailable"],
  ["missing root", (state) => { state.root.path = null }, "actual_root_unavailable"],
  ["no scope", (state) => { delete state.write_scope }, "scope_mismatch"],
  ["unknown mode", (state) => { state.write_scope.mode = "anything" }, "scope_mismatch"],
  ["workspace person", (state) => { state.write_scope.person = "ari" }, "scope_mismatch"],
  ["workspace path", (state) => { state.write_scope.relative_path = "desks/ari" }, "scope_mismatch"],
  ["person path", (state) => { state.write_scope = { mode: "person", person: "ari", relative_path: "." } }, "scope_mismatch"],
  ["missing person", (state) => { state.write_scope = { mode: "person", person: null, relative_path: "desks/ari" } }, "scope_mismatch"],
  ["authority refused", (state) => { state.state = "degraded:authority_invalid" }, "admission_refused"],
]) {
  test(`${name} refuses before operation`, async () => {
    const fixture = mockTransport()
    const original = fixture.launch
    const result = await recovery({
      launch: async (options) => {
        const transport = await original(options)
        const write = transport.output.write.bind(transport.output)
        transport.output.write = (text) => {
          const message = JSON.parse(text)
          if (message.result?.content) {
            const state = JSON.parse(message.result.content[0].text)
            mutate(state)
            message.result.content[0].text = JSON.stringify(state)
          }
          return write(JSON.stringify(message) + "\n")
        }
        return transport
      },
    })
    assert.equal(result.report.code, expected)
    assert.equal(fixture.sent.some((request) => request.params?.name === "task_update"), false)
  })
}

for (const [name, wire, expected] of [
  ["malformed JSON", () => "PRIVATE_PARSE_SENTINEL\n", "protocol_parse_error"],
  ["protocol version", () => '{"jsonrpc":"1.0"}\n', "protocol_parse_error"],
  ["error response", (request) => JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { message: "PRIVATE_ERROR_SENTINEL" } }) + "\n", "protocol_error"],
  ["no result", (request) => JSON.stringify({ jsonrpc: "2.0", id: request.id }) + "\n", "protocol_parse_error"],
  ["oversized response", () => "x".repeat(4 * 1024 * 1024 + 1), "protocol_parse_error"],
]) {
  test(`${name} is a nonzero protocol failure without raw text`, async () => {
    const result = await recovery({
      launch: async () => {
        const input = new PassThrough()
        const output = new PassThrough()
        input.on("data", (text) => output.write(wire(JSON.parse(text.toString()))))
        return { input, output, close: async () => input.end() }
      },
    })
    assert.equal(result.report.code, expected)
    assert.equal(result.exitCode, 1)
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_/u)
  })
}

for (const value of [null, [], "PRIVATE_RESULT_SENTINEL"]) {
  test(`non-object tool payload (${JSON.stringify(value)}) is unknown, never successful`, async () => {
    const fixture = mockTransport(() => value)
    const result = await recovery({ launch: fixture.launch })
    assert.equal(result.report.code, "tool_parse_error")
    assert.equal(result.report.effects.mutation, "unknown")
  })
}

test("unexpected tool status cannot become success", async () => {
  const fixture = mockTransport(() => ({ status: "degraded" }))
  const result = await recovery({ launch: fixture.launch })
  assert.equal(result.report.code, "unexpected_tool_result")
  assert.equal(result.exitCode, 2)
})

test("read-only admission polling does not retry the mutation", async () => {
  const fixture = mockTransport()
  const original = fixture.launch
  let statuses = 0
  const result = await recovery({
    launch: async (options) => {
      const transport = await original(options)
      const write = transport.output.write.bind(transport.output)
      transport.output.write = (text) => {
        const message = JSON.parse(text)
        if (message.result?.content && JSON.parse(message.result.content[0].text).state) {
          const state = JSON.parse(message.result.content[0].text)
          if (statuses++ === 0) { state.state = "admitting"; state.root.path = null }
          message.result.content[0].text = JSON.stringify(state)
        }
        return write("\n" + JSON.stringify({ jsonrpc: "2.0", method: "notifications/tools/list_changed" }) + "\n" + JSON.stringify(message) + "\n")
      }
      return transport
    },
  })
  assert.equal(result.report.actualRoot, root)
  assert.equal(statuses, 2)
  assert.equal(fixture.sent.filter((request) => request.params?.name === "task_update").length, 1)
})

test("symlink requested root resolves to the verified actual root", async () => {
  const link = path.join(root, "root-link")
  symlinkSync(root, link, process.platform === "win32" ? "junction" : "dir")
  const fixture = mockTransport()
  const result = await recovery({ argv: ["--root", link, "--operation", "task_update"], launch: fixture.launch })
  assert.equal(result.report.requestedRoot, root)
  assert.equal(result.report.actualRoot, root)
})

test("closing a session unsuccessfully cannot leave success-shaped completion", async () => {
  const fixture = mockTransport(() => ({ status: "nothing_to_commit" }))
  const result = await recovery({
    launch: async (options) => {
      const transport = await fixture.launch(options)
      transport.close = async () => { throw new Error("PRIVATE_SHUTDOWN_SENTINEL") }
      return transport
    },
  })
  assert.equal(result.report.code, "child_shutdown_unknown")
  assert.equal(result.exitCode, 2)
  assert.equal(result.report.transport.shutdown, "unknown")
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_/u)
})

test("bootstrap spawn failure is an explicit closed transport", async () => {
  const result = await recovery({
    launch: (options) => launchBootstrap({ ...options, cwd: path.join(root, "missing-cwd") }),
  })
  assert.ok(["transport_error", "transport_closed"].includes(result.report.code))
  assert.equal(result.exitCode, 1)
})

test("nested arrays and escaped payload values are redacted", async () => {
  const secret = 'PRIVATE_NESTED_"SENTINEL'
  const fixture = mockTransport(() => ({ status: "error", message: JSON.stringify({ secret }), nested: [secret, 1, null] }))
  const result = await recovery({ input: stream(JSON.stringify({ nested: [{ secret }] })), launch: fixture.launch })
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_NESTED/u)
})

test("ready cached status is read again before mutation, not treated as fresh authority", async () => {
  const fixture = mockTransport()
  let reads = 0
  const result = await recovery({
    launch: async (options) => {
      const transport = await fixture.launch(options)
      const write = transport.output.write.bind(transport.output)
      transport.output.write = (text) => {
        const message = JSON.parse(text)
        if (message.result?.content && JSON.parse(message.result.content[0].text).state) {
          const state = JSON.parse(message.result.content[0].text)
          if (reads++ === 0) {
            state.root.path = null
            state.detail_pending = true
            state.status_detail = "unavailable: status computation pending"
          }
          message.result.content[0].text = JSON.stringify(state)
        }
        return write(JSON.stringify(message) + "\n")
      }
      return transport
    },
  })
  assert.equal(result.report.actualRoot, root)
  assert.equal(reads, 2)
  assert.equal(fixture.sent.filter((request) => request.params?.name === "task_update").length, 1)
})

test("recovery reference documents the maintained command, refusal and five-field reporting boundary", () => {
  const readme = readFileSync(new URL("../../../../../plugins/desk/mcp/README.md", import.meta.url), "utf8")
  const skill = readFileSync(new URL("../../../../../plugins/desk/skills/desk-problem/SKILL.md", import.meta.url), "utf8")
  for (const text of [readme, skill]) {
    assert.match(text, /node .*scripts\/local-recovery\.js/u)
    assert.match(text, /confirmed .*mismatch/iu)
    assert.match(text, /permission.*validation.*missing.card/iu)
    assert.match(text, /unknown/iu)
  }
  assert.match(readme, /push_pending/u)
  assert.match(skill, /broke.*means.*fix.*file.*tell/u)
})

for (const old of [true, false]) {
  test(`${old ? "old" : "owned-session"} cached detail ${old ? "refuses" : "remains usable under load"}`, async () => {
    const fixture = mockTransport()
    const result = await recovery({
      launch: async (options) => {
        const transport = await fixture.launch(options)
        const write = transport.output.write.bind(transport.output)
        transport.output.write = (text) => {
          const message = JSON.parse(text)
          if (message.result?.content && JSON.parse(message.result.content[0].text).state) {
            const state = JSON.parse(message.result.content[0].text)
            state.status_detail = "cached: this computation was already running"
            state.status_detail_from = new Date(old ? 0 : Date.now()).toISOString()
            message.result.content[0].text = JSON.stringify(state)
          }
          return write(JSON.stringify(message) + "\n")
        }
        return transport
      },
    })
    if (old) {
      assert.equal(result.report.code, "status_stale")
      assert.equal(fixture.sent.some((request) => request.params?.name === "task_update"), false)
    } else {
      assert.equal(result.report.preflight.statusDetail, "cached_in_owned_session")
      assert.equal(fixture.sent.filter((request) => request.params?.name === "task_update").length, 1)
    }
  })
}

test("credential-shaped runtime error text is scrubbed even when not in the input", async () => {
  const fixture = mockTransport(() => ({ status: "error", message: "synthetic ghp_1234567890abcdefghijklmnopqrstuv" }))
  const result = await recovery({ launch: fixture.launch })
  assert.doesNotMatch(JSON.stringify(result), /ghp_/u)
})

test("default API arguments refuse without a requested operation", async () => {
  const result = await runRecovery()
  assert.equal(result.exitCode, 1)
  assert.equal(result.report.code, "invalid_arguments")
})

test("no Git observation is explicit partial state, not commit success", async () => {
  const fixture = mockTransport()
  const result = await recovery({ env: { PATH: "" }, launch: fixture.launch })
  assert.equal(result.report.effects.commit, "unknown")
  assert.equal(result.report.code, "commit_not_observed")
})

test("non-string input values are not echoed or reinterpreted", async () => {
  const fixture = mockTransport(() => ({ status: "nothing_to_commit", nested: [null, 1, false, { note: "" }] }))
  const result = await recovery({ input: stream('{"nested":[null,1,false,{"note":""}]}'), launch: fixture.launch })
  assert.equal(result.exitCode, 0)
  assert.equal(result.report.effects.mutation, "reported_complete")
})

for (const [name, modify, code] of [
  ["missing operation", (message) => { if (message.result?.tools) message.result.tools = [] }, "operation_unavailable"],
  ["status error", (message) => {
    if (message.result?.content) {
      const state = JSON.parse(message.result.content[0].text)
      state.status_error = "status calculation failed"
      message.result.content[0].text = JSON.stringify(state)
    }
  }, "status_unavailable"],
]) {
  test(`${name} never dispatches the mutation`, async () => {
    const fixture = mockTransport()
    const result = await recovery({
      launch: async (options) => {
        const transport = await fixture.launch(options)
        const write = transport.output.write.bind(transport.output)
        transport.output.write = (text) => { const message = JSON.parse(text); modify(message); return write(JSON.stringify(message) + "\n") }
        return transport
      },
    })
    assert.equal(result.report.code, code)
    assert.equal(fixture.sent.some((request) => request.params?.name === "task_update"), false)
  })
}

test("malformed activation cannot justify a state-branch override", async () => {
  const config = path.join(root, "broken-activation.json")
  writeFileSync(config, "{bad")
  const result = await recovery({ argv: [...base, "--activation-config", config, "--state-branch", "main"] })
  assert.equal(result.report.code, "activation_unavailable")
})

test("person argument must match the runtime-reported scope", async () => {
  const fixture = mockTransport()
  const result = await recovery({ argv: [...base, "--person", "ari"], launch: fixture.launch })
  assert.equal(result.report.code, "scope_mismatch")
})

for (const unknown of [false, true]) {
  test(`owned child shutdown ${unknown ? "reports retention" : "uses its exact child handle"}`, async () => {
    const child = new EventEmitter()
    child.stdin = new PassThrough()
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.pid = 12345
    const signals = []
    child.kill = (signal) => {
      signals.push(signal)
      if (!unknown) child.emit("exit", 0)
    }
    const transport = launchBootstrap({
      argv: ["--onboarding", "desk:first-run"], env: process.env, cwd: root,
      spawnChild: () => child, shutdownMs: 1,
    })
    try {
      if (unknown) await assert.rejects(transport.close(), (error) => error.code === "child_shutdown_unknown")
      else await transport.close()
      assert.deepEqual(signals, ["SIGTERM"])
      assert.equal(transport.pid, 12345)
    } finally {
      child.stdin.destroy()
      child.stdout.destroy()
      child.stderr.destroy()
    }
  })
}

for (const boundary of ["input", "output", "end"]) {
  test(`${boundary} transport loss is explicit before mutation`, async () => {
    const result = await recovery({
      launch: async () => {
        const input = new PassThrough()
        const output = new PassThrough()
        input.once("data", () => {
          if (boundary === "end") output.end()
          else (boundary === "input" ? input : output).emit("error", new Error("synthetic loss"))
        })
        return { input, output, close: async () => input.end() }
      },
    })
    assert.equal(result.report.code, boundary === "end" ? "transport_closed" : "transport_error")
    assert.equal(result.report.effects.mutation, "not_dispatched")
    assert.equal(result.report.transport.shutdown, "closed")
  })
}

test("split protocol frames and non-text content remain standard MCP", async () => {
  const fixture = mockTransport(() => ({ status: "nothing_to_commit" }))
  const result = await recovery({
    launch: async (options) => {
      const transport = await fixture.launch(options)
      const write = transport.output.write.bind(transport.output)
      transport.output.write = (text) => {
        const message = JSON.parse(text)
        if (message.result?.content) message.result.content.unshift({ type: "image", data: "ignored" })
        const wire = JSON.stringify(message) + "\n"
        write(wire.slice(0, 4))
        return write(wire.slice(4))
      }
      return transport
    },
  })
  assert.equal(result.exitCode, 0)
})

test("tool result with no textual JSON is unknown after dispatch", async () => {
  const fixture = mockTransport()
  const result = await recovery({
    launch: async (options) => {
      const transport = await fixture.launch(options)
      const write = transport.output.write.bind(transport.output)
      transport.output.write = (text) => {
        const message = JSON.parse(text)
        if (message.result?.content && JSON.parse(message.result.content[0].text).status) {
          message.result.content = [{ type: "image", data: "ignored" }]
        }
        return write(JSON.stringify(message) + "\n")
      }
      return transport
    },
  })
  assert.equal(result.report.code, "tool_parse_error")
  assert.equal(result.report.effects.mutation, "unknown")
})

test("plain launch exceptions remain a generic recovery error", async () => {
  const result = await recovery({ launch: async () => { throw new Error("synthetic failure") } })
  assert.equal(result.report.code, "recovery_error")
})

test("shutdown failure before dispatch preserves non-dispatched effects", async () => {
  const fixture = mockTransport()
  const result = await recovery({
    launch: async (options) => {
      const transport = await fixture.launch(options)
      const write = transport.output.write.bind(transport.output)
      transport.output.write = (text) => {
        const message = JSON.parse(text)
        if (message.result?.tools) message.result.tools = []
        return write(JSON.stringify(message) + "\n")
      }
      transport.close = async () => { throw new Error("synthetic retention") }
      return transport
    },
  })
  assert.equal(result.exitCode, 1)
  assert.equal(result.report.code, "child_shutdown_unknown")
  assert.equal(result.report.effects.mutation, "not_dispatched")
})

test("zero budget never sends a protocol request or mutation", async () => {
  const fixture = mockTransport()
  const result = await recovery({ timeoutMs: 0, launch: fixture.launch })
  assert.equal(result.report.code, "timeout")
  assert.equal(fixture.sent.length, 0)
})

test("a cached pre-admission scope is read again without overriding person authority", async () => {
  const fixture = mockTransport()
  let reads = 0
  const result = await recovery({
    argv: [...base, "--person", "ari"],
    launch: async (options) => {
      const transport = await fixture.launch(options)
      const write = transport.output.write.bind(transport.output)
      transport.output.write = (text) => {
        const message = JSON.parse(text)
        if (message.result?.content && JSON.parse(message.result.content[0].text).state) {
          const state = JSON.parse(message.result.content[0].text)
          if (reads++ === 0) {
            state.status_detail = "cached: scope from pending admission"
            state.status_detail_from = new Date().toISOString()
          } else state.write_scope = { mode: "person", person: "ari", relative_path: "desks/ari" }
          message.result.content[0].text = JSON.stringify(state)
        }
        return write(JSON.stringify(message) + "\n")
      }
      return transport
    },
  })
  assert.equal(result.report.preflight?.writeScope.person, "ari")
  assert.equal(reads, 2)
  assert.equal(fixture.sent.filter((request) => request.params?.name === "task_update").length, 1)
})

test("a transport that breaks after handshake cannot send initialized or mutate", async () => {
  const result = await recovery({
    launch: async () => {
      const input = new PassThrough()
      const output = new PassThrough()
      input.once("data", (text) => {
        const request = JSON.parse(text.toString())
        output.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: {} }) + "\nmalformed\n")
      })
      return { input, output, close: async () => input.end() }
    },
  })
  assert.equal(result.report.code, "protocol_parse_error")
  assert.equal(result.report.effects.mutation, "not_dispatched")
})

test("a synchronous transport write failure clears its request without mutation", async () => {
  const result = await recovery({
    launch: async () => {
      const input = new PassThrough()
      const output = new PassThrough()
      input.write = () => { throw new Error("synthetic write failure") }
      return { input, output, close: async () => input.end() }
    },
  })
  assert.equal(result.report.code, "recovery_error")
  assert.equal(result.report.effects.mutation, "not_dispatched")
})
