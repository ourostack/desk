// Per-worker `agent_type` and `requested_model`: the local and published schemas,
// the publish rule that keeps a private agent type private, and the host list.

import { test } from "node:test"
import { strict as assert } from "node:assert"
import { readFileSync } from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

import { BUILTIN_AGENT_TYPES, CUSTOM_AGENT_TYPE, publishedAgentType } from "../../../../../plugins/desk/mcp/src/factory/agent-types.js"
import { ENUMS, validateLocalFacts } from "../../../../../plugins/desk/mcp/src/factory/schema.js"
import { validatePublished, validatePublishedBytes } from "../../../../../plugins/desk/mcp/src/factory/published-schema.js"
import { toPublished, serializePublished } from "../../../../../plugins/desk/mcp/src/factory/publish.js"

const here = path.dirname(fileURLToPath(import.meta.url))
const LOCAL_GOLDEN = JSON.parse(readFileSync(path.join(here, "fixtures", "local-golden.json"), "utf8"))
const SENTINEL = "SENTINEL-7f3a"
const visibility = (repo) => (repo === "ourostack/desk" || repo === "acme/public-plugin" ? "public" : "private")

function local(agents) {
  const value = structuredClone(LOCAL_GOLDEN)
  if (agents) value.agents = agents
  return value
}

const agentsWith = (first, second = {}) => [
  { n: 0, parent: null, model: "claude-opus-5-5", ...first },
  { n: 1, parent: 0, model: "claude-sonnet-5", ...second },
]

const errorsOf = (result) => result.errors.map((error) => `${error.code}:${error.path}`)

// --- Schema, local -----------------------------------------------------------

test("a file with no agent_type or requested_model still validates, locally and published", () => {
  assert.deepEqual(validateLocalFacts(local()), { ok: true, errors: [] })
  const { published } = toPublished(local(), { visibility, deskVisibility: "private" })
  assert.deepEqual(validatePublished(published), { ok: true, errors: [] })
  assert.equal(published.agents.some((agent) => Object.hasOwn(agent, "agent_type") || Object.hasOwn(agent, "requested_model")), false)
})

test("local facts accept agent_type and requested_model", () => {
  const value = local(agentsWith({ agent_type: "general-purpose" }, { agent_type: "plugin:My_Agent.v2", requested_model: "sonnet" }))
  assert.deepEqual(validateLocalFacts(value), { ok: true, errors: [] })
  value.agents[0].requested_model = "claude-opus-5-5"
  assert.deepEqual(validateLocalFacts(value), { ok: true, errors: [] })
})

for (const [key, bad] of [
  ["agent_type", ""], ["agent_type", ":x"], ["agent_type", "a b"], ["agent_type", "a".repeat(65)], ["agent_type", 7], ["agent_type", `${SENTINEL}/x`],
  ["requested_model", ""], ["requested_model", "bad model"], ["requested_model", "m".repeat(81)], ["requested_model", null],
]) {
  test(`local facts reject ${key} ${JSON.stringify(bad).slice(0, 20)}`, () => {
    const result = validateLocalFacts(local(agentsWith({ [key]: bad })))
    assert.equal(result.ok, false)
    assert.ok(errorsOf(result).some((entry) => entry.endsWith(`agents.0.${key}`)), errorsOf(result).join())
    assert.equal(JSON.stringify(result).includes(SENTINEL), false)
  })
}

test("local facts still reject an unknown agent key", () => {
  assert.deepEqual(errorsOf(validateLocalFacts(local(agentsWith({ surprise: "x" })))), ["unknown_key:agents.0"])
})

test("codex-cli is a known host", () => {
  assert.ok(ENUMS.host.includes("codex-cli"))
  const value = local()
  value.session.host = "codex-cli"
  assert.deepEqual(validateLocalFacts(value), { ok: true, errors: [] })
  const { published } = toPublished(value, { visibility, deskVisibility: "private" })
  assert.equal(published.session.host, "codex-cli")
  assert.deepEqual(validatePublished(published), { ok: true, errors: [] })
})

// --- Schema, published -------------------------------------------------------

function publishedWith(agents) {
  const { published } = toPublished(local(), { visibility, deskVisibility: "private" })
  published.agents = agents
  return published
}

