import { test } from "node:test"
import { strict as assert } from "node:assert"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import * as path from "node:path"

const repoRoot = path.resolve(fileURLToPath(new URL("../../../../..", import.meta.url)))
const require = createRequire(import.meta.url)
const docsValidator = require(path.join(repoRoot, "scripts", "test-desk-docs.cjs"))

function record(text, headingPath = [], { inFence = false, file = "fixture.md", line = 1 } = {}) {
  return docsValidator.fixtureRecord(text, headingPath, { inFence, file, line })
}

function errorsFor(text, headingPath = [], options = {}) {
  const errors = []
  docsValidator.validateHealthyPathRecord(errors, record(text, headingPath, options))
  return errors
}

function assertFails(text, expected, headingPath = [], options = {}) {
  assert.ok(
    errorsFor(text, headingPath, options).some((error) => error.includes(expected)),
    `${JSON.stringify(text)} should fail with ${expected}`,
  )
}

function assertPasses(text, headingPath = [], options = {}) {
  assert.deepEqual(errorsFor(text, headingPath, options), [])
}

function readText(relativePath) {
  return readFileSync(path.join(repoRoot, relativePath), "utf8")
}

function toolNamesSource(tools = docsValidator.MCP_TOOL_NAMES) {
  return `export const TOOL_NAMES = [\n${tools.map((tool) => `  "${tool}",`).join("\n")}\n]\n`
}

function mcpReadmeBody(tools = docsValidator.MCP_TOOL_NAMES) {
  return [
    `## Tools exposed (${tools.length})`,
    ...tools.map((tool) => `- \`${tool}\``),
    `All ${tools.length} tools are wired to real implementations.`,
  ].join("\n")
}

const canonicalRfcPath = "plugins/desk/docs/agentic-engineering-v2-rfc.md"
const canonicalRfcMarker = "<!-- canonical-agentic-engineering-v2-rfc -->"
const topLevelRfcPointer = "AGENTIC-ENGINEERING-V2.md"

function canonicalRfcBody({ marker = canonicalRfcMarker, extraSection = "" } = {}) {
  return [
    marker,
    "# Agentic Engineering V2",
    "",
    "## Purpose",
    "",
    "This public RFC is for maintainers and operators.",
    "",
    "## Current status — September 22, 2026",
    "",
    "Alpha 1 candidate under qualification.",
    "",
    extraSection,
  ].join("\n")
}

function browserPolicyBody() {
  return [
    "The browser-context-broker owns acquisition, proxying, status, doctor, and release.",
    "The plugin-relative source is canonical; an ordinary Desk install does not place the broker on PATH.",
    'The host overlay supplies "$BROWSER_CONTEXT_BROKER_BIN" as the executable path.',
    'Use "$BROWSER_CONTEXT_BROKER_BIN" acquire and proxy.',
    "Target.createTarget({ url, background: true })",
    "Use status, doctor, and release for the exact lease.",
    "A lease exposes only its owned targets.",
  ].join("\n")
}

test("Desk docs validator exports a testable contract", () => {
  for (const exportName of [
    "DOCS",
    "MCP_TOOL_NAMES",
    "PRIVACY_REQUIRED_DOCS",
    "TOPIC_REQUIREMENTS",
    "WORKFLOW_REQUIREMENTS",
    "fixtureRecord",
    "run",
    "validateHealthyPathRecord",
    "validatePrivacyNotes",
    "validateMcpReadmeToolSurface",
    "validateMcpToolRegistrySurface",
    "validateTopicCoverage",
    "validateValidatorFixtures",
    "validateWorkflowWiring",
  ]) {
    assert.equal(typeof docsValidator[exportName] === "undefined", false, `${exportName} must be exported`)
  }
})

