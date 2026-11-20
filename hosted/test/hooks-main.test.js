// The hooks receiver's settings and start-up (hosted/src/hooks/main.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import { hooksConfig, startHooks } from "../src/hooks/main.js";
import { createHooksMemoryStore } from "../src/hooks/memory-store.js";

const ENV = {
  DESK_CLIENT_KEY: "k".repeat(64),
  DESK_GITHUB_ACCOUNTS: "16390116=acct-ari",
  DESK_GITHUB_LOGINS: "16390116=arimendelow",
  DESK_ACCOUNTS_ENDPOINT: "https://stouroaccounts261e0b.table.core.windows.net",
  AZURE_CLIENT_ID: "e9c97801-2067-41f8-83a2-1241652c9a40",
  CONTAINER_APP_NAME: "ouro-desk-hooks",
  CONTAINER_APP_ENV_DNS_SUFFIX: "blueflower-44af4710.eastus2.azurecontainerapps.io",
};

test("the public URL defaults to the Container App's own address", () => {
  const config = hooksConfig(ENV);
  assert.equal(config.publicUrl, "https://ouro-desk-hooks.blueflower-44af4710.eastus2.azurecontainerapps.io");
  assert.equal(config.port, 8080);
  assert.equal(config.clientId, ENV.AZURE_CLIENT_ID);
  assert.equal(hooksConfig({ ...ENV, DESK_HOOKS_PUBLIC_URL: "https://hooks.ouro.bot/" }).publicUrl, "https://hooks.ouro.bot");
  assert.equal(hooksConfig({ ...ENV, AZURE_CLIENT_ID: "" }).clientId, undefined);
});

test("missing or malformed settings stop the receiver with the setting's name, never its value", () => {
  assert.throws(() => hooksConfig({ ...ENV, DESK_CLIENT_KEY: "" }), /DESK_CLIENT_KEY is not set/);
  assert.throws(() => hooksConfig({ ...ENV, DESK_CLIENT_KEY: "has space" }), /DESK_CLIENT_KEY contains whitespace/);
  assert.throws(() => hooksConfig({ ...ENV, DESK_GITHUB_ACCOUNTS: "", DESK_GITHUB_LOGINS: "" }), /names no account/);
  assert.throws(() => hooksConfig({ ...ENV, DESK_ACCOUNTS_ENDPOINT: "" }), /DESK_ACCOUNTS_ENDPOINT/);
  assert.throws(() => hooksConfig({ ...ENV, CONTAINER_APP_NAME: "" }), /DESK_HOOKS_PUBLIC_URL/);
  assert.throws(() => hooksConfig({ ...ENV, DESK_HOOKS_PUBLIC_URL: "http://plain" }), /DESK_HOOKS_PUBLIC_URL/);
});

test("startHooks creates the tables and listens", async (t) => {
  const store = createHooksMemoryStore();
  let ensured = false;
  const ensure = store.ensure;
  store.ensure = async () => {
    ensured = true;
    return ensure();
  };
  const logs = [];
  const server = await startHooks({ env: { ...ENV, PORT: "0" }, store, log: (line) => logs.push(line) });
  t.after(() => server.close());
  assert.equal(ensured, true);
  const response = await fetch(`http://127.0.0.1:${server.address().port}/healthz`);
  assert.equal(await response.text(), "ok");
  assert.match(logs[0], /hooks: listening on \d+ for https:\/\/ouro-desk-hooks\./);
  assert.ok(!logs.join("").includes(ENV.DESK_CLIENT_KEY));
});
