import { test } from "node:test"
import assert from "node:assert/strict"
import { promises as fs } from "node:fs"
import * as path from "node:path"
import { reconcileMarker } from "../../../../../plugins/desk/mcp/src/factory/session-lifetime.js"
import { END, ID, scratch, session } from "./_session_helpers.js"

test("lifetime inspection retains a current end, ignores child/foreign activity and accepts a final line without newline", () => scratch(async (ctx) => {
  for (const host of ["claude-code", "copilot-cli"]) {
    const marker = { ...await session(ctx, host), ended_at: END, end_reason: "complete" }
    for (const event of [
      { type: "session.shutdown", timestamp: "2026-09-26T09:00:00.000Z" },
      { type: "session.resume", agentId: "child", timestamp: "2026-09-26T09:00:00.000Z" },
      { type: "session.resume", isSidechain: true, timestamp: "2026-09-26T09:00:00.000Z" },
      { type: "session.resume", sessionId: "another-session", timestamp: "2026-09-26T09:00:00.000Z" },
      { type: "session.resume", sessionId: ID, timestamp: END },
    ]) {
      await fs.writeFile(marker.log_path, ` \n${JSON.stringify(event)}`)
      assert.equal((await reconcileMarker(marker)).end_reason, "complete")
    }
  }
}))

test("unknown lifecycle evidence cannot certify closure, and open markers need no source read", () => scratch(async (ctx) => {
  const marker = { ...await session(ctx, "copilot-cli"), ended_at: END, end_reason: "complete" }
  for (const text of ["{", "null", "123", '{"type":"session.resume"}', JSON.stringify({ type: "session.resume", timestamp: "invalid" }), `${JSON.stringify({ padding: "x".repeat(1024 * 1024) })}\n`]) {
    await fs.writeFile(marker.log_path, text)
    assert.equal((await reconcileMarker(marker)).ended_at, null)
  }
  await fs.unlink(marker.log_path)
  assert.equal((await reconcileMarker({ ...marker, end_reason: null })).ended_at, null)
  assert.equal((await reconcileMarker({ ...marker, ended_at: null })).end_reason, null)
  await assert.rejects(reconcileMarker(marker), { code: "ENOENT" })
}))

test("lifecycle scanning handles multiple chunks and split UTF-8 without retaining content", () => scratch(async (ctx) => {
  const marker = { ...await session(ctx), ended_at: END, end_reason: "complete" }
  await fs.writeFile(marker.log_path, `${JSON.stringify({ type: "other", padding: "é".repeat(40000) })}\n${JSON.stringify({ type: "user", timestamp: "2026-09-26T09:00:00.000Z", message: { content: "fixture" } })}\n`)
  assert.deepEqual(await reconcileMarker(marker), { ...marker, ended_at: null, end_reason: null })
  await fs.writeFile(marker.log_path, `${JSON.stringify({ type: "other", padding: "x".repeat(900000) })}\n`)
  assert.equal((await reconcileMarker(marker)).end_reason, "complete")
}))

test("lifecycle scanning refuses a linked or nonregular source even without a preceding stamp check", () => scratch(async (ctx) => {
  const marker = { ...await session(ctx), ended_at: END, end_reason: "complete" }
  await fs.link(marker.log_path, path.join(ctx.base, "external"))
  await assert.rejects(reconcileMarker(marker), /source_unreadable/u)
  await assert.rejects(reconcileMarker({ ...marker, log_path: ctx.base }))
}))
