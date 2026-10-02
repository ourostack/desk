// A protected checkout fixture for the PowerShell and Bash guard tests: a protected clone `prot` on main (state branch main,
// with a local branch `topic` pushed to a bare origin) and an ordinary clone `own`. Shared by the false-positive tests and the
// guard corpus, so both run against the same repositories.
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { guardShellCommand, protectCheckout } from "../../../../../plugins/desk/mcp/src/runtime/protected-checkout.js"
import { removeFixtureAfter } from "../_process_hygiene.js"

/** `text` as a PowerShell single-quoted string. */
export const psq = (text) => `'${text.replaceAll("'", "''")}'`

export async function fixture(t) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "desk-guard-fp-")))
  removeFixtureAfter(t, root)
  const home = path.join(root, "home")
  mkdirSync(home)
  writeFileSync(path.join(home, ".gitconfig"), "[user]\n\tname = Fixture\n\temail = fixture@example.invalid\n[init]\n\tdefaultBranch = main\n")
  const env = { ...process.env, HOME: home, USERPROFILE: home, GIT_CONFIG_NOSYSTEM: "1", GIT_EDITOR: "true" }
  for (const key of Object.keys(env)) if (/^GIT_(?:DIR|WORK_TREE|COMMON_DIR|INDEX_FILE|CONFIG_(?:COUNT|KEY_|VALUE_|PARAMETERS|GLOBAL))/u.test(key)) delete env[key]
  const git = (dir, ...args) => execFileSync("git", ["-C", dir, ...args], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
  const origin = path.join(root, "origin.git"), prot = path.join(root, "prot"), own = path.join(root, "own")
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin], { env })
  execFileSync("git", ["init", "-q", "-b", "main", prot], { env })
  writeFileSync(path.join(prot, "file.txt"), "base\n")
  git(prot, "add", "file.txt"); git(prot, "commit", "-qm", "first")
  git(prot, "branch", "topic")
  git(prot, "remote", "add", "origin", origin)
  git(prot, "push", "-q", "-u", "origin", "main", "topic")
  execFileSync("git", ["clone", "-q", origin, own], { env })
  const saved = process.env.HOME
  process.env.HOME = home
  try { await protectCheckout({ root: prot, stateBranch: "main" }) } finally { process.env.HOME = saved }
  return { root, env, prot, own, guard: (command, { cwd = prot, powershell = true } = {}) => guardShellCommand({ command, cwd, env, powershell }) }
}

