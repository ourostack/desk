import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import express from "express";
import { createRelay } from "../src/relay.js";

const FIXTURE = fileURLToPath(new URL("./fixtures/echo-desk.js", import.meta.url));
const PROTOCOL = "2025-06-18";

// Starts a relay behind Express with a fixture Desk child per session. The
// test's token login comes from the x-test-login header (default arimendelow).
// spawnDesk is async, as the gateway's is.
// `beforeSpawn(auth)`, when given, runs (and may delay or fail) before each
// child starts, the way the gateway fetches a token first.
async function start(t, { beforeSpawn, ...options } = {}) {
  const children = [];
  const spawned = [];
  const relay = createRelay({
    ...options,
    async spawnDesk({ auth, sessionId }) {
      await beforeSpawn?.(auth);
      const login = auth.extra.login;
      const child = spawn(process.execPath, [FIXTURE], { stdio: "pipe", env: { ...process.env, ECHO_LOGIN: login } });
      const closed = once(child, "close");
      children.push({ child, closed });
      spawned.push({ login, sessionId });
      return child;
    },
  });
  const app = express();
  app.all("/mcp", express.json(), (req, res) => {
    const login = req.get("x-test-login") ?? "arimendelow";
    return relay.handle(req, res, { token: "t", clientId: "c", scopes: [], extra: { login } });
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = `http://127.0.0.1:${server.address().port}/mcp`;
  t.after(async () => {
    await relay.close();
    server.closeAllConnections();
    server.close();
  });
  return { relay, url, children, spawned };
}

// POSTs one JSON-RPC message and resolves once the reply's headers arrive.
function send(url, message, { sessionId, login } = {}) {
  const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
  if (sessionId) {
    headers["mcp-session-id"] = sessionId;
    headers["mcp-protocol-version"] = PROTOCOL;
  }
  if (login) headers["x-test-login"] = login;
  return fetch(url, { method: "POST", headers, body: JSON.stringify(message) });
}

// Collects the JSON-RPC messages in a reply, whether the transport answered
// with an SSE stream or a JSON body.
async function collect(response) {
  const text = await response.text();
  const messages = (response.headers.get("content-type") ?? "").includes("text/event-stream")
    ? text.split("\n").filter((line) => line.startsWith("data: ")).map((line) => JSON.parse(line.slice(6)))
    : text ? [JSON.parse(text)] : [];
  return { status: response.status, sessionId: response.headers.get("mcp-session-id"), messages };
}

const post = async (url, message, options) => collect(await send(url, message, options));

const initialize = (id = 1) => ({
  jsonrpc: "2.0",
  id,
  method: "initialize",
  params: { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: "test", version: "0" } },
});
const callTool = (id, name, args = {}) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });

async function open(url, login) {
  const reply = await post(url, initialize(), { login });
  assert.equal(reply.status, 200);
  await post(url, { jsonrpc: "2.0", method: "notifications/initialized" }, { sessionId: reply.sessionId, login });
  return reply.sessionId;
}

test("initialize returns the child's result and a session id", async (t) => {
  const { url, spawned } = await start(t);
  const reply = await post(url, initialize());
  assert.equal(reply.status, 200);
  assert.match(reply.sessionId, /^[0-9a-f-]{36}$/);
  assert.deepEqual(reply.messages, [
    {
      jsonrpc: "2.0",
      id: 1,
      result: { protocolVersion: PROTOCOL, capabilities: { tools: {} }, serverInfo: { name: "echo-desk", version: "0.0.0" } },
    },
  ]);
  assert.deepEqual(spawned, [{ login: "arimendelow", sessionId: reply.sessionId }]);
});

test("tools/list and tools/call round-trip through the child", async (t) => {
  const { url } = await start(t);
  const sessionId = await open(url);
  const list = await post(url, { jsonrpc: "2.0", id: 2, method: "tools/list" }, { sessionId });
  assert.deepEqual(list.messages[0].result.tools.map((tool) => tool.name), ["echo", "hang"]);
  const call = await post(url, callTool(3, "echo", { text: "hi" }), { sessionId });
  assert.deepEqual(call.messages, [{ jsonrpc: "2.0", id: 3, result: { content: [{ type: "text", text: "arimendelow:hi" }] } }]);
});

test("two sessions get two children", async (t) => {
  const { relay, url, children } = await start(t);
  const first = await open(url);
  const second = await open(url);
  assert.notEqual(first, second);
  assert.equal(children.length, 2);
  assert.notEqual(children[0].child.pid, children[1].child.pid);
  assert.equal(relay.size(), 2);
});

test("two concurrent initializes for different logins each get a child of their own login", async (t) => {
  const delays = { arimendelow: 150, someone: 0 };
  const { url, spawned } = await start(t, { beforeSpawn: (auth) => new Promise((resolve) => setTimeout(resolve, delays[auth.extra.login])) });
  const [ari, other] = await Promise.all([post(url, initialize(), { login: "arimendelow" }), post(url, initialize(), { login: "someone" })]);
  assert.equal(ari.status, 200);
  assert.equal(other.status, 200);
  assert.deepEqual(
    spawned.map(({ login, sessionId }) => [login, sessionId]).sort(),
    [["arimendelow", ari.sessionId], ["someone", other.sessionId]].sort(),
  );
  for (const [reply, login] of [[ari, "arimendelow"], [other, "someone"]]) {
    await post(url, { jsonrpc: "2.0", method: "notifications/initialized" }, { sessionId: reply.sessionId, login });
    const call = await post(url, callTool(2, "echo", { text: "hi" }), { sessionId: reply.sessionId, login });
    assert.equal(call.messages[0].result.content[0].text, `${login}:hi`);
  }
});

