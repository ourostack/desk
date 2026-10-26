#!/usr/bin/env node
// Desk's black-box tester. It installs the shipped plugin folders the way Copilot and Claude Code do, starts them the way
// each host starts them (MCP servers from the host's MCP config, hooks from the host's hook manifest, the boot script),
// drives every user-facing behavior against a throwaway Git desk, compares the two hosts and measures time and memory.
// It never imports Desk's source, so a refactor that keeps behavior cannot break it. See README.md beside it.

import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import fs from "node:fs"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { McpSession } from "./lib/mcp.mjs"
import { hookContext, hookEntries, runHook } from "./lib/hooks.mjs"
import { claudeConfigDir, copyTree, deskStateDir, git, installPlugins, makeDesk, makeHome, makeTempRoot, NOTES, personEnv, WINDOWS } from "./lib/world.mjs"
import { treeRssKiB } from "./lib/proc.mjs"

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, "..", "..")

// ---- options ----

function parseArgs(argv) {
  const options = {
    repeat: 1,
    hosts: ["copilot", "claude"],
    out: path.join(os.tmpdir(), "desk-blackbox-results"),
    cacheDir: process.env.DESK_BLACKBOX_CACHE ?? path.join(os.tmpdir(), "desk-blackbox-cache"),
    browser: true,
    mine: false,
    keep: false,
    plugins: path.join(repoRoot, "plugins"),
    semanticTimeoutMs: 180000,
    label: `${process.platform}-${process.arch}`,
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const next = () => argv[++i]
    if (arg === "--repeat") options.repeat = Math.max(1, Number(next()))
    else if (arg === "--hosts") options.hosts = next().split(",")
    else if (arg === "--out") options.out = path.resolve(next())
    else if (arg === "--cache-dir") options.cacheDir = path.resolve(next())
    else if (arg === "--no-cache") options.cacheDir = null
    else if (arg === "--no-browser") options.browser = false
    else if (arg === "--mine") options.mine = true
    else if (arg === "--keep") options.keep = true
    else if (arg === "--plugins") options.plugins = path.resolve(next())
    else if (arg === "--label") options.label = next()
    else if (arg === "--semantic-timeout") options.semanticTimeoutMs = Number(next()) * 1000
    else if (arg === "--help") {
      console.log(fs.readFileSync(path.join(here, "README.md"), "utf8"))
      process.exit(0)
    } else throw new Error(`unknown option ${arg}`)
  }
  return options
}

// ---- known failures on main: the check still runs; a pass here is reported as fixed ----
// Each entry is a real bug, not a weakened check. Key: "<host>:<check id>" or "*:<check id>".
// Parity gaps use "parity:<parity id>".
const KNOWN = {
  "parity:hooks.plain-language.copilot_has_every_claude_event": "Plain Language injects its contract into every Claude Code subagent through SubagentStart, but plugins/plain-language/hooks/copilot-hooks.json registers only sessionStart, so Copilot subagents start without it.",
  "parity:speed.desk_session_start_hook_ms": "Copilot's Desk sessionStart hook does more than Claude Code's (it records the session folder for the server and checks Copilot's settings), and on Windows Copilot starts it through PowerShell: p50 1.4 s against 0.8 s on Windows CI; on macOS the two vary run to run between 0.9 and 2.8 s.",
  "parity:speed.desk_ready_ms": "On current main a Copilot session's Desk server reaches full readiness (desk_status ready with its root and search details loaded) about 2 s later than Claude Code's: p50 5.4 s against 3.5 s over 3 repeats on macOS, 7.7 s against 4.0 s on Windows CI. Copilot's server resolves its desk through the session record its sessionStart hook writes; the cause is not yet found.",
}

// ---- result recording ----

const results = [] // { repeat, host, id, area, ok, ms, error, known }
const metrics = [] // { repeat, host, name, value, unit }
const parity = [] // { id, ok, detail }

function knownReason(host, id) {
  return KNOWN[`${host}:${id}`] ?? KNOWN[`*:${id}`] ?? null
}

async function check(ctx, id, area, fn) {
  const started = performance.now()
  let ok = true
  let error = null
  let value
  try {
    value = await fn()
  } catch (caught) {
    ok = false
    error = caught instanceof Error ? caught.message : String(caught)
  }
  const ms = performance.now() - started
  const known = knownReason(ctx.host, id)
  results.push({ repeat: ctx.repeat, host: ctx.host, id, area, ok, ms, error, known })
  const mark = ok ? (known ? "FIXED" : "ok  ") : known ? "KNOWN" : "FAIL"
  if (!ok || known || process.env.DESK_BLACKBOX_VERBOSE) console.log(`  ${mark} ${ctx.host} ${id} (${Math.round(ms)} ms)${error ? `: ${error.slice(0, 400)}` : ""}`)
  return ok ? value : undefined
}

