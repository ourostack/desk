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

Current default coverage is deliberately narrow: native Mach-O images whose
absolute dependencies and loader bytes can be inspected. Unknown shell/npm
launchers, unresolved loader paths and unreadable dyld shared-cache images
hold as `launch_chain_unknown`. No installed engine is copied or patched.
The built-in file reader records managed file revisions, but cannot establish
OS/MDM or effective remote/MCP policy from current doctor text alone. It
therefore holds as `diagnostic_inadequate`. Trusted parent integration readers
are not model-accessible tools or new CLI flags; incomplete evidence never
becomes an unmanaged-host assertion.

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
blocks. Symlink probes exercise both directions against synthetic paths.
Unknown effective hook/helper/grant policy holds before a consuming probe.

No installed-host qualification, release, live rollout or publication is
asserted by this increment's unit suite.
