import { test } from "node:test"
import { strict as assert } from "node:assert"
import { createRequire } from "node:module"

const require = createRequire(import.meta.url)
const sso = require("../../../../../plugins/desk/mcp/web-sso.cjs")

test("only GitHub's enterprise SSO path counts as the SSO page, and only Entra's sign-in hosts count as Entra", () => {
  assert.equal(sso.isSsoPage(new URL("https://github.com/enterprises/example/sso")), true)
  assert.equal(sso.isSsoPage(new URL("https://github.com/enterprises/example/sso/?return_to=x")), true)
  assert.equal(sso.isSsoPage(new URL("https://github.com/enterprises/example/settings")), false)
  assert.equal(sso.isSsoPage(new URL("https://ghe.example.test/enterprises/example/sso")), false)
  assert.equal(sso.isSsoPage(null), false, "a page with no readable address is not the SSO page")
  assert.equal(sso.onEntra(new URL("https://login.microsoftonline.com/common/oauth2/authorize")), true)
  assert.equal(sso.onEntra(new URL("https://login.windows.net/common")), true)
  assert.equal(sso.onEntra(new URL("https://github.com/")), false)
  assert.equal(sso.onEntra(null), false)
})

const button = (extra, children = []) => ({ role: "button", ref: "e1", ...extra, children })
const text = (value) => ({ role: "text", text: value })

test("Continue is found by its name or its visible words, and never when hidden, unnamed in text or another button", () => {
  assert.deepEqual(sso.continueIn({ role: "generic", children: [button({ name: "Continue" })] }), { ref: "e1", name: "Continue" })
  assert.deepEqual(sso.continueIn({ role: "generic", children: [button({}, [text(" Continue "), { role: "generic" }])] }), { ref: "e1", name: "Continue" }, "words are read from text children")
  assert.deepEqual(sso.continueIn(button({}, [text("[redacted]"), text(42), text("CONTINUE")])), { ref: "e1", name: "Continue" }, "redacted and non-string text is skipped")
  assert.equal(sso.continueIn(button({ name: "Continue", visible: false })), null, "a hidden button is not pressed")
  assert.equal(sso.continueIn(button({ name: "Continue with GitHub" })), null)
  assert.equal(sso.continueIn({ role: "button", name: "Continue" }), null, "a button without a ref cannot be pressed")
  assert.equal(sso.continueIn({ role: "link", ref: "e2", name: "Continue" }), null)
  const two = { role: "generic", children: [button({ name: "Continue", ref: "first" }), button({ name: "Continue", ref: "second" })] }
  assert.equal(sso.continueIn(two).ref, "first", "the first Continue wins")
})

test("each state's report says what happened, and the ones that need more say what to do meanwhile", () => {
  const renewed = sso.report("renewed")
  assert.equal(renewed.state, "renewed")
  assert.equal(renewed.keepWorking, undefined)
  const person = sso.report("needs_person")
  assert.equal(person.state, "needs_person")
  assert.match(person.note, /asked to sign in/u)
  assert.match(person.keepWorking, /browser_context/u)
  const stalled = sso.report("stalled")
  assert.equal(stalled.state, "stalled")
  assert.match(stalled.note, /did not leave it in time/u)
  assert.match(stalled.keepWorking, /press Continue once more/u)
})
