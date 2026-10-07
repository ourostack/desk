// The unused-code check lists hook files by name instead of by glob, so a hook that is not listed is reported as unused code. This keeps the list equal to what the hosts register.

import { test } from "node:test"
import { strict as assert } from "node:assert"
import { readdirSync, readFileSync } from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

const repository = path.resolve(fileURLToPath(new URL("../../../../../", import.meta.url)))
const read = (...parts) => readFileSync(path.join(repository, ...parts), "utf8")

// knip.jsonc holds comments, and a comment marker can sit inside a string (a URL), so strip them with a small scanner that knows about strings.
function parseJsonc(text) {
  let out = ""
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (c === '"') {
      let j = i + 1
      while (text[j] !== '"') j += text[j] === "\\" ? 2 : 1
      out += text.slice(i, j + 1)
      i = j
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++
      out += "\n"
    } else {
      out += c
    }
  }
  return JSON.parse(out)
}

const knip = parseJsonc(read("tools", "unused-code", "knip.jsonc"))
const registered = (...files) => new Set(files.flatMap((file) => [...read(...file).matchAll(/hooks[\\/]+([\w-]+\.cjs)/gu)].map((match) => match[1])))

test("the Desk hooks the unused-code check lists are the ones hooks.json and copilot-hooks.json register, plus the ones a registered hook starts", () => {
  const entries = knip.workspaces["plugins/desk/hooks"].entry
  const hooks = registered(["plugins", "desk", "hooks", "hooks.json"], ["plugins", "desk", "hooks", "copilot-hooks.json"])
  assert.ok(hooks.size > 0)
  for (const hook of hooks) assert.ok(entries.includes(hook), `${hook} is registered but not listed in knip.jsonc`)
  const bootChecks = read("plugins", "desk", "hooks", "lib", "boot-checks.cjs")
  for (const entry of entries.filter((name) => !hooks.has(name))) {
    assert.ok(bootChecks.includes(`"${entry}"`), `${entry} is listed in knip.jsonc but neither registered nor started by lib/boot-checks.cjs`)
  }
  for (const entry of entries) {
    assert.ok(readdirSync(path.join(repository, "plugins", "desk", "hooks")).includes(entry), `${entry} does not exist`)
  }
})

// A hook's logic is a module with named exports under lib/, which knip checks export by export. A registered file that exported its own members would be loaded as one whole object again, which knip cannot see through.
test("the hook files hosts register or start by path are thin entries over lib/, with no exports of their own", () => {
  for (const name of ["boot-checks.cjs", "factory-end.cjs", "sync-end.cjs"]) {
    const text = read("plugins", "desk", "hooks", name)
    assert.doesNotMatch(text, /module\.exports|exports\./u, `${name} must not export`)
    assert.match(text, new RegExp(`require\\("\\./lib/${name.replace(".", "\\.")}"\\)`, "u"), `${name} must call its module under lib/`)
    assert.ok(text.split("\n").length <= 12, `${name} must stay a thin entry`)
  }
})

test("the plain-language hook the unused-code check lists is the one its registration files name", () => {
  const hooks = registered(["plugins", "plain-language", "hooks", "hooks.json"], ["plugins", "plain-language", "hooks", "copilot-hooks.json"])
  assert.deepEqual([...hooks].sort(), [...knip.workspaces["plugins/plain-language/hooks"].entry].sort())
})
