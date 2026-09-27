// The factory's credential check (`src/factory/credential.js`) is its own
// copy of Desk's `isCredentialLike` rules, because `src/factory/**` imports
// only built-ins and factory files. This test holds the two in parity on
// Desk's own case table, and pins the token prefixes only the factory adds.

import { test } from "node:test"
import { strict as assert } from "node:assert"

import { isCredentialLike as deskIsCredentialLike } from "../../src/desk/naming.js"
import { isCredentialLike } from "../../src/factory/credential.js"

const DESK_CASES = [
  "please-use-pw-hunter2",
  "hi-please-set-pw-hunter2-on-box",
  `deploy-pw-hunter2-${"a".repeat(40)}`,
  "login-pw-hunter2-notes.txt",
  "Login_PWD_Hunter2",
  "hi-set-pw-hunter2",
  "rotate-a1b2c3d4e5f6a7b8c9d0.md",
  "box-10-0-0-1",
  "set-pw.hunter2",
  "setup-user-root-pw-alpine",
  "connect-100-73-66-84",
  "connect-999-999-999-999",
  "deploy-a1b2c3d4e5f6a7b8c9d0",
  "DEPLOY-A1B2C3D4E5F6A7B8C9D0-EXTRA",
  "deploy-x9k2m7q1p4z8r3n6",
  "aaaaaaaa-aaaaaaaa-aaaaaaaa-aaaaaaaa-aaaaaaaa-aaaaaaa",
  "internationalization-effort",
  "api-key-rotation",
  "rotate-pw",
  "notes.txt",
  ".git",
  "token-budget-report",
  "password-reset-flow",
  "secret-management-review",
  "sha256-migration",
  "user-root-cause-analysis",
  "hello-world",
  "let-it-ride",
  "",
]

test("the factory check agrees with Desk's isCredentialLike on Desk's case table", () => {
  for (const value of DESK_CASES) assert.equal(isCredentialLike(value), deskIsCredentialLike(value), value)
  // The table exercises both answers.
  assert.ok(DESK_CASES.some((value) => isCredentialLike(value)))
  assert.ok(DESK_CASES.some((value) => !isCredentialLike(value)))
})

test("known token prefixes are credential-like in any case, even when short", () => {
  for (const value of ["ghp_x", "GHO_x", "ghs_x", "ghu_x", "ghr_x", "github_pat_x", "sk-x", "SK-ANT-api03-x", "ghp_SENTINEL0123456789abcdefghijklmnopqrstuv", "github_pat_SENTINEL0123456789_abcdefghijklmnop", "gho_SENTINEL0123456789abcdefghijklmnopqrstuv", "sk-ant-SENTINEL-api03-abcdefghijklmnop"]) {
    assert.equal(isCredentialLike(value), true, value)
  }
  assert.equal(isCredentialLike("0123456789abcdef0123456789abcdef"), true)
  // The documented false positive: a real name with a 16+ letter-and-digit run.
  assert.equal(isCredentialLike("acme/build2026Q3release"), true)
})

test("real model IDs, plugin names and repository names are not credential-like", () => {
  for (const value of [
    "claude-opus-5-5",
    "claude-3-5-sonnet-20241022",
    "us.anthropic.claude-3-7-sonnet-20250219-v1:0",
    "gpt-5.1-codex",
    "desk",
    "superpowers",
    "plain-language",
    "ourostack/desk",
    "ourostack/ouroboros-agent-harness",
    "skill-evals",
    "ghost",
  ]) {
    assert.equal(isCredentialLike(value), false, value)
  }
  assert.equal(isCredentialLike(undefined), false)
  assert.equal(isCredentialLike(42), false)
})
