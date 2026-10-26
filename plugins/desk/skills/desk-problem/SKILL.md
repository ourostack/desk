---
name: desk-problem
description: Use when a Desk mechanism itself (a hook, boot check, migration, MCP tool or sync) fails at its own job. Not for ordinary task failures such as a failing test.
---

# Desk problem

A Desk mechanism just failed at its own job. This skill turns that into the standard block below, and — once fixed or not — a filed report, so the same failure never has to be silently rediscovered by another agent on another machine.

## The block format

Every migrated mechanism emits the same five-field block, in this order, whenever it cannot complete its job the normal way — after it has already tried the deterministic fix:

```
Desk problem: <mechanism> — <short symptom>
  broke: <raw signal — the exact command/exit status/error text, one line>
  means: <plain-language consequence, addressed to the operator>
  fix: <what Desk did automatically, or attempted and its result>
  file: <https://github.com/ourostack/desk/issues/NNN (filed) | known: <url> | not filed: <reason>>
  tell: <one line, ready to relay to the operator verbatim>
```

Worked example, from a real incident:

```
Desk problem: session-sync — git pull --rebase failed
  broke: `git pull --rebase --quiet origin main` exited 1: "cannot pull with rebase: Your index contains uncommitted changes."
  means: two staged files from another session are blocking this desk's sync; it hasn't pulled in this session.
  fix: left the other session's staged paths untouched; read the local task and continued independent work without retrying a conflicting write.
  file: https://github.com/ourostack/desk/issues/123 — filed (no existing fingerprint match)
  tell: Sync is blocked by another session's staged files. I preserved them and continued the task using local state; sync remains unhealthy. Filed ourostack/desk#123.
```

## The procedure

1. **Recognize.** A Desk mechanism failed to do its designed job — not the operator's task. If this is a bug in the code the operator asked for help with, or a failing test in their project, this skill does not apply. It does not apply either when Desk reports a state it did not cause and repairs it as designed, such as a checkout someone moved off its branch that `desk_doctor` switched back: that is the mechanism working (`friction-management` says how to tell whose state it is).
2. **Bounded operational recovery.** For a mutation with partial or unknown effects, read back its actual files, commit and push state before considering a retry; an error or timeout does not establish no effect. Classify confirmed applied, confirmed absent or unknown; preserve pending pushes and uncertainty. Retry only when safe under the destination's duplicate-suppression or confirmed-absence semantics. Use an already-known repair within this task's authority, never move or unstage another writer's files, and never bypass an actually refused protected mutation. If it resolves the fault, report exactly what readback established.
3. **Continue the task, not a maintenance project.** When safe operational recovery is unavailable, use available authorized tools or transports for the supplied task. A checker, missing MCP, save failure or stale index does not revoke task authority. A fallback does not qualify or fix the failed helper. Record what could not be saved and where recoverable work remains; never invent a successful save or discard applied effects. Respect real authentication, source trust, protected writes, permission denials and conflicting writers; stop only the dependent operation and continue independent safe work. Do not spawn a repair child, take an improvement card, edit tooling source or open a repair PR unless that repair is explicitly in this task's scope. Preserve evidence for the existing repair owner.
4. **Emit the block locally**, always, regardless of whether step 2 fully worked. This is what the operator sees and what the session transcript carries, independent of whether an issue gets filed.
5. **Check for a known issue before filing.** This step and the next are what `fileDeskProblem` (`plugins/desk/mcp/src/factory/desk-problem-file.js`) does: it computes the failure fingerprint and searches `ourostack/desk` issues labeled `desk-problem` with `state: "all"` (not just open — a closed-as-shipped or closed-as-wontfix issue is still known, and refiling it is pure noise) for a body containing the matching fingerprint marker.
6. **File, or mark known.** A match: `file:` says `known: <url>`, nothing new is filed. No match: `fileDeskProblem` opens a new issue via the public-safe template below, embedding the fingerprint marker; `file:` carries the new URL. A held cap, no suitable account, or `gh` unavailable are all `not filed: <reason>` — never a thrown error, and never a reason to hold up step 4's block.
7. **Leave repair ownership distinct.** The loop can route a filed or known problem to an improvement card (`desk_problem:ourostack/desk#<n>`). Reporting the fault during an ordinary task does not assign that card to this agent or authorize source repair. A separately authorized repair owner follows `desk:curator`; do not duplicate another controller's work. Card closure and release remain separate from this task's completion. The card closes after 7 days quiet once released and the issue is closed: `closed_confirmed` when the known-hit reading is measured and shows no hit, `closed_unverified` otherwise.
8. **Tell the operator**, once, in plain words — the `tell:` line, said in normal conversation, never a form-style prompt.

## Confirmed desk mismatch: validated local recovery

