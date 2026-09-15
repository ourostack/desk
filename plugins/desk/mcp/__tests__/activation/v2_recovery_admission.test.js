import { test } from "node:test"
import { strict as assert } from "node:assert"
import { readFileSync } from "node:fs"

const pluginRoot = new URL("../../../", import.meta.url)
const read = path => readFileSync(new URL(path, pluginRoot), "utf8")

// Source-contract witnesses only; actual interruption/replacement proof belongs to the consuming host.
test("checkpoint admission binds a complete generation and preserves the previous one", () => {
  const source = read("skills/session-resumption/SKILL.md")
  for (const requirement of [
    /handoff manifest/u,
    /checkpoint generation/u,
    /storage.*before.*capture/u,
    /atomically.*ready/u,
    /previous complete generation/u,
    /current authority.*source.*ownership/u,
    /intervening.*source/u,
    /torn.*latest.*previous complete generation/u,
    /preserve newer.*uncommitted.*bytes/u,
    /never reset.*replay/u,
  ]) assert.match(source, requirement)
})

test("host recovery has bounded armed intent and requires observed work after launch", () => {
  const source = read("skills/session-resumption/SKILL.md")
  for (const requirement of [
    /armed.*disarmed/u,
    /persisted.*consecutive recoveries.*progress/u,
    /disarm.*intentional stop/u,
    /non-ready.*do not launch/u,
    /acknowledgement.*next.*step/u,
    /finite.*pressure-persistence\/checkpoint\/handover\/acknowledgement limits/u,
    /heartbeat.*cannot reset/u,
    /fresh-history executable\/argv.*source\/profile.*identity/u,
    /without copying credentials or changing permissions/u,
  ]) assert.match(source, requirement)
})

test("the recovery exercise cannot pass through two idle restarts", () => {
  const source = read("skills/session-resumption/SKILL.md")
  for (const requirement of [
    /graceful.*abrupt/u,
    /uncommitted.*external/u,
    /operation identity.*before.*issue/u,
    /read-back.*replay/u,
    /surviving.*writer/u,
    /intentional-stop\/disarm.*exhausted recovery budget.*incomplete latest checkpoint/u,
    /Each replacement must perform the next expected work step/u,
  ]) assert.match(source, requirement)
})

test("root exit leaves replacement non-ready until the entire writer tree is released", () => {
  const source = read("skills/session-resumption/SKILL.md")
  assert.match(source, /entire writer tree.*released/u)
  assert.match(source, /root (?:PID|process).*exit.*not.*release/iu)
  assert.match(source, /surviving delegated writer.*non-ready/u)
  assert.match(source, /unobservable.*remote writer.*not.*released/u)
  assert.match(source, /Only after.*writer.*source.*effect.*reconcil.*invoke.*adapter once/u)
})

test("uncertain source-system effects require identity-bound readback, never blind replay", () => {
  const source = read("skills/session-resumption/SKILL.md")
  assert.match(source, /operation identity or idempotency key before issue/u)
  assert.match(source, /source-system readback.*operation identity/u)
  assert.match(source, /unknown.*remain unresolved/u)
  assert.match(source, /never blind replay.*transcript replay/u)
  assert.match(source, /unresolved.*effects.*non-ready/u)
})
