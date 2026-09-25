import { test } from "node:test"
import { strict as assert } from "node:assert"
import { existsSync, readFileSync } from "node:fs"
import { createHash } from "node:crypto"
import { materializeCodexActivation } from "../../src/activation/adapters/codex.js"

const repoRoot = new URL("../../../../../", import.meta.url)
const read = (relativePath) => readFileSync(new URL(relativePath, repoRoot), "utf8")
const json = (relativePath) => JSON.parse(read(relativePath))
const integration = "plugins/desk/skills/superpowers-integration/SKILL.md"
const adapter = "plugins/desk/skills/using-superpowers-with-desk/SKILL.md"
const excludedProviderPattern = new RegExp(["robo", "rev"].join(""), "iu")
const normalWorkerSurfaces = [
  "plugins/desk/agents/worker.md",
  "plugins/desk/agents/worker.agent.md",
  "plugins/desk/agents/worker.toml",
  "plugins/desk/output-styles/worker.md",
]

for (const file of normalWorkerSurfaces) {
  test(`${file} selects the sole method and native Superpowers review`, () => {
    const text = read(file)
    assert.match(text, /desk:superpowers-integration/u)
    assert.match(text, /superpowers:requesting-code-review/u)
    assert.doesNotMatch(text, /desk:independent-review/u)
    assert.doesNotMatch(text, excludedProviderPattern)
  })
}

test("normal generic orchestration and compatibility policy select native Superpowers review", () => {
  for (const file of [
    "plugins/desk/skills/work-orchestration/SKILL.md",
    integration,
    adapter,
    "plugins/desk/skills/session-resumption/SKILL.md",
    "plugins/desk/skills/task-lifecycle/SKILL.md",
    "plugins/desk/skills/pr-feedback-on-own-pr/SKILL.md",
    "plugins/desk/skills/pr-self-review/SKILL.md",
  ]) {
    const text = read(file)
    assert.match(text, /superpowers:requesting-code-review/u)
    assert.doesNotMatch(text, /desk:independent-review/u)
    assert.doesNotMatch(text, excludedProviderPattern)
  }
})

const retiredWorkerDirectives = [
  ["plugins/desk/agents/worker.md", /Skills come from the Desk and Work Suite plugins/u],
  ["plugins/desk/agents/worker.md", /\*\*work-suite\*\* \(declared dep\)/u],
  ["plugins/desk/agents/worker.md", /Verify Desk, Work Suite, Plain Language/u],
  ["plugins/desk/agents/worker.md", /use `work-ideator` to agree/u],
  ["plugins/desk/agents/worker.md", /^\| `(?:work-ideator|work-planner|work-doer|work-merger|autopilot|stay-in-turn|inch-worm)` \|/mu],
  ["plugins/desk/agents/worker.agent.md", /Skills come from the Desk and Work Suite plugins/u],
  ["plugins/desk/agents/worker.agent.md", /\*\*work-suite\*\* \(declared dep\)/u],
  ["plugins/desk/agents/worker.agent.md", /Verify Desk, Work Suite, Plain Language/u],
  ["plugins/desk/agents/worker.agent.md", /use `work-ideator` to agree/u],
  ["plugins/desk/agents/worker.agent.md", /^\| `(?:work-ideator|work-planner|work-doer|work-merger|autopilot|stay-in-turn|inch-worm)` \|/mu],
  ["plugins/desk/agents/worker.toml", /The work-suite plugin registers risk-scaled workflow skills/u],
  ["plugins/desk/agents/worker.toml", /^- `work-ideator`, `work-planner`, `work-doer`, `work-merger`/mu],
  ["plugins/desk/output-styles/worker.md", /dispatches to desk \+ work-suite skills/u],
  ["plugins/desk/output-styles/worker.md", /risk-scaled workflow skills come from \*\*work-suite\*\*/u],
  ["plugins/desk/output-styles/worker.md", /Clear work can go directly to `work-doer` and `work-merger`/u],
]
for (const [file, directive] of retiredWorkerDirectives) {
  test(`${file} removes its specific retired directive ${directive.source}`, () => {
    assert.doesNotMatch(read(file), directive)
  })
}

for (const [file, retiredDirective] of [
  ["plugins/desk/skills/work-orchestration/SKILL.md", /New engineering work enters `work-ideator`|`work-doer` → `work-merger`/u],
  ["plugins/desk/skills/codex-onboarding/SKILL.md", /`work-suite@<marketplace-name>` enabled|Desk and Work Suite are installed/u],
]) {
  test(`${file} routes active choreography through the alpha integration contract`, () => {
    const text = read(file)
    assert.match(text, /desk:superpowers-integration/u)
    assert.doesNotMatch(text, retiredDirective)
  })
}

