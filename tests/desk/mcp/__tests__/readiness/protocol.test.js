import { test } from "node:test"
import assert from "node:assert/strict"
import { requestMessage, responseMessage } from "../../../../../plugins/desk/mcp/src/readiness/protocol.js"

test("a request carries its parameters, or an empty object when it has none", () => {
  assert.deepEqual(requestMessage({ id: 1, method: "ping" }), { type: "request", id: 1, method: "ping", params: {} })
  assert.deepEqual(requestMessage({ id: 2, method: "state", params: { a: 1 } }), { type: "request", id: 2, method: "state", params: { a: 1 } })
})

test("a response carries its result, or its error when it has one", () => {
  assert.deepEqual(responseMessage({ id: 1, result: "ok" }), { type: "response", id: 1, result: "ok" })
  assert.deepEqual(responseMessage({ id: 2, error: { code: "x" } }), { type: "response", id: 2, error: { code: "x" } })
})