test("published facts accept agent_type and requested_model", () => {
  const value = publishedWith(agentsWith({ agent_type: "Explore", requested_model: "sonnet" }, { agent_type: CUSTOM_AGENT_TYPE }))
  assert.deepEqual(validatePublished(value), { ok: true, errors: [] })
})

for (const [key, bad, code] of [
  ["agent_type", "a b", "pattern"], ["agent_type", "", "pattern"], ["agent_type", 3, "type"],
  ["agent_type", "plugin:2026-09-25", "date"], ["agent_type", "plugin:08:30", "time"],
  ["requested_model", "bad model", "pattern"], ["requested_model", "m-2026-09-25", "date"], ["requested_model", "m:08:30", "time"],
  ["requested_model", "ghp_SENTINEL0123456789abcdefghijklmnopqrstuv", "credential_like"],
]) {
  test(`published facts reject ${key} ${JSON.stringify(bad)}`, () => {
    const result = validatePublished(publishedWith(agentsWith({ [key]: bad })))
    assert.deepEqual(errorsOf(result), [`${code}:agents.0.${key}`])
  })
}

// --- publishedAgentType ------------------------------------------------------

test("the built-in allowlist is one frozen object keyed by host", () => {
  assert.ok(Object.isFrozen(BUILTIN_AGENT_TYPES))
  assert.deepEqual(Object.keys(BUILTIN_AGENT_TYPES), ENUMS.host)
  for (const list of Object.values(BUILTIN_AGENT_TYPES)) assert.ok(Object.isFrozen(list))
  assert.deepEqual(BUILTIN_AGENT_TYPES["claude-code"], ["general-purpose", "Explore", "Plan", "statusline-setup", "claude-code-guide", "output-style-setup"])
})

test("publishedAgentType keeps built-ins, keeps a public plugin's type and maps everything else to custom", () => {
  for (const type of BUILTIN_AGENT_TYPES["claude-code"]) assert.equal(publishedAgentType("claude-code", type, []), type)
  assert.equal(publishedAgentType("claude-code", "desk:worker", ["desk"]), "desk:worker")
  assert.equal(publishedAgentType("claude-code", "desk:worker", new Set(["desk"])), "desk:worker")
  assert.equal(publishedAgentType("claude-code", "desk:worker", []), "custom", "a plugin that is not public")
  assert.equal(publishedAgentType("claude-code", "secret:worker", ["desk"]), "custom")
  assert.equal(publishedAgentType("claude-code", "my-private-agent", ["desk"]), "custom")
  assert.equal(publishedAgentType("claude-code", ":worker", ["", "desk"]), "custom", "an empty plugin name never matches")
  assert.equal(publishedAgentType("claude-code", "desk", ["desk"]), "custom", "a bare plugin name is not a plugin type")
  assert.equal(publishedAgentType("copilot-cli", "Explore", []), "custom", "a built-in of another host is not one here")
  assert.equal(publishedAgentType("codex-cli", "general-purpose", []), "custom")
  assert.equal(publishedAgentType("unknown-host", "Explore", []), "custom")
  assert.equal(publishedAgentType("toString", "Explore", []), "custom", "the host lookup ignores inherited keys")
})

// --- Publish -----------------------------------------------------------------

function publishAgents(agents, options = {}) {
  const value = local(agents)
  const result = toPublished(value, { visibility, deskVisibility: "private", ...options })
  assert.deepEqual(validatePublished(result.published), { ok: true, errors: [] })
  return result.published.agents
}

test("publish keeps a built-in type and an unset type stays unset", () => {
  const agents = publishAgents(agentsWith({ agent_type: "general-purpose" }))
  assert.equal(agents[0].agent_type, "general-purpose")
  assert.equal(Object.hasOwn(agents[1], "agent_type"), false)
})

test("publish keeps a public plugin's type and hides a private plugin's type, in a public store", () => {
  const value = local(agentsWith({ agent_type: "desk:worker" }, { agent_type: "hidden:worker" }))
  value.plugins = [
    { name: "desk", version: "3.2.0", source: "ourostack/desk" },
    { name: "hidden", version: "1.0.0", source: "acme/private-plugin" },
  ]
  const { published } = toPublished(value, { visibility, deskVisibility: "private", storeVisibility: "public" })
  assert.deepEqual(published.agents.map((agent) => agent.agent_type), ["desk:worker", "custom"])
  assert.equal(serializePublished(published).includes("hidden"), false)
  assert.deepEqual(published.plugins.map((plugin) => plugin.name), ["desk"])
})

