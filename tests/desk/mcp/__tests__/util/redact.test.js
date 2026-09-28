// Session-start redaction: the startup and boot lines and the active-task
// listing never repeat a folder name that carries a secret's value.
//
// Regression (M4-7-F4, 2026-09-27): a session-start status quoted the user
// and password that two task folder names carried.

import { test } from "node:test"
import { strict as assert } from "node:assert"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import * as path from "node:path"
import { tmpdir } from "node:os"
import {
  __redactInternalsForTests,
  REDACTED_SEGMENT,
  REDACTED_TITLE,
  redactCredentialLikeText,
  redactName,
  redactTitle,
} from "../../../../../plugins/desk/mcp/src/util/redact.js"
import { deskStartupDirection } from "../../../../../plugins/desk/mcp/src/util/startup-direction.js"

const require = createRequire(import.meta.url)
const BOOT = fileURLToPath(new URL("../../../../../plugins/desk/hooks/boot-checks.cjs", import.meta.url))

// Fixture names shaped like the incident without carrying a real value.
const PASSWORD_FOLDER = "setup-root-pw-hunter-two"
const TOKEN_FOLDER = "ghp_exampleexampleexample"
const HEX_FOLDER = "deploy-0123456789abcdef0123"

test("redactName hides a secret's value and keeps ordinary names, including topic words", () => {
  for (const name of [PASSWORD_FOLDER, TOKEN_FOLDER, HEX_FOLDER, "connect-10-0-0-1", "set-pw.hunter2"]) {
    assert.equal(redactName(name), REDACTED_SEGMENT, name)
  }
  for (const name of ["rotate-api-token", "secret-store-migration", "password-reset-flow", "book-flights", "29c084a1-b40b-4141-80cc-a8b8804654a5"]) {
    assert.equal(redactName(name), name, name)
  }
})

test("redactTitle hides a whole title that carries a value, even across spaces", () => {
  assert.equal(redactTitle("Set up root pw hunter2 on alpine"), REDACTED_TITLE)
  assert.equal(redactTitle("Rotate the API token"), "Rotate the API token")
})

test("redactCredentialLikeText redacts each path segment or word on its own and keeps the separators", () => {
  const line = `Desk startup: $DESK is /home/a/${PASSWORD_FOLDER}/desk (the saved desk binding); worktree C:\\w\\${TOKEN_FOLDER}; branch "${HEX_FOLDER}".`
  assert.equal(
    redactCredentialLikeText(line),
    `Desk startup: $DESK is /home/a/${REDACTED_SEGMENT}/desk (the saved desk binding); worktree C:\\w\\${REDACTED_SEGMENT}; branch "${REDACTED_SEGMENT}".`,
  )
  assert.equal(redactCredentialLikeText("nothing to hide here"), "nothing to hide here")
  assert.equal(redactCredentialLikeText(""), "")
})

test("redactCredentialLikeText judges a whole path segment, spaces included (review of #51, S4)", () => {
  assert.equal(
    redactCredentialLikeText("Desk startup: $DESK is /tmp/x/set pw hunter2/y (env)."),
    `Desk startup: $DESK is /tmp/x/${REDACTED_SEGMENT}/y (env).`,
  )
  assert.equal(redactCredentialLikeText("C:\\w\\set pw hunter2"), `C:\\w\\${REDACTED_SEGMENT}`)
  assert.equal(redactCredentialLikeText("Desk boot: /w/set pw hunter2: branch retained"), `Desk boot: /w/${REDACTED_SEGMENT}: branch retained`)
  // A segment's own surrounding spaces and a closing full stop stay outside the marker.
  assert.equal(redactCredentialLikeText("left /w/ set pw hunter2 ."), `left /w/ ${REDACTED_SEGMENT} .`)
  // A word that is credential-like on its own is replaced alone, and the sentence's full stop is kept.
  assert.equal(redactCredentialLikeText(`see ${PASSWORD_FOLDER}. Next`), `see ${REDACTED_SEGMENT}. Next`)
  assert.equal(redactCredentialLikeText(`ends at /w/${HEX_FOLDER}...`), `ends at /w/${REDACTED_SEGMENT}...`)
  assert.equal(redactCredentialLikeText("rotate the api token. then pw"), "rotate the api token. then pw", "a topic word or a lone password word is not a value")
})

