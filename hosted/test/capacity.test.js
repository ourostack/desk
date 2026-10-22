import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import express from "express";
import { createRelay } from "../src/relay.js";

const FIXTURE = fileURLToPath(new URL("./fixtures/echo-desk.js", import.meta.url));
const PROTOCOL = "2025-06-18";
const A = "0b8e2f4c-1d3a-4e5b-9c7d-6f8a0b1c2d3e";
const B = "7c1d9e3f-2a4b-4c6d-8e0f-1a2b3c4d5e6f";
const MINUTE = 60_000;

// A relay behind Express whose clock the test moves. Every session belongs to the Ouro account in x-test-account.
async function start(t, { beforeSpawn, ...options } = {}) {
  const clock = { now: 1_000_000 };
  const children = [];
  const relay = createRelay({
    now: () => clock.now,
    ...options,
    async spawnDesk({ auth }) {
      await beforeSpawn?.(auth);
      const child = spawn(process.execPath, [FIXTURE], { stdio: "pipe", env: { ...process.env, ECHO_LOGIN: auth.extra.accountId } });
      children.push({ child, closed: once(child, "close") });
      return child;
    },
  });
  const app = express();
  app.all("/mcp", express.json(), (req, res) =>
    relay.handle(req, res, { token: "t", clientId: "c", scopes: [], extra: { accountId: req.get("x-test-account") } }));
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    await relay.close();
    server.closeAllConnections();
    server.close();
  });
  return { relay, clock, children, url: `http://127.0.0.1:${server.address().port}/mcp` };
}

async function post(url, message, { sessionId, account }) {
  const headers = { "content-type": "application/json", accept: "application/json, text/event-stream", "x-test-account": account };
  if (sessionId) Object.assign(headers, { "mcp-session-id": sessionId, "mcp-protocol-version": PROTOCOL });
  const response = await fetch(url, { method: "POST", headers, body: JSON.stringify(message) });
  const text = await response.text();
  const messages = (response.headers.get("content-type") ?? "").includes("text/event-stream")
    ? text.split("\n").filter((line) => line.startsWith("data: ")).map((line) => JSON.parse(line.slice(6)))
    : text ? [JSON.parse(text)] : [];
  return { status: response.status, sessionId: response.headers.get("mcp-session-id"), messages };
}

const initialize = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: "test", version: "0" } } };
const echo = (id) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "echo", arguments: { text: "hi" } } });

async function open(url, account) {
  const reply = await post(url, initialize, { account });
  assert.equal(reply.status, 200, JSON.stringify(reply.messages));
  await post(url, { jsonrpc: "2.0", method: "notifications/initialized" }, { sessionId: reply.sessionId, account });
  return reply.sessionId;
}

const works = async (url, sessionId, account) => (await post(url, echo(2), { sessionId, account })).status === 200;

test("a 4th session for one account is refused with a message naming 3, and the other 3 keep working", async (t) => {
  const { url, relay } = await start(t, { maxSessions: 12, maxPerAccount: 3, minIdleOwnMs: 10 * MINUTE });
  const sessions = [await open(url, A), await open(url, A), await open(url, A)];
  const fourth = await post(url, initialize, { account: A });
  assert.equal(fourth.status, 429);
  assert.match(fourth.messages[0].error.message, /\b3\b/);
  assert.match(fourth.messages[0].error.message, /session/i);
  assert.match(fourth.messages[0].error.message, /a few minutes/);
  for (const sessionId of sessions) assert.ok(await works(url, sessionId, A));
  assert.equal(relay.size(), 3);
});

