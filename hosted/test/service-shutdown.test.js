import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import express from "express";
import { createRelay } from "../src/relay.js";
import { serviceHandle } from "../src/service-lifetime.js";
import { completion } from "../src/account-runtime.js";
import { serveTokens } from "../src/token-socket.js";
import { stopGateway } from "../src/main.js";

test("a live disconnected guardian lets real relay shutdown reach sticky rejection and retain broker/root", async t => {
  const root = mkdtempSync(join(tmpdir(), "desk-r2-"));
  console.log(`retained R2 unit root: ${root}`);
  writeFileSync(join(root, "recovery"), "retained unit recovery evidence");
  const broker = serveTokens({ socketPath: join(root, "token.sock"), mint: async () => ({ token: "synthetic" }) });
  await broker.ready;
  // Portable live IPC/stdio consumer regression, not native realm admission.
  const guardian = spawn(process.execPath, ["-e", `
    require("node:readline").createInterface({ input: process.stdin }).on("line", line => {
      const request = JSON.parse(line);
      if (request.method !== "initialize") return;
      process.send({ serviceStdout: Buffer.from(JSON.stringify({
        jsonrpc: "2.0", id: request.id,
        result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "shutdown-unit", version: "1" } },
      }) + "\\n").toString("base64"), serviceOutputId: 1 });
    });
    process.on("message", () => {});
    process.on("disconnect", () => {});
    setInterval(() => {}, 1000);
  `], { stdio: ["pipe", "pipe", "pipe", "ipc"] });
  const exited = once(guardian, "exit");
  const retired = completion(guardian, null, true);
  let sticky;
  retired.catch(error => { sticky ??= error; });
  const service = serviceHandle(guardian, error => { sticky ??= error; });
  let guardianClosed = false;
  guardian.once("close", () => { guardianClosed = true; });
  const relay = createRelay({ spawnDesk: () => service });
  const app = express();
  app.all("/mcp", express.json(), (req, res) => relay.handle(req, res, {
    token: "synthetic", clientId: "unit", scopes: [], extra: { accountId: "unit" },
  }));
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    // The intentionally broken baseline must also release its relay waiter
    // during test teardown; this is not a guardian-close/retirement event.
    if (!service.stdout.destroyed) service.emit("error", new Error("unit teardown"));
    if (guardian.connected) guardian.disconnect();
    if (guardian.exitCode === null && guardian.signalCode === null) guardian.kill("SIGKILL");
    await exited;
    for (const stream of [guardian.stdin, guardian.stdout, guardian.stderr]) stream.destroy();
    await relay.close();
    server.closeAllConnections();
    server.close();
    await new Promise(resolve => broker.close(resolve));
  });
  const response = await fetch(`http://127.0.0.1:${server.address().port}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
      protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "unit", version: "1" },
    } }),
  });
  assert.equal(response.status, 200);
  await response.text();
  let reachedRuntime = 0;
  let brokerClosed = false;
  const options = {
    server, relay,
    pushDesk: () => { reachedRuntime++; return retired; },
    closeTokenSocket: () => { brokerClosed = true; broker.close(); },
  };
  guardian.disconnect();
  const stopping = stopGateway(options);
  stopping.catch(() => {});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(reachedRuntime, 1, "relay must not wait for a live-but-disconnected guardian");
  await assert.rejects(stopping, error => error.code === "DESK_OPERATION_UNQUIESCENT" && !error.quiescent);
  await assert.rejects(stopGateway(options), error => error === sticky || error.code === sticky.code);
  assert.equal(reachedRuntime, 2);
  assert.equal(guardianClosed, false);
  assert.equal(guardian.kill(0), true, "the real disconnected ChildProcess is still alive");
  assert.equal(brokerClosed, false);
  assert.equal(broker.listening, true);
  assert.equal(existsSync(join(root, "recovery")), true);
  assert.equal(existsSync(join(root, "token.sock")), true);
});
