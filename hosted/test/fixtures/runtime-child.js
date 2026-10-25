import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

const own = dirname(process.env.DESK);
const parent = dirname(own);
let neighborDenied = false;
try { readdirSync(parent); } catch (error) { neighborDenied = error.code === "EACCES"; }
let gatewayKeyDenied = false;
try { readFileSync("/data/runtime-native/synthetic-key"); } catch (error) { gatewayKeyDenied = error.code === "EACCES"; }
const status = readFileSync("/proc/self/status", "utf8");
assert.match(status, /NoNewPrivs:\s+1/);
console.log(JSON.stringify({
  uid: process.getuid(), cwd: process.cwd(), neighborDenied, gatewayKeyDenied,
  capsCleared: ["CapInh", "CapPrm", "CapEff", "CapAmb"].every(name => new RegExp(`${name}:\\s+0+\\n`).test(status)),
  runtimeContextExcluded: process.env.DESK_RUNTIME_JOB === undefined,
  socketUid: statSync(process.env.DESK_TOKEN_SOCKET).uid,
  socketMode: statSync(process.env.DESK_TOKEN_SOCKET).mode & 0o777,
  homeUid: statSync(process.env.HOME).uid,
}));
process.send?.({ ready: true });
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1000);