test("at the per-account limit, the account's own session quiet for minIdleOwnMs gives way; one quiet for less does not", async (t) => {
  const { url, clock } = await start(t, { maxSessions: 12, maxPerAccount: 3, minIdleOwnMs: 10 * MINUTE });
  const oldest = await open(url, A);
  clock.now += 2 * MINUTE;
  const others = [await open(url, A), await open(url, A)];
  // Two minutes between turns is ordinary use: the 4th is refused and nothing is evicted.
  assert.equal((await post(url, initialize, { account: A })).status, 429);
  assert.ok(await works(url, others[0], A));
  assert.ok(await works(url, others[1], A));
  // Quiet for 10 minutes, the oldest was most likely left behind: it gives way to the new session.
  clock.now += 9 * MINUTE;
  const fourth = await open(url, A);
  assert.equal((await post(url, echo(3), { sessionId: oldest, account: A })).status, 404);
  for (const sessionId of [...others, fourth]) assert.ok(await works(url, sessionId, A));
});

test("a session waiting on a Desk call is never reaped, however long it has been waiting", async (t) => {
  const { url, clock } = await start(t, { maxSessions: 12, maxPerAccount: 1, minIdleOwnMs: MINUTE, callTimeoutMs: 60 * MINUTE });
  const busy = await open(url, A);
  const hang = post(url, { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "hang", arguments: {} } }, { sessionId: busy, account: A });
  await new Promise((resolve) => setTimeout(resolve, 200));
  clock.now += 30 * MINUTE;
  assert.equal((await post(url, initialize, { account: A })).status, 429);
  hang.catch(() => {});
});

test("a full gateway refuses with a plain message", async (t) => {
  const { url } = await start(t, { maxSessions: 1, maxPerAccount: 3, minIdleOwnMs: MINUTE, minIdleForeignMs: 10 * MINUTE });
  await open(url, B);
  const refused = await post(url, initialize, { account: A });
  assert.equal(refused.status, 503);
  assert.equal(refused.messages[0].error.message, "Hosted Desk is full right now. Please try again in a few minutes.");
});

test("by default the relay never reaps another account's session, however long it has been quiet", async (t) => {
  const { url, clock } = await start(t, { maxSessions: 1 });
  const b = await open(url, B);
  clock.now += 24 * 60 * MINUTE;
  assert.equal((await post(url, initialize, { account: A })).status, 503);
  assert.ok(await works(url, b, B));
});

test("at the total limit, a new session reaps its own account's oldest idle session before another account's older one", async (t) => {
  const { url, clock } = await start(t, { maxSessions: 4, maxPerAccount: 3, minIdleOwnMs: MINUTE, minIdleForeignMs: 10 * MINUTE });
  const b = [await open(url, B), await open(url, B)];
  const a = [await open(url, A), await open(url, A)];
  clock.now += 11 * MINUTE;
  const fresh = await open(url, A);
  assert.equal((await post(url, echo(3), { sessionId: a[0], account: A })).status, 404);
  for (const sessionId of b) assert.ok(await works(url, sessionId, B));
  assert.ok(await works(url, a[1], A));
  assert.ok(await works(url, fresh, A));
});

test("a new session never reaps another account's session idle under 10 minutes, and reaps the oldest one past it", async (t) => {
  const { url, clock } = await start(t, { maxSessions: 2, maxPerAccount: 3, minIdleOwnMs: MINUTE, minIdleForeignMs: 10 * MINUTE });
  const oldest = await open(url, B);
  clock.now += MINUTE;
  const newer = await open(url, B);
  clock.now += 8 * MINUTE;
  const busy = await post(url, initialize, { account: A });
  assert.equal(busy.status, 503);
  assert.ok(await works(url, oldest, B));
  assert.ok(await works(url, newer, B));
  // Both just answered a call, so both are fresh again; let the older one go quiet first.
  clock.now += MINUTE;
  assert.ok(await works(url, newer, B));
  clock.now += 10 * MINUTE;
  const a = await open(url, A);
  assert.equal((await post(url, echo(4), { sessionId: oldest, account: B })).status, 404);
  assert.ok(await works(url, newer, B));
  assert.ok(await works(url, a, A));
});

