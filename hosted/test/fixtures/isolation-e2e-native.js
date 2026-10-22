// Two accounts' realms, end to end, on the production image (selected by DESK_NATIVE_ISOLATION=1 in runtime-native.js).
// Account A acts through the same paths production uses (realm.launch, the actual Desk MCP server, the credential
// helper and token socket) and tries to reach account B. Each case asserts the refusal and that B is untouched.
import assert from "node:assert/strict";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { generateKeyPairSync } from "node:crypto";
import { chmodSync, writeFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createAccountRuntime } from "../../src/account-runtime.js";
import { installationToken } from "../../src/github-app.js";

const PROBE = "/data/isolation-probe.mjs";
const TARGET = "/data/isolation-target.json";
const INSTALLATION = 123;

// A realm-side probe, launched through realm.launch like the Desk server. It reads B's locations from TARGET (the
// test is omniscient; a real neighbor would have to guess them) and reports what the kernel let it do.
const probe = `
import fs from "node:fs"; import net from "node:net"; import cp from "node:child_process";
const target = JSON.parse(fs.readFileSync(${JSON.stringify(TARGET)}, "utf8"));
const attempt = fn => { try { fn(); return "allowed"; } catch (error) { return error.code ?? error.message; } };
const connect = path => new Promise(resolve => {
  const socket = net.connect(path);
  socket.once("connect", () => { socket.destroy(); resolve("connected"); });
  socket.once("error", error => resolve(error.code));
});
const mode = process.argv[2];
if (mode === "kernel") {
  const status = fs.readFileSync("/proc/self/status", "utf8");
  const field = name => status.match(new RegExp("^" + name + ":\\\\s*(\\\\S+)", "m"))?.[1];
  console.log(JSON.stringify({
    uid: process.getuid(), gid: process.getgid(),
    CapInh: field("CapInh"), CapPrm: field("CapPrm"), CapEff: field("CapEff"), CapAmb: field("CapAmb"), NoNewPrivs: field("NoNewPrivs"),
    setuid: attempt(() => process.setuid(0)), setgid: attempt(() => process.setgid(0)),
    setuidNeighbor: attempt(() => process.setuid(target.uid)),
  }));
} else if (mode === "reach") {
  console.log(JSON.stringify({
    ownSocket: await connect(process.env.DESK_TOKEN_SOCKET),
    neighborSocket: await connect(target.socket),
    neighborMarker: attempt(() => fs.readFileSync(target.desk + "/marker")),
    neighborRoot: attempt(() => fs.readdirSync(target.root)),
    realmsParent: attempt(() => fs.readdirSync(target.parent)),
    neighborWrite: attempt(() => fs.writeFileSync(target.desk + "/_shared/probe.md", "x")),
  }));
} else if (mode === "git-calls") {
  const log = process.env.XDG_STATE_HOME + "/git-calls.jsonl";
  console.log(JSON.stringify(fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\\n").filter(Boolean).map(JSON.parse) : []));
} else if (mode === "state") {
  const shared = process.env.DESK + "/_shared";
  console.log(JSON.stringify({
    head: cp.execFileSync("/usr/bin/git", ["rev-parse", "HEAD"], { cwd: process.env.DESK, encoding: "utf8" }).trim(),
    shared: fs.existsSync(shared) ? fs.readdirSync(shared).sort() : [],
  }));
}
`;

// Runs `args` in the realm through realm.launch and returns its exit code and output.
async function inRealm(desk, args, input = "") {
  const child = desk.launch(args);
  const stdout = [];
  const stderr = [];
  child.stdout.on("data", chunk => stdout.push(chunk));
  child.stderr.on("data", chunk => stderr.push(chunk));
  const closed = once(child, "close");
  child.stdin.end(input);
  const [code] = await closed;
  return { code, stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString() };
}
const probeIn = async (desk, mode) => {
  const result = await inRealm(desk, [PROBE, mode]);
  assert.equal(result.code, 0, result.stderr);
  return JSON.parse(result.stdout);
};

// An MCP client on the realm's actual Desk server, as the gateway's relay drives it. Every answer's text is kept,
// with the request that produced it, for the error-text checks.
async function connect(desk, answers) {
  const child = desk.launch(["/app/plugins/desk/mcp/index.js"]);
  child.stderr.on("data", () => {});
  const transport = {
    async start() {
      createInterface({ input: child.stdout }).on("line", line => { if (line.trim()) this.onmessage?.(JSON.parse(line)); });
      child.once("close", () => this.onclose?.());
      child.once("error", error => this.onerror?.(error));
    },
    async send(message) { child.stdin.write(`${JSON.stringify(message)}\n`); },
    async close() {
      const closed = once(child, "close");
      child.stdin.end();
      await closed;
    },
  };
  const client = new Client({ name: "isolation-e2e-native", version: "1" });
  await client.connect(transport);
  return {
    client,
    async call(name, args = {}) {
      let result;
      try {
        result = await client.callTool({ name, arguments: args }, undefined, { timeout: 120_000 });
      } catch (error) {
        result = { isError: true, content: [{ type: "text", text: String(error?.message ?? error) }] };
      }
      const text = result.content?.filter(part => part.type === "text").map(part => part.text).join("\n") ?? "";
      answers.push({ name, request: JSON.stringify(args), text, isError: result.isError === true });
      return { isError: result.isError === true, text };
    },
  };
}