test("markdown parsing preserves headings and fenced command context", () => {
  const records = docsValidator.markdownLines("fixture.md", {
    readFile: () => [
      "# Root",
      "healthy prose",
      "```",
      "## fenced heading ignored",
      "/plugin install desk@ourostack",
      "```",
      "## Troubleshooting",
      "/plugin install desk@ourostack",
    ].join("\n"),
  })

  assert.equal(records[1].headingPath.join(" > "), "Root")
  assert.equal(records[4].inFence, true)
  assert.equal(records[4].headingPath.join(" > "), "Root")
  assert.equal(records[7].headingPath.join(" > "), "Root > Troubleshooting")
})

test("healthy-path command validation covers Codex and Claude manual setup escapes", () => {
  assertFails("Run `codex mcp add desk` after activation.", "codex mcp add")
  assertFails("/plugin install desk@ourostack", "manual Desk/Work Suite plugin dependency installation", [], { inFence: true })
  assertFails("/plugin install work-suite@ourostack", "manual Desk/Work Suite plugin dependency installation", [], { inFence: true })
  assertFails("Claude Code requires you to install `work-suite` explicitly.", "manual Desk/Work Suite plugin dependency installation")
  assertFails("Paste the worker default block into your Codex instructions.", "AGENTS/worker copy or append")

  assertPasses("Do not run `codex mcp add` for the healthy path.")
  assertPasses("/plugin install desk@ourostack", ["Troubleshooting"], { inFence: true })
  assertPasses("Copied agent files are not part of the healthy path.")
})

test("healthy-path validation allows host-native activation language for all supported host families", () => {
  for (const text of [
    "Codex uses global-personal activation by default, with project-local and manual-only opt-outs.",
    "Claude uses host-native dependency resolution or a flattened Desk + Work Suite bundle.",
    "Copilot-compatible hosts load the generated flattened bundle metadata.",
    "Ouroboros bundles Desk + Work Suite into the autonomous-agent bundle and binds $DESK in the preamble.",
    "Generic stdio is degraded MCP-only with no worker activation or dependency closure.",
  ]) {
    assertPasses(text)
  }
})

test("privacy validation requires embeddings, snapshots, derivative data, and privacy risk", () => {
  const errors = []
  const docs = ["plugins/desk/README.md", "plugins/desk/mcp/README.md"]
  docsValidator.validatePrivacyNotes(errors, {
    docs,
    readFile: (file) => file === "plugins/desk/README.md"
      ? "Embeddings and snapshots are derivative data and may carry privacy risk."
      : "Embeddings and snapshots are derivative data only.",
  })

  assert.deepEqual(errors, [
    "plugins/desk/mcp/README.md must state that embeddings and snapshots are derivative data and may carry privacy risk",
  ])
})

test("workflow validation requires docs command and host/artifact path filters", () => {
  const errors = []
  docsValidator.validateWorkflowWiring(errors, {
    requirements: [{
      path: ".github/workflows/desk-mcp-tests.yml",
      command: "node scripts/test-desk-docs.cjs",
      paths: [
        "plugins/desk/README.md",
        "plugins/desk/docs/**",
        "plugins/desk/mcp/README.md",
        "plugins/desk/activation/README.md",
        "desk/tasks/2026-06-14-1335-planning-desk-dependency-activation.md",
        "scripts/test-desk-docs.cjs",
      ],
    }],
    readFile: () => [
      "run: node scripts/test-desk-docs.cjs",
      '- "plugins/desk/README.md"',
      '- "plugins/desk/docs/**"',
      '- "plugins/desk/mcp/README.md"',
      '- "plugins/desk/activation/README.md"',
      '- "desk/tasks/2026-06-14-1335-planning-desk-dependency-activation.md"',
    ].join("\n"),
  })

  assert.deepEqual(errors, [
    ".github/workflows/desk-mcp-tests.yml path filters must include scripts/test-desk-docs.cjs",
  ])

  const commandErrors = []
  docsValidator.validateWorkflowWiring(commandErrors, {
    requirements: [{
      path: ".github/workflows/desk-mcp-tests.yml",
      command: "node scripts/test-desk-docs.cjs",
      paths: ["plugins/desk/README.md"],
    }],
    readFile: () => '- plugins/desk/README.md\n',
  })

  assert.deepEqual(commandErrors, [
    ".github/workflows/desk-mcp-tests.yml must run node scripts/test-desk-docs.cjs",
  ])
})

