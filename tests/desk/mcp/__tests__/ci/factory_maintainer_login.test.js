import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { test } from "node:test"

const text = readFileSync(new URL("../../../../../plugins/desk/docs/factory-store-playbook.md", import.meta.url), "utf8")

for (const [name, variable] of [["validate", "AUTHOR"], ["merge", "author"]]) {
  const lines = text.split("\n")
  const start = lines.findIndex((line) => line.includes(`if printf '%s' "$${variable}" | grep`)
    || line.includes(`if [[ \${#${variable}}`))
  assert.notEqual(start, -1, "actual author guard must exist")
  const indent = lines[start].match(/^ */)[0]
  const end = lines.findIndex((line, i) => i > start && line === `${indent}fi`)
  assert.notEqual(end, -1)
  const block = lines.slice(start, end + 1).map((line) => line.slice(indent.length)).join("\n")

  function authorize(login, permission = "write", status = "0") {
    const result = spawnSync("bash", ["-c", `
      set -uo pipefail
      association=NONE
      REPOSITORY=synthetic/store
      number=1
      summary() { :; }
      gh() {
        test "$2" = "repos/$REPOSITORY/collaborators/$${variable}/permission" || return 9
        test "$API_STATUS" = 0 || return "$API_STATUS"
        printf '%s' "$API_PERMISSION"
      }
      ${block}
      printf '\\nRESULT:%s' "$association"
    `], {
      encoding: "utf8",
      env: { PATH: process.env.PATH, [variable]: login, API_PERMISSION: permission, API_STATUS: status, GITHUB_STEP_SUMMARY: "/dev/null" },
    })
    assert.equal(result.status, 0, result.stderr)
    return result.stdout.split("RESULT:").at(-1)
  }

  test(`${name}: playbook permits regular and managed author lookup`, () => {
    for (const login of ["a", "synthetic-maintainer", "synthetic-user_example", "a".repeat(29) + "_synthetic", "a".repeat(39)]) {
      assert.equal(authorize(login), "COLLABORATOR", login)
    }
  })

  test(`${name}: playbook refuses empty, malformed and malicious authors`, () => {
    for (const login of ["", "_example", "user_", "user__example", "user_ex-ample", "-user", "a".repeat(40),
      "a".repeat(30) + "_synthetic", "user/permission", "../user", "user?x=1", "user%2fowner", "user name",
      "user\nother", "user\r", "user\n", "user;echo nope", "$(echo nope)", "üser_example"]) {
      assert.equal(authorize(login), "NONE", JSON.stringify(login))
    }
  })

  test(`${name}: playbook still requires permission and fails closed on API errors`, () => {
    for (const permission of ["none", "read", "triage", "unknown", ""]) {
      assert.equal(authorize("synthetic-user_example", permission), "NONE", permission)
    }
    assert.equal(authorize("synthetic-user_example", "write", "1"), "NONE")
    assert.equal(authorize("synthetic-user_example", "write", "22"), "NONE")
    assert.equal(authorize("synthetic-user_example", "admin"), "COLLABORATOR")
  })
}