export async function runIsolationCases({ config, store, binding, root }) {
  const bound = setTimeout(() => { console.error("Isolation native fixture exceeded 150 seconds."); process.exit(1); }, 150_000);
  // A GitHub API for the App's own calls: every synthetic repository is on installation 123.
  const githubCalls = [];
  const fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    githubCalls.push(`${init.method ?? "GET"} ${url.pathname}`);
    const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (/^\/repos\/synthetic\/[a-z]+\/installation$/.test(url.pathname)) return json(200, { id: INSTALLATION });
    if (url.pathname === `/app/installations/${INSTALLATION}/access_tokens`) {
      return json(201, { token: `ghs_isolation_${githubCalls.length}`, expires_at: new Date(Date.now() + 3600_000).toISOString() });
    }
    return json(404, {});
  };
  const privateKeyPem = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs1", format: "pem" });
  const mint = (repo, installationId) => installationToken({ appId: 4242, privateKeyPem, repo, installationId, fetch });
  for (const [accountId, repo] of [["iso-a", binding.repo], ["iso-b", "synthetic/second"]]) {
    await store.putAccount({ accountId, displayName: "Synthetic", deskAccess: true });
    await store.putBinding(accountId, { ...binding, repo, installationId: INSTALLATION });
  }
  const parent = join(root, "isolation-realms");
  const manager = createAccountRuntime({
    config, store, rootDir: parent, mint,
    baseEnv: { PATH: "/data/runtime-native-bin:/usr/local/bin:/usr/bin:/bin", DESK_SIGNING_KEY: "gateway secret" },
  });
  const [a, b] = await Promise.all(["iso-a", "iso-b"].map(id => manager.prepare(id)));
  writeFileSync(PROBE, probe, { mode: 0o644 });
  writeFileSync(TARGET, JSON.stringify({ root: b.realm.root, desk: b.env.DESK, socket: b.env.DESK_TOKEN_SOCKET, uid: b.realm.uid, parent }), { mode: 0o644 });
  chmodSync(PROBE, 0o644);
  chmodSync(TARGET, 0o644);
  const bBefore = await probeIn(b, "state");
  const neighbor = [b.realm.root, basename(b.realm.root), "iso-b", "synthetic/second"];
  const cases = {};

  // 1. Forged installation or repository. A binding naming an installation GitHub doesn't serve the repository from
  // gets no token; a binding naming another account's repository gets no realm; A's own token still works.
  const credential = desk => inRealm(desk, ["/app/hosted/bin/git-credential-desk.js", "get"], "protocol=https\nhost=github.com\n\n");
  const own = await credential(a);
  assert.equal(own.code, 0, own.stderr);
  assert.match(own.stdout, /^username=x-access-token\npassword=ghs_isolation_\d+\n$/);
  await store.putAccount({ accountId: "iso-forged-installation", displayName: "Synthetic", deskAccess: true });
  await store.putBinding("iso-forged-installation", { ...binding, repo: "synthetic/third", installationId: 999 });
  const forgedDesk = await manager.prepare("iso-forged-installation");
  const minted = githubCalls.filter(call => call.startsWith("POST")).length;
  const forged = await credential(forgedDesk);
  assert.notEqual(forged.code, 0, "a forged installation gets no token");
  assert.doesNotMatch(forged.stdout, /password=/);
  assert.match(forged.stderr, /Desk token unavailable/);
  assert.ok(githubCalls.includes("GET /repos/synthetic/third/installation"), githubCalls.join("\n"));
  assert.equal(githubCalls.filter(call => call.startsWith("POST")).length, minted, "no token was requested for the forged installation");
  await store.putAccount({ accountId: "iso-forged-repo", displayName: "Synthetic", deskAccess: true });
  await store.putBinding("iso-forged-repo", { ...binding, repo: "synthetic/second", installationId: INSTALLATION });
  await assert.rejects(manager.prepare("iso-forged-repo"), /authority/);
  assert.equal((await credential(b)).code, 0, "B's desk keeps working");
  cases.forgedInstallationOrRepo = { ownToken: true, forgedInstallationRefused: true, forgedRepoRefused: true };

  // 6. Kernel boundary of A's actual launched process.
  const kernel = await probeIn(a, "kernel");
  assert.equal(kernel.uid, a.realm.uid);
  for (const field of ["CapInh", "CapPrm", "CapEff", "CapAmb"]) assert.equal(kernel[field], "0000000000000000", field);
  assert.equal(kernel.NoNewPrivs, "1");
  for (const field of ["setuid", "setgid", "setuidNeighbor"]) assert.equal(kernel[field], "EPERM", field);
  cases.kernel = kernel;

  // 4. B's token socket, clone and realm are closed to A; A's own socket works.
  const reach = await probeIn(a, "reach");
  assert.equal(reach.ownSocket, "connected");
  assert.equal(reach.neighborSocket, "EACCES");
  assert.equal(reach.neighborMarker, "EACCES");
  assert.equal(reach.neighborRoot, "EACCES");
  assert.equal(reach.realmsParent, "EACCES");
  assert.equal(reach.neighborWrite, "EACCES");
  cases.reach = reach;

  const answers = [];
  const session = await connect(a, answers);
  // The service cases assert readiness itself; here the status only has to answer.
  assert.equal((await session.call("desk_status")).isError, false);

  // 2. desk_save into B, by a relative escape and by an absolute path.
  const escape = relative(a.env.DESK, join(b.env.DESK, "_shared", "escape.md"));
  assert.match(escape, /^\.\.\//);
  for (const path of [escape, join(b.env.DESK, "_shared", "absolute.md"), "../../outside.md", "_shared/../../outside.md"]) {
    const saved = await session.call("desk_save", { files: [{ path, content: "not yours\n" }], message: "reach the neighbor" });
    assert.equal(saved.isError, true, `desk_save ${path} must be refused: ${saved.text}`);
    assert.match(saved.text, /outside|escape|absolute|relative|within the desk/i, `desk_save ${path} is refused for its path: ${saved.text}`);
  }
  // A's own write still works, so the refusals above are about the path, not a broken session.
  {
    const saved = await session.call("desk_save", { files: [{ path: "_shared/own.md", content: "mine\n" }], message: "own write" });
    assert.equal(saved.isError, false, saved.text);
  }
  cases.deskSave = answers.filter(answer => answer.name === "desk_save").map(answer => answer.text);

  // 3. A card whose local_path is B's clone: commit evidence is refused, and no Git runs anywhere but A's desk.
  const callsBefore = (await probeIn(a, "git-calls")).length;
  const track = await session.call("track_create", { slug: "neighbor-probe", title: "Neighbor probe", scope: "isolation fixture; not real work" });
  assert.equal(track.isError, false, track.text);
  const created = await session.call("task_create", {
    track: "neighbor-probe", slug: "reach-neighbor-clone", title: "Reach the neighbor's clone", status: "processing",
    repos: [{ name: "synthetic/second", local_path: b.env.DESK, mode: "local", url: "https://github.com/synthetic/second" }],
  });
  assert.equal(created.isError, false, created.text);
  const done = await session.call("task_update", {
    track: "neighbor-probe", slug: "reach-neighbor-clone", status: "done", evidence: { kind: "commit", ref: bBefore.head },
  });
  assert.equal(done.isError, true, `commit evidence from B's clone must be refused: ${done.text}`);
  // The hosted Git guard refuses before any spawn; a spawn into B's unreadable clone would only fail later, so this
  // pins the refusal to the guard.
  assert.match(done.text, /Desk Git context refused/);
  assert.equal((await session.call("desk_status")).isError, false, "a card naming B's clone does not break A's status");
  const calls = (await probeIn(a, "git-calls")).slice(callsBefore);
  const outside = calls.filter(call => call.cwd !== a.env.DESK && !call.cwd.startsWith(`${a.env.DESK}/`));
  assert.deepEqual(outside, [], "Desk ran Git outside A's desk");
  assert.ok(!calls.some(call => call.argv.some(arg => arg.includes(b.realm.root))), "no Git argument names B's realm");
  cases.localPath = { refused: done.text, gitCalls: calls.length, outsideDesk: outside.length };

  // 5. Error text. No answer names B unless A's own request did, none shows B's content, and none shows A's or B's
  // absolute realm path except as A itself wrote it in the request.
  await session.call("desk_thread", { path: "../../missing.md" });
  await session.call("task_focus", { track: "neighbor-probe", slug: "../../iso-b" });
  for (const answer of answers) {
    for (const secret of neighbor) {
      if (!answer.request.includes(secret)) assert.ok(!answer.text.includes(secret), `${answer.name} named B (${secret}) unprompted: ${answer.text}`);
    }
    assert.ok(!answer.text.includes("second marker"), `${answer.name} showed B's content`);
    if (answer.isError && !answer.request.includes(a.realm.root)) {
      assert.ok(!answer.text.includes(a.realm.root), `${answer.name} error names an absolute realm path: ${answer.text}`);
    }
  }
  cases.errors = { answers: answers.length, errors: answers.filter(answer => answer.isError).length };

  await session.client.close();
  const bAfter = await probeIn(b, "state");
  assert.deepEqual(bAfter, bBefore, "B's desk is unchanged");
  await manager.close();
  clearTimeout(bound);
  console.log(JSON.stringify({ isolationCases: cases }));
  return { forged: true, kernel: true, reach: true, deskSave: true, localPath: true, errors: true };
}