test("MCP README validation locks the advertised tool surface", () => {
  const errors = []
  docsValidator.validateMcpReadmeToolSurface(errors, {
    tools: ["desk_status", "desk_search"],
    readFile: () => mcpReadmeBody(["desk_status", "desk_search"]),
  })
  assert.deepEqual(errors, [])

  const staleErrors = []
  docsValidator.validateMcpReadmeToolSurface(staleErrors, {
    tools: ["desk_status"],
    readFile: () => "## Tools exposed (13)\n13 tools are wired.",
  })

  assert.ok(staleErrors.some((error) => error.includes("advertise 1 exposed tools")))
  assert.ok(staleErrors.some((error) => error.includes("state all 1 tools are wired")))
  assert.ok(staleErrors.some((error) => error.includes("must list desk_status")))
  assert.ok(staleErrors.some((error) => error.includes("must enumerate desk_status in its tool list")))
  assert.ok(staleErrors.some((error) => error.includes("stale 12/13 tool counts")))

  const extraErrors = []
  docsValidator.validateMcpReadmeToolSurface(extraErrors, {
    tools: ["desk_status"],
    readFile: () => mcpReadmeBody(["desk_status", "desk_retired"]).replace("(2)", "(1)").replace("All 2", "All 1"),
  })
  assert.ok(extraErrors.some((error) => error.includes("enumerates desk_retired, which is not an exposed tool")))

  // A tool named only in the prose around the list is not discoverable from
  // the list, so a mention must not stand in for a bullet.
  const proseOnlyErrors = []
  docsValidator.validateMcpReadmeToolSurface(proseOnlyErrors, {
    tools: ["desk_status", "desk_doctor"],
    readFile: () => [
      "## Tools exposed (2)",
      "- `desk_status`",
      "All 2 tools are wired to real implementations. See `desk_doctor` for first-boot diagnosis.",
    ].join("\n"),
  })
  assert.ok(proseOnlyErrors.some((error) => error.includes("must enumerate desk_doctor in its tool list")))
  assert.equal(proseOnlyErrors.some((error) => error.includes("must list desk_doctor")), false)
})

test("MCP tool documentation is compared against the registry rather than a private copy", () => {
  const matched = []
  docsValidator.validateMcpToolRegistrySurface(matched, {
    tools: ["desk_status", "desk_search"],
    readFile: () => toolNamesSource(["desk_status", "desk_search"]),
  })
  assert.deepEqual(matched, [])

  const drifted = []
  docsValidator.validateMcpToolRegistrySurface(drifted, {
    tools: ["desk_status", "desk_feedback"],
    readFile: () => toolNamesSource(["desk_status", "desk_work_ledger"]),
  })
  assert.ok(drifted.some((error) => error.includes("missing registered tool(s) desk_work_ledger")))
  assert.ok(drifted.some((error) => error.includes("unregistered tool(s) desk_feedback")))

  const unreadable = []
  docsValidator.validateMcpToolRegistrySurface(unreadable, {
    tools: ["desk_status"],
    readFile: () => "// no registry here\n",
  })
  assert.deepEqual(unreadable, [
    "plugins/desk/mcp/src/tool-names.js must export a readable TOOL_NAMES registry",
  ])

  const headless = []
  docsValidator.validateMcpReadmeToolSurface(headless, {
    tools: [],
    readFile: () => "no tool section at all",
  })
  assert.deepEqual(headless, [
    "plugins/desk/mcp/README.md must advertise 0 exposed tools",
    "plugins/desk/mcp/README.md must state all 0 tools are wired",
  ])
})

