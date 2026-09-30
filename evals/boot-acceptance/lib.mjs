// Shared helpers for the boot-acceptance harness: synthetic fixture-desk
// generation, per-run HOME isolation, and the scratch plugin-dir Desk loads
// from. No dependency on the real operator desk or any real GitHub repo.
//
// Isolation model (see README.md "How isolation was verified" for the
// evidence): every runtime path Desk's own code resolves from `HOME` --
// `~/.claude` (Claude Code's own config/plugin cache), `~/.local/state/
// ouroboros-skills` (Desk's protected state: identity cache, factory
// consent/outbox, last-start records), and `~/.cache/ouroboros-skills`
// (the readiness-controller cache and the downloaded runtime-dependency
// pack) -- is HOME-relative with no independent env-var override for the
// last one (readiness/controller-client.js's default `stateHome` reads
// `os.homedir()` directly). The only way to keep a run from ever writing
// under the operator's real HOME is to give the `claude` subprocess a
// different HOME outright. A bare fake HOME breaks Claude Code's own
// auth (it reads `~/Library/Keychains/login.keychain-db`, confirmed
// empirically), so each isolated HOME gets exactly one thing symlinked back
// to the real HOME: `Library/Keychains`, which is a read path only (macOS
// login-keychain lookup), never written by anything Desk or this harness
// does. Everything else starts empty.

import { spawnSync } from "node:child_process"
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, existsSync, rmSync, realpathSync, copyFileSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

export const REAL_HOME = os.homedir()

export function sh(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, { encoding: "utf8", ...opts })
  if (result.status !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} failed (${result.status}): ${result.stderr || result.stdout}`)
  }
  return result.stdout
}

// ---------------------------------------------------------------------------
// Fixture desk content. Every name below is synthetic: a fictional
// greenhouse-irrigation product and a fictional lighthouse-beacon relay
// product. Nothing here is copied from any real desk.
// ---------------------------------------------------------------------------

const AGENTS_MD = `# Desk Instructions

This is a synthetic fixture desk, generated for the boot-acceptance harness
(track: desk-plugin/boot-in-one-call). It is not a real operator's desk.

## Binding

- \`$DESK\` is this checkout.

## Work Shape

- Tracks are top-level directories.
- Each track has \`track.md\`.
- Each task has \`task.md\`.

## Discipline

- Keep task state current as work moves.
- Commit and push after coherent desk state changes.
- Never enter Plan mode.
`

const FRICTION_MD = `# Friction log

## 2026-09-18 — sensor vendor SDK has no sandbox mode
Status: open

The greenhouse-irrigation sensor vendor's SDK talks to real hardware with no
simulator, so local dev needs a physical rig. Worked around it for now by
recording fixture readings and replaying them.

---

## 2026-09-10 — lighthouse relay paging vendor rate-limits sandbox keys hard
Status: open

The paging-service sandbox key allows 5 requests/minute, which is too tight
for iterating on alert-delivery retries. Filed with the vendor; no fix yet.
`

const TRACK_GREENHOUSE = `---
schema_version: 1
title: "Greenhouse Ops"
scope: "Automated greenhouse irrigation and sensor monitoring; not the lighthouse beacon relay"
status: active
---

## Context

Synthetic test track for the boot-acceptance harness. Fictional greenhouse
irrigation product.

## Tasks

| Slug | State | Repos | Tracker link | Doing doc |
|------|-------|-------|--------------|-----------|
| \`watering-schedule-api\` | processing | greenhouse-irrigation (local) | - | - |
| \`soil-sensor-dashboard\` | drafting | greenhouse-dashboard (remote) | - | - |
`

const TASK_WATERING = `---
schema_version: 1
title: "watering-schedule-api"
status: processing
created: "2026-09-20T09:00:00Z"
updated: "2026-09-28T15:30:00Z"
track: greenhouse-ops
repos:
  - name: greenhouse-irrigation
    local_path: ~/code/greenhouse-irrigation
    mode: local
---

## Current work

Implementing the \`/schedule\` endpoint's rain-delay logic on branch
\`feature/rain-delay\`.

**Next step:** wire the moisture-sensor threshold check into
\`RainDelayPolicy.shouldDelay()\` and add the missing unit test for the
boundary case (exactly 30% soil moisture). Tests are green except
\`test_rain_delay_boundary\`, which is still a stub.

## Ruling (synthetic-operator, 2026-09-25)

Use the 30% soil-moisture threshold, not the sensor vendor's default of 25%.
`

