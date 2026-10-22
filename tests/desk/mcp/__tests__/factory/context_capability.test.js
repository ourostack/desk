import { test } from "node:test"
import assert from "node:assert/strict"
import { storeAcceptsContext } from "../../../../../plugins/desk/mcp/src/factory/context-capability.js"

const response = (text) => ({ status: 200, json: { type: "file", encoding: "base64", content: Buffer.from(text).toString("base64") } })
const client = (value) => ({ api: async () => value })

test("context capability requires a bounded regular JSON file with an exact supported declaration", async () => {
  for (const value of [
    { status: 404 },
    { status: 200 },
    { status: 200, json: { type: "dir" } },
    { status: 200, json: { type: "file", encoding: "utf8", content: "{}" } },
    { status: 200, json: { type: "file", encoding: "base64", content: null } },
    response(" ".repeat(1025)),
    response("{"),
    response("null"),
    response("[]"),
    response("1"),
    response("{}"),
    response('{"task_context":0}'),
    response('{"task_context":1,"extra":1}'),
    response('{"task_context":1,"loop_context":0}'),
  ]) assert.equal(await storeAcceptsContext(client(value), "synthetic/store", "main"), false)
  assert.equal(await storeAcceptsContext(client(response('{"task_context":1}')), "synthetic/store", "main"), true)
})

test("loop metadata is a separate capability and cannot be inferred from task prose support", async () => {
  assert.equal(await storeAcceptsContext(client(response('{"task_context":1}')), "synthetic/store", "main", "loop_context"), false)
  const both = client(response('{"task_context":1,"loop_context":1}'))
  assert.equal(await storeAcceptsContext(both, "synthetic/store", "main"), true)
  assert.equal(await storeAcceptsContext(both, "synthetic/store", "main", "loop_context"), true)
  assert.equal(await storeAcceptsContext(client(response('{"loop_context":1}')), "synthetic/store", "main", "loop_context"), false)
})

test("capability transport failures remain errors and unsupported features never make a request", async () => {
  const failed = { api: async () => { throw new Error("transport_failed") } }
  await assert.rejects(storeAcceptsContext(failed, "synthetic/store", "main"), /transport_failed/u)
  await assert.rejects(storeAcceptsContext({ api: () => assert.fail("unsupported feature must not reach transport") },
    "synthetic/store", "main", "other"), /unsupported context capability/u)
  await storeAcceptsContext({ api: async (method, url) => {
    assert.equal(method, "GET")
    assert.equal(url, "repos/synthetic/store/contents/context.json?ref=refs%2Fheads%2Frelease")
    return response('{"task_context":1}')
  } }, "synthetic/store", "refs/heads/release")
})