test("browser focus validation requires broker routing and rejects unsafe discovery or cleanup", () => {
  const errors = []
  docsValidator.validateBrowserFocusPolicy(errors, {
    readFile: () => browserPolicyBody(),
  })
  assert.deepEqual(errors, [])

  const staleErrors = []
  docsValidator.validateBrowserFocusPolicy(staleErrors, {
    readFile: () => [
      'curl -s "http://localhost:9222/json/version"',
      'nohup browser --remote-debugging-port=9222 &',
      "browser-context-broker acquire --alias corporate-default",
      'pkill -f "user-data-dir=profile"',
      "const page = ctx.pages().find(candidate => candidate.url().includes(target))",
    ].join("\n"),
  })
  assert.ok(staleErrors.some((error) => error.includes("browser context broker")))
  assert.ok(staleErrors.some((error) => error.includes("background target creation")))
  assert.ok(staleErrors.some((error) => error.includes("fixed-port or arbitrary endpoint discovery")))
  assert.ok(staleErrors.some((error) => error.includes("process-pattern cleanup")))
  assert.ok(staleErrors.some((error) => error.includes("cross-lease page selection")))
  assert.ok(staleErrors.some((error) => error.includes("plugin-relative broker executable")))
  assert.ok(staleErrors.some((error) => error.includes("bare PATH command")))
})

test("canonical RFC validation is structural rather than prose-locking", () => {
  docsValidator.validateCanonicalRfc([], {
    readFile: (file) => file === canonicalRfcPath ? canonicalRfcBody() : "Not the canonical RFC.",
    repoRoot,
  })

  docsValidator.validateCanonicalRfc([], {
    readFile: (file) => file === canonicalRfcPath
      ? canonicalRfcBody({ extraSection: "## An editorially flexible section\n\nNew public-safe prose." })
      : "Not the canonical RFC.",
    repoRoot,
  })
})

test("canonical RFC validation requires one marker and the blessed top-level pointer", () => {
  assert.throws(
    () => docsValidator.validateCanonicalRfc([], {
      readFile: (file) => file === canonicalRfcPath ? canonicalRfcBody({ marker: "" }) : "Not the canonical RFC.",
      repoRoot,
    }),
    /canonical marker/iu,
  )

  const errors = []
  docsValidator.validateCanonicalRfcPointers(errors, {
    pointers: [topLevelRfcPointer],
    readFile: () => "# Pointer\n\nNo canonical destination here.\n",
  })
  assert.deepEqual(errors, [
    `${topLevelRfcPointer} must link to ${canonicalRfcPath}`,
  ])
})

