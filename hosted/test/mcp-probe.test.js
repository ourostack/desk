// hosted/infra/mcp-probe.mjs against a local fake authorization server and a real SDK MCP server in stateless mode.
// Nothing here reaches the network. These cover the probe's token file (0600, rewritten atomically on each refresh),
// that no token ever reaches its output, and that a refused refresh exits non-zero with the OAuth error code.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { main, tokenFile } from "../infra/mcp-probe.mjs";

// A fake gateway: OAuth metadata, a token endpoint that rotates refresh tokens, and /mcp guarded by the access token.
async function fakeGateway({ refuse = null } = {}) {
  let generation = 0;
  const state = { access: "access-token-0", refresh: "refresh-token-0", refreshes: 0, toolCalls: [], seenTokens: new Set() };
  state.seenTokens.add(state.access).add(state.refresh);
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, base());
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString();
    const json = (status, value) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(value));
    };
    if (url.pathname === "/.well-known/oauth-protected-resource/mcp" || url.pathname === "/.well-known/oauth-protected-resource") {
      return json(200, { resource: `${base()}/mcp`, authorization_servers: [base()] });
    }
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      return json(200, {
        issuer: base(),
        authorization_endpoint: `${base()}/authorize`,
        token_endpoint: `${base()}/token`,
        registration_endpoint: `${base()}/register`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
      });
    }
    if (url.pathname === "/token") {
      const form = new URLSearchParams(body);
      if (form.get("grant_type") !== "refresh_token") return json(400, { error: "unsupported_grant_type" });
      if (refuse) return json(400, { error: refuse, error_description: "refused by the test" });
      if (form.get("refresh_token") !== state.refresh) return json(400, { error: "invalid_grant", error_description: "stale refresh token" });
      generation += 1;
      state.refreshes += 1;
      state.access = `access-token-${generation}`;
      state.refresh = `refresh-token-${generation}`;
      state.seenTokens.add(state.access).add(state.refresh);
      return json(200, { access_token: state.access, token_type: "Bearer", expires_in: 3600, refresh_token: state.refresh });
    }
    if (url.pathname === "/mcp") {
      if (req.headers.authorization !== `Bearer ${state.access}`) {
        res.writeHead(401, { "www-authenticate": `Bearer resource_metadata="${base()}/.well-known/oauth-protected-resource/mcp"` });
        return res.end();
      }
      const mcp = new Server({ name: "fake-desk", version: "0.0.0" }, { capabilities: { tools: {} } });
      mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: ["desk_status", "task_update"].map((name) => ({ name, inputSchema: { type: "object" } })),
      }));
      mcp.setRequestHandler(CallToolRequestSchema, async (request) => {
        state.toolCalls.push([request.params.name, request.params.arguments]);
        return { content: [{ type: "text", text: JSON.stringify({ status: "ok", tool: request.params.name }) }] };
      });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      await mcp.connect(transport);
      return transport.handleRequest(req, res, body ? JSON.parse(body) : undefined);
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  function base() {
    return `http://127.0.0.1:${server.address().port}`;
  }
  return { state, url: `${base()}/mcp`, close: () => new Promise((resolve) => server.close(resolve)) };
}

// A home holding a probe file as `connect` would leave it.
function homeWith(gateway, name = "t") {
  const home = mkdtempSync(join(tmpdir(), "mcp-probe-"));
  mkdirSync(join(home, ".ouro"), { mode: 0o700 });
  const file = tokenFile(home, name);
  writeFileSync(
    file,
    JSON.stringify({
      url: gateway.url,
      clientInformation: { client_id: "client-1", redirect_uris: ["http://127.0.0.1:1/callback"], token_endpoint_auth_method: "none" },
      tokens: { access_token: gateway.state.access, token_type: "Bearer", refresh_token: gateway.state.refresh },
    }),
  );
  chmodSync(file, 0o600);
  return { home, file };
}

function capture() {
  const out = [];
  const err = [];
  return { out, err, io: { stdout: (s) => out.push(s), stderr: (s) => err.push(s) } };
}

test("the token file is 0600", async () => {
  const gateway = await fakeGateway();
  try {
    const { home, file } = homeWith(gateway);
    chmodSync(file, 0o644);
    const { io } = capture();
    const code = await main(["status", "--name", "t"], { home, ...io });
    assert.equal(code, 0);
    assert.equal(statSync(file).mode & 0o777, 0o600);
  } finally {
    await gateway.close();
  }
});

test("each refresh rewrites the file atomically with the rotated token", async () => {
  const gateway = await fakeGateway();
  try {
    const { home, file } = homeWith(gateway);
    for (let i = 1; i <= 2; i++) {
      const before = statSync(file).ino;
      const { io } = capture();
      assert.equal(await main(["status", "--name", "t"], { home, ...io }), 0);
      const saved = JSON.parse(readFileSync(file, "utf8"));
      assert.equal(saved.tokens.refresh_token, `refresh-token-${i}`);
      assert.equal(saved.tokens.access_token, `access-token-${i}`);
      assert.equal(saved.url, gateway.url);
      assert.equal(saved.clientInformation.client_id, "client-1");
      // A rename, not an in-place write: a new inode, and no temporary file left beside it.
      assert.notEqual(statSync(file).ino, before);
      assert.deepEqual(readdirSync(join(home, ".ouro")), ["probe-t.json"]);
      assert.equal(statSync(file).mode & 0o777, 0o600);
    }
    assert.equal(gateway.state.refreshes, 2);
    assert.deepEqual(gateway.state.toolCalls.map(([name]) => name), ["desk_status", "desk_status"]);
  } finally {
    await gateway.close();
  }
});

test("no token appears in stdout or stderr", async () => {
  const gateway = await fakeGateway();
  try {
    const { home } = homeWith(gateway);
    const { out, err, io } = capture();
    assert.equal(await main(["status", "--name", "t"], { home, ...io }), 0);
    assert.equal(await main(["task-update", "--name", "t", "--card", "rehearsal/staging-card", "--note", "probe check"], { home, ...io }), 0);
    const text = [...out, ...err].join("\n");
    assert.match(text, /desk_status/);
    assert.match(text, /task_update/);
    for (const token of gateway.state.seenTokens) assert.ok(!text.includes(token), "a token reached the output");
    const update = gateway.state.toolCalls.find(([name]) => name === "task_update")[1];
    assert.equal(update.track, "rehearsal");
    assert.equal(update.slug, "staging-card");
    assert.equal(update.note, "probe check");
  } finally {
    await gateway.close();
  }
});

test("a refused refresh exits non-zero with the OAuth error code", async () => {
  const gateway = await fakeGateway({ refuse: "invalid_grant" });
  try {
    const { home, file } = homeWith(gateway);
    const saved = readFileSync(file, "utf8");
    const { out, err, io } = capture();
    const code = await main(["status", "--name", "t"], { home, ...io });
    assert.notEqual(code, 0);
    assert.match(err.join("\n"), /invalid_grant/);
    // The file is left as it was, and nothing reached the MCP server.
    assert.equal(readFileSync(file, "utf8"), saved);
    assert.equal(gateway.state.toolCalls.length, 0);
    const text = [...out, ...err].join("\n");
    for (const token of gateway.state.seenTokens) assert.ok(!text.includes(token));
  } finally {
    await gateway.close();
  }
});

test("status without a probe file says to connect first", async () => {
  const home = mkdtempSync(join(tmpdir(), "mcp-probe-"));
  const { err, io } = capture();
  assert.notEqual(await main(["status", "--name", "missing"], { home, ...io }), 0);
  assert.match(err.join("\n"), /connect/);
});