test("sessions still starting count toward the per-account limit", { timeout: 20_000 }, async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { url, relay } = await start(t, { maxSessions: 12, maxPerAccount: 3, minIdleOwnMs: MINUTE, beforeSpawn: () => gate });
  const replies = [1, 2, 3, 4].map(() => post(url, initialize, { account: A }));
  const refused = await Promise.race(replies.map((reply) => reply.then((value) => (value.status === 429 ? value : new Promise(() => {})))));
  assert.match(refused.messages[0].error.message, /\b3\b/);
  release();
  const statuses = (await Promise.all(replies)).map(({ status }) => status).sort();
  assert.deepEqual(statuses, [200, 200, 200, 429]);
  assert.equal(relay.size(), 3);
});

test("disk use is the share of usable blocks in use, as df reports it", async () => {
  const { diskUsedFraction } = await import("../src/account-runtime.js");
  // 1000 blocks, 300 free of which 250 are available to unprivileged users: 700 used of 950 usable.
  const statfs = () => ({ blocks: 1000, bfree: 300, bavail: 250 });
  assert.equal(diskUsedFraction("/data/realms", statfs), 700 / 950);
  assert.equal(diskUsedFraction("/data/realms", () => ({ blocks: 0, bfree: 0, bavail: 0 })), 1);
});

test("shutdown closes every realm at once; one push failure is logged by account and the others complete", async () => {
  const { closeRealms } = await import("../src/account-runtime.js");
  const started = [];
  let releaseA;
  const realm = (accountId, outcome) => ({
    accountId,
    value: {
      close: () => {
        started.push(accountId);
        if (outcome === "wait") return new Promise((resolve) => { releaseA = resolve; });
        if (outcome === "fail") return Promise.reject(Object.assign(new Error("not verified"), { code: "DESK_PUSH_UNPRESERVED" }));
        return Promise.resolve();
      },
    },
  });
  const lines = [];
  const closing = closeRealms([realm("acct-a", "wait"), realm("acct-b", "fail"), realm("acct-c", "ok")], (line) => lines.push(line));
  // All three closes start before the first one finishes.
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, ["acct-a", "acct-b", "acct-c"]);
  releaseA();
  const failed = await closing;
  assert.deepEqual(failed.map(({ accountId }) => accountId), ["acct-b"]);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /acct-b/);
  assert.match(lines[0], /DESK_PUSH_UNPRESERVED/);
  assert.doesNotMatch(lines[0], /kept on disk/, "the container's disk does not outlive the replica");
  assert.match(lines[0], /lost when this replica stops/);
  assert.doesNotMatch(lines.join("\n"), /acct-a|acct-c/);
});

test("a multi-user gateway's relay allows 3 sessions per account and 12 in all", async () => {
  const { MULTI_USER_LIMITS } = await import("../src/main.js");
  assert.deepEqual(MULTI_USER_LIMITS, { maxSessions: 12, maxPerAccount: 3, minIdleOwnMs: 600_000, minIdleForeignMs: 600_000 });
});

test("shutdown closes prepared realms at once, closes a realm still being prepared once it is ready, and stops waiting at the deadline", async () => {
  const { closeAll } = await import("../src/account-runtime.js");
  const order = [];
  const realm = (accountId) => ({ close: async () => { order.push(`close ${accountId}`); } });
  const prepared = new Map([["acct-a", realm("acct-a")]]);
  let finishB;
  const preparingB = new Promise((resolve) => { finishB = () => { prepared.set("acct-b", realm("acct-b")); resolve(); }; });
  const never = new Promise(() => {});
  const preparing = new Map([["acct-b", preparingB], ["acct-c", never]]);
  const lines = [];
  const closing = closeAll({ prepared, preparing, deadline: Date.now() + 300, write: (line) => lines.push(line) });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ["close acct-a"], "a prepared realm's close does not wait for a preparation");
  finishB();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(order, ["close acct-a", "close acct-b"], "a preparation that finishes is closed then, not at the deadline");
  const failed = await closing;
  assert.deepEqual(order, ["close acct-a", "close acct-b"]);
  assert.deepEqual(failed, []);
  assert.match(lines.join("\n"), /account acct-c was still being prepared at the shutdown deadline/);
});