test("canonical RFC discovery rejects another active canonical declaration", () => {
  assert.throws(
    () => docsValidator.validateCanonicalRfc([], {
      readFile: (file) => {
        if (file === canonicalRfcPath) return canonicalRfcBody()
        if (file === "SECOND-RFC.md") return `${canonicalRfcMarker}\n# Another RFC\n`
        return "Not canonical."
      },
      repoRoot,
      markdownFiles: [canonicalRfcPath, "SECOND-RFC.md"],
    }),
    /exactly one active canonical/iu,
  )

  for (const declaration of [
    "This RFC is not merely a pointer but is the canonical Agentic Engineering V2 RFC.",
    "This document is the canonical Agentic Engineering V2 RFC, with a link to migration notes.",
  ]) {
    assert.throws(
      () => docsValidator.validateCanonicalRfc([], {
        readFile: (file) => {
          if (file === canonicalRfcPath) return canonicalRfcBody()
          if (file === "SECOND-RFC.md") return `# Another RFC\n\n${declaration}\n`
          return "Not canonical."
        },
        repoRoot,
        markdownFiles: [canonicalRfcPath, "SECOND-RFC.md"],
      }),
      /exactly one active canonical/iu,
    )
  }

  assert.throws(
    () => docsValidator.validateCanonicalRfc([], {
      readFile: (file) => {
        if (file === canonicalRfcPath) return canonicalRfcBody()
        if (file === "SECOND-RFC.md") {
          return "# Another RFC\n\nThis RFC is the canonical Agentic Engineering V2 RFC.\n"
        }
        return "Not canonical."
      },
      repoRoot,
      markdownFiles: [canonicalRfcPath, "SECOND-RFC.md"],
    }),
    /exactly one active canonical/iu,
  )

  assert.throws(
    () => docsValidator.validateCanonicalRfc([], {
      readFile: (file) => {
        if (file === canonicalRfcPath) return canonicalRfcBody()
        if (file === "SECOND-RFC.md") {
          return "# Another RFC\n\nThis RFC establishes the canonical Agentic Engineering V2 RFC.\n"
        }
        return "Not canonical."
      },
      repoRoot,
      markdownFiles: [canonicalRfcPath, "SECOND-RFC.md"],
    }),
    /exactly one active canonical/iu,
  )

  docsValidator.validateCanonicalRfc([], {
    readFile: (file) => {
      if (file === canonicalRfcPath) return canonicalRfcBody()
      if (file === "RFC-POINTER.md") {
        return "# Pointer\n\nThis document is the canonical RFC pointer and redirect.\n"
      }
      return "Not canonical."
    },
    repoRoot,
    markdownFiles: [canonicalRfcPath, "RFC-POINTER.md"],
  })

  for (const disclaimer of [
    "This RFC is not the canonical Agentic Engineering V2 RFC.",
    "This document does not serve as the canonical Agentic Engineering V2 RFC.",
    "This RFC is no longer the canonical Agentic Engineering V2 RFC.",
    "This RFC establishes neither the canonical Agentic Engineering V2 RFC nor its successor.",
    "This document was previously authoritative but is not the canonical Agentic Engineering V2 RFC.",
    "This document is a pointer to the canonical Agentic Engineering V2 RFC.",
    "This document is merely a pointer to the canonical Agentic Engineering V2 RFC.",
    "This document remains a pointer to the canonical Agentic Engineering V2 RFC.",
    "This document constitutes a reference to the canonical Agentic Engineering V2 RFC.",
  ]) {
    docsValidator.validateCanonicalRfc([], {
      readFile: (file) => {
        if (file === canonicalRfcPath) return canonicalRfcBody()
        if (file === "DISCLAIMER.md") return `# Disclaimer\n\n${disclaimer}\n`
        return "Not canonical."
      },
      repoRoot,
      markdownFiles: [canonicalRfcPath, "DISCLAIMER.md"],
    })
  }

  assert.throws(
    () => docsValidator.validateCanonicalRfc([], {
      readFile: (file) => {
        if (file === canonicalRfcPath) return canonicalRfcBody()
        if (file === "SECOND-RFC.md") {
          return "# Another RFC\n\nThis document establishes the canonical Agentic Engineering V2 RFC and includes a link to it.\n"
        }
        return "Not canonical."
      },
      repoRoot,
      markdownFiles: [canonicalRfcPath, "SECOND-RFC.md"],
    }),
    /exactly one active canonical/iu,
  )

  assert.throws(
    () => docsValidator.validateCanonicalRfc([], {
      readFile: (file) => {
        if (file === canonicalRfcPath) return canonicalRfcBody()
        if (file === "SECOND-RFC.md") {
          return "# Another RFC\n\nThis is the active canonical Agentic Engineering V2 RFC.\n"
        }
        return "Not canonical."
      },
      repoRoot,
      markdownFiles: [canonicalRfcPath, "SECOND-RFC.md"],
    }),
    /exactly one active canonical/iu,
  )
})

test("canonical RFC validation rejects broken local links", () => {
  assert.throws(
    () => docsValidator.validateCanonicalRfc([], {
      readFile: (file) => file === canonicalRfcPath
        ? canonicalRfcBody({ extraSection: "[Missing](./does-not-exist.md)" })
        : "Not canonical.",
      repoRoot,
      markdownFiles: [canonicalRfcPath],
      exists: (file) => file.endsWith(canonicalRfcPath),
    }),
    /broken local link/iu,
  )
})