test("the startup line redacts a credential-like segment of the bound root", () => {
  const root = path.join("/home/a", PASSWORD_FOLDER, "desk")
  const line = deskStartupDirection({ root, source: "env:DESK" })
  assert.doesNotMatch(line, /hunter/)
  assert.match(line, new RegExp(`\\$DESK is /home/a/${REDACTED_SEGMENT}/desk \\(the DESK environment variable\\)`))
  const spaced = deskStartupDirection({ root: "/tmp/x/set pw hunter2/y", source: "env:DESK" })
  assert.doesNotMatch(spaced, /hunter/)
  assert.ok(spaced.includes(`/tmp/x/${REDACTED_SEGMENT}/y`))
  const unavailable = deskStartupDirection({ root: null, unavailable: { source: "env:DESK", message: `desk-mcp: $DESK names ${root}, which does not exist.` } })
  assert.doesNotMatch(unavailable, /hunter/)
  assert.ok(unavailable.includes(REDACTED_SEGMENT))
})

test("the Desk boot line redacts every check's credential-like segments", async () => {
  const { runBootChecks } = require(BOOT)
  const quiet = { launchRepair: async () => {}, launch: async () => {}, record: async () => {} }
  const line = await runBootChecks({
    ...quiet,
    checks: [
      { id: "a", budgetMs: 100, run: async () => ({ line: `Desk: degraded (desk checkout on ${HEX_FOLDER}; writes paused); run desk_doctor` }) },
      { id: "b", budgetMs: 100, run: async () => ({ line: `workspace-tidy Last repair: Tidied 0 stale worktrees; 1 left; /w/${PASSWORD_FOLDER}: branch retained` }) },
      { id: "c", budgetMs: 100, run: async () => ({ line: "worktree /w/set pw hunter2 left" }) },
    ],
  })
  assert.equal(
    line,
    `Desk boot: Desk: degraded (desk checkout on ${REDACTED_SEGMENT}; writes paused); run desk_doctor; workspace-tidy Last repair: Tidied 0 stale worktrees; 1 left; /w/${REDACTED_SEGMENT}: branch retained; worktree /w/${REDACTED_SEGMENT}`,
  )
})

test("the Desk boot line is withheld, never shown unredacted, when the redaction cannot load", async () => {
  const { runBootChecks } = require(BOOT)
  const line = await runBootChecks({
    launchRepair: async () => {}, launch: async () => {}, record: async () => {},
    loadRedaction: async () => { throw new Error("missing") },
    checks: [{ id: "a", budgetMs: 100, run: async () => ({ line: `/w/${PASSWORD_FOLDER}` }) }],
  })
  assert.equal(line, "")
})

test("the machine's own home and temporary folders are never redacted, though a secret-shaped name beside them is", () => {
  const macTemp = "/var/folders/nh/3z0zcc3j0xs16ys7lkh3x80c0000gp/T"
  const segments = __redactInternalsForTests.machineSegments({
    homedir: () => "/Users/a",
    tmpdir: () => macTemp,
    realpath: (dir) => { if (dir === macTemp) return `/private${macTemp}`; throw new Error("ENOENT") },
  })
  assert.ok(segments.has("3z0zcc3j0xs16ys7lkh3x80c0000gp"))
  assert.ok(segments.has("private"))
  const temp = path.join(tmpdir(), "desk-x", PASSWORD_FOLDER)
  assert.equal(redactCredentialLikeText(temp), path.join(tmpdir(), "desk-x", REDACTED_SEGMENT))
})