test("a push gets at most 65 s, and only the time left before the shutdown deadline", async () => {
  const { pushBudget } = await import("../src/account-runtime.js");
  assert.equal(pushBudget(1_000, Infinity), 65_000);
  assert.equal(pushBudget(1_000, 31_000), 30_000);
  assert.equal(pushBudget(1_000, 900), 0);
});

test("a failed shutdown push leaves the last seconds before the deadline for a rescue push", async () => {
  const { pushBudget, RESCUE_RESERVE_MS } = await import("../src/account-runtime.js");
  assert.equal(RESCUE_RESERVE_MS, 10_000);
  assert.equal(pushBudget(1_000, 81_000 - RESCUE_RESERVE_MS), 65_000);
  assert.equal(pushBudget(1_000, 41_000 - RESCUE_RESERVE_MS), 30_000);
});

test("a rescue pushes unpushed desk writes to a new branch, which no newer commit can reject", async () => {
  const { rescueDeskWrites } = await import("../src/account-runtime.js");
  const calls = [];
  const lines = [];
  const run = async (job, timeoutMs) => {
    calls.push({ args: job.args, timeoutMs });
    return job.args[0] === "rev-list" ? "abc123\n" : "";
  };
  const branch = await rescueDeskWrites({
    run, accountId: "acct-a", deadline: 50_000, now: () => 45_000, stamp: () => "20261022T034500Z-1a2b3c4d", write: line => lines.push(line),
  });
  assert.equal(branch, "desk-rescue/20261022T034500Z-1a2b3c4d");
  assert.deepEqual(calls.map(call => call.args), [
    ["rebase", "--abort"],
    ["rev-list", "@{u}..HEAD"],
    ["push", "--quiet", "origin", "HEAD:refs/heads/desk-rescue/20261022T034500Z-1a2b3c4d"],
  ]);
  assert.ok(calls.every(call => call.timeoutMs > 0 && call.timeoutMs <= 5_000), "the rescue gets only the time left");
  assert.ok(calls.flatMap(call => call.args).every(arg => !arg.includes("acct-a")), "no account id on any argv");
  assert.match(lines.join("\n"), /DESK WRITES RESCUED for account acct-a: pushed to branch desk-rescue\/20261022T034500Z-1a2b3c4d/);
});

test("a rescue with nothing unpushed pushes nothing and says nothing needed saving", async () => {
  const { rescueDeskWrites } = await import("../src/account-runtime.js");
  const calls = [];
  const branch = await rescueDeskWrites({
    run: async (job) => { calls.push(job.args); return ""; }, accountId: "acct-a", deadline: Infinity, write: () => {},
  });
  assert.equal(branch, "");
  assert.deepEqual(calls, [["rebase", "--abort"], ["rev-list", "@{u}..HEAD"]]);
});

test("a rescue still pushes when the unpushed count can't be read, within 10 s without a deadline", async () => {
  const { rescueDeskWrites } = await import("../src/account-runtime.js");
  const timeouts = [];
  const branch = await rescueDeskWrites({
    run: async (job, timeoutMs) => { timeouts.push(timeoutMs); if (job.args[0] !== "push") throw new Error("no rebase, no upstream"); return ""; },
    accountId: "acct-a", deadline: Infinity, stamp: () => "s", write: () => {},
  });
  assert.equal(branch, "desk-rescue/s");
  assert.ok(timeouts.every(ms => ms === 10_000));
});