function metric(ctx, name, value, unit) {
  if (value === null || value === undefined || Number.isNaN(value)) return
  metrics.push({ repeat: ctx.repeat, host: ctx.host, name, value, unit })
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const samePath = (a, b) => {
  try { return fs.realpathSync(a).toLowerCase() === fs.realpathSync(b).toLowerCase() } catch { return false }
}

// A plain error: something a person can read. No stack frames, no "undefined"/"[object Object]", short.
function assertPlainError(response, label) {
  const text = response.text ?? ""
  assert(response.isError || /refus|invalid|not found|missing|required|must|error/iu.test(text), `${label}: expected a refusal, got ${text.slice(0, 200)}`)
  assert(text.length > 0, `${label}: the error has no text`)
  assert(!/\n\s+at .+\(.+:\d+:\d+\)/u.test(text) && !/at file:\/\//u.test(text), `${label}: the error shows a stack trace`)
  assert(!/\[object Object\]|\bundefined\b|TypeError|ReferenceError/u.test(text), `${label}: the error is not plain: ${text.slice(0, 200)}`)
}

// ---- host launch from the shipped config ----

function expand(value, vars) {
  return typeof value === "string" ? value.replace(/\$\{([A-Z_]+)\}/gu, (whole, name) => (name in vars ? vars[name] : whole)) : value
}

/** The MCP server entry from the host's MCP config, expanded the way the host expands it. */
function serverLaunch(world, serverName) {
  const desk = world.plugins.desk
  const configFile = world.host === "copilot" ? ".mcp.copilot.json" : readJson(path.join(desk, ".claude-plugin", "plugin.json")).mcpServers
  const config = readJson(path.join(desk, configFile)).mcpServers[serverName]
  assert(config !== undefined, `${configFile} declares no ${serverName} server`)
  const vars = world.host === "copilot" ? { COPILOT_PLUGIN_ROOT: desk, PLUGIN_ROOT: desk } : { CLAUDE_PLUGIN_ROOT: desk }
  const env = { ...world.env, ...Object.fromEntries(Object.entries(config.env ?? {}).map(([key, value]) => [key, expand(value, vars)])) }
  let cwd
  if (world.host === "copilot") {
    // Copilot starts its MCP servers in the plugin's own folder and hands them only the session id.
    cwd = desk
    env.COPILOT_AGENT_SESSION_ID = world.sessionId
  } else {
    // Claude Code starts plugin servers in the project folder with the plugin root in the environment.
    cwd = config.cwd && config.cwd !== "." ? path.resolve(world.desk, config.cwd) : world.desk
    env.CLAUDE_PLUGIN_ROOT = desk
    env.CLAUDECODE = "1"
  }
  return { command: config.command, args: (config.args ?? []).map((arg) => expand(arg, vars)), cwd, env }
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"))
}

function hookEnv(world, pluginRoot) {
  const env = { ...world.env }
  if (world.host === "copilot") {
    env.PLUGIN_ROOT = pluginRoot
    env.COPILOT_AGENT_SESSION_ID = world.sessionId
  } else {
    env.CLAUDE_PLUGIN_ROOT = pluginRoot
    env.CLAUDE_PROJECT_DIR = world.desk
    env.CLAUDECODE = "1"
  }
  return env
}

function hookManifest(world, plugin) {
  const root = world.plugins[plugin]
  if (world.host === "copilot") {
    const manifest = readJson(path.join(root, "plugin.json")).hooks
    return manifest ? path.join(root, manifest) : null
  }
  const declared = readJson(path.join(root, ".claude-plugin", "plugin.json")).hooks
  const file = declared ? path.join(root, declared) : path.join(root, "hooks", "hooks.json")
  return fs.existsSync(file) ? file : null
}

const EVENTS = {
  copilot: { start: "sessionStart", prompt: "userPromptSubmitted", postTool: "postToolUse", stop: "agentStop", end: "sessionEnd", subagent: null },
  claude: { start: "SessionStart", prompt: "UserPromptSubmit", postTool: "PostToolUse", stop: "Stop", end: "SessionEnd", subagent: "SubagentStart" },
}

function payloadFor(world, event, extra = {}) {
  if (world.host === "copilot") return { sessionId: world.sessionId, timestamp: Date.now(), cwd: world.desk, ...extra }
  return { session_id: world.sessionId, transcript_path: path.join(claudeConfigDir(world.home), "projects", "t.jsonl"), cwd: world.desk, hook_event_name: event, ...extra }
}

/** Run every hook of one event across the installed plugin set; returns { plugin: result }. */
async function runEvent(world, event, extra = {}, plugins = ["desk", "superpowers", "plain-language"]) {
  const outputs = {}
  for (const plugin of plugins) {
    const manifest = hookManifest(world, plugin)
    if (manifest === null) continue
    const entries = hookEntries({ host: world.host, pluginRoot: world.plugins[plugin], manifestPath: manifest, event })
    for (const [index, entry] of entries.entries()) {
      const result = await runHook(entry, { env: hookEnv(world, world.plugins[plugin]), cwd: world.desk, payload: payloadFor(world, event, extra) })
      outputs[`${plugin}#${index}`] = { ...result, entry }
    }
  }
  return outputs
}

function assertHookOk(result, label) {
  assert(!result.timedOut, `${label} timed out after ${Math.round(result.ms)} ms`)
  assert(result.code === 0, `${label} exited ${result.code}: ${result.stderr.slice(0, 300)}`)
  assert(!result.overBudget, `${label} took ${Math.round(result.ms)} ms, over its ${result.entry.timeoutMs} ms manifest timeout`)
  const text = result.stdout.trim()
  if (text !== "" && text.startsWith("{")) JSON.parse(text)
}

// ---- the per-host session ----

const EXPECTED_DESK_TOOLS = (pluginRoot) => {
  // The launcher in the Claude config carries the full tool list it answers with when Desk cannot start: shipped data, not source.
  const launcher = readJson(path.join(pluginRoot, ".mcp.claude-codex.json")).mcpServers.desk.args.join(" ")
  return JSON.parse(launcher.match(/names=(\[[^\]]+\])/u)[1].replace(/'/gu, '"'))
}

async function waitFor(fn, { timeoutMs, intervalMs = 250, label }) {
  const started = performance.now()
  let last
  while (performance.now() - started < timeoutMs) {
    last = await fn()
    if (last?.done) return { ...last, ms: performance.now() - started }
    await sleep(intervalMs)
  }
  throw new Error(`${label} not reached within ${timeoutMs} ms; last: ${JSON.stringify(last?.detail ?? last).slice(0, 400)}`)
}

function resultPaths(response) {
  const json = response.json ?? {}
  const list = json.results ?? json.matches ?? json.items ?? json.docs ?? json.chain ?? []
  return Array.isArray(list) ? list.map((item) => String(item.path ?? item.doc_path ?? item.file ?? "")) : []
}

async function hostSession(options, host, repeat, shared) {
  const ctx = { host, repeat }
  const root = path.join(shared.tempRoot, `r${repeat}-${host}`)
  fs.mkdirSync(root, { recursive: true })
  const home = makeHome(root)
  // The registry this machine's npm uses (a network may block the public one); only the address, never credentials.
  if (shared.npmRegistry) fs.writeFileSync(path.join(home, ".npmrc"), `registry=${shared.npmRegistry}\n`)
  const env = personEnv(home)
  const world = { host, root, home, env, sessionId: randomUUID() }

  console.log(`[${host} #${repeat}] installing and building the desk in ${root}`)
  world.plugins = installPlugins({ host, home, pluginsSource: options.plugins })
  Object.assign(world, makeDesk({ root, env }))

  // Warm caches a person would already have after their first day: the downloaded search model and browser driver.
  const stateDir = deskStateDir(home)
  const seeded = { model: false, browser: false }
  if (options.cacheDir) {
    seeded.model = copyTree(path.join(options.cacheDir, "embedding-model"), path.join(world.desk, ".state", "embedding-model"))
    seeded.browser = copyTree(path.join(options.cacheDir, "browser"), path.join(stateDir, "browser"))
  }
  world.seeded = seeded
  shared.lastSeeded = seeded

  await installLayoutChecks(ctx, world, shared)
  await sessionStartHooks(ctx, world, shared)
  const session = await deskServer(ctx, world, shared)
  if (session) {
    try {
      await deskTools(ctx, world, session, shared, options)
      await bootScript(ctx, world)
    } finally {
      const info = await session.close()
      metric(ctx, "desk_server_peak_rss_mib", session.rss.peakKiB / 1024, "MiB")
      await check(ctx, "desk_server.exits_on_stdin_close", "mcp", () => assert(!info.forced, `the server needed a signal to exit (${JSON.stringify(info)})`))
    }
  }
  if (options.browser) await webServer(ctx, world, options)
  await endHooks(ctx, world)
  await check(ctx, "git.sync_end_pushes_or_records", "git", async () => {
    const local = git(world.desk, ["rev-parse", "HEAD"], env)
    const status = git(world.desk, ["status", "--porcelain"], env)
    assert(status === "", `the desk was left with uncommitted changes:\n${status}`)
    const remoteHead = git(world.root, ["--git-dir", world.remote, "rev-parse", "main"], env)
    shared.unpushed[host] = remoteHead !== local
  })

  // Keep the warm caches for the next run.
  if (options.cacheDir && !seeded.model) {
    for (const dir of [path.join(world.desk, ".state"), stateDir]) {
      if (copyTree(path.join(dir, "embedding-model"), path.join(options.cacheDir, "embedding-model"))) break
    }
  }
  if (options.cacheDir && options.browser && !seeded.browser) {
    const browserDir = path.join(stateDir, "browser")
    if (fs.existsSync(browserDir)) {
      fs.mkdirSync(path.join(options.cacheDir, "browser"), { recursive: true })
      for (const entry of fs.readdirSync(browserDir)) {
        if (/context/iu.test(entry)) continue
        copyTree(path.join(browserDir, entry), path.join(options.cacheDir, "browser", entry))
      }
    }
  }
}

// ---- install layout ----

function frontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/u.exec(text)
  if (!match) return null
  const fields = {}
  for (const line of match[1].split(/\r?\n/u)) {
    const field = /^([A-Za-z_-]+):\s*(.*)$/u.exec(line)
    if (field) fields[field[1]] = field[2].replace(/^["']|["']$/gu, "")
  }
  return fields
}

function skillNames(skillsDir) {
  if (!fs.existsSync(skillsDir)) return []
  return fs.readdirSync(skillsDir).filter((name) => fs.existsSync(path.join(skillsDir, name, "SKILL.md"))).sort()
}

async function installLayoutChecks(ctx, world, shared) {
  const { host, plugins } = world
  const desk = plugins.desk
  const skills = []
  const agents = []
  if (host === "copilot") {
    await check(ctx, "install.manifest_paths_exist", "install", () => {
      const manifest = readJson(path.join(desk, "plugin.json"))
      for (const key of ["agents", "skills", "hooks", "extensions", "mcpServers"]) {
        if (manifest[key] === undefined) continue
        assert(fs.existsSync(path.join(desk, manifest[key])), `plugin.json ${key} points at ${manifest[key]}, which is not installed`)
      }
      for (const [name, dep] of Object.entries(manifest.activation?.copilot?.dependencies ?? {})) {
        const depManifest = readJson(path.join(plugins[name], "plugin.json"))
        assert(depManifest.version === dep.version, `${name} is installed at ${depManifest.version} but Desk declares ${dep.version}`)
        if (depManifest.hooks) assert(fs.existsSync(path.join(plugins[name], depManifest.hooks)), `${name} hooks file is not installed`)
      }
      for (const [id, target] of Object.entries(manifest.activation?.copilot?.targets ?? {})) {
        assert(fs.existsSync(path.join(desk, target.source)), `${id} source ${target.source} is not installed`)
      }
    })
    await check(ctx, "install.skills_and_agents_load", "install", () => {
      const manifest = readJson(path.join(desk, "plugin.json"))
      for (const name of ["desk", ...Object.keys(manifest.activation?.copilot?.dependencies ?? {})]) {
        const depManifest = readJson(path.join(plugins[name], "plugin.json"))
        for (const skill of skillNames(path.join(plugins[name], depManifest.skills ?? "skills"))) skills.push(`${name}:${skill}`)
      }
      const agentDir = path.join(desk, manifest.agents)
      for (const file of fs.readdirSync(agentDir).filter((f) => f.endsWith(".agent.md"))) {
        const fields = frontmatter(fs.readFileSync(path.join(agentDir, file), "utf8"))
        assert(fields?.description, `${file} has no description in its frontmatter`)
        agents.push(fields.name ?? file.replace(/\.agent\.md$/u, ""))
      }
    })
  } else {
    await check(ctx, "install.manifest_paths_exist", "install", () => {
      const manifest = readJson(path.join(desk, ".claude-plugin", "plugin.json"))
      assert(fs.existsSync(path.join(desk, manifest.skills)), "skills folder is not installed")
      assert(fs.existsSync(path.join(desk, manifest.mcpServers)), "MCP config is not installed")
      for (const agent of manifest.agents) assert(fs.existsSync(path.join(desk, agent)), `agent ${agent} is not installed`)
      assert(fs.existsSync(path.join(desk, "hooks", "hooks.json")), "hooks/hooks.json is not installed")
      for (const dep of manifest.dependencies ?? []) {
        const depManifest = readJson(path.join(plugins[dep.name], ".claude-plugin", "plugin.json"))
        const [major, minor] = dep.version.replace(/^\^/u, "").split(".").map(Number)
        const [haveMajor, haveMinor] = depManifest.version.split(".").map(Number)
        assert(haveMajor === major && haveMinor >= minor, `${dep.name} ${depManifest.version} does not satisfy ${dep.version}`)
      }
    })
    await check(ctx, "install.skills_and_agents_load", "install", () => {
      const manifest = readJson(path.join(desk, ".claude-plugin", "plugin.json"))
      for (const name of ["desk", ...(manifest.dependencies ?? []).map((dep) => dep.name)]) {
        const depManifest = readJson(path.join(plugins[name], ".claude-plugin", "plugin.json"))
        for (const skill of skillNames(path.join(plugins[name], depManifest.skills ?? "skills"))) skills.push(`${name}:${skill}`)
      }
      for (const agent of manifest.agents) {
        const fields = frontmatter(fs.readFileSync(path.join(desk, agent), "utf8"))
        assert(fields?.description, `${agent} has no description in its frontmatter`)
        agents.push(fields.name ?? path.basename(agent, ".md"))
      }
    })
  }
  await check(ctx, "install.skill_frontmatter", "install", () => {
    for (const qualified of skills) {
      const [plugin, skill] = qualified.split(":")
      const fields = frontmatter(fs.readFileSync(path.join(plugins[plugin], "skills", skill, "SKILL.md"), "utf8"))
      assert(fields?.name && fields?.description !== undefined, `${qualified} SKILL.md lacks name or description frontmatter`)
    }
  })
  shared.surface[host] = { skills: [...new Set(skills)].sort(), agents: [...new Set(agents)].sort() }
}

// ---- hooks ----

async function sessionStartHooks(ctx, world, shared) {
  const events = EVENTS[world.host]
  const outputs = await check(ctx, "hook.session_start.runs", "hooks", async () => {
    const started = performance.now()
    let prompt = {}
    // Copilot runs userPromptSubmitted before sessionStart on a new session.
    if (world.host === "copilot") prompt = await runEvent(world, events.prompt, { prompt: "hello" }, ["desk"])
    const outputs = await runEvent(world, events.start, world.host === "copilot" ? { source: "new", initialPrompt: "hello" } : { source: "startup" })
    metric(ctx, "session_start_hooks_ms", performance.now() - started, "ms")
    for (const [key, result] of Object.entries({ ...outputs, ...Object.fromEntries(Object.entries(prompt).map(([k, v]) => [`prompt:${k}`, v])) })) assertHookOk(result, key)
    return { outputs, prompt }
  })
  if (!outputs) return
  const deskStart = outputs.outputs["desk#0"]
  const context = hookContext(deskStart?.stdout ?? "")
  shared.hooks[world.host] = { startContext: context, startMs: deskStart?.ms, pluginRoot: world.plugins.desk }
  metric(ctx, "desk_session_start_hook_ms", deskStart?.ms, "ms")
  metric(ctx, "desk_session_start_context_chars", context.length, "chars")
  await check(ctx, "hook.session_start.boot_direction", "hooks", () => {
    const head = context.slice(0, 2000)
    assert(context.length > 0, "the Desk session start gave the host no context")
    assert(head.includes(world.desk) || head.includes(fs.realpathSync(world.desk)) || head.includes(world.desk.split(path.sep).join("/")), `the first 2 KB do not name the bound desk ${world.desk}: ${head.slice(0, 400)}`)
    assert(/session-boot\.js|desk:session-start|session-start/u.test(head), "the first 2 KB do not give the boot as the next step")
    assert(context.includes("Desk RFC:"), "the context lacks the RFC pointer line")
  })
  await check(ctx, "hook.session_start.no_flood", "hooks", () => {
    // Claude Code shows only a 2 KB preview of context past 10,000 characters; both hosts get the same budget.
    assert(context.length <= 10000, `the Desk session start context is ${context.length} characters, over the 10,000 a host shows in full`)
  })
  await check(ctx, "hook.session_start.dependencies_inject", "hooks", () => {
    const plain = Object.entries(outputs.outputs).find(([key]) => key.startsWith("plain-language#"))
    const superpowers = Object.entries(outputs.outputs).find(([key]) => key.startsWith("superpowers#"))
    assert(plain && /plain/iu.test(hookContext(plain[1].stdout)), "plain-language gave no Plain Language context")
    assert(superpowers && /superpowers/iu.test(hookContext(superpowers[1].stdout) || superpowers[1].stdout), "superpowers gave no context")
  })
  if (world.host === "copilot") {
    await check(ctx, "hook.prompt.first_prompt_directs_boot", "hooks", () => {
      const first = hookContext(outputs.prompt["desk#0"].stdout)
      assert(first.length > 0, "the first prompt got no boot direction")
    })
    await check(ctx, "hook.prompt.later_prompts_quiet", "hooks", async () => {
      const again = await runEvent(world, EVENTS.copilot.prompt, { prompt: "and again" }, ["desk"])
      assertHookOk(again["desk#0"], "second prompt")
      assert(hookContext(again["desk#0"].stdout) === "", `a later prompt repeated the boot direction: ${again["desk#0"].stdout.slice(0, 200)}`)
    })
  }
  if (EVENTS[world.host].subagent) {
    await check(ctx, "hook.subagent_start.plain_language", "hooks", async () => {
      const out = await runEvent(world, EVENTS[world.host].subagent, { agent_type: "general-purpose" }, ["plain-language"])
      const entry = Object.values(out)[0]
      assert(entry, "no SubagentStart hook is registered")
      assertHookOk(entry, "SubagentStart")
      assert(/plain/iu.test(hookContext(entry.stdout)), "the subagent got no Plain Language context")
    })
  }
}

async function postToolHooks(ctx, world) {
  if (world.host !== "copilot") return
  await check(ctx, "hook.post_tool.skill_intake_context", "hooks", async () => {
    const extra = {
      toolName: "skill",
      toolArgs: JSON.stringify({ skill: "brainstorming" }),
      toolResult: { resultType: "success", textResultForLlm: 'Skill "brainstorming" loaded successfully. Follow the instructions in the skill context.' },
    }
    const matched = await runEvent(world, "postToolUse", extra, ["desk"])
    assertHookOk(matched["desk#0"], "postToolUse")
    assert(/intake/iu.test(hookContext(matched["desk#0"].stdout)), `brainstorming gave no intake context: ${matched["desk#0"].stdout.slice(0, 200)}`)
    const other = await runEvent(world, "postToolUse", { ...extra, toolArgs: JSON.stringify({ skill: "other" }) }, ["desk"])
    assertHookOk(other["desk#0"], "postToolUse other")
    assert(hookContext(other["desk#0"].stdout) === "", "another skill got the intake context")
  })
}

async function endHooks(ctx, world) {
  const events = EVENTS[world.host]
  await check(ctx, "hook.stop.runs", "hooks", async () => {
    const out = await runEvent(world, events.stop, world.host === "claude" ? { stop_hook_active: false } : {}, ["desk"])
    for (const [key, result] of Object.entries(out)) assertHookOk(result, key)
    metric(ctx, "stop_hook_ms", Math.max(...Object.values(out).map((r) => r.ms)), "ms")
  })
  await check(ctx, "hook.session_end.runs", "hooks", async () => {
    const out = await runEvent(world, events.end, world.host === "claude" ? { reason: "exit" } : { reason: "complete" }, ["desk"])
    assert(Object.keys(out).length >= 2, "expected the factory and sync session-end hooks")
    for (const [key, result] of Object.entries(out)) assertHookOk(result, key)
    metric(ctx, "session_end_hooks_ms", Object.values(out).reduce((sum, r) => sum + r.ms, 0), "ms")
  })
}

// ---- the Desk MCP server ----

async function deskServer(ctx, world, shared) {
  return check(ctx, "desk_server.handshake", "mcp", async () => {
    const launch = serverLaunch(world, "desk")
    const session = new McpSession({ ...launch, name: `${world.host} desk` })
    try {
      await session.handshake(world.host === "copilot" ? "github-copilot-cli" : "claude-code")
    } catch (error) {
      await session.close()
      throw error
    }
    metric(ctx, "desk_server_cold_start_ms", session.toolsListMs, "ms")
    metric(ctx, "desk_server_initialize_ms", session.initializeMs, "ms")
    shared.tools[world.host] = session.tools.map((tool) => ({ name: tool.name, inputSchema: tool.inputSchema })).sort((a, b) => a.name.localeCompare(b.name))
    return session
  })
}

async function deskTools(ctx, world, session, shared, options) {
  const call = (name, args, timeoutMs) => session.call(name, args, timeoutMs)
  const { desk, env } = world
  const exists = (rel) => fs.existsSync(path.join(desk, rel))
  const read = (rel) => fs.readFileSync(path.join(desk, rel), "utf8")
  const lastCommitFiles = () => git(desk, ["show", "--name-only", "--format=", "HEAD"], env)

  await check(ctx, "desk_server.lists_every_tool", "mcp", () => {
    const expected = EXPECTED_DESK_TOOLS(world.plugins.desk).sort()
    const names = session.tools.map((tool) => tool.name).sort()
    assert(JSON.stringify(names) === JSON.stringify(expected), `tools differ: got ${names.join(",")}`)
    for (const tool of session.tools) assert(tool.description?.length > 20 && tool.inputSchema?.type === "object", `${tool.name} lacks a description or an object schema`)
  })

  const ready = await check(ctx, "desk_status.ready", "mcp", async () => {
    const result = await waitFor(async () => {
      const status = await call("desk_status", {})
      // "ready" with detail_pending is documented: the root and search details are still loading.
      return { done: status.json?.state === "ready" && status.json?.detail_pending !== true && Boolean(status.json?.root?.path), detail: status.json ?? status.text }
    }, { timeoutMs: 60000, label: "desk_status ready" })
    metric(ctx, "desk_ready_ms", performance.now() - session.started, "ms")
    const status = await call("desk_status", {})
    assert(samePath(status.json.root.path, desk), `desk_status bound ${status.json.root.path}, not the session's desk ${desk}: ${JSON.stringify(status.json).slice(0, 900)}`)
    return result
  })
  if (!ready) return

  await check(ctx, "desk_status.detail", "mcp", async () => {
    const status = await call("desk_status", { detail: true })
    assert(!status.isError && status.json?.state === "ready", `detail status: ${status.text.slice(0, 200)}`)
    const version = readJson(path.join(world.plugins.desk, "plugin.json")).version
    const compact = await call("desk_status", {})
    const reported = compact.json?.plugin_version ?? status.json.runtime?.plugin_version ?? status.json.activation?.plugin_version
    assert(reported === version, `desk_status reports plugin_version ${JSON.stringify(reported)}, not the installed ${version}; compact: ${compact.text.slice(0, 300)}; runtime: ${JSON.stringify(status.json.runtime).slice(0, 300)}`)
  })
  await check(ctx, "desk_doctor.healthy", "mcp", async () => {
    const doctor = await call("desk_doctor", {})
    assert(!doctor.isError, `desk_doctor errored: ${doctor.text.slice(0, 300)}`)
    assert(/healthy|ready|ok/iu.test(doctor.text), `desk_doctor does not report a healthy runtime: ${doctor.text.slice(0, 300)}`)
    const preview = await call("desk_doctor", { format: "preview" })
    assert(!preview.isError, `desk_doctor preview errored: ${preview.text.slice(0, 300)}`)
  })
  await check(ctx, "desk_skill.lists_and_reads", "mcp", async () => {
    const list = await call("desk_skill", {})
    assert(!list.isError, list.text.slice(0, 200))
    for (const skill of shared.surface[world.host].skills.filter((s) => s.startsWith("desk:")).map((s) => s.slice(5))) {
      assert(list.text.includes(skill), `desk_skill does not list ${skill}`)
    }
    const one = await call("desk_skill", { name: "task-lifecycle" })
    const body = fs.readFileSync(path.join(world.plugins.desk, "skills", "task-lifecycle", "SKILL.md"), "utf8")
    const line = body.split("\n").find((l) => l.length > 40 && !l.startsWith("---") && !l.includes(":"))
    assert(!one.isError && one.text.includes(line.trim().slice(0, 30)), "desk_skill task-lifecycle did not return the skill's text")
    const missing = await call("desk_skill", { name: "no-such-skill" })
    assertPlainError(missing, "unknown skill")
  })

  // Tracks.
  await check(ctx, "track_create.writes_and_commits", "tools", async () => {
    const created = await call("track_create", { slug: "search-quality", title: "Search quality", scope: "making desk search find the right notes; not the browser" })
    assert(!created.isError, created.text.slice(0, 300))
    assert(exists("search-quality/track.md"), "search-quality/track.md was not written")
    assert(lastCommitFiles().includes("search-quality/track.md"), "track_create did not commit the track card")
    const second = await call("track_create", { slug: "garden-planning", title: "Garden planning", scope: "planting and watering plans; not travel" })
    assert(!second.isError && exists("garden-planning/track.md"), second.text.slice(0, 300))
  })
  await check(ctx, "track_update.appends", "tools", async () => {
    const updated = await call("track_update", { slug: "search-quality", body_append: "\n## Notes\n\nThe ranking favours recent cards.\n" })
    assert(!updated.isError, updated.text.slice(0, 300))
    assert(read("search-quality/track.md").includes("ranking favours recent cards"), "track_update did not write the body")
  })
  await check(ctx, "track_rename.moves", "tools", async () => {
    const renamed = await call("track_rename", { track: "garden-planning", to: "garden-schedule" })
    assert(!renamed.isError, renamed.text.slice(0, 300))
    assert(exists("garden-schedule/track.md") && !exists("garden-planning"), "track_rename did not move the track")
  })

  // Tasks.
  const token = `zephyrquartz${ctx.repeat}`
  await check(ctx, "task_create.writes", "tools", async () => {
    const created = await call("task_create", { track: "search-quality", slug: "rank-recent-cards-higher", title: "Rank recent cards higher", body: `## Goal\n\nMake recent cards rank higher; marker ${token}.\n` })
    assert(!created.isError, created.text.slice(0, 400))
    assert(exists("search-quality/rank-recent-cards-higher/task.md"), "task.md was not written")
    const card = read("search-quality/rank-recent-cards-higher/task.md")
    assert(/schema_version:\s*1/u.test(card) && card.includes(token), "task.md lacks its frontmatter or body")
    world.createdTask = true
    const other = await call("task_create", { track: "search-quality", slug: "drop-stale-index-files", title: "Drop stale index files" })
    assert(!other.isError, other.text.slice(0, 300))
    const third = await call("task_create", { track: "garden-schedule", slug: "water-the-tomatoes", title: "Water the tomatoes" })
    assert(!third.isError, third.text.slice(0, 300))
  })
  await check(ctx, "task_update.note_and_next_step", "tools", async () => {
    const updated = await call("task_update", { track: "search-quality", slug: "rank-recent-cards-higher", status: "processing", note: "Measured the current ranking.", next_step: "Try a recency boost." })
    assert(!updated.isError, updated.text.slice(0, 400))
    const card = read("search-quality/rank-recent-cards-higher/task.md")
    assert(card.includes("Measured the current ranking.") && card.includes("Try a recency boost."), "task_update did not record the note and next step")
  })
  await check(ctx, "task_focus.reads_card", "tools", async () => {
    const focused = await call("task_focus", { track: "search-quality", slug: "rank-recent-cards-higher" })
    assert(!focused.isError, focused.text.slice(0, 300))
    assert(focused.json?.next_step?.includes("recency boost") || focused.text.includes("recency boost"), "task_focus did not return the next step")
    const cleared = await call("task_focus", { clear: true })
    assert(!cleared.isError, cleared.text.slice(0, 300))
  })
  await check(ctx, "task_move.renames", "tools", async () => {
    const moved = await call("task_move", { track: "search-quality", slug: "drop-stale-index-files", to_slug: "remove-stale-index-files" })
    assert(!moved.isError, moved.text.slice(0, 300))
    assert(exists("search-quality/remove-stale-index-files/task.md") && !exists("search-quality/drop-stale-index-files"), "task_move did not move the card")
  })
  await check(ctx, "task_archive.cancelled", "tools", async () => {
    const archived = await call("task_archive", { track: "search-quality", slug: "remove-stale-index-files", outcome: "cancelled" })
    assert(!archived.isError, archived.text.slice(0, 300))
    assert(exists("search-quality/_archive/remove-stale-index-files/task.md") && !exists("search-quality/remove-stale-index-files"), "task_archive did not move the card into _archive")
  })
  await check(ctx, "task_signoff.refuses_undelivered", "tools", async () => {
    const signoff = await call("task_signoff", { track: "garden-schedule", slug: "water-the-tomatoes", outcome: "accepted" })
    assertPlainError(signoff, "signoff of an undelivered task")
    assert(!read("garden-schedule/water-the-tomatoes/task.md").includes("signoff:") || !/accepted/u.test(read("garden-schedule/water-the-tomatoes/task.md")), "a refused signoff still wrote the card")
  })

  // Friction, lessons, improvements.
  await check(ctx, "friction_add.setup", "tools", async () => {
    const added = await call("friction_add", { body: "The search index rebuild blocked the session for a minute." })
    assert(!added.isError, added.text.slice(0, 300))
    assert(read("_meta/friction.md").includes("blocked the session for a minute"), "friction_add did not write _meta/friction.md")
  })
  await check(ctx, "friction_add.system_opens_card", "tools", async () => {
    const added = await call("friction_add", { about: "system", title: "Boot output repeats the task list", body: "The boot listed every task twice.", friction_class: "skill" })
    assert(!added.isError, added.text.slice(0, 300))
    assert(/improvement|card|key/iu.test(added.text), `system friction did not report its improvement card: ${added.text.slice(0, 300)}`)
  })
  await check(ctx, "lesson_add.writes", "tools", async () => {
    const added = await call("lesson_add", { topic: "search-ranking", body: "Recency matters more than length." })
    assert(!added.isError, added.text.slice(0, 300))
    assert(exists("_meta/tips/search-ranking.md") && read("_meta/tips/search-ranking.md").includes("Recency matters"), "lesson_add did not write the tip")
  })
  let card
  await check(ctx, "improvement_open.opens", "tools", async () => {
    const opened = await call("improvement_open", { source: "friction_candidate", id: "0123456789abcdef".repeat(2), evidence: ["fingerprint:abcdef0123456789"] })
    assert(!opened.isError && opened.json?.status === "ok", `improvement_open: ${opened.text.slice(0, 300)}`)
    card = opened.json
  })
  await check(ctx, "improvement_next_and_update", "tools", async () => {
    const next = await call("improvement_next", { session: world.sessionId })
    assert(!next.isError || next.json?.status, `improvement_next: ${next.text.slice(0, 300)}`)
    if (next.json?.claim_id) {
      const updated = await call("improvement_update", { key: next.json.key ?? next.json.card?.key, claim_id: next.json.claim_id, state: "open" })
      assert(!updated.isError && updated.json?.status === "updated", `improvement_update: ${updated.text.slice(0, 300)} after improvement_next ${next.text.slice(0, 400)}`)
    } else {
      // Documented refusals carry a status and a one-line meaning.
      assert(typeof next.json?.status === "string" && typeof next.json?.meaning === "string", `improvement_next gave neither a claim nor a documented refusal: ${next.text.slice(0, 300)}`)
      const refused = await call("improvement_update", { key: card?.key ?? "friction_candidate:aaaaaaaaaaaaaaaa", claim_id: randomUUID(), state: "open" })
      assert(refused.json?.status === "refused" || refused.isError, `improvement_update without a claim was not refused: ${refused.text.slice(0, 300)}`)
    }
  })

  // Saving files.
  await check(ctx, "desk_save.commits_exact_paths", "git", async () => {
    fs.mkdirSync(path.join(desk, "search-quality", "rank-recent-cards-higher"), { recursive: true })
    fs.writeFileSync(path.join(desk, "search-quality", "rank-recent-cards-higher", "planning.md"), `# Plan\n\nBoost cards edited this week; planning marker ${token}.\n`)
    fs.writeFileSync(path.join(desk, "garden-schedule", "unsaved.md"), "not saved\n")
    const saved = await call("desk_save", { paths: ["search-quality/rank-recent-cards-higher/planning.md"], message: "Plan the recency boost" })
    assert(!saved.isError, saved.text.slice(0, 300))
    const files = lastCommitFiles()
    assert(files.includes("planning.md") && !files.includes("unsaved.md"), `desk_save committed ${files}`)
    const again = await call("desk_save", { paths: ["search-quality/rank-recent-cards-higher/planning.md"], message: "again" })
    assert(/nothing_to_commit/u.test(again.text), `a second save of an unchanged file did not answer nothing_to_commit: ${again.text.slice(0, 200)}`)
    const card = await call("desk_save", { paths: ["search-quality/rank-recent-cards-higher/task.md"], message: "edit card" })
    assertPlainError(card, "desk_save of a task card")
    for (const [name, text] of Object.entries(NOTES)) fs.writeFileSync(path.join(desk, "garden-schedule", "water-the-tomatoes", name), text)
    const notes = await call("desk_save", { paths: Object.keys(NOTES).map((name) => `garden-schedule/water-the-tomatoes/${name}`), message: "Add notes" })
    assert(!notes.isError && Object.keys(NOTES).every((name) => lastCommitFiles().includes(name)), `desk_save of several notes: ${notes.text.slice(0, 200)}`)
    const outside = await call("desk_save", { paths: ["../outside.md"], message: "escape" })
    assertPlainError(outside, "desk_save outside the desk")
    fs.renameSync(path.join(desk, "garden-schedule", "unsaved.md"), path.join(world.root, "unsaved.md"))
  })

  // Search.
  await check(ctx, "desk_search.exact_word_at_once", "search", async () => {
    const result = await waitFor(async () => {
      const found = await call("desk_search", { query: token })
      return { done: resultPaths(found).some((p) => p.includes("rank-recent-cards-higher")), detail: found.text.slice(0, 300) }
    }, { timeoutMs: 15000, intervalMs: 200, label: "exact-word search finds the new task" })
    metric(ctx, "exact_word_findable_ms", result.ms, "ms")
  })
  await check(ctx, "desk_search.scope_and_filters", "search", async () => {
    const archived = await call("desk_search", { query: "stale index", scope: "archived" })
    assert(!archived.isError, archived.text.slice(0, 200))
    assert(resultPaths(archived).every((p) => p.includes("_archive")), `archived scope returned live paths: ${resultPaths(archived).join(", ")}`)
  })
  await check(ctx, "desk_timeline.lists", "search", async () => {
    const timeline = await call("desk_timeline", { limit: 20 })
    assert(!timeline.isError && resultPaths(timeline).length > 0, `desk_timeline: ${timeline.text.slice(0, 300)}`)
  })
  await check(ctx, "desk_thread.walks_or_says_not_indexed", "search", async () => {
    const thread = await call("desk_thread", { start_path: "search-quality/rank-recent-cards-higher/task.md" })
    assert(!thread.isError || /not_indexed/u.test(thread.text), `desk_thread: ${thread.text.slice(0, 300)}`)
  })
  await check(ctx, "desk_reindex.converges", "search", async () => {
    const reindex = await call("desk_reindex", {}, 45000)
    assert(!reindex.isError, `desk_reindex: ${reindex.text.slice(0, 300)}`)
  })
  await check(ctx, "desk_recall.by_meaning", "search", async () => {
    // No word in common with the garden note: only meaning can find it.
    const result = await waitFor(async () => {
      const recall = await call("desk_recall", { topic: "vegetable plants and irrigation" })
      const paths = resultPaths(recall)
      const { results: _results, ...rest } = recall.json ?? {}
      const semantic = recall.json?.semantic_unavailable !== true && !/exact words|getting ready|preparing/iu.test(JSON.stringify(rest))
      return { done: semantic && paths.slice(0, 3).some((p) => p.includes("gardening")), detail: { paths: paths.slice(0, 3), rest } }
    }, { timeoutMs: options.semanticTimeoutMs, intervalMs: 1000, label: "meaning-based recall finds the garden note" })
    metric(ctx, "first_meaning_recall_ms", performance.now() - session.started, "ms")
    metric(ctx, "meaning_recall_wait_ms", result.ms, "ms")
  })
  await check(ctx, "desk_status.search_ready_wording", "search", async () => {
    const status = await call("desk_status", { detail: true })
    assert(status.text.includes("Search is ready."), `desk_status does not say "Search is ready." once meaning-based search works: ${status.text.slice(0, 300)}`)
  })
  await check(ctx, "desk_similar.finds_neighbours", "search", async () => {
    const similar = await call("desk_similar", { path: "garden-schedule/water-the-tomatoes/gardening.md" })
    assert(!similar.isError, `desk_similar: ${similar.text.slice(0, 300)}`)
    assert(!resultPaths(similar).includes("garden-schedule/water-the-tomatoes/gardening.md"), "desk_similar returned the seed itself")
    assert(resultPaths(similar).length > 0, `desk_similar returned nothing: ${similar.text.slice(0, 200)}`)
  })

  // Plain errors for bad input.
  await check(ctx, "errors.plain_messages", "errors", async () => {
    assertPlainError(await call("task_create", { track: "search-quality", slug: "Bad Slug!!", title: "x" }), "bad slug")
    assertPlainError(await call("task_create", { track: "search-quality" }), "missing fields")
    assertPlainError(await call("task_update", { track: "search-quality", slug: "no-such-task-here", note: "x" }), "unknown task")
    assertPlainError(await call("track_create", { slug: "misc", title: "Misc", scope: "everything" }), "catch-all track")
    assertPlainError(await call("desk_similar", { path: "no/such/file.md" }), "unknown path")
    assertPlainError(await call("no_such_tool", {}), "unknown tool")
  })

  await postToolHooks(ctx, world)

  // Git writes reach the remote.
  await check(ctx, "git.commits_reach_remote", "git", async () => {
    const local = git(desk, ["rev-parse", "HEAD"], env)
    const count = Number(git(desk, ["rev-list", "--count", "HEAD"], env))
    assert(count >= 8, `expected the tools to have committed, found ${count} commits`)
    const result = await waitFor(async () => {
      let remoteHead = ""
      try { remoteHead = git(world.root, ["--git-dir", world.remote, "rev-parse", "main"], env) } catch { /* not yet */ }
      return { done: remoteHead === local, detail: { remoteHead, local } }
    }, { timeoutMs: 60000, intervalMs: 500, label: "Desk pushes its commits to the remote" })
    metric(ctx, "push_reaches_remote_ms", result.ms, "ms")
    const clone = path.join(world.root, "readback")
    git(world.root, ["clone", "-q", world.remote, clone], env)
    assert(fs.existsSync(path.join(clone, "search-quality", "rank-recent-cards-higher", "planning.md")), "the remote clone lacks the saved planning doc")
    assert(fs.existsSync(path.join(clone, "garden-schedule", "track.md")), "the remote clone lacks the renamed track")
  })
}

// ---- boot script ----

async function bootScript(ctx, world) {
  await check(ctx, "boot.next_step_no_flood", "boot", async () => {
    const env = hookEnv(world, world.plugins.desk)
    const started = performance.now()
    let output
    try {
      output = execFileSync(process.execPath, [path.join(world.plugins.desk, "mcp", "scripts", "session-boot.js")], { cwd: world.desk, env, encoding: "utf8", timeout: 90000, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] })
    } catch (error) {
      throw new Error(`the boot script failed (${error.status}): ${String(error.stderr ?? error.message).slice(0, 400)}`)
    }
    metric(ctx, "boot_ms", performance.now() - started, "ms")
    const lines = output.trim().split(/\r?\n/u)
    metric(ctx, "boot_lines", lines.length, "lines")
    assert(/ready|degraded|setup_required/iu.test(lines[0]), `the first line is not the status line: ${lines[0]}`)
    if (world.createdTask) assert(output.includes("rank-recent-cards-higher"), "the boot does not list the active task")
    assert(!output.includes("remove-stale-index-files"), "the boot lists an archived task")
    assert(lines.length <= 200 && output.length <= 20000, `the boot output floods: ${lines.length} lines, ${output.length} characters`)
  })
}

// ---- the browser server ----

async function webServer(ctx, world, options) {
  const page = http.createServer((request, response) => {
    response.setHeader("content-type", "text/html")
    response.end("<title>Blackbox page</title><button>Press me</button>")
  })
  await new Promise((resolve) => page.listen(0, "127.0.0.1", resolve))
  const url = `http://127.0.0.1:${page.address().port}/`
  const session = await check(ctx, "desk_web.handshake", "browser", async () => {
    const s = new McpSession({ ...serverLaunch(world, "desk-web"), name: `${world.host} desk-web` })
    await s.handshake(world.host)
    metric(ctx, "web_server_cold_start_ms", s.toolsListMs, "ms")
    const names = s.tools.map((tool) => tool.name).sort()
    assert(JSON.stringify(names) === JSON.stringify(["browser_command", "browser_context"]), `desk-web tools: ${names}`)
    return s
  })
  if (!session) {
    page.close()
    return
  }
  try {
    for (const browser of options.mine ? ["fresh", "mine"] : ["fresh"]) {
      await check(ctx, `browser.${browser}.open_use_close`, "browser", async () => {
        const started = performance.now()
        const opened = await session.call("browser_context", { action: "open", browser }, 240000)
        assert(!opened.isError && opened.json?.contextId, `open ${browser}: ${opened.text.slice(0, 400)}`)
        metric(ctx, `browser_${browser}_open_ms`, performance.now() - started, "ms")
        const { contextId } = opened.json
        try {
          const goto = await session.call("browser_command", { contextId, args: ["goto", url] }, 60000)
          assert(!goto.isError && goto.text.includes("Blackbox page"), `goto: ${goto.text.slice(0, 300)}`)
          const snapshot = await session.call("browser_command", { contextId, args: ["snapshot"] }, 60000)
          assert(/button "Press me"/u.test(snapshot.text), `snapshot: ${snapshot.text.slice(0, 300)}`)
        } finally {
          const closed = await session.call("browser_context", { action: "close", contextId }, 60000)
          assert(!closed.isError, `close: ${closed.text.slice(0, 300)}`)
        }
        const after = await session.call("browser_command", { contextId, args: ["snapshot"] }, 30000)
        assertPlainError(after, "a command on a closed browser")
      })
    }
    await check(ctx, "browser.bad_context_plain_error", "errors", async () => {
      assertPlainError(await session.call("browser_command", { contextId: randomUUID(), args: ["snapshot"] }), "unknown contextId")
      assertPlainError(await session.call("browser_context", { action: "explode" }), "bad action")
    })
  } finally {
    const info = await session.close()
    metric(ctx, "web_server_peak_rss_mib", session.rss.peakKiB / 1024, "MiB")
    await check(ctx, "desk_web.exits_on_stdin_close", "browser", () => assert(!info.forced, `desk-web needed a signal to exit (${JSON.stringify(info)})`))
    page.close()
  }
}

// ---- parity ----

function median(values) {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted.length === 0 ? null : sorted[Math.floor((sorted.length - 1) / 2)]
}

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b)
  if (sorted.length === 0) return null
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]
}

