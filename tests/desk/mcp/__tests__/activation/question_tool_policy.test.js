import { test } from "node:test"
import { strict as assert } from "node:assert"
import { readFileSync } from "node:fs"

const plugin = new URL("../../../../../plugins/desk/", import.meta.url)
const read = (file) => readFileSync(new URL(file, plugin), "utf8")

for (const agent of ["worker", "observer"]) {
  test(`Claude ${agent} excludes only structured questions, retaining the inherited tool pool`, () => {
    const frontmatter = read(`agents/${agent}.md`).split("---")[1]
    const field = (name) => frontmatter.match(new RegExp(`^${name}: (.+)$`, "mu"))?.[1]
    assert.deepEqual(JSON.parse(field("disallowedTools") ?? "null"), ["AskUserQuestion"])
    assert.deepEqual(JSON.parse(field("tools")), ["*"])
  })
}

test("plugin defaults do not pretend to impose host-wide tool permissions", () => {
  assert.equal(Object.hasOwn(JSON.parse(read("settings.json")), "permissions"), false)
})