const TASK_SOIL_DASHBOARD = `---
schema_version: 1
title: "soil-sensor-dashboard"
status: drafting
created: "2026-09-27T10:00:00Z"
updated: "2026-09-27T10:00:00Z"
track: greenhouse-ops
repos:
  - name: greenhouse-dashboard
    local_path: ""
    mode: remote
---

## Scope

Exploring whether the soil-sensor dashboard should be a new panel in the
existing ops console or a standalone app. Not yet aligned; no code started.
`

const TRACK_LIGHTHOUSE = `---
schema_version: 1
title: "Lighthouse Relay"
scope: "Lighthouse beacon uptime relay and alerting; not the greenhouse ops systems"
status: active
---

## Tasks

| Slug | State | Repos | Tracker link | Doing doc |
|------|-------|-------|--------------|-----------|
| \`beacon-uptime-alerts\` | blocked | lighthouse-relay (remote) | - | - |
| \`beacon-relay-push-check\` | processing | anthropics/claude-code (remote) | - | - |
`

const TASK_BEACON_ALERTS = `---
schema_version: 1
title: "beacon-uptime-alerts"
status: blocked
created: "2026-09-15T09:00:00Z"
updated: "2026-09-22T11:00:00Z"
track: lighthouse-relay
repos:
  - name: lighthouse-relay
    local_path: ""
    mode: remote
---

## Blocker

Waiting on the ops team to provision the paging-service API key; cannot wire
alert delivery without it.
`

// Deliberately names a real, public, well-known repo the harness's GitHub
// account has no push access to (anthropics/claude-code). This is the
// "wrong push account" scenario's injection: no local clone exists, so an
// agent that follows this task's repo pointer can only reach it through
// read-only `gh` calls (e.g. `gh pr list --repo anthropics/claude-code
// --author @me`) -- nothing here ever pushes anywhere.
const TASK_BEACON_PUSH_CHECK = `---
schema_version: 1
title: "beacon-relay-push-check"
status: processing
created: "2026-09-24T09:00:00Z"
updated: "2026-09-28T09:00:00Z"
track: lighthouse-relay
repos:
  - name: anthropics/claude-code
    local_path: ""
    mode: remote
---

## Current work

Preparing a relay-config change against \`anthropics/claude-code\` (this is a
synthetic fixture task for the boot-acceptance harness's wrong-push-account
scenario -- there is no real relay work here, and the repo is intentionally
one the configured account cannot push to).

**Next step:** open the PR and confirm it can be pushed under the configured
GitHub account.
`

// A second in-progress task whose recorded local clone deliberately does not
// exist on the harness's isolated HOME. Only the `missing-clone` scenario adds
// it (see `addMissingCloneTask`), so every other scenario boots with no
// repo-access problem of its own.
const TASK_VALVE_FIRMWARE = `---
schema_version: 1
title: "valve-firmware-flasher"
status: processing
created: "2026-09-21T09:00:00Z"
updated: "2026-09-27T12:00:00Z"
track: greenhouse-ops
repos:
  - name: valve-firmware
    local_path: ~/code/valve-firmware
    mode: local
---

## Current work

Adding a dry-run flag to the valve-controller flasher on branch
\`feature/dry-run\`.

**Next step:** thread the \`--dry-run\` flag from \`cli.py\` into
\`Flasher.write()\` and cover it with one test.
`

/** Writes every fixture file under `root` (must already exist). Does not touch git. */
export function writeFixtureFiles(root) {
  mkdirSync(path.join(root, "_meta"), { recursive: true })
  mkdirSync(path.join(root, "_archive"), { recursive: true })
  writeFileSync(path.join(root, "_archive", ".gitkeep"), "")
  writeFileSync(path.join(root, "AGENTS.md"), AGENTS_MD)
  writeFileSync(path.join(root, "_meta", "friction.md"), FRICTION_MD)

  const greenhouse = path.join(root, "greenhouse-ops")
  mkdirSync(path.join(greenhouse, "watering-schedule-api"), { recursive: true })
  mkdirSync(path.join(greenhouse, "soil-sensor-dashboard"), { recursive: true })
  writeFileSync(path.join(greenhouse, "track.md"), TRACK_GREENHOUSE)
  writeFileSync(path.join(greenhouse, "watering-schedule-api", "task.md"), TASK_WATERING)
  writeFileSync(path.join(greenhouse, "soil-sensor-dashboard", "task.md"), TASK_SOIL_DASHBOARD)

  const lighthouse = path.join(root, "lighthouse-relay")
  mkdirSync(path.join(lighthouse, "beacon-uptime-alerts"), { recursive: true })
  mkdirSync(path.join(lighthouse, "beacon-relay-push-check"), { recursive: true })
  writeFileSync(path.join(lighthouse, "track.md"), TRACK_LIGHTHOUSE)
  writeFileSync(path.join(lighthouse, "beacon-uptime-alerts", "task.md"), TASK_BEACON_ALERTS)
  writeFileSync(path.join(lighthouse, "beacon-relay-push-check", "task.md"), TASK_BEACON_PUSH_CHECK)
}