A confirmed requested/actual desk mismatch is a transport failure. A card-not-found result alone is not proof. Refuse the misrouted mutation first and establish the intended existing desk. Permission, validation, containment and genuinely missing-card errors stay refusals; never recommend an override.

Use the maintained local transport from the installed plugin's `mcp` directory:

```sh
node scripts/local-recovery.js --root "/confirmed/existing/desk" --operation task_update --input-file "/private/recovery-input.json"
```

The file, or stdin when `--input-file` is omitted, contains the ordinary tool JSON. Never put payloads or secrets in argv. The client starts the ordinary bootstrap and uses MCP, including shared admission, authority, card validation and exact-path commits. It checks its newly owned server's `desk_status` root and scope before dispatch and reports whether detail is current or cached within that owned session; old or undated cached detail refuses. The run ends within 100 seconds: up to 60 before dispatch, and the mutation gets the rest (at least 40), so it reports before a 120-second command limit. Only `task_update`, `task_create`, `task_archive` and `desk_save` are supported. Carry only the existing authorized `--person`/`--activation-config`; `--state-branch` cannot override its declaration. Do not edit config, restart the host or import raw handlers to recover.

Read the local JSON report, not just its exit code: `1` means not dispatched, `2` means partial or unknown effects, and `0` does not claim a push to a configured remote or project-code delivery. Commit failures may leave writes applied. Pending push is explicit. Never infer unchanged files from `isError` or automatically resend after timeout. Run the report's readback in the confirmed root and inspect the exact card/files from the original JSON before another mutation. See [the MCP recovery reference](../../mcp/README.md#validated-local-recovery-after-a-confirmed-transport-mismatch) for flags, effect classifications and resource lifetime.

Use the same `broke / means / fix / file / tell` block above: `broke` names the operation and signal; `means` identifies requested and actual roots locally, plus verified unchanged, applied or unknown effects; `fix` records refusal, validated recovery and readback outcomes; `file` uses the existing public-safe dedup/cap helper; `tell` relays only what the evidence establishes. No blanket success claim. If this validated path is unavailable, state the bounded manual exception and exactly which validation is absent; do not present manual card edits as equally validated. This transport does not fix underlying workspace selection or late context.

## The public-safe issue template

Structured fields only, mirroring `kaizen-file.js`'s `publicCard` shape:

- **Title:** `<mechanism id>: <short, generic symptom>`, normalized the same way `normalizeTitle` does.
- **Body fields:** mechanism id; Desk version; host (`claude`/`copilot`, never an account or org name); the raw error text, only if it passes the same credential/path/email scrub `kaizen-file.js`'s `isGeneric`/`PRIVATE_TEXT` already run — otherwise a generic placeholder; what the deterministic fix attempted and its result; the fingerprint marker (`<!-- desk-problem-fingerprint: <hex> -->`).
- **Forbidden, always:** operator name or email, any machine path, any task or track name, session transcripts, anything credential-shaped. A desk-relative path (`<track>/<task>/planning.md`) is reduced to a count and category before it ever reaches a rendered issue body — only Desk's own reserved names (`_meta`, `_friction`, `_planning`, `.gitignore`) survive verbatim, and only as a bare two-segment path.
- **Label:** `desk-problem`, plus `bug`.

## The fingerprint

Plain `SHA-256` of `<mechanism id>\n<normalized error signature>` — deliberately no secret, unlike `kaizen-file.js`'s machine-local `HMAC`. A Desk problem's whole point is catching that a *different* agent on a *different* machine already hit and reported the exact same failure, so every agent on every machine must compute the same hash for the same failure. The normalized signature strips run-specific detail (file paths, commit hashes, timestamps, counts): two pulls blocked by two different stray filenames are the same signature; two pulls blocked by an actual merge conflict on different files are also the same signature, distinct from the stray-file one. There is no separate database mapping signatures to issues — the fingerprint marker in the issue body is the mapping, looked up live via `listIssues` every time, so it can never drift from what is actually still open or closed on GitHub.

## Rate limit and account

At most 5 filings to `ourostack/desk` in a 24-hour window (`desk_problem_filed` in the factory's `status.json`, alongside `kaizen_filed`); past the cap, filing is held, never an error. The account that files is never a managed or Enterprise Managed User account, and never one that cannot see `ourostack/desk` (the desk's own recorded consent account is preferred when it can also deliver, otherwise the account `chooseAccount` itself picks). No suitable account is `not filed: no_suitable_account`, and the block still carries a paste-ready issue title and body so the operator's agent can file it by hand later. No consent prompt is needed for this: reporting that Desk's own shared tool broke is not the operator's private data, and the target is always this one fixed public infrastructure repo, never a routed private store.