function parityChecks(shared, hosts) {
  if (!(hosts.includes("copilot") && hosts.includes("claude"))) return
  const add = (id, ok, detail) => parity.push({ id, ok, detail })
  const [cop, cla] = [shared.tools.copilot, shared.tools.claude]
  if (cop && cla) {
    const copNames = cop.map((t) => t.name)
    const claNames = cla.map((t) => t.name)
    add("tools.same_list", JSON.stringify(copNames) === JSON.stringify(claNames), `copilot ${copNames.length}, claude ${claNames.length}; only claude: ${claNames.filter((n) => !copNames.includes(n)).join(",") || "none"}; only copilot: ${copNames.filter((n) => !claNames.includes(n)).join(",") || "none"}`)
    const differing = cop.filter((tool) => JSON.stringify(tool.inputSchema) !== JSON.stringify(cla.find((t) => t.name === tool.name)?.inputSchema)).map((t) => t.name)
    add("tools.same_schemas", differing.length === 0, differing.length ? `schemas differ: ${differing.join(",")}` : "identical")
  } else add("tools.same_list", false, `a host never listed its tools (copilot ${Boolean(cop)}, claude ${Boolean(cla)})`)

  const [sc, sl] = [shared.surface.copilot, shared.surface.claude]
  if (sc && sl) {
    const missingSkills = sl.skills.filter((s) => !sc.skills.includes(s))
    add("skills.copilot_has_every_claude_skill", missingSkills.length === 0, missingSkills.length ? `missing on Copilot: ${missingSkills.join(", ")}` : `${sc.skills.length} skills on Copilot, ${sl.skills.length} on Claude`)
    const extra = sc.skills.filter((s) => !sl.skills.includes(s))
    if (extra.length) add("skills.claude_has_every_copilot_skill", false, `missing on Claude: ${extra.join(", ")}`)
    const missingAgents = sl.agents.filter((a) => !sc.agents.includes(a))
    add("agents.copilot_has_every_claude_agent", missingAgents.length === 0, missingAgents.length ? `missing on Copilot: ${missingAgents.join(", ")}` : sc.agents.join(", "))
  }

  const [hc, hl] = [shared.hooks.copilot, shared.hooks.claude]
  if (hc && hl) {
    // Each host installs the plugin in its own folder, so the plugin root and the session's temp folder are named alike first.
    const strip = (text, pluginRoot) => text.split(pluginRoot).join("<plugin>").replace(/\\/gu, "/").split(pluginRoot.replace(/\\/gu, "/")).join("<plugin>").replace(/\/[^\s"'`]*r\d+-(copilot|claude)/gu, "<root>")
    const firstLine = (hook) => strip(hook.startContext.split("\n")[0], hook.pluginRoot)
    const [a, b] = [firstLine(hc), firstLine(hl)]
    let at = 0
    while (at < a.length && a[at] === b[at]) at++
    add("hooks.same_startup_line", a === b, a === b ? a.slice(0, 160) : `differs at character ${at}: copilot "…${a.slice(Math.max(0, at - 40), at + 120)}" / claude "…${b.slice(Math.max(0, at - 40), at + 120)}"`)
    add("hooks.copilot_context_not_smaller", hc.startContext.length >= hl.startContext.length * 0.9, `copilot ${hc.startContext.length} chars, claude ${hl.startContext.length} chars`)
  }
  // Every hook event a plugin registers for Claude Code should have its Copilot counterpart registered too.
  const counterpart = { SessionStart: "sessionStart", SessionEnd: "sessionEnd", Stop: "agentStop", UserPromptSubmit: "userPromptSubmitted", PreToolUse: "preToolUse", PostToolUse: "postToolUse", SubagentStart: "subagentStart", SubagentStop: "subagentStop" }
  for (const plugin of ["desk", "superpowers", "plain-language"]) {
    const dir = path.join(shared.pluginsSource, plugin, "hooks")
    const claudeEvents = fs.existsSync(path.join(dir, "hooks.json")) ? Object.keys(readJson(path.join(dir, "hooks.json")).hooks) : []
    const copilotEvents = fs.existsSync(path.join(dir, "copilot-hooks.json")) ? Object.keys(readJson(path.join(dir, "copilot-hooks.json")).hooks) : []
    const missing = claudeEvents.filter((event) => !copilotEvents.includes(counterpart[event] ?? event))
    add(`hooks.${plugin}.copilot_has_every_claude_event`, missing.length === 0, missing.length ? `${plugin} registers ${missing.join(", ")} for Claude Code but no Copilot counterpart (${missing.map((e) => counterpart[e] ?? e).join(", ")})` : `Claude: ${claudeEvents.join(", ")}; Copilot: ${copilotEvents.join(", ")}`)
  }

  // Reliability and speed.
  const byHost = (host) => results.filter((r) => r.host === host)
  const fails = (host) => byHost(host).filter((r) => !r.ok && !r.known).length
  add("reliability.copilot_not_worse", fails("copilot") <= fails("claude"), `unexpected failures: copilot ${fails("copilot")}, claude ${fails("claude")}`)
  const ids = [...new Set(results.map((r) => r.id))]
  for (const id of ids) {
    const c = byHost("copilot").filter((r) => r.id === id)
    const l = byHost("claude").filter((r) => r.id === id)
    if (c.length && l.length && c.some((r) => !r.ok) && l.every((r) => r.ok)) add(`reliability.${id}`, false, "fails on Copilot, passes on Claude")
  }
  for (const name of ["desk_server_cold_start_ms", "desk_ready_ms", "desk_session_start_hook_ms", "web_server_cold_start_ms", "boot_ms", "first_meaning_recall_ms"]) {
    const c = median(metrics.filter((m) => m.host === "copilot" && m.name === name).map((m) => m.value))
    const l = median(metrics.filter((m) => m.host === "claude" && m.name === name).map((m) => m.value))
    if (c === null || l === null) continue
    // Slower only past noise: 50% and 300 ms both.
    add(`speed.${name}`, !(c > l * 1.5 && c - l > 300), `copilot p50 ${Math.round(c)} ms, claude p50 ${Math.round(l)} ms`)
  }
}

// ---- reporting ----

function summarize(options, shared, wallMs) {
  const checks = {}
  for (const r of results) {
    const key = `${r.host} ${r.id}`
    checks[key] ??= { host: r.host, id: r.id, area: r.area, runs: 0, passed: 0, failed: 0, ms: [], known: r.known, errors: [] }
    const entry = checks[key]
    entry.runs += 1
    entry[r.ok ? "passed" : "failed"] += 1
    entry.ms.push(r.ms)
    if (r.error && entry.errors.length < 3) entry.errors.push(r.error)
  }
  const checkRows = Object.values(checks).map((c) => ({ ...c, p50_ms: median(c.ms), p95_ms: percentile(c.ms, 95), ms: undefined }))
  const metricRows = {}
  for (const m of metrics) {
    const key = `${m.host} ${m.name}`
    metricRows[key] ??= { host: m.host, name: m.name, unit: m.unit, values: [] }
    metricRows[key].values.push(m.value)
  }
  const metricList = Object.values(metricRows).map((m) => ({ ...m, p50: median(m.values), p95: percentile(m.values, 95), max: Math.max(...m.values) }))
  const unexpected = checkRows.filter((c) => c.failed > 0 && !c.known)
  const flaky = checkRows.filter((c) => c.failed > 0 && c.passed > 0)
  for (const p of parity) if (KNOWN[`parity:${p.id}`]) p.known = KNOWN[`parity:${p.id}`]
  const parityFailures = parity.filter((p) => !p.ok && !p.known)
  return {
    schemaVersion: 1,
    label: options.label,
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    desk_version: readJson(path.join(options.plugins, "desk", "plugin.json")).version,
    git_head: (() => { try { return git(repoRoot, ["rev-parse", "HEAD"]) } catch { return null } })(),
    started_at: shared.startedAt,
    wall_ms: wallMs,
    repeat: options.repeat,
    caches_seeded: shared.seeded,
    npm_registry: shared.npmRegistry ?? "default",
    totals: {
      runs: results.length,
      passed: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).length,
      known_failures: results.filter((r) => !r.ok && r.known).length,
      unexpected_failures: unexpected.length,
      flaky_checks: flaky.length,
      parity_gaps: parity.filter((p) => !p.ok).length,
      unexpected_parity_gaps: parity.filter((p) => !p.ok && !KNOWN[`parity:${p.id}`]).length,
    },
    ok: unexpected.length === 0 && parityFailures.length === 0,
    checks: checkRows,
    metrics: metricList,
    parity,
    known: KNOWN,
  }
}

function markdown(summary) {
  const fmt = (v, unit = "ms") => (v === null || v === undefined ? "–" : unit === "ms" ? `${Math.round(v)}` : `${Math.round(v * 10) / 10}`)
  const lines = [
    `# Desk black-box run: ${summary.label}`,
    "",
    `Desk ${summary.desk_version} at ${summary.git_head?.slice(0, 12) ?? "unknown"}, Node ${summary.node}, ${summary.repeat} repeat(s), ${Math.round(summary.wall_ms / 1000)} s wall. Caches seeded: ${JSON.stringify(summary.caches_seeded)}.`,
    "",
    `**${summary.ok ? "PASS" : "FAIL"}**: ${summary.totals.passed} of ${summary.totals.runs} check runs passed; ${summary.totals.unexpected_failures} unexpected failure(s), ${summary.totals.known_failures} known, ${summary.totals.flaky_checks} flaky, ${summary.totals.parity_gaps} parity gap(s) (${summary.totals.unexpected_parity_gaps} not known).`,
    "",
    "## Measurements",
    "",
    "| Measure | Copilot p50 | Copilot p95 | Claude p50 | Claude p95 | Unit |",
    "| --- | --- | --- | --- | --- | --- |",
  ]
  const names = [...new Set(summary.metrics.map((m) => m.name))]
  for (const name of names) {
    const c = summary.metrics.find((m) => m.name === name && m.host === "copilot")
    const l = summary.metrics.find((m) => m.name === name && m.host === "claude")
    const unit = (c ?? l).unit
    lines.push(`| ${name} | ${fmt(c?.p50, unit)} | ${fmt(c?.p95, unit)} | ${fmt(l?.p50, unit)} | ${fmt(l?.p95, unit)} | ${unit} |`)
  }
  lines.push("", "## Parity", "", "| Check | Result | Detail |", "| --- | --- | --- |")
  for (const p of summary.parity) lines.push(`| ${p.id} | ${p.ok ? (p.known ? "same (was known)" : "same") : p.known ? "GAP (known)" : "GAP"} | ${p.detail.replace(/\|/gu, "/")} |`)
  lines.push("", "## Checks", "", "| Check | Area | Copilot | Claude | Copilot p50 ms | Claude p50 ms |", "| --- | --- | --- | --- | --- | --- |")
  const ids = [...new Set(summary.checks.map((c) => c.id))]
  for (const id of ids) {
    const c = summary.checks.find((x) => x.id === id && x.host === "copilot")
    const l = summary.checks.find((x) => x.id === id && x.host === "claude")
    const cell = (x) => (x === undefined ? "–" : `${x.passed}/${x.runs}${x.failed ? (x.known ? " known" : " FAIL") : ""}`)
    lines.push(`| ${id} | ${(c ?? l).area} | ${cell(c)} | ${cell(l)} | ${fmt(c?.p50_ms)} | ${fmt(l?.p50_ms)} |`)
  }
  const failing = summary.checks.filter((c) => c.failed > 0)
  if (failing.length) {
    lines.push("", "## Failures", "")
    for (const f of failing) lines.push(`- ${f.host} ${f.id}${f.known ? ` (known: ${f.known})` : ""}: ${f.errors[0]?.replace(/\s+/gu, " ").slice(0, 300)}`)
  }
  return `${lines.join("\n")}\n`
}

// ---- cleanup of processes this run started ----

function processesUnder(tempRoot) {
  try {
    const out = WINDOWS
      ? execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Get-CimInstance Win32_Process | ForEach-Object { \"$($_.ProcessId)`t$($_.CommandLine)\" }"], { encoding: "utf8", windowsHide: true, maxBuffer: 16 * 1024 * 1024 })
      : execFileSync("ps", ["-A", "-o", "pid=,command="], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 })
    const needle = [tempRoot, tempRoot.split(path.sep).join("/")]
    return out.split(/\r?\n/u).map((line) => /^\s*(\d+)\s+(.*)$/u.exec(line)).filter(Boolean)
      .filter((m) => Number(m[1]) !== process.pid && needle.some((n) => m[2].includes(n))).map((m) => ({ pid: Number(m[1]), command: m[2] }))
  } catch {
    return []
  }
}

