// The operator's GitHub logins, read locally from gh's hosts config, are
// operator names: a track named after one is refused and reported. Every
// config here is synthetic and lives in a temporary folder.

import { test } from "node:test"
import { strict as assert } from "node:assert"
import { execFileSync } from "node:child_process"
import { promises as fs } from "node:fs"
import * as path from "node:path"
import { mkTempRoot } from "../_temp_roots.js"
import { MAX_HOSTS_BYTES, ghConfigDir, ghLogins, parseGhHostLogins } from "../../src/desk/gh-logins.js"
import { operatorNames, validateTrackName } from "../../src/desk/naming.js"
import { organizationFindings } from "../../src/desk/organization.js"

const TOKEN = "gho_" + "x".repeat(36)
const noGitIdentity = { spawnGitConfig: () => ({ status: 1, stdout: "" }) }

const HOSTS = [
  "github.com:",
  "    users:",
  "        example-login:",
  `            oauth_token: ${TOKEN}`,
  "        second-login:",
  `            oauth_token: ${TOKEN}`,
  "    git_protocol: https",
  `    oauth_token: ${TOKEN}`,
  "    user: example-login",
  "ghe.example.com:",
  "    user: 'enterprise-login' # comment",
  "    users: {}",
  "",
].join("\n")

async function ghConfig(content) {
  const dir = await mkTempRoot("desk-gh-config-")
  if (content !== null) await fs.writeFile(path.join(dir, "hosts.yml"), content)
  return dir
}

test("gh's config directory is found the way gh finds it", () => {
  assert.equal(ghConfigDir({ env: { GH_CONFIG_DIR: "/gh", XDG_CONFIG_HOME: "/xdg", AppData: "C:\\AppData" }, platform: "win32", homeDir: "/home/a" }), "/gh")
  assert.equal(ghConfigDir({ env: { XDG_CONFIG_HOME: "/xdg", AppData: "C:\\AppData" }, platform: "win32", homeDir: "/home/a" }), path.join("/xdg", "gh"))
  assert.equal(ghConfigDir({ env: { AppData: "C:\\AppData" }, platform: "win32", homeDir: "/home/a" }), path.join("C:\\AppData", "GitHub CLI"))
  assert.equal(ghConfigDir({ env: { AppData: "C:\\AppData" }, platform: "darwin", homeDir: "/home/a" }), path.join("/home/a", ".config", "gh"))
  assert.equal(ghConfigDir({ env: { GH_CONFIG_DIR: " " }, platform: "win32", homeDir: "/home/a" }), path.join("/home/a", ".config", "gh"))
  assert.equal(typeof ghConfigDir(), "string")
})

test("every host's user and users keys are logins; tokens never are", () => {
  const logins = parseGhHostLogins(HOSTS)
  assert.deepEqual(logins, ["example-login", "second-login", "example-login", "enterprise-login"])
  assert.ok(!logins.some((login) => login.includes("gho_")), "no token value is ever returned")
  assert.deepEqual(parseGhHostLogins("github.com:\r\n  user: \"\"\r\n  users:\r\n  # a comment\r\n  - not a key\r\n    crlf-login:\r\n"), ["crlf-login"])
  assert.deepEqual(parseGhHostLogins("github.com:\n  settings:\n    nested: not-a-login\n  user: only-login\n"), ["only-login"], "keys nested under anything but users are not logins")
  assert.deepEqual(parseGhHostLogins("not yaml at all\n:::\n"), [])
  assert.deepEqual(parseGhHostLogins(""), [])
})

test("the hosts config is read locally, bounded, and tolerated when missing or malformed", async () => {
  const dir = await ghConfig(HOSTS)
  assert.deepEqual(ghLogins({ env: { GH_CONFIG_DIR: dir } }), ["example-login", "second-login", "example-login", "enterprise-login"])
  assert.deepEqual(ghLogins({ env: { GH_CONFIG_DIR: await ghConfig(null) } }), [], "missing")
  assert.deepEqual(ghLogins(), [], "the test process's own isolated config folder has no gh config")
  assert.deepEqual(ghLogins({ env: { GH_CONFIG_DIR: await ghConfig("\u0000\u0001 {{{ ::: ]]]") } }), [], "malformed")
  const unreadable = await ghConfig(null)
  await fs.mkdir(path.join(unreadable, "hosts.yml"))
  assert.deepEqual(ghLogins({ env: { GH_CONFIG_DIR: unreadable } }), [], "a directory in the file's place")
  const huge = await ghConfig(`${"#".repeat(MAX_HOSTS_BYTES)}\ngithub.com:\n  user: beyond-the-bound\n`)
  assert.deepEqual(ghLogins({ env: { GH_CONFIG_DIR: huge } }), [], "only the first 64 KiB is read")
  const xdg = await mkTempRoot("desk-gh-xdg-")
  await fs.mkdir(path.join(xdg, "gh"))
  await fs.writeFile(path.join(xdg, "gh", "hosts.yml"), "github.com:\n  user: xdg-login\n")
  assert.deepEqual(ghLogins({ env: { XDG_CONFIG_HOME: xdg } }), ["xdg-login"])
  assert.deepEqual(ghLogins({ env: { GH_CONFIG_DIR: dir, XDG_CONFIG_HOME: xdg } })[0], "example-login", "GH_CONFIG_DIR wins")
})

test("a track named after the operator's GitHub login is refused and reported", async () => {
  const dir = await ghConfig("github.com:\n    user: example-login\n")
  const desk = await mkTempRoot("desk-gh-login-track-")
  execFileSync("git", ["init", "-q", desk])
  execFileSync("git", ["-C", desk, "config", "user.name", "Example Person"])
  const env = { GH_CONFIG_DIR: dir }
  const names = operatorNames(desk, { env })
  assert.deepEqual(names, ["example-person", "example-login"])
  assert.equal(validateTrackName("example-login", { operatorNames: names }).code, "person")
  assert.equal(validateTrackName("example-person", { operatorNames: names }).code, "person")

  await fs.mkdir(path.join(desk, "example-login", "some-real-outcome"), { recursive: true })
  await fs.writeFile(path.join(desk, "example-login", "track.md"), "---\ntitle: example-login\nscope: a track named after a login; not anything else\n---\n")
  await fs.writeFile(path.join(desk, "example-login", "some-real-outcome", "task.md"), "---\nstatus: processing\n---\n")
  const findings = organizationFindings(desk, { operatorNames: names })
  assert.deepEqual(findings.filter((finding) => finding.code === "track_person_name").map((finding) => finding.path), ["example-login"])

  assert.deepEqual(operatorNames(desk, { ...noGitIdentity, env: { GH_CONFIG_DIR: await ghConfig(null) } }), [], "no gh config: no logins")
})
