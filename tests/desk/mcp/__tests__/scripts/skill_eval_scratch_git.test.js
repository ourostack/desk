// The skill-eval harness commits its scratch desks, fixture repositories and world baselines with the same isolated Git config it gives the subject.
// scripts/test-skill-evals.cjs holds the full harness regression and runs on Linux only; this keeps the setup path under the Windows suite too, with a
// synthetic hostile global config whose failing hooks would stop any setup commit that read it.
import { test } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { createRequire } from "node:module"
import { mkdirSync, writeFileSync, existsSync } from "node:fs"
import * as path from "node:path"
import { mkTempRoot } from "../_temp_roots.js"

const require = createRequire(import.meta.url)
const { commitBaseline } = require("../../../../../scripts/skill-evals-run.cjs")

const slash = (file) => file.split(path.sep).join("/")

async function hostileGlobalConfig() {
  const root = await mkTempRoot("skill-eval-hostile-git-")
  const hooks = path.join(root, "hooks")
  const template = path.join(root, "template")
  mkdirSync(hooks)
  mkdirSync(path.join(template, "hooks"), { recursive: true })
  for (const directory of [hooks, path.join(template, "hooks")]) {
    for (const name of ["pre-commit", "commit-msg", "post-commit"]) writeFileSync(path.join(directory, name), "#!/bin/sh\necho contributor hook ran >&2\nexit 1\n", { mode: 0o755 })
  }
  const configFile = path.join(root, "hostile-gitconfig")
  writeFileSync(configFile, `[core]\n\thooksPath = ${slash(hooks)}\n[init]\n\ttemplateDir = ${slash(template)}\n`)
  return { root, configFile, hooks }
}

const git = (cwd, args, env) => spawnSync("git", args, { cwd, encoding: "utf8", env })

test("setup commits ignore a hostile global Git config, ambient GIT_* variables and contributor hooks", async () => {
  const { root, configFile, hooks } = await hostileGlobalConfig()
  const subject = path.join(root, "subject")
  const control = path.join(root, "control")
  for (const directory of [subject, control]) {
    mkdirSync(directory)
    writeFileSync(path.join(directory, "file.txt"), "baseline\n")
  }
  const hostile = {
    ...process.env,
    GIT_CONFIG_GLOBAL: configFile,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TEMPLATE_DIR: path.join(root, "template"),
    GIT_CONFIG_PARAMETERS: `'core.hookspath=${slash(hooks)}'`,
    GIT_DIR: path.join(root, "elsewhere", ".git"),
  }
  const saved = new Map(Object.keys(hostile).map((key) => [key, process.env[key]]))
  try {
    // The hostile setup really bites: a plain commit under it is refused by the failing hook.
    const plain = { ...hostile }
    delete plain.GIT_DIR
    git(control, ["init", "-q", "-b", "main"], plain)
    git(control, ["add", "-A"], plain)
    const refused = git(control, ["-c", "user.name=T", "-c", "user.email=t@example.invalid", "commit", "-q", "-m", "x"], plain)
    assert.notEqual(refused.status, 0, "the fixture's hooks must refuse an ordinary commit")
    assert.match(refused.stderr, /contributor hook ran/u)

    for (const [key, value] of Object.entries(hostile)) if (saved.has(key)) process.env[key] = value
    const commit = commitBaseline(subject)
    assert.match(commit, /^[0-9a-f]{40,64}$/u, "the setup commit is made and its id returned")
    assert.equal(existsSync(path.join(subject, ".git")), true, "the repository was created in the scratch directory, not where GIT_DIR pointed")
    assert.equal(existsSync(path.join(root, "elsewhere")), false)
    assert.equal(existsSync(path.join(subject, ".git", "hooks", "pre-commit")), false, "the global template's hooks were not copied in")
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})