test("a plugin with no source is private in a public store", () => {
  const value = local(agentsWith({ agent_type: "nosrc:worker" }))
  value.plugins = [{ name: "nosrc", version: "1.0.0" }]
  assert.equal(toPublished(value, { visibility, deskVisibility: "private" }).published.agents[0].agent_type, "custom")
})

test("a private store names every plugin, so every plugin's type publishes", () => {
  const value = local(agentsWith({ agent_type: "hidden:worker" }, { agent_type: "my-private-agent" }))
  value.plugins = [{ name: "hidden", version: "1.0.0", source: "acme/private-plugin" }]
  const { published } = toPublished(value, { visibility, deskVisibility: "private", storeVisibility: "private" })
  assert.deepEqual(published.agents.map((agent) => agent.agent_type), ["hidden:worker", "custom"])
})

test("a private agent type never reaches the published bytes", () => {
  const value = local(agentsWith({ agent_type: `${SENTINEL}-agent` }, { agent_type: `${SENTINEL}:agent` }))
  const { published } = toPublished(value, { visibility, deskVisibility: "private", storeVisibility: "public" })
  assert.equal(serializePublished(published).includes(SENTINEL), false)
  assert.deepEqual(published.agents.map((agent) => agent.agent_type), ["custom", "custom"])
})

test("publish scrubs date and time shapes from a plugin's type and a requested model", () => {
  const value = local(agentsWith({ agent_type: "desk:run-2026-09-25", requested_model: "m-2026-09-25:08:30" }))
  const agents = publishAgents(value.agents)
  assert.equal(agents[0].agent_type, "desk:run-20260925")
  assert.equal(agents[0].requested_model, "m-202609250830")
})

test("publish carries requested_model with or without agent_type", () => {
  const agents = publishAgents(agentsWith({ requested_model: "sonnet" }, { requested_model: "claude-sonnet-5" }))
  assert.deepEqual(agents.map((agent) => agent.requested_model), ["sonnet", "claude-sonnet-5"])
  assert.equal(agents.some((agent) => Object.hasOwn(agent, "agent_type")), false)
})

// --- A per-worker value never blocks publishing ------------------------------

const HEX_RUN = "a1b2c3d4e5f60718"

test("publishedAgentType returns custom for a plugin type the published validator would reject", () => {
  assert.equal(publishedAgentType("claude-code", `myplug:${HEX_RUN}`, ["myplug"]), "custom")
  assert.equal(publishedAgentType("claude-code", "myplug:worker", ["myplug"]), "myplug:worker")
  assert.equal(publishedAgentType("claude-code", "myplug:run-2026-09-25", ["myplug"]), "myplug:run-20260925", "a date shape is scrubbed, not refused")
})

test("a credential-shaped agent type, requested model and model still publish, as custom, omitted and unknown", () => {
  const value = local([
    { n: 0, parent: null, model: "claude-opus-5-5" },
    { n: 1, parent: 0, model: `sk-${HEX_RUN}`, agent_type: `myplug:${HEX_RUN}`, requested_model: `sk-${HEX_RUN}` },
    { n: 2, parent: 0, model: "claude-sonnet-5", agent_type: "myplug:worker", requested_model: "sonnet" },
  ])
  value.plugins = [{ name: "myplug", version: "1.0.0", source: "ourostack/desk" }]
  const { published } = toPublished(value, { visibility, deskVisibility: "private", storeVisibility: "public" })
  const bytes = serializePublished(published)
  assert.deepEqual(validatePublishedBytes(bytes), { ok: true, errors: [] })
  assert.equal(bytes.includes(HEX_RUN), false)
  assert.equal(published.agents[1].model, "unknown")
  assert.equal(published.agents[1].agent_type, "custom")
  assert.equal(Object.hasOwn(published.agents[1], "requested_model"), false)
  assert.deepEqual(published.agents[2], { n: 2, parent: 0, model: "claude-sonnet-5", agent_type: "myplug:worker", requested_model: "sonnet" })
})