async function cleanup(tempRoot, keep) {
  // Detached helpers Desk started for this run's throwaway homes (factory delivery, sync, readiness) carry the temp root in their command line.
  let left = processesUnder(tempRoot)
  for (const { pid } of left) { try { process.kill(pid, "SIGTERM") } catch { /* gone */ } }
  if (left.length) await sleep(1500)
  for (const { pid } of processesUnder(tempRoot)) { try { process.kill(pid, "SIGKILL") } catch { /* gone */ } }
  left = processesUnder(tempRoot)
  if (!keep) {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        fs.rmSync(tempRoot, { recursive: true, force: true })
        break
      } catch {
        await sleep(1000)
      }
    }
  }
  return left
}

async function warmUp(options, tempRoot) {
  const root = path.join(tempRoot, "warm-up")
  fs.mkdirSync(root, { recursive: true })
  const home = makeHome(root)
  const env = personEnv(home)
  const { desk } = makeDesk({ root, env })
  const session = new McpSession({ command: process.execPath, args: [path.join(options.plugins, "desk", "mcp", "bootstrap.cjs")], cwd: desk, env: { ...env, DESK: desk }, name: "warm-up" })
  try {
    await session.handshake("warm-up")
    await session.call("desk_status", {})
  } catch (error) {
    console.log(`warm-up start failed (not a check): ${error.message.slice(0, 200)}`)
  } finally {
    await session.close()
  }
}

