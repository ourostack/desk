#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { copilotEnvironment, copilotLogin, isWorkOwner } = require("./copilot-account.cjs");

const remote = (url) => (cmd) => ({ status: 0, stdout: cmd === "git" ? url : "" });

assert.equal(isWorkOwner("teams-microsoft"), true);
assert.equal(isWorkOwner("gim-home"), true);
assert.equal(isWorkOwner("shared-internal-tools"), true);
assert.equal(isWorkOwner("arimendelow_microsoft"), true);
for (const owner of ["ourostack", "arimendelow", "someone-else", ""]) assert.equal(isWorkOwner(owner), false);

assert.equal(copilotLogin("/x", { env: {}, run: remote("https://github.com/ourostack/desk.git\n") }), "arimendelow");
assert.equal(copilotLogin("/x", { env: {}, run: remote("git@github.com:arimendelow/notes.git\n") }), "arimendelow");
assert.equal(copilotLogin("/x", { env: {}, run: remote("https://github.com/gim-home/CIT\n") }), "arimendelow_microsoft");
assert.equal(copilotLogin("/x", { env: { DESK_COPILOT_ACCOUNT: "pinned" }, run: remote("https://github.com/gim-home/CIT\n") }), "pinned");

const calls = [];
const run = (cmd, args, options) => {
  if (cmd === "git") return { status: 0, stdout: "https://github.com/ourostack/desk.git" };
  calls.push({ args, env: options.env });
  return { status: 0, stdout: "personal-token\n" };
};
const env = copilotEnvironment({ GH_TOKEN: "work-token", GITHUB_TOKEN: "work-token", KEEP: "1" }, "/x", { run });
assert.equal(env.GH_TOKEN, undefined);
assert.equal(env.GITHUB_TOKEN, undefined);
assert.equal(env.KEEP, "1");
assert.equal(env.COPILOT_GITHUB_TOKEN, "personal-token");
assert.equal(calls[0].args.at(-1), "arimendelow");

assert.equal(copilotEnvironment({ COPILOT_GITHUB_TOKEN: "given", GH_TOKEN: "w" }, "/x", { run }).COPILOT_GITHUB_TOKEN, "given");
console.log("copilot-account: ok");
