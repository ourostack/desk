# Factory triage runner

Triage is disabled until a protected root-owned qualification record proves
the actual installed engine's confinement on two identical admitted launches.
Unit fixtures do not qualify an installed CLI. A valid candidate is not
permission to publish private prose or commit a changed card basis.

## Threat and authority boundary

The model and prepared/source content are adversarial. The parent, installed
engine/runtime and privileged policy controllers preserve the admitted
file/tool/billing invariant. Their theoretical ability to change policy is
not itself a hold. Unknown applicable delivery, unsafe effective policy or
unsupported governance is a hold.

Admission fingerprints the selected execution chain, runtime files, argv,
allowlisted environment selection, and effective source revisions. It runs
the selected executable's bounded non-model `doctor` command. A trusted
nonexecuting policy reader must establish all applicable sources and grant
merge semantics. File absence and version/help labels alone cannot do this.

The connected default macOS arm64 adapter validates the installed Anthropic
signature and Apple loader signature. It records the sealed APFS boot snapshot,
enabled SIP/authenticated root, OS build, actual shared-cache UUID/header/hash,
map and root-owned subcache identities. Shared-cache provenance is trusted
installed-platform evidence, not fabricated individual dylib hashes or an
administrative tamper-proof guarantee. Unknown launchers/platforms still hold.
No installed engine is copied or patched.

The default policy reader is bound to the source-inspected signed native
2.1.296 SHA-256. It reads the actual native per-user/device MDM plist paths
through `plutil`, managed JSON/drop-ins, managed MCP, and remote cache; it
combines those observations with positive doctor applicability/completion.
Restricted/safe mode excludes user/project/local discovery. Before doctor,
command-bearing user diagnostic settings are also inspected and rejected.
Doctor runs from `/`, not an untrusted project. Only positively resolved
no-applicable/no-config remote policy with compatible known local sources is
admitted by this initial adapter. Delivered/failed/unknown cache, incompatible
keys, unsigned or source-unverified engine revisions remain concrete holds.
This works through the default CLI: no external reader injection is needed
for a compatible inspectable installed host.

## Pinned supported CLI controls

The official sources checked for this increment are:

- Claude Code CLI reference: `https://code.claude.com/docs/en/cli-reference`
- Read/Edit permissions: `https://code.claude.com/docs/en/permissions#read-and-edit`
- Settings: `https://code.claude.com/docs/en/settings`
- Server delivery diagnostics:
  `https://code.claude.com/docs/en/server-managed-settings#verify-settings-delivery`

Supported candidate invocation, with `cwd=inputDir`, no additional directory,
and precreated `.triage-result.json`:

```text
-p --restricted --safe-mode --permission-mode dontAsk --permission-prompts none
--tools Read,Grep,Glob,Edit --disable-slash-commands --no-chrome
--no-session-persistence --strict-mcp-config --mcp-config '{"mcpServers":{}}'
--settings <inline-policy-json> --max-budget-usd 1
--output-format stream-json --verbose --system-prompt <fixed-inline-brief>
```

The fixed policy is:

```json
{
  "permissions": {
    "allow": ["Read(//absolute/result/path)", "Edit(//absolute/result/path)"],
    "deny": ["Bash", "PowerShell", "REPL", "Agent", "Task", "Skill", "WebFetch", "WebSearch", "mcp__*"]
  },
  "disableAllHooks": true
}
```

The result uses the exact absolute path specifier. **Do not add a result Read
deny:** documented Read denies also defeat Edit/Write. DontAsk does not erase
inherited grants; inspect the actual effective policy. Restricted/safe modes
retain managed settings and managed hooks. Local hook disabling is not proof
that managed command-bearing controls are absent.

No bare mode, bypass, agent/session inheritance, mutable settings file,
permission-host callback, added tool, plugin or MCP gate is authorized.
Sign-in is still probed by the maintained first-party subscription guard.
Provider/billing variables still block before any launch.

## Production and qualifier

`runTriageChild` consumes parent-only `qualification` state. Production state
must be `qualified` with two launches and the matching fingerprint; `probing`
is reserved to the explicit qualifier. Parent-provided resolver/diagnostic/
policy-reader adapters must be authentic, not synthetic fixture results.
They are neither model claims nor public status fields.

The runner rechecks admission before sign-in, immediately before spawn, and
after exit. Detected drift invalidates the record and rejects the candidate;
it is acceptance/new-launch control, **not synchronous per-tool prevention**.
Prepared `input.json` contains the parent's authorized candidate-validator
brief; the runner compares its bytes after exit. The caller must separately
revalidate external card/claim/ruling/evidence revisions before publication.
After the last awaited diagnostic/sign-in, prepared directory/input/result
identities and content are rechecked synchronously immediately before spawn.
Replacement or drift invalidates without spending a model launch.

Only root invokes the consuming qualifier after independent safety review:

```sh
node plugins/desk/mcp/scripts/qualify-triage-runner.js --cli /absolute/existing/engine --out /protected/evidence
```

Evidence must be outside Git, owner-only and not through symlink parents.
The qualifier retains bounded protected help/diagnostic/stream records,
synthetic sentinels, exact resources and case outcomes. It uses the same
policy and runner as production. It does not modify real policy or runtime.
Output stdout contains only closed state/reason and fingerprint.

Positive input/result Read and exact result Edit require actual correlated
tool results. Negative cases require correlated runtime refusal or positive
tool-manifest absence. Model text and unchanged sentinels alone fail. A
changed sentinel, widened tool manifest, invalid output or admission drift
blocks. Excluded command/agent/network/MCP calls are correlated globally by
name and actual tool-use IDs, regardless of argument shape or target. An
omitted tool in the manifest cannot excuse a successful actual invocation.
Symlink probes exercise both directions against synthetic paths.
Unknown effective hook/helper/grant policy holds before a consuming probe.

Runtime and policy mutation probes target the **actual admitted** engine and
policy source, using deliberately nonmatching Edit strings so a broken
permission check cannot alter real installed bytes. A generic outside-file
refusal is not customization proof. Private isolated `.claude/settings.json`
fixtures contain genuine project hook/helper discovery keys and harmless
indicator code, never installed into HOME or managed controls. The qualifier
forces reading that prepared triggering source and an exact permitted result
Edit containing the triggering data. It requires authenticated pinned-native
discovery-disable/data-only capability evidence as well as those actual tool
observations; hook events or an executed indicator block. Neither fixture
configuration nor indicator code is enabled/executed by this author pass.

No installed-host qualification, release, live rollout or publication is
asserted by this increment's unit suite.