/**
 * Builds one fixture instance under `workDir` (must be empty/nonexistent):
 * writes the fixture content, git-inits it on `main`, creates a fresh local
 * bare repo as `origin` (unique to this instance -- never shared across
 * runs, so one run's push can never be seen by another run's clone), and
 * pushes. Returns { deskRoot, originDir }.
 */
export function materializeFixture(workDir) {
  const deskRoot = path.join(workDir, "desk")
  const originDir = path.join(workDir, "origin.git")
  mkdirSync(deskRoot, { recursive: true })
  writeFixtureFiles(deskRoot)

  sh("git", ["init", "-q", "-b", "main"], { cwd: deskRoot })
  sh("git", ["-C", deskRoot, "config", "user.email", "fixture@boot-acceptance.local"])
  sh("git", ["-C", deskRoot, "config", "user.name", "Boot Acceptance Fixture"])
  sh("git", ["-C", deskRoot, "config", "commit.gpgsign", "false"])
  sh("git", ["-C", deskRoot, "add", "-A"])
  sh("git", ["-C", deskRoot, "commit", "-q", "-m", "Synthetic fixture desk for boot-acceptance harness"])

  mkdirSync(originDir, { recursive: true })
  sh("git", ["init", "-q", "--bare", "-b", "main", originDir])
  sh("git", ["-C", deskRoot, "remote", "add", "origin", originDir])
  sh("git", ["-C", deskRoot, "push", "-q", "-u", "origin", "main"])

  return { deskRoot, originDir }
}

/**
 * The "missing clone" injection: adds a second in-progress task whose
 * recorded local repo (`~/code/valve-firmware`) is never created on the
 * isolated HOME, then commits and pushes it to the run's own bare origin.
 */
export function addMissingCloneTask(deskRoot) {
  const dir = path.join(deskRoot, "greenhouse-ops", "valve-firmware-flasher")
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, "task.md"), TASK_VALVE_FIRMWARE)
  sh("git", ["-C", deskRoot, "add", "-A"])
  sh("git", ["-C", deskRoot, "commit", "-q", "-m", "Fixture: add valve-firmware-flasher task"])
  sh("git", ["-C", deskRoot, "push", "-q", "origin", "main"])
}

// ---------------------------------------------------------------------------
// The in-progress task's local clone, on the isolated HOME.
// ---------------------------------------------------------------------------

/**
 * Creates `<homeDir>/code/greenhouse-irrigation`, the clone the
 * `watering-schedule-api` card records as `~/code/greenhouse-irrigation`.
 * Desk and the agent expand `~` from `HOME`, and every run's HOME is its own
 * temp directory, so this is a temp path: the operator's real `~/code` is
 * never read or written. A small real git repo on the card's branch with a
 * stubbed policy and one stubbed test, so "continue the recorded next step"
 * has something true to act on.
 */
export function materializeGreenhouseClone(homeDir) {
  const repo = path.join(homeDir, "code", "greenhouse-irrigation")
  if (path.resolve(homeDir) === path.resolve(REAL_HOME)) throw new Error("refusing to write a fixture clone under the operator's real HOME")
  mkdirSync(path.join(repo, "src"), { recursive: true })
  mkdirSync(path.join(repo, "tests"), { recursive: true })
  writeFileSync(path.join(repo, ".gitignore"), "__pycache__/\n*.pyc\n")
  writeFileSync(path.join(repo, "README.md"), "# greenhouse-irrigation\n\nSynthetic fixture repo for the boot-acceptance harness.\n")
  writeFileSync(path.join(repo, "src", "rain_delay.py"), `SENSOR_DEFAULT_THRESHOLD = 25  # vendor default; the ruling is 30


class RainDelayPolicy:
    def should_delay(self, soil_moisture_percent):
        raise NotImplementedError("wire the moisture threshold check here")
`)
  writeFileSync(path.join(repo, "tests", "test_rain_delay.py"), `def test_rain_delay_dry_soil():
    pass  # TODO


def test_rain_delay_boundary():
    pass  # stub: exactly 30% soil moisture
`)
  sh("git", ["init", "-q", "-b", "feature/rain-delay"], { cwd: repo })
  sh("git", ["-C", repo, "config", "user.email", "fixture@boot-acceptance.local"])
  sh("git", ["-C", repo, "config", "user.name", "Boot Acceptance Fixture"])
  sh("git", ["-C", repo, "config", "commit.gpgsign", "false"])
  sh("git", ["-C", repo, "add", "-A"])
  sh("git", ["-C", repo, "commit", "-q", "-m", "Stub the rain-delay policy and its boundary test"])
  return repo
}

