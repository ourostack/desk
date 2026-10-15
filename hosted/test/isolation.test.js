import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { deskChildArgs, deskChildEnv } from "../src/main.js";

const source = new URL("../src/isolation.js", import.meta.url);
const isolation = existsSync(source) ? await import(source.href) : {};
const realm = {
  uid: 19001, gid: 19001,
  root: "/data/realms/opaque-a",
};

test("UID allocation is stable per desk, distinct across desks and refuses exhaustion", () => {
  assert.equal(typeof isolation.createUidAllocator, "function", "UID allocator is not implemented");
  const allocate = isolation.createUidAllocator({ firstUid: 19001, lastUid: 19002 });
  assert.equal(allocate("desk-a"), 19001);
  assert.equal(allocate("desk-b"), 19002);
  assert.equal(allocate("desk-a"), 19001);
  assert.throws(() => allocate("desk-c"), { code: "DESK_UID_EXHAUSTED" });
  assert.equal(allocate("desk-b"), 19002);
});

test("UID allocation rejects privileged ranges and invalid desk identities without consuming an ID", () => {
  assert.equal(typeof isolation.createUidAllocator, "function", "UID allocator is not implemented");
  for (const options of [
    { firstUid: 0, lastUid: 19002 }, { firstUid: 1000, lastUid: 19002 },
    { firstUid: 19002, lastUid: 19001 }, { firstUid: 19001.5, lastUid: 19002 },
    { firstUid: 19001, lastUid: 4294967295 },
  ]) assert.throws(() => isolation.createUidAllocator(options), { code: "DESK_ISOLATION_INVALID" });
  const allocate = isolation.createUidAllocator({ firstUid: 19001, lastUid: 19002 });
  for (const key of [null, undefined, 1, "", " ", " desk-a", "a\0b"]) {
    assert.throws(() => allocate(key), { code: "DESK_ISOLATION_INVALID" });
  }
  assert.equal(allocate("desk-a"), 19001);
});

test("the child launcher clears supplementary groups and inheritable/ambient caps, enforcing NoNewPrivs", () => {
  assert.equal(typeof isolation.isolationArgs, "function", "child launcher is not implemented");
  assert.deepEqual(isolation.isolationArgs({
    uid: 19001, gid: 19001, command: "/usr/bin/node", args: ["/app/plugins/desk/mcp/index.js"],
  }), [
    "--reuid=19001", "--regid=19001", "--clear-groups",
    "--inh-caps=-all", "--ambient-caps=-all", "--no-new-privs",
    "--", "/usr/bin/node", "/app/plugins/desk/mcp/index.js",
  ]);
});

test("the child launcher refuses privileged/mismatched identities and malformed execution input", () => {
  assert.equal(typeof isolation.isolationArgs, "function", "child launcher is not implemented");
  const valid = { uid: 19001, gid: 19001, command: "/usr/bin/node", args: [] };
  for (const change of [
    { uid: 0 }, { uid: 1000 }, { uid: "19001" }, { uid: 1.1 }, { gid: 0 }, { gid: 19002 },
    { command: "node" }, { command: "/usr/bin/no\0de" }, { args: "--root" }, { args: [null] }, { args: Array(1) },
  ]) assert.throws(() => isolation.isolationArgs({ ...valid, ...change }), { code: "DESK_ISOLATION_INVALID" });
});