test("public RFC pointers reject denylisted context and broken local links", () => {
  const privateErrors = []
  docsValidator.validateCanonicalRfcPointers(privateErrors, {
    readFile: (file) => file === topLevelRfcPointer
      ? `# Pointer\n\nSee [the RFC](${canonicalRfcPath}). Microsoft-only context.\n`
      : "See [the RFC](./docs/agentic-engineering-v2-rfc.md).\n",
    repoRoot,
  })
  assert.ok(privateErrors.some((error) => error.includes("public-safety")))

  const linkErrors = []
  docsValidator.validateCanonicalRfcPointers(linkErrors, {
    readFile: (file) => file === "plugins/desk/README.md"
      ? "See [the RFC](./docs/agentic-engineering-v2-rfc.md) and [missing context](./docs/missing-rfc.md).\n"
      : `See [the RFC](${canonicalRfcPath}).\n`,
    repoRoot,
    exists: (file) => !file.endsWith("missing-rfc.md"),
  })
  assert.ok(linkErrors.some((error) => (
    error.includes("plugins/desk/README.md has broken local link")
  )))

  const barePathErrors = []
  docsValidator.validateCanonicalRfcPointers(barePathErrors, {
    pointers: [topLevelRfcPointer],
    readFile: () => [
      "# Pointer",
      "",
      `Canonical path: \`${canonicalRfcPath}\`.`,
      "",
      "[Another document](plugins/desk/README.md)",
    ].join("\n"),
    repoRoot,
  })
  assert.deepEqual(barePathErrors, [
    `${topLevelRfcPointer} must link to ${canonicalRfcPath}`,
  ])

  for (const body of [
    `[RFC](<${canonicalRfcPath}>)`,
    `[RFC](${canonicalRfcPath} "Canonical RFC")`,
    `[RFC][canonical-rfc]\n\n[canonical-rfc]: ${canonicalRfcPath} "Canonical RFC"`,
  ]) {
    const standardLinkErrors = []
    docsValidator.validateCanonicalRfcPointers(standardLinkErrors, {
      pointers: [topLevelRfcPointer],
      readFile: () => body,
      repoRoot,
    })
    assert.deepEqual(standardLinkErrors, [])
  }

  for (const body of [
    `Use \`[RFC](${canonicalRfcPath})\`.`,
    `\`\`\`markdown\n[RFC](${canonicalRfcPath})\n\`\`\``,
    `![RFC](${canonicalRfcPath})`,
    `<!-- [RFC](${canonicalRfcPath}) -->`,
  ]) {
    const nonNavigableErrors = []
    docsValidator.validateCanonicalRfcPointers(nonNavigableErrors, {
      pointers: [topLevelRfcPointer],
      readFile: () => body,
      repoRoot,
    })
    assert.deepEqual(nonNavigableErrors, [
      `${topLevelRfcPointer} must link to ${canonicalRfcPath}`,
    ])
  }

  const linkedImageErrors = []
  docsValidator.validateCanonicalRfcPointers(linkedImageErrors, {
    pointers: [topLevelRfcPointer],
    readFile: () => `[![RFC](${canonicalRfcPath})](plugins/desk/README.md)`,
    repoRoot,
  })
  assert.deepEqual(linkedImageErrors, [
    `${topLevelRfcPointer} must link to ${canonicalRfcPath}`,
  ])
})

test("default markdown discovery paths cover tracked docs, archive filtering, reference fallbacks, and local-link defaults", () => {
  assert.equal(docsValidator.listTrackedMarkdownFiles().includes(canonicalRfcPath), true)
  assert.deepEqual(
    docsValidator.findCanonicalRfcCopies({
      repoRoot: "/unused",
      markdownFiles: [canonicalRfcPath, "_archive/old.md"],
      readFile: () => canonicalRfcBody(),
    }),
    [canonicalRfcPath],
  )

  const existing = path.join(repoRoot, "plugins", "desk", "README.md")
  const exists = (candidate) => candidate === existing

  const implicitLinkErrors = []
  docsValidator.validateLocalMarkdownLinks(implicitLinkErrors, {
    file: "notes.md",
    body: [
      "[Implicit][]",
      "[Implicit]: plugins/desk/README.md",
      "[Missing][nope]",
    ].join("\n"),
    repoRoot,
    exists,
  })
  assert.deepEqual(implicitLinkErrors, [])

  const linkErrors = []
  docsValidator.validateLocalMarkdownLinks(linkErrors, {
    file: "notes.md",
    body: "[Broken](./missing.md)",
    repoRoot,
    exists: () => false,
  })
  assert.deepEqual(linkErrors, [
    "notes.md has broken local link missing.md",
  ])

  assert.deepEqual(docsValidator.findCanonicalRfcCopies(), [canonicalRfcPath])
  docsValidator.validateCanonicalRfc([])
  const pointerErrors = []
  docsValidator.validateCanonicalRfcPointers(pointerErrors)
  assert.deepEqual(pointerErrors, [])
})