const adapterCallers = [
  ["plugins/desk/skills/start-task/SKILL.md", "start", /explicit go-ahead through `work-ideator`/u],
  ["plugins/desk/skills/session-resumption/SKILL.md", "reconciled-resume", /dispatch `work-doer`|Resume `work-merger`/u],
  ["plugins/desk/skills/task-lifecycle/SKILL.md", "material-redesign", /otherwise establish the missing agreement through `work-ideator`|Work-doer decides its own dispatch/u],
]

for (const [file, entry, retiredDirective] of adapterCallers) {
  test(`${file} enters the Desk adapter at its own ${entry} entry`, () => {
    const text = read(file)
    assert.match(text, /desk:using-superpowers-with-desk/u)
    assert.ok(text.includes(entry), `${file} must name its ${entry} adapter entry`)
    assert.doesNotMatch(text, retiredDirective)
  })
}

test("the Desk adapter ships with valid named frontmatter", () => {
  assert.ok(existsSync(new URL(adapter, repoRoot)), `${adapter} must ship`)
  const frontmatter = read(adapter).match(/^---\r?\n([\s\S]*?)\r?\n---/u)
  assert.ok(frontmatter, "using-superpowers-with-desk must have YAML frontmatter")
  assert.match(frontmatter[1], /^name: using-superpowers-with-desk$/mu)
  assert.match(frontmatter[1], /^description: .+$/mu)
})

test("the Desk adapter admits exactly the three recorded entries", () => {
  const text = read(adapter)
  assert.match(text, /Entry: start \| reconciled-resume \| material-redesign\./u)
  for (const rejected of ["review", "recovery", "scheduling", "delivery", "measurement"]) {
    assert.ok(
      !new RegExp(`^Entry:.*\\b${rejected}\\b`, "mu").test(text),
      `${rejected} must not become a fourth adapter entry`,
    )
  }
  assert.match(text, /Do not review, recover, schedule, deliver or measure here\./u)
})

test("the Desk adapter reads existing state and selects one provider entry", () => {
  const text = read(adapter)
  assert.match(text, /Read: canonical task, recorded approval, delivery endpoint, explicit artifact map\./u)
  assert.match(text, /Select once:/u)
  assert.match(text, /Pass: task path, design\/plan\/progress pointers, authority and endpoint\./u)
  assert.match(text, /Return: selected provider entry and mapped context\./u)
  for (const [condition, entry] of [
    ["new/material design", "superpowers:brainstorming"],
    ["approved unplanned design", "superpowers:writing-plans"],
    ["this approved plan", "superpowers:subagent-driven-development"],
    ["same ready-set sequential fallback", "superpowers:executing-plans"],
  ]) {
    assert.ok(text.includes(entry), `the adapter must name ${entry}`)
    assert.ok(text.includes(condition), `the adapter must state the ${entry} condition: ${condition}`)
  }
})

test("the Desk adapter maps existing artifacts instead of creating a second lifecycle tree", () => {
  const text = read(adapter)
  assert.match(text, /--progress-path/u)
  assert.match(text, /--plan-path/u)
  assert.match(text, /`rulingsPath`/u)
  assert.ok(text.includes("Do not create a competing `.superpowers/sdd` tree."), "the adapter must prohibit a second lifecycle tree")
  assert.match(text, /reads and creates nothing|creates nothing/u)
})

test("the Desk adapter delegates every non-entry responsibility to its existing owner", () => {
  const text = read(adapter)
  for (const owner of [
    "desk:session-resumption",
    "superpowers:requesting-code-review",
    "desk:work-orchestration",
    "desk:work-measurement-ledger",
  ]) {
    assert.ok(text.includes(owner), `the adapter must route its non-entry responsibility to ${owner}`)
    const [plugin, skill] = owner.split(":")
    assert.ok(existsSync(new URL(`plugins/${plugin}/skills/${skill}/SKILL.md`, repoRoot)), `${owner} must be a shipped skill`)
  }
  assert.match(text, /recorded repository policy/u)
})