test("a realm receives its own HOME, temp, XDG, Git config, desk and token socket without gateway secrets", () => {
  assert.equal(typeof isolation.isolatedDeskEnv, "function", "realm environment is not implemented");
  const env = isolation.isolatedDeskEnv({
    realm, baseEnv: {
      PATH: "/usr/bin:/bin", LANG: "C.UTF-8", TZ: "UTC", HOME: "/gateway",
      TMPDIR: "/gateway/tmp", XDG_CONFIG_HOME: "/gateway/config",
      GIT_CONFIG_GLOBAL: "/gateway/gitconfig", GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "credential.helper", GIT_CONFIG_VALUE_0: "bad",
      DESK_SIGNING_KEY: "private", DESK_APP_KEY_FILE: "/private/key",
      AZURE_CLIENT_SECRET: "private", NODE_OPTIONS: "--inspect=0",
      GH_TOKEN: "private", HTTPS_PROXY: "http://private",
    },
    author: { name: "Ari", email: "16390116+arimendelow@users.noreply.github.com" },
    pluginDir: "/app/plugins/desk", issuer: "https://desk.ouro.bot",
  });
  assert.equal(env.DESK, "/data/realms/opaque-a/clone");
  assert.equal(env.HOME, "/data/realms/opaque-a/home");
  assert.equal(env.TMPDIR, "/data/realms/opaque-a/tmp");
  assert.equal(env.XDG_CONFIG_HOME, "/data/realms/opaque-a/config");
  assert.equal(env.XDG_CACHE_HOME, "/data/realms/opaque-a/cache");
  assert.equal(env.XDG_DATA_HOME, "/data/realms/opaque-a/data");
  assert.equal(env.XDG_STATE_HOME, "/data/realms/opaque-a/state");
  assert.equal(env.GIT_CONFIG_GLOBAL, "/data/realms/opaque-a/gitconfig");
  assert.equal(env.DESK_TOKEN_SOCKET, "/data/realms/opaque-a/git-token.sock");
  assert.equal(env.GIT_CONFIG_NOSYSTEM, "1");
  assert.equal(env.GIT_TERMINAL_PROMPT, "0");
  assert.equal(env.DESK_HOSTED, "1");
  assert.equal(env.USER, "desk-19001");
  assert.equal(env.GIT_AUTHOR_EMAIL, "16390116+arimendelow@users.noreply.github.com");
  assert.equal(env.GIT_COMMITTER_EMAIL, env.GIT_AUTHOR_EMAIL);
  assert.equal(env.DESK_MCP_ICON_URL, "https://desk.ouro.bot/assets/desk-logo.png");
  assert.equal(env.LANG, "C.UTF-8");
  assert.equal(env.TZ, "UTC");
  assert.ok(env.PATH.endsWith("/usr/bin:/bin"));
  assert.deepEqual(Object.keys(env).sort(), [
    "DESK", "DESK_HOSTED", "DESK_MCP_ICON_URL", "DESK_TOKEN_SOCKET",
    "GIT_AUTHOR_EMAIL", "GIT_AUTHOR_NAME", "GIT_COMMITTER_EMAIL", "GIT_COMMITTER_NAME",
    "GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM", "GIT_TERMINAL_PROMPT",
    "HOME", "LANG", "PATH", "TMPDIR", "TZ", "USER",
    "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME",
  ].sort());
});

test("separate realm environments cannot share writable settings or put a realm path in launch arguments", () => {
  assert.equal(typeof isolation.isolatedDeskEnv, "function", "realm environment is not implemented");
  const options = { baseEnv: { PATH: "/usr/bin" }, author: { name: "A", email: "a@users.noreply.github.com" } };
  const first = isolation.isolatedDeskEnv({ ...options, realm });
  const second = isolation.isolatedDeskEnv({
    ...options, realm: { uid: 19002, gid: 19002, root: "/data/realms/opaque-b" },
  });
  for (const key of ["HOME", "TMPDIR", "DESK", "DESK_TOKEN_SOCKET", "GIT_CONFIG_GLOBAL",
    "XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME"]) {
    assert.notEqual(first[key], second[key]);
  }
  const args = isolation.isolationArgs({
    uid: realm.uid, gid: realm.gid, command: "/usr/bin/node", args: ["/app/plugins/desk/mcp/index.js"],
  });
  assert.ok(args.every(arg => !arg.includes(realm.root)));
});

test("a realm refuses relative/escaped roots, mismatched ownership and malformed authors", () => {
  assert.equal(typeof isolation.isolatedDeskEnv, "function", "realm environment is not implemented");
  const options = { realm, baseEnv: {}, author: { name: "A", email: "a@users.noreply.github.com" } };
  for (const badRealm of [
    { ...realm, root: "relative" }, { ...realm, root: "/" },
    { ...realm, root: "/data/realms/../other" }, { ...realm, root: "/data/no\0dir" },
    { ...realm, uid: 0 }, { ...realm, gid: 19002 },
  ]) assert.throws(() => isolation.isolatedDeskEnv({ ...options, realm: badRealm }), { code: "DESK_ISOLATION_INVALID" });
  for (const author of [
    { name: "", email: "a@users.noreply.github.com" },
    { name: "A\nB", email: "a@users.noreply.github.com" },
    { name: "A", email: "private@example.com" },
  ]) assert.throws(() => isolation.isolatedDeskEnv({ ...options, author }), { code: "DESK_ISOLATION_INVALID" });
});

function status({ uid = 19001, gid = uid, caps = "0000000000000000", nnp = 1, groups = "" } = {}) {
  return `Uid:\t${uid}\t${uid}\t${uid}\t${uid}\nGid:\t${gid}\t${gid}\t${gid}\t${gid}\nGroups:\t${groups}\n`
    + `CapInh:\t${caps}\nCapPrm:\t${caps}\nCapEff:\t${caps}\nCapBnd:\t00000000000000c1\nCapAmb:\t${caps}\nNoNewPrivs:\t${nnp}\n`;
}

