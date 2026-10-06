---
name: desk-problem
description: Invoke when a Desk mechanism itself — a hook, a boot check, a migration, an MCP tool call, the sync step — fails to do its own designed job (a nonzero exit where zero was expected, an exception its own try/catch didn't already turn into a normal result, a budget timeout, or a result the mechanism itself flags as a failure state). This is about Desk breaking, not about the task the operator asked for. Do NOT invoke for an ordinary task failure (a failing test, a rejected PR review, a bug in the code being worked on) — that is the task's own problem, not Desk's.
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
  fix: unstaged the 2 untracked-then-staged paths, moved them to `_cache/stray-2026-09-28/` (git-ignored; nothing deleted), retried the pull — it now succeeds.
  file: https://github.com/ourostack/desk/issues/123 — filed (no existing fingerprint match)
  tell: Sync was stuck on 2 stray staged files from another session; I moved them aside (they're safe, in _cache/) and sync is working again. Filed ourostack/desk#123 so this fails loudly next time instead of just warning.
```

## The procedure

1. **Recognize.** A Desk mechanism failed to do its designed job — not the operator's task. If this is a bug in the code the operator asked for help with, or a failing test in their project, this skill does not apply.
2. **Fix, deterministically first.** Try the mechanism-specific, already-known repair — retry the pull with `--rebase --autostash` once; quarantine an orphaned stray path (never delete); rerun a migration's own printed repair command; retry a lock-contended write after the hold. If that resolves it, say so in the `fix:` field and move on — most of the block's job here is record-keeping, not drama.
3. **Never block.** If the deterministic fix doesn't fully resolve it, fall back to ordinary judgment — plain shell, ordinary Desk tools, reasoning about the actual repo state. Work continues either way; the block is informational, not a gate.
4. **Emit the block locally**, always, regardless of whether step 2 fully worked. This is what the operator sees and what the session transcript carries, independent of whether an issue gets filed.
5. **Check for a known issue before filing.** This step and the next are what `fileDeskProblem` (`plugins/desk/mcp/src/factory/desk-problem-file.js`) does: it computes the failure fingerprint and searches `ourostack/desk` issues labeled `desk-problem` with `state: "all"` (not just open — a closed-as-shipped or closed-as-wontfix issue is still known, and refiling it is pure noise) for a body containing the matching fingerprint marker.
6. **File, or mark known.** A match: `file:` says `known: <url>`, nothing new is filed. No match: `fileDeskProblem` opens a new issue via the public-safe template below, embedding the fingerprint marker; `file:` carries the new URL. A held cap, no suitable account, or `gh` unavailable are all `not filed: <reason>` — never a thrown error, and never a reason to hold up step 4's block.
7. **A filed or known problem has an improvement card.** The loop's route step opens `desk_problem:ourostack/desk#<n>` for every open `desk-problem` issue a consenting account filed, so you do not open the card yourself, and a known issue already has one. An agent that takes the card fixes the cause in the same pull request flow as any card and records its rulings in the countermeasure pull request (`desk:curator`, "The improvement-card routine"). The card closes after 7 days quiet once the fix is released and the issue is closed: `closed_confirmed` when the known-hit reading is measured and shows no hit, `closed_unverified` otherwise.
8. **Tell the operator**, once, in plain words — the `tell:` line, said in normal conversation, never a form-style prompt.

## The public-safe issue template

Structured fields only, mirroring `kaizen-file.js`'s `publicCard` shape:

- **Title:** `<mechanism id>: <short, generic symptom>`, normalized the same way `normalizeTitle` does.
- **Body fields:** mechanism id; Desk version; host (`claude`/`codex`/`copilot`, never an account or org name); the raw error text, only if it passes the same credential/path/email scrub `kaizen-file.js`'s `isGeneric`/`PRIVATE_TEXT` already run — otherwise a generic placeholder; what the deterministic fix attempted and its result; the fingerprint marker (`<!-- desk-problem-fingerprint: <hex> -->`).
- **Forbidden, always:** operator name or email, any machine path, any task or track name, session transcripts, anything credential-shaped. A desk-relative path (`<track>/<task>/planning.md`) is reduced to a count and category before it ever reaches a rendered issue body — only Desk's own reserved names (`_meta`, `_friction`, `_planning`, `.gitignore`) survive verbatim, and only as a bare two-segment path.
- **Label:** `desk-problem`, plus `bug`.

## The fingerprint

Plain `SHA-256` of `<mechanism id>\n<normalized error signature>` — deliberately no secret, unlike `kaizen-file.js`'s machine-local `HMAC`. A Desk problem's whole point is catching that a *different* agent on a *different* machine already hit and reported the exact same failure, so every agent on every machine must compute the same hash for the same failure. The normalized signature strips run-specific detail (file paths, commit hashes, timestamps, counts): two pulls blocked by two different stray filenames are the same signature; two pulls blocked by an actual merge conflict on different files are also the same signature, distinct from the stray-file one. There is no separate database mapping signatures to issues — the fingerprint marker in the issue body is the mapping, looked up live via `listIssues` every time, so it can never drift from what is actually still open or closed on GitHub.

## Rate limit and account

At most 5 filings to `ourostack/desk` in a 24-hour window (`desk_problem_filed` in the factory's `status.json`, alongside `kaizen_filed`); past the cap, filing is held, never an error. The account that files is never a managed or Enterprise Managed User account, and never one that cannot see `ourostack/desk` (the desk's own recorded consent account is preferred when it can also deliver, otherwise the account `chooseAccount` itself picks). No suitable account is `not filed: no_suitable_account`, and the block still carries a paste-ready issue title and body so the operator's agent can file it by hand later. No consent prompt is needed for this: reporting that Desk's own shared tool broke is not the operator's private data, and the target is always this one fixed public infrastructure repo, never a routed private store.