test("a spawn that fails answers the initialize with 502 and opens no session", async (t) => {
  const { relay, url, children } = await start(t, { beforeSpawn: async () => Promise.reject(new Error("no installation token")) });
  const stderr = t.mock.method(process.stderr, "write", () => true);
  const reply = await post(url, initialize());
  stderr.mock.restore();
  assert.match(String(stderr.mock.calls[0]?.arguments[0]), /could not start Desk for a new session: no installation token/);
  assert.equal(reply.status, 502);
  assert.equal(reply.messages[0].error.code, -32000);
  assert.equal(reply.sessionId, null);
  assert.equal(relay.size(), 0);
  assert.equal(children.length, 0);
});

test("an unknown session id answers 404", async (t) => {
  const { url } = await start(t);
  const reply = await post(url, callTool(2, "echo", { text: "hi" }), { sessionId: "00000000-0000-0000-0000-000000000000" });
  assert.equal(reply.status, 404);
  assert.equal(reply.messages[0].error.code, -32001);
});

test("a child killed mid-call yields a JSON-RPC error and drops the session", async (t) => {
  const { relay, url, children } = await start(t);
  const sessionId = await open(url);
  // The reply's headers arrive after the call has been relayed to the child.
  const response = await send(url, callTool(7, "hang"), { sessionId });
  children[0].child.kill("SIGKILL");
  const reply = await collect(response);
  assert.equal(reply.status, 200);
  assert.equal(reply.messages.length, 1);
  assert.equal(reply.messages[0].id, 7);
  assert.equal(typeof reply.messages[0].error.code, "number");
  assert.equal(relay.size(), 0);
  const later = await post(url, callTool(8, "echo", { text: "hi" }), { sessionId });
  assert.equal(later.status, 404);
});

test("a request with another login's token answers 403", async (t) => {
  const { url } = await start(t);
  const sessionId = await open(url, "arimendelow");
  const reply = await post(url, callTool(2, "echo", { text: "hi" }), { sessionId, login: "someone-else" });
  assert.equal(reply.status, 403);
  const owner = await post(url, callTool(3, "echo", { text: "hi" }), { sessionId, login: "arimendelow" });
  assert.equal(owner.messages[0].result.content[0].text, "arimendelow:hi");
});

test("at maxSessions a new session reaps the least recently used idle one", async (t) => {
  const { relay, url, children } = await start(t, { maxSessions: 2 });
  const oldest = await open(url);
  const newer = await open(url);
  await post(url, callTool(2, "echo", { text: "touch" }), { sessionId: oldest });
  // newer is now the least recently used session.
  const third = await open(url);
  const [, signal] = await children[1].closed;
  assert.equal(signal, "SIGTERM");
  assert.equal(relay.size(), 2);
  assert.equal((await post(url, callTool(3, "echo", { text: "x" }), { sessionId: newer })).status, 404);
  assert.equal((await post(url, callTool(4, "echo", { text: "x" }), { sessionId: oldest })).status, 200);
  assert.equal((await post(url, callTool(5, "echo", { text: "x" }), { sessionId: third })).status, 200);
});

test("idle sessions close after idleMs", async (t) => {
  mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => mock.timers.reset());
  const { relay, url, children } = await start(t, { idleMs: 60_000 });
  const sessionId = await open(url);
  mock.timers.tick(59_000);
  assert.equal(relay.size(), 1);
  mock.timers.tick(1_000);
  const [, signal] = await children[0].closed;
  assert.equal(signal, "SIGTERM");
  assert.equal(relay.size(), 0);
  assert.equal((await post(url, callTool(2, "echo", { text: "x" }), { sessionId })).status, 404);
});

test("a call Desk does not answer within callTimeoutMs gets a JSON-RPC error and the session closes", async (t) => {
  mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => mock.timers.reset());
  const { relay, url, children } = await start(t, { callTimeoutMs: 200_000 });
  const sessionId = await open(url);
  const response = await send(url, callTool(9, "hang"), { sessionId });
  mock.timers.tick(199_000);
  assert.equal(relay.size(), 1);
  mock.timers.tick(1_000);
  const reply = await collect(response);
  assert.deepEqual(reply.messages, [
    {
      jsonrpc: "2.0",
      id: 9,
      error: { code: -32001, message: "Desk did not answer within 200 s; the session was closed. Reconnect to start a new one." },
    },
  ]);
  const [, signal] = await children[0].closed;
  assert.equal(signal, "SIGTERM");
  assert.equal(relay.size(), 0);
  assert.equal((await post(url, callTool(10, "echo", { text: "x" }), { sessionId })).status, 404);
});

test("an answered call's deadline does not close the session", async (t) => {
  mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => mock.timers.reset());
  const { relay, url } = await start(t, { callTimeoutMs: 1_000 });
  const sessionId = await open(url);
  assert.equal((await post(url, callTool(2, "echo", { text: "x" }), { sessionId })).status, 200);
  mock.timers.tick(5_000);
  assert.equal(relay.size(), 1);
  assert.equal((await post(url, callTool(3, "echo", { text: "y" }), { sessionId })).messages[0].result.content[0].text, "arimendelow:y");
});
