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
  const started = performance.now();
  let pending = "", stderrBytes = 0, cliXml = false, progress = false;
  child.stdout.on("data", chunk => {
    pending += chunk.toString("utf8");
    let newline;
    while ((newline = pending.indexOf("\n")) !== -1) {
      const line = pending.slice(0, newline).replace(/\r$/, "");
      pending = pending.slice(newline + 1);
      fs.appendFileSync(file, JSON.stringify({ event: "reply", pid: child.pid,
        token: line === "private" ? "private" : line === "refused" ? "refused" : "other",
        elapsedMs: Math.round(performance.now() - started) }) + "\n");
    }
  });
  child.stderr.on("data", chunk => {
    stderrBytes += Buffer.byteLength(chunk);
    const text = chunk.toString("utf8");
    cliXml ||= text.includes("#< CLIXML");
    progress ||= text.includes("Preparing modules for first use") || text.includes('S="progress"');
  });
  const end = child.stdin.end;
  child.stdin.end = function () {
    fs.appendFileSync(file, JSON.stringify({ event: "eof", pid: child.pid }) + "\n");
    return end.apply(this, arguments);
  };
  child.once("close", (code, signal) => {
    fs.appendFileSync(file, JSON.stringify({ event: "close", pid: child.pid, code, signal,
      stderrBytes, cliXml, progress, partialReply: pending.length > 0,
      elapsedMs: Math.round(performance.now() - started) }) + "\n");
  });
  return child;
};
require("node:module").syncBuiltinESMExports();