test("the retired integration name redirects to the adapter without becoming a second contract", () => {
  const text = read(integration)
  assert.match(text, /desk:using-superpowers-with-desk/u)
  assert.match(text, /[Rr]etired/u)
  assert.doesNotMatch(text, /Entry: start \| reconciled-resume \| material-redesign\./u)
  assert.doesNotMatch(text, /## Bounded execution and recovery/u)
  assert.doesNotMatch(text, /host protocol declares armed|two consecutive actual interruption/u)
  assert.doesNotMatch(text, /^## Review and accounting$/mu)
  const sections = [...text.matchAll(/^## (.+)$/gmu)].map((match) => match[1])
  assert.deepEqual(sections, ["Legacy capability mapping"], "the retired seam permits only the Legacy capability mapping section")
})

for (const mode of ["global-personal", "project-local"]) {
  test(`${mode} owned instructions contain no active retired lifecycle dispatch`, () => {
    const golden = read(`plugins/desk/mcp/__tests__/fixtures/activation/codex/${mode}/generated-instructions.md`)
    const owned = golden.split("# BEGIN desk activation:")[1]?.split("# END desk activation")[0]
    assert.ok(owned)
    assert.doesNotMatch(owned, /\b(?:use|invoke|run|dispatch to)\s+(?:the\s+)?(?:Work Suite(?: skills)?|`?work-(?:ideator|planner|doer|merger))/iu)
  })
  test(`the ${mode} owned block and golden fixture select the same alpha lifecycle`, () => {
    const input = {
      manifest: json("plugins/desk/activation/desk.activation.json"),
      mode,
      existingConfig: '# user-authored Codex config\nmodel = "gpt-5.4"\napproval_policy = "on-request"\n',
      existingInstructions: "# user-authored Codex guidance\nKeep repo-local rules intact.\n",
      pluginRoot: "plugins/desk",
      deskRoot: mode === "project-local" ? ".desk" : "~/desk",
      runtimeCacheDir: mode === "project-local" ? ".codex/desk-runtime-cache" : "~/.cache/ouroboros-skills/desk",
    }
    const rendered = materializeCodexActivation(input).generatedInstructions
    const golden = read(`plugins/desk/mcp/__tests__/fixtures/activation/codex/${mode}/generated-instructions.md`)
    assert.equal(golden, rendered)
    assert.match(golden, /Selected engineering lifecycle: Superpowers\./u)
    assert.match(golden, /desk:using-superpowers-with-desk/u)
    assert.match(golden, /superpowers:requesting-code-review/u)
    assert.doesNotMatch(golden, /desk:independent-review/u)
    assert.doesNotMatch(golden, excludedProviderPattern)
  })
}

test("activation background disclosure names the selected provider without upgrading unsupported capability", () => {
  const background = json("plugins/desk/activation/desk.activation.json").host_activation.claude.backgroundSessionInheritance
  assert.equal(background.status, "unsupported")
  assert.equal(background.inheritsPluginContext, false)
  assert.match(background.reason, /Superpowers/u)
  assert.doesNotMatch(background.reason, /Work Suite skills/u)
})

test("the technical preview guide preflights selected source paths rather than retired lifecycle skills", () => {
  const guide = read("AGENTIC-ENGINEERING-V2.md")
  assert.match(guide, /plugins\/desk\/docs\/agentic-engineering-v2-rfc\.md/u)
  assert.doesNotMatch(guide, /^## /mu)
  assert.doesNotMatch(guide, /Require the enabled Work Suite skills|copilot plugin install work-suite@/u)
  assert.doesNotMatch(read("README.md").split("\n").slice(0, 10).join("\n"), /interactive RFC/iu)
})

test("catalog metadata selects Superpowers and leaves the legacy Work Suite and Ponytail providers out", () => {
  const catalog = json(".claude-plugin/marketplace.json")
  assert.match(catalog.metadata.description, /Superpowers/u)
  assert.doesNotMatch(catalog.metadata.description, /Work Suite routes work|Ponytail/u)
  assert.equal(catalog.plugins.find((plugin) => plugin.name === "superpowers")?.source, "./plugins/superpowers")
  // The legacy providers keep shipping from ourostack/ouroboros-skills; this marketplace carries only the V2 plugins.
  assert.deepEqual(catalog.plugins.map((plugin) => plugin.name).sort(), ["crew", "desk", "plain-language", "superpowers"])
})

test("the independent-review skill ships with valid named frontmatter", () => {
  const file = "plugins/desk/skills/independent-review/SKILL.md"
  assert.ok(existsSync(new URL(file, repoRoot)), `${file} must ship`)
  const frontmatter = read(file).match(/^---\r?\n([\s\S]*?)\r?\n---/u)
  assert.ok(frontmatter, "independent-review must have YAML frontmatter")
  assert.match(frontmatter[1], /^name: independent-review$/mu)
  assert.match(frontmatter[1], /^description: .+$/mu)
})

test("the adapter preserves prior approval, delegation, alpha endpoint and a single remediation owner", () => {
  const contract = read(adapter)
  for (const invariant of [
    "Prior approval remains valid; do not reopen it without a scope change.",
    "Delegation remains limited by the recorded authority.",
    "An intentional alpha or PR-only delivery endpoint does not authorize main promotion.",
    "One implementation owner handles all remediation and re-review findings.",
  ]) {
    assert.ok(contract.includes(invariant), `missing adapter invariant: ${invariant}`)
  }
})

const successors = [
  ["work-ideator", "superpowers:brainstorming"],
  ["work-planner", "superpowers:writing-plans"],
  ["work-doer", "superpowers:subagent-driven-development"],
  ["work-merger", "superpowers:verification-before-completion"],
  ["autopilot", "native continuation"],
  ["stay-in-turn", "native notifications"],
  ["inch-worm", "approved backlog"],
  ["watchdog-mode", "native monitoring"],
  ["visual-qa-dogfood", "screenshots"],
  ["deep-research", "firsthand evidence"],
]

for (const [retired, successor] of successors) {
  test(`retired capability ${retired} has a named successor, not a second lifecycle dependency`, () => {
    const row = read(integration).split("\n").find((line) => line.startsWith(`| \`${retired}\` |`))
    assert.ok(row, `missing capability disposition for ${retired}`)
    assert.ok(row.includes(successor), `${retired} must name ${successor}`)
  })
}

for (const [retired, owner, requiredLimit] of [
  ["autopilot", "superpowers:executing-plans", "host continuation"],
  ["stay-in-turn", "superpowers:executing-plans", "host wait tools"],
  ["inch-worm", "desk:start-task", "approved backlog"],
  ["watchdog-mode", "desk:runtime-symptom-investigation", "persistent monitoring is not bundled"],
  ["visual-qa-dogfood", "superpowers:verification-before-completion", "visual tools"],
  ["deep-research", "superpowers:brainstorming", "exhaustive research requires a consumer-provided entrypoint"],
]) {
  test(`${retired} discloses its owning entrypoint, conditional capability and unproven runtime status`, () => {
    const row = read(integration).split("\n").find((line) => line.startsWith(`| \`${retired}\` |`))
    assert.ok(row)
    assert.ok(row.includes(`Owner: \`${owner}\``), `${retired} must identify its actual owning entrypoint`)
    assert.ok(row.includes("Capability: conditional"), `${retired} must not imply unconditional availability`)
    assert.ok(row.includes("Proof: runtime qualification required"), `${retired} must not treat source characterization as consumption proof`)
    assert.ok(row.includes(requiredLimit), `${retired} must disclose its material capability limit`)
    const [plugin, skill] = owner.split(":")
    assert.ok(existsSync(new URL(`plugins/${plugin}/skills/${skill}/SKILL.md`, repoRoot)), `${owner} must be a shipped skill, not an invented entrypoint`)
  })
}

// T02: Desk's ready-set scheduling and continuous peer review contract.
// This is a source contract witness over `work-orchestration/SKILL.md`, not proof that natural-language
// instructions execute correctly at runtime — T24 supplies the actual dispatch/acceptance proof.
const orchestration = read("plugins/desk/skills/work-orchestration/SKILL.md")

test("work-orchestration's source contract names every required ready-set and review rule", () => {
  const requiredRules = [
    "all dependencies accepted",
    "failure blocks only descendants",
    "overlapping write sets",
    "exclusive resources",
    "missing conflict data",
    "stable table order",
    "frozen candidate",
    "finding disposition",
    "bounded correction",
    "affected re-review",
    "same Superpowers implementation owner",
  ]
  for (const rule of requiredRules) assert.ok(orchestration.includes(rule), rule)
})

test("work-orchestration ships the exact eight-step ready-set algorithm verbatim", () => {
  const readySetAlgorithm = [
    "1. Read the plan and progress; reject unknown dependencies and dependency cycles before dispatch.",
    "2. Ready = pending nodes with all dependencies accepted.",
    "3. Walk ready nodes in stable table order; reserve complete writes/resources before launching.",
    "4. Dispatch every non-conflicting ready node through pristine Superpowers skills in its own worktree.",
    "5. Missing conflict data or unavailable parallel execution serializes the same ready set.",
    "6. A result is accepted only after spec/targeted proof and native Superpowers review disposition.",
    "7. On failure, block only descendants; release verified resources and recompute immediately.",
    "8. A candidate-changing repair invalidates affected descendants and re-enters at the same owner.",
  ].join("\n")
  assert.ok(orchestration.includes(readySetAlgorithm), "the exact eight-step algorithm must appear verbatim")
})

test("work-orchestration keeps correction and affected re-review with the implementation owner", () => {
  assert.match(orchestration, /bounded correction/iu)
  assert.match(orchestration, /affected re-review/iu)
  assert.match(orchestration, /same Superpowers implementation owner/iu)
  assert.doesNotMatch(orchestration, excludedProviderPattern)
})

test("work-orchestration attributes concurrency relaxation to Desk's own policy, not an upstream Superpowers source change", () => {
  assert.ok(orchestration.includes("Desk's own approved concurrency policy"), "must attribute the relaxation to Desk")
  assert.ok(orchestration.includes("not an upstream source change"), "must disclaim an upstream Superpowers change")
})

test("work-orchestration keeps one coherent task's implement/fix loop sequential while independent nodes may run concurrently", () => {
  assert.ok(
    orchestration.includes(
      "One coherent task's implement/fix loop stays sequential; independent non-conflicting nodes may run concurrently in stable table order.",
    ),
    "must state the coherent-task sequencing rule verbatim",
  )
})

test("work-orchestration invokes only pristine, pinned Superpowers skills for dispatch and verification, matching the existing provider witness", () => {
  const lock = json("upstream-sources.lock.json")
  const source = lock.sources.find((entry) => entry.repository === "obra/superpowers")
  assert.ok(source, "the existing lock must include the Superpowers provider")
  for (const skill of [
    "subagent-driven-development",
    "dispatching-parallel-agents",
    "executing-plans",
    "using-git-worktrees",
    "verification-before-completion",
  ]) {
    assert.ok(orchestration.includes(`superpowers:${skill}`), `orchestration must invoke superpowers:${skill}`)
    const sourcePath = `skills/${skill}/SKILL.md`
    const file = source.files.find((entry) => entry.sourcePath === sourcePath)
    assert.ok(file, `the lock must pin ${sourcePath}`)
    assert.equal(
      createHash("sha256").update(readFileSync(new URL(file.generatedPath, repoRoot))).digest("hex"),
      file.sha256,
      file.generatedPath,
    )
  }
})

// T02-I01 fix: `independent-review/SKILL.md` is an independently callable entrypoint that now owns its own
// exact-commit acceptance gate. The tests above only bind `work-orchestration/SKILL.md`; these tests read
// `independent-review/SKILL.md` through the same existing normalized reader and protect that standalone
// paragraph so its deletion or weakening is caught here, not only through the orchestration cross-reference.
const independentReview = read("plugins/desk/skills/independent-review/SKILL.md")

test("independent-review requires a terminal exact-commit source=post_commit disposition from the same implementation owner", () => {
  assert.ok(independentReview.includes("source=post_commit"), "must require the post_commit source")
  assert.ok(independentReview.includes("terminal exact-commit disposition"), "must require a terminal exact-commit disposition")
  assert.ok(independentReview.includes("same implementation owner"), "must name the same implementation owner")
})

test("independent-review rejects promised, in-flight, stale-SHA or duplicate results as acceptance substitutes", () => {
  assert.ok(
    independentReview.includes("a promised, in-flight, stale-SHA or duplicate result never substitutes for it"),
    "must explicitly reject every listed substitute for the terminal exact-commit disposition",
  )
})

test("independent-review prohibits roborev fix/refine and any second or parallel remediation loop", () => {
  assert.ok(independentReview.includes("`roborev fix`"), "must name roborev fix")
  assert.ok(independentReview.includes("`roborev refine`"), "must name roborev refine")
  assert.ok(
    independentReview.includes("Never run `roborev fix` or `roborev refine` as a parallel remediation path"),
    "must prohibit roborev fix/refine as a parallel remediation path",
  )
  assert.ok(
    independentReview.includes("never open a second fix loop beside the same owner's own loop"),
    "must prohibit a second fix loop beside the same owner's own loop",
  )
})

test("independent-review states that work-orchestration gates ready-node acceptance on exactly this disposition", () => {
  assert.ok(
    independentReview.includes("`desk:work-orchestration` gates a ready node's acceptance on exactly this disposition"),
    "must state the exact cross-reference from independent-review to work-orchestration's acceptance gate",
  )
})
