// The loop's functions take their clock, person, spawn and similar arguments with a default for production. Each test
// here calls one of them the way production does, with the default, so the default is exercised. Every desk and state
// folder is a throwaway; the only process started is node itself, asked for something it cannot answer.
import "../_isolated_env.mjs"
import { test } from "node:test"
import assert from "node:assert/strict"
import { promises as fs } from "node:fs"
import * as path from "node:path"

import { improvementBootCheck, labelsLine, loopWorkerLine } from "../../../../../plugins/desk/mcp/src/factory/boot-check.js"
import { recordKnownHit } from "../../../../../plugins/desk/mcp/src/factory/desk-problem-known.js"
import { probeSignIn } from "../../../../../plugins/desk/mcp/src/factory/headless.js"
import { buildLoopHealth, unreadAlarms } from "../../../../../plugins/desk/mcp/src/factory/loop-health.js"
import { runReconcileStep } from "../../../../../plugins/desk/mcp/src/factory/reconcile-step.js"
import { callTool } from "../../../../../plugins/desk/mcp/src/server.js"
import { scratch } from "./_session_helpers.js"

test("probeSignIn spawns the real child by default; a program that cannot answer is an unknown sign-in", async () => {
  const answer = await probeSignIn({ cli: process.execPath, env: { PATH: process.env.PATH } })
  assert.deepEqual(answer, { state: "sign_in_unknown" })
})

test("labelsLine and loopWorkerLine read their defaults", () => scratch(async ({ env }) => {
  assert.match(labelsLine({ count: 2 }), /^Factory evaluator: 2 finished jobs wait for labels; the plugin labels them in the background, no result recorded yet$/u)
  const saved = process.env.XDG_STATE_HOME
  process.env.XDG_STATE_HOME = env.XDG_STATE_HOME
  try {
    assert.equal(typeof loopWorkerLine(), "string")
  } finally {
    if (saved === undefined) delete process.env.XDG_STATE_HOME
    else process.env.XDG_STATE_HOME = saved
  }
}))

test("improvementBootCheck defaults the person folder and the clock", () => scratch(async ({ desk }) => {
  const summary = await improvementBootCheck({ deskRoot: desk })
  assert.equal(summary.status, "ok")
  assert.equal(summary.open, 0)
}))

test("recordKnownHit defaults the clock, and a call with no options says the version is bad", () => scratch(async ({ env }) => {
  assert.deepEqual(await recordKnownHit(env, 12, { version: "3.2.0-alpha.9" }), { recorded: true })
  assert.deepEqual(await recordKnownHit(env, 12), { recorded: false, code: "bad_version" })
}))

test("buildLoopHealth defaults the clock; unreadAlarms takes no signals and reads every signal-less alarm as unread", () => scratch(async ({ env, desk }) => {
  const loop = await buildLoopHealth({ env, deskRoot: desk })
  assert.equal(loop.schema, "desk.factory.loop/1")
  assert.ok(unreadAlarms(loop).includes("cards_invalid"))
}))

test("the reconcile step takes the real reconcile by default and, with no desk named, reconciles none", () => scratch(async ({ env }) => {
  const out = await runReconcileStep(env, { now: new Date(), desks: [] })
  assert.equal(out.result, "no_desks")
}))

test("improvement_next called through the tool table reads the process environment for the session kind", () => scratch(async ({ desk }) => {
  const reply = await callTool({ deskRoot: desk, name: "improvement_next", input: {} })
  assert.equal(typeof JSON.parse(reply.content[0].text).status, "string")
}))
