"use strict";
const childProcess = require("node:child_process");
const fs = require("node:fs");
const { createHash } = require("node:crypto");
const { isMainThread } = require("node:worker_threads");
const file = process.env.DESK_OWNED_PRIVATE_PATH_OBSERVER;
const original = childProcess.spawn;
childProcess.spawn = function (executable, args, options) {
  const child = original.call(this, executable, args, options);
  const digest = createHash("sha256").update(JSON.stringify({
    present: Object.hasOwn(process.env, "NODE_OPTIONS"), value: process.env.NODE_OPTIONS, execArgv: process.execArgv,
  })).digest("hex");
  fs.appendFileSync(file, JSON.stringify({ event: "spawn", pid: child.pid, executable, isMainThread, digest }) + "\n");
  const end = child.stdin.end;
  child.stdin.end = function () {
    fs.appendFileSync(file, JSON.stringify({ event: "eof", pid: child.pid }) + "\n");
    return end.apply(this, arguments);
  };
  child.once("close", (code, signal) => {
    fs.appendFileSync(file, JSON.stringify({ event: "close", pid: child.pid, code, signal }) + "\n");
  });
  return child;
};
require("node:module").syncBuiltinESMExports();