test("docs validator exports also pass through their repository defaults", () => {
  assert.equal(docsValidator.markdownLines("plugins/desk/README.md").length > 0, true)
  assert.deepEqual(docsValidator.fixtureRecord("fixture text"), {
    file: "fixture.md",
    line: 1,
    text: "fixture text",
    lower: "fixture text",
    headingPath: [],
    inFence: false,
  })
  assert.deepEqual(docsValidator.fixtureErrors("healthy path"), [])

  const errors = []
  docsValidator.validateHealthyPathLanguage(errors)
  docsValidator.validatePrivacyNotes(errors)
  docsValidator.validateTopicCoverage(errors)
  docsValidator.validateWorkflowWiring(errors)
  docsValidator.validateMcpReadmeToolSurface(errors)
  docsValidator.validateMcpToolRegistrySurface(errors)
  docsValidator.validateBrowserFocusPolicy(errors)
  assert.deepEqual(errors, [])

  assert.throws(() => docsValidator.validateLocalMarkdownLinks([]), /replace/u)
  docsValidator.validateLocalMarkdownLinks([], {
    file: canonicalRfcPath,
    body: readText(canonicalRfcPath),
  })
  assert.throws(() => docsValidator.localMarkdownLinkPaths(), /replace/u)
  assert.equal(
    docsValidator.localMarkdownLinkPaths({
      file: canonicalRfcPath,
      body: readText(canonicalRfcPath),
    }).every((entry) => path.isAbsolute(entry)),
    true,
  )

  assert.equal(docsValidator.run(), 0)
  const previousExitCode = process.exitCode
  try {
    process.exitCode = undefined
    assert.equal(docsValidator.startCli({ isMain: true }), 0)
    assert.equal(process.exitCode, 0)
  } finally {
    process.exitCode = previousExitCode
  }
})

test("run and startCli expose success, failure, and no-op CLI paths", () => {
  const goodBody = "Embeddings and snapshots are derivative data and may carry privacy risk."
  const workflowBody = [
    "run: node scripts/test-desk-docs.cjs",
    '- "plugins/desk/README.md"',
  ].join("\n")
  const stdout = []
  const stderr = []

  assert.equal(
    docsValidator.run({
      docs: ["plugins/desk/README.md"],
      privacyRequiredDocs: ["plugins/desk/README.md"],
      topicRequirements: [],
      workflowRequirements: [{
        path: ".github/workflows/validate-skills.yml",
        command: "node scripts/test-desk-docs.cjs",
        paths: ["plugins/desk/README.md"],
      }],
      readFile: (file) => {
        if (file === canonicalRfcPath) return canonicalRfcBody()
        if (file === topLevelRfcPointer) return `[Canonical RFC](${canonicalRfcPath})`
        if (file === "plugins/desk/README.md") {
          return `${goodBody}\n[Canonical RFC](./docs/agentic-engineering-v2-rfc.md)`
        }
        if (file === "plugins/desk/mcp/README.md") return mcpReadmeBody()
        if (file === "plugins/desk/mcp/src/tool-names.js") return toolNamesSource()
        if (file === "plugins/desk/skills/cdp-headed-browser/SKILL.md") return browserPolicyBody()
        return file.endsWith(".yml") ? workflowBody : goodBody
      },
      stdout: { write: (text) => stdout.push(text) },
      stderr: { write: (text) => stderr.push(text) },
    }),
    0,
  )
  assert.equal(stdout.join(""), "Desk docs validation passed.\n")
  assert.equal(stderr.join(""), "")

  const badStderr = []
  assert.equal(
    docsValidator.run({
      docs: ["plugins/desk/README.md"],
      privacyRequiredDocs: ["plugins/desk/README.md"],
      workflowRequirements: [],
      readFile: () => "Run `npm install`.",
      stdout: { write: () => {} },
      stderr: { write: (text) => badStderr.push(text) },
    }),
    1,
  )
  assert.match(badStderr.join(""), /Desk docs validation failed:/u)
  assert.match(badStderr.join(""), /npm install/u)

  assert.equal(docsValidator.startCli({ isMain: false }), null)
  const exitCodes = []
  assert.equal(
    docsValidator.startCli({
      isMain: true,
      runFn: () => 7,
      setExitCode: (code) => exitCodes.push(code),
    }),
    7,
  )
  assert.deepEqual(exitCodes, [7])

  const previousExitCode = process.exitCode
  try {
    assert.equal(docsValidator.startCli({ isMain: true, runFn: () => 0 }), 0)
    assert.equal(process.exitCode, 0)
  } finally {
    process.exitCode = previousExitCode
  }
})

