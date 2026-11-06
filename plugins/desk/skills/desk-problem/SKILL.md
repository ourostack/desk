---
name: desk-problem
description: Use when a Desk mechanism itself (a hook, boot check, migration, MCP tool or sync) fails at its own job. Not for ordinary task failures such as a failing test.
---

# Desk problem

A Desk mechanism just failed at its own job. This skill turns that into the standard block below, and — once fixed or not — a filed report, so the same failure never has to be silently rediscovered by another agent on another machine.

## The block format

Retain the same five-field block in diagnostic evidence when a mechanism cannot complete normally, after its safe recovery attempt. Routine background work and verified recovery stay quiet; surface unresolved failures, unknown effects and consequential changes once.

```
Desk problem: <mechanism> — <short symptom>
  broke: <raw signal — the exact command/exit status/error text, one line>
  means: <plain-language consequence, addressed to the operator>
  fix: <what Desk did automatically, or attempted and its result>
  file: <https://github.com/ourostack/desk/issues/NNN (filed) | known: <url> | not filed: <reason>>
  tell: <one line, ready to relay to the operator verbatim>
```

Illustrative recovered search:

```
Desk problem: search-index — warm index transaction failed
  broke: SQLITE_IOERR while refreshing the in-memory index.
  means: indexed search failed; the authorized source files remain readable.
  fix: the search engine executed directLexicalSearch and returned the fresh matching file; a later indexed query verified restoration.
  file: not filed: illustrative example
  tell: Search recovered through current files; indexed search was subsequently verified.
```

## The procedure

1. **Recognize.** A Desk mechanism failed to do its designed job — not the operator's task. If this is a bug in the code the operator asked for help with, or a failing test in their project, this skill does not apply. It does not apply either when Desk reports a state it did not cause and repairs it as designed, such as a checkout someone moved off its branch that `desk_doctor` switched back: that is the mechanism working (`friction-management` says how to tell whose state it is).
2. **Own recovery without blocking startup.** Session entry has a 3000 ms foreground budget. Sync, migrations, index work, deep checks and recovery belong in the background, not a serial repair loop before the supplied task. When the runtime acknowledges a recovery worker, retain its operation identity and use its supported local status/readback rather than dispatch a replacement or wait for settlement. A queued request or elapsed timeout is not custody or recovery proof. If custody is unknown, inspect it without blindly restarting. Routine pending work is neither degradation nor synchronization.
3. **Execute and verify the supported route.** Within existing authority, execute a known safe repair or trusted alternate that preserves the intended root, destination, identity and policy; naming a tool, discovering it or scheduling work is not recovery. Use the actual installed tool contract, never an invented CLI, raw handler, security downgrade or permission change. For a mutation with partial or unknown effects, read back its actual files, commit and push state before considering another dispatch; an error or timeout does not establish no effect. Classify confirmed applied, confirmed absent or unknown; preserve pending pushes and uncertainty. Retry only under duplicate-suppression or confirmed-absence semantics. Never move or unstage another writer's files or retry a protected refusal through a different route. For sync, verify incoming graph, outgoing delivery, local source and required bytes separately against the captured destination; a fetch or push alone is not synchronization.
4. **Keep the task and recovery distinct.** A checker, missing MCP, save failure or stale index does not revoke task authority. Continue independent authorized work while the recovery owner works; that progress is not proof of recovery, a successful save or current source. If no permitted recovery route exists, name the actual barrier and unresolved dependent operation. User-only authentication and conflicting writers cannot be guaranteed away. Preserve root/admission, source trust, authentication and protected-write gates on affected operations. Do not spawn a repair child, take an improvement card, edit tooling source or open a repair PR unless repair is explicitly in scope. Preserve evidence for the existing repair owner.
5. **Retain the block locally**, regardless of recovery outcome, independent of issue filing. Keep routine verified recovery out of the first reply.
6. **Check for a known issue before filing.** This step and the next are what `fileDeskProblem` (`plugins/desk/mcp/src/factory/desk-problem-file.js`) does: it computes the failure fingerprint and searches `ourostack/desk` issues labeled `desk-problem` with `state: "all"` (not just open — a closed-as-shipped or closed-as-wontfix issue is still known, and refiling it is pure noise) for a body containing the matching fingerprint marker.
7. **File, or mark known.** A match: `file:` says `known: <url>`, nothing new is filed. No match: `fileDeskProblem` opens a new issue via the public-safe template below, embedding the fingerprint marker; `file:` carries the new URL. A held cap, no suitable account, or `gh` unavailable are all `not filed: <reason>` — never a thrown error, and never a reason to hold up the supplied task.
8. **Leave repair ownership distinct.** The loop can route a filed or known problem to an improvement card (`desk_problem:ourostack/desk#<n>`). Reporting the fault during an ordinary task does not assign that card to this agent or authorize source repair. A separately authorized repair owner follows `desk:curator`; do not duplicate another controller's work. Card closure and release remain separate from this task's completion. The card closes after 7 days quiet once released and the issue is closed: `closed_confirmed` when the known-hit reading is measured and shows no hit, `closed_unverified` otherwise.
9. **Tell the operator about unresolved or consequential outcomes**, once, in plain words, never a form-style prompt. Routine successful recovery needs no warning or health report.

## Search recovery

The engine routes supported exact-word and timeline requests through `directLexicalSearch` after classified in-memory index faults. It reads current files with the existing exclusions and tombstones; thread and meaning-based requests keep their own contracts. `searchStatus()` identifies `index_unavailable`, the actual lexical backend and the index error code. File results prove that request recovered, not that the index was repaired. A later successful indexed request establishes restoration. Filesystem, authorization, policy and unknown errors remain errors; do not turn an unreadable source into empty results.

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