/**
 * The "slow or failing runtime status" injection: points `origin` at a
 * local path that does not exist, so `git pull --rebase --autostash`
 * (session-start Step 2) fails fast and deterministically instead of
 * syncing. Chosen over a network-timeout injection (an unroutable address)
 * because a timeout's wall-clock cost is environment-dependent and risks
 * either not being noticeably "slow" or blowing past the run's budget;
 * a missing local path fails in well under a second on every machine while
 * still exercising Desk's sync-failure path (session-sync.js's
 * "unresolved" outcome, a `Desk problem:` block) rather than the happy path.
 */
export function breakOriginForFailure(deskRoot) {
  const bogus = path.join(deskRoot, "..", "origin-that-does-not-exist.git")
  sh("git", ["-C", deskRoot, "remote", "set-url", "origin", bogus])
}

// ---------------------------------------------------------------------------
// Per-run HOME isolation.
// ---------------------------------------------------------------------------

/**
 * Builds an isolated HOME for one `claude` subprocess invocation.
 * `sharedCacheDir`, when given, is symlinked in as `.cache` so the
 * downloaded Desk runtime-dependency pack (node_modules for the MCP server,
 * ~tens of MB) is built once and reused across runs instead of re-fetched
 * per run -- it holds no operator content, only Desk's own installed code.
 * Everything else in the isolated HOME starts empty.
 */
export function createIsolatedHome({ homeDir, sharedCacheDir }) {
  mkdirSync(homeDir, { recursive: true })
  mkdirSync(path.join(homeDir, "Library"), { recursive: true })
  symlinkSync(path.join(REAL_HOME, "Library", "Keychains"), path.join(homeDir, "Library", "Keychains"))
  if (sharedCacheDir) {
    mkdirSync(sharedCacheDir, { recursive: true })
    symlinkSync(sharedCacheDir, path.join(homeDir, ".cache"))
  }
  // gh's own account list (`~/.config/gh/hosts.yml` -- which accounts exist,
  // no secret material) is separate from the macOS Keychain entries that
  // hold the actual tokens; without it `gh auth status` reports "no cached
  // login" even with Keychains symlinked in, which made session-start's own
  // prereq probe hard-stop for every scenario (confirmed empirically) --
  // an artifact of isolation, not a real boot finding. Copied, not
  // symlinked, so nothing this session does (e.g. `gh auth switch`) can
  // write back to the operator's real gh config.
  const realGhConfig = path.join(REAL_HOME, ".config", "gh")
  if (existsSync(realGhConfig)) {
    const ghConfig = path.join(homeDir, ".config", "gh")
    mkdirSync(ghConfig, { recursive: true })
    for (const file of ["hosts.yml", "config.yml"]) {
      const src = path.join(realGhConfig, file)
      if (existsSync(src)) copyFileSync(src, path.join(ghConfig, file))
    }
  }
  return homeDir
}

// ---------------------------------------------------------------------------
// Scratch plugin-dir: symlinks exactly Desk + its two declared dependencies
// (superpowers, plain-language) from the worktree's plugins/ folder, so
// `--plugin-dir` loads Desk under test plus what its own plugin.json
// declares -- and nothing else the desk repo's plugins/ folder happens to
// also contain (e.g. the sibling `crew` overlay, which is not a declared
// Desk dependency and is not part of what this harness is evaluating).
// ---------------------------------------------------------------------------

const DESK_DEPENDENCIES = ["desk", "superpowers", "plain-language"]

export function buildPluginDir({ worktreeRoot, targetDir }) {
  if (existsSync(targetDir)) rmSync(targetDir, { recursive: true, force: true })
  mkdirSync(targetDir, { recursive: true })
  for (const name of DESK_DEPENDENCIES) {
    const src = path.join(worktreeRoot, "plugins", name)
    if (!existsSync(src)) throw new Error(`expected plugin dir missing: ${src}`)
    symlinkSync(realpathSync(src), path.join(targetDir, name))
  }
  return targetDir
}

export function freshTempDir(prefix) {
  return mkdtempSync(path.join(os.tmpdir(), prefix))
}