// ---- main ----

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const tempRoot = makeTempRoot()
  const shared = { tempRoot, pluginsSource: options.plugins, tools: {}, surface: {}, hooks: {}, unpushed: {}, seeded: {}, startedAt: new Date().toISOString() }
  try {
    const registry = execFileSync(WINDOWS ? "npm.cmd" : "npm", ["config", "get", "registry"], { encoding: "utf8", shell: WINDOWS, windowsHide: true, timeout: 20000 }).trim()
    if (/^https?:\/\//u.test(registry) && !/registry\.npmjs\.org/u.test(registry)) shared.npmRegistry = registry
  } catch { /* npm's default registry */ }
  const started = performance.now()
  console.log(`Desk black-box tester: ${options.hosts.join(" and ")}, ${options.repeat} repeat(s), temp ${tempRoot}`)
  let leftover = []
  try {
    // One untimed start first, so the first host measured does not alone pay for a cold machine (Node, Git and the disk cache).
    await warmUp(options, tempRoot)
    for (let repeat = 1; repeat <= options.repeat; repeat++) {
      // Alternate the order so neither host always runs first on a cold machine.
      const order = repeat % 2 === 1 ? options.hosts : [...options.hosts].reverse()
      for (const host of order) {
        const before = results.length
        await hostSession(options, host, repeat, shared)
        shared.seeded[`${host}#${repeat}`] = shared.lastSeeded
        const run = results.slice(before)
        console.log(`[${host} #${repeat}] ${run.filter((r) => r.ok).length}/${run.length} checks passed`)
      }
    }
  } finally {
    leftover = await cleanup(tempRoot, options.keep)
  }
  parityChecks(shared, options.hosts)
  const summary = summarize(options, shared, performance.now() - started)
  summary.leftover_processes = leftover.map((p) => p.command.slice(0, 200))
  if (leftover.length) summary.ok = false
  fs.mkdirSync(options.out, { recursive: true })
  const base = path.join(options.out, `blackbox-${options.label}`)
  fs.writeFileSync(`${base}.json`, `${JSON.stringify(summary, null, 2)}\n`)
  fs.writeFileSync(`${base}.md`, markdown(summary))
  console.log(markdown(summary))
  console.log(`Wrote ${base}.json and ${base}.md`)
  if (leftover.length) console.log(`Processes still running after cleanup: ${leftover.map((p) => p.pid).join(", ")}`)
  process.exitCode = summary.ok ? 0 : 1
}

await main()