test("validator fixture self-tests cover artifact privacy and publication policy language", () => {
  const errors = []
  docsValidator.validateValidatorFixtures(errors)
  assert.deepEqual(errors, [])

  const selfTestErrors = []
  docsValidator.validateValidatorFixtures(selfTestErrors, {
    failingFixtures: [{
      text: "Do not run `codex mcp add` for the healthy path.",
      expected: "codex mcp add",
    }],
    passingFixtures: [{
      text: "Run `npm install`.",
    }],
  })
  assert.match(selfTestErrors.join("\n"), /expected "Do not run `codex mcp add`/)
  assert.match(selfTestErrors.join("\n"), /expected "Run `npm install`."/)

  for (const text of [
    "Vector packs are explicit release artifacts protected by publication policy.",
    "Snapshots restore into local state and do not mutate the repository artifact.",
    "Redaction cleanup uses tombstones and artifact rotation.",
  ]) {
    assertPasses(text)
  }
})

test("validateAll rejects docs stripped of required host and artifact coverage", () => {
  const privacyOnly = "Embeddings and snapshots are derivative data and may carry privacy risk."
  const workflowBody = [
    "run: node scripts/test-desk-docs.cjs",
    '- "plugins/desk/README.md"',
    '- "plugins/desk/docs/**"',
    '- "plugins/desk/mcp/README.md"',
    '- "plugins/desk/activation/README.md"',
    '- "desk/tasks/2026-06-14-1335-planning-desk-dependency-activation.md"',
    '- "scripts/test-desk-docs.cjs"',
  ].join("\n")

  const errors = docsValidator.validateAll({
    readFile: (file) => file.endsWith(".yml") ? workflowBody : privacyOnly,
  })

  for (const label of [
    "Codex global personal activation",
    "Claude native dependency activation",
    "Copilot root flattened bundle",
    "Ouroboros autonomous-agent bundle",
    "Generic stdio MCP-only fallback",
    "Vector pack publication",
    "Snapshot warm boot restore",
    "Redaction cleanup",
    "Publication policy approval",
  ]) {
    assert.ok(
      errors.some((error) => error.includes(label)),
      `${label} coverage should be required`,
    )
  }
})

test("topic coverage reports missing terms without accepting command-body false positives", () => {
  const errors = []
  docsValidator.validateTopicCoverage(errors, {
    requirements: [{
      label: "Fixture host coverage",
      docs: ["fixture.md"],
      terms: ["codex", "global-personal", "manual-only"],
    }],
    readFile: () => "Codex uses global-personal activation.",
  })

  assert.deepEqual(errors, [
    "docs must cover Fixture host coverage: missing manual-only in fixture.md",
  ])
})

test("actual Desk docs validate through the default file reads", () => {
  assert.deepEqual(docsValidator.validateAll(), [])
})