test("a failed rescue is logged by account and doesn't throw", async () => {
  const { rescueDeskWrites } = await import("../src/account-runtime.js");
  const lines = [];
  const branch = await rescueDeskWrites({
    run: async (job) => { if (job.args[0] === "push") throw Object.assign(new Error("offline"), { code: "DESK_OPERATION_FAILED" }); return "abc\n"; },
    accountId: "acct-a", deadline: Infinity, stamp: () => "s", write: line => lines.push(line),
  });
  assert.equal(branch, null);
  assert.match(lines.join("\n"), /DESK WRITES NOT RESCUED for account acct-a \(DESK_OPERATION_FAILED\)/);
});

test("a rescue with no time left before the deadline runs nothing and says so", async () => {
  const { rescueDeskWrites } = await import("../src/account-runtime.js");
  const lines = [];
  let ran = false;
  const branch = await rescueDeskWrites({
    run: async () => { ran = true; return ""; }, accountId: "acct-a", deadline: 1_000, now: () => 1_000, write: line => lines.push(line),
  });
  assert.equal(branch, null);
  assert.equal(ran, false);
  assert.match(lines.join("\n"), /DESK WRITES NOT RESCUED for account acct-a \(no time left\)/);
});

test("the processes still running as a realm's UID are read from /proc, by any of their UIDs, without zombies that are truly gone", async () => {
  const { uidProcesses } = await import("../src/account-runtime.js");
  const status = {
    "10": "PPid:\t1\nUid:\t10001\t10001\t10001\t10001\n",
    "11": "PPid:\t1\nUid:\t1000\t1000\t1000\t1000\n",
    "12": "PPid:\t10\nUid:\t1000\t10001\t1000\t1000\n",
    "14": "State:\tZ (zombie)\nPPid:\t1\nThreads:\t1\nUid:\t10001\t10001\t10001\t10001\n",
    // The gateway's own unreaped child: its last messages may not have been read yet.
    "15": "State:\tZ (zombie)\nPPid:\t500\nThreads:\t1\nUid:\t10001\t10001\t10001\t10001\n",
    // A leader whose other threads still run.
    "16": "State:\tZ (zombie)\nPPid:\t1\nThreads:\t3\nUid:\t10001\t10001\t10001\t10001\n",
  };
  const proc = {
    list: () => ["10", "11", "12", "13", "14", "15", "16", "self"],
    ownPid: 500,
    read: (path) => {
      const pid = path.split("/").at(-2);
      if (!(pid in status)) throw Object.assign(new Error("gone"), { code: "ENOENT" });
      return status[pid];
    },
  };
  assert.deepEqual(uidProcesses(10001, proc), [{ pid: 10, ppid: 1 }, { pid: 12, ppid: 10 }, { pid: 15, ppid: 500 }, { pid: 16, ppid: 1 }]);
  assert.deepEqual(uidProcesses(10002, proc), []);
});

test("a realm counts as still running only for processes outside its token broker's tree", async () => {
  const { othersRunning } = await import("../src/account-runtime.js");
  const processes = [{ pid: 20, ppid: 1 }, { pid: 22, ppid: 21 }, { pid: 21, ppid: 20 }, { pid: 30, ppid: 1 }, { pid: 31, ppid: 30 }];
  assert.deepEqual(othersRunning(processes, 20), [30, 31]);
  assert.deepEqual(othersRunning(processes.slice(0, 3), 20), []);
  assert.deepEqual(othersRunning(processes, null), [20, 22, 21, 30, 31]);
});

test("without a shutdown deadline, close waits for every preparation", async () => {
  const { closeAll } = await import("../src/account-runtime.js");
  const prepared = new Map();
  let finish;
  const preparing = new Map([["acct-b", new Promise((resolve) => { finish = resolve; })]]);
  const closed = [];
  const closing = closeAll({ prepared, preparing, deadline: Infinity, write: () => {} });
  await new Promise((resolve) => setTimeout(resolve, 50));
  prepared.set("acct-b", { close: async () => { closed.push("acct-b"); } });
  finish();
  await closing;
  assert.deepEqual(closed, ["acct-b"]);
});