test("the kernel child gate requires all four UID/GID values and zero active capabilities with NoNewPrivs", () => {
  assert.equal(typeof isolation.assertChildKernelBoundary, "function", "kernel child gate is not implemented");
  assert.doesNotThrow(() => isolation.assertChildKernelBoundary({ status: status(), uid: 19001, gid: 19001 }));
  assert.doesNotThrow(() => isolation.assertChildKernelBoundary({ status: status({ groups: "19001" }), uid: 19001, gid: 19001 }));
  for (const bad of [
    status({ uid: 0 }), status({ gid: 19002 }), status({ nnp: 0 }),
    status({ groups: "19002" }), status().replace("19001\t19001\t19001\t19001", "19001\t19001\t0\t19001"),
    ...["CapEff", "CapPrm", "CapInh", "CapAmb"].map(field => status().replace(`${field}:\t0000000000000000`, `${field}:\t0000000000000040`)),
  ]) assert.throws(() => isolation.assertChildKernelBoundary({ status: bad, uid: 19001, gid: 19001 }), { code: "DESK_ISOLATION_UNPROTECTED" });
});

test("kernel gates reject duplicate, malformed or missing observations instead of treating them as zero", () => {
  assert.equal(typeof isolation.assertChildKernelBoundary, "function", "kernel child gate is not implemented");
  for (const bad of [
    "", status().replace("CapEff:", "Unknown:"), `${status()}CapEff:\t0\n`,
    status().replace("CapEff:\t0000000000000000", "CapEff:\tnot-hex"),
    status().replace("NoNewPrivs:\t1", "NoNewPrivs:\t2"),
    status().replace("Groups:\t", "Missing:\t"),
    status().replace("Uid:\t19001", "Uid:\t-1"),
  ]) assert.throws(() => isolation.assertChildKernelBoundary({ status: bad, uid: 19001, gid: 19001 }), { code: "DESK_ISOLATION_UNPROTECTED" });
});

test("the kernel gateway gate refuses root and any power beyond chown/setgid/setuid", () => {
  assert.equal(typeof isolation.assertGatewayKernelBoundary, "function", "kernel gateway gate is not implemented");
  const gateway = status({ uid: 1000, caps: "00000000000000c1" });
  assert.doesNotThrow(() => isolation.assertGatewayKernelBoundary({ status: gateway, uid: 1000, gid: 1000 }));
  for (const bad of [
    status({ uid: 0, caps: "00000000000000c1" }),
    status({ uid: 1000, caps: "00000000000001c1" }),
    status({ uid: 1000, caps: "00000000000000c0" }),
    gateway.replace("CapAmb:\t00000000000000c1", "CapAmb:\t00000000000000c3"),
    gateway.replace("CapBnd:\t00000000000000c1", "CapBnd:\t00000000a80425fb"),
    status({ uid: 1000, caps: "00000000000000c1", nnp: 0 }),
  ]) assert.throws(() => isolation.assertGatewayKernelBoundary({ status: bad, uid: 1000, gid: 1000 }), { code: "DESK_ISOLATION_UNPROTECTED" });
});

test("the existing child-argument builder omits identifying root paths for a realm", () => {
  const config = { pluginDir: "/app/plugins/desk", cloneDir: "/legacy/desk" };
  assert.deepEqual(deskChildArgs(config, realm), ["/app/plugins/desk/mcp/index.js"]);
  assert.deepEqual(deskChildArgs(config), ["/app/plugins/desk/mcp/index.js", "--root", "/legacy/desk"]);
});

test("the existing child-environment builder consumes a realm without inheriting legacy writable locations", () => {
  const env = deskChildEnv({
    realm, config: { cloneDir: "/legacy/desk", issuer: "https://desk.ouro.bot" },
    author: { name: "Ari", email: "16390116+arimendelow@users.noreply.github.com" },
    socketPath: "/legacy/socket",
    baseEnv: { PATH: "/usr/bin", HOME: "/gateway", GIT_CONFIG_GLOBAL: "/gateway/gitconfig", DESK_SIGNING_KEY: "private" },
  });
  assert.equal(env.DESK, "/data/realms/opaque-a/clone");
  assert.equal(env.DESK_TOKEN_SOCKET, "/data/realms/opaque-a/git-token.sock");
  assert.equal(env.HOME, "/data/realms/opaque-a/home");
  assert.equal(env.GIT_CONFIG_GLOBAL, "/data/realms/opaque-a/gitconfig");
  assert.equal(env.DESK_SIGNING_KEY, undefined);
});
