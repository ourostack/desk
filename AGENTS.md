# Agent notes for this repository

## CI tiers

A pull request runs the fast tier, about 10 minutes, all on Linux:

- **Quick checks** (`desk-mcp-tests.yml`) runs first, in about 2 minutes. It parses every changed JavaScript, JSON and YAML file and runs the changed Desk test files that fit its budget. Everything else waits for it, so a syntax error fails fast.
- After it: the coverage shards and the coverage gate, unused code, the offline eval tests when the change touches them, and the Linux legs of the browser, Crew member-binding and black-box checks.
- `Validate skills` and `Claude Code plugin load` run alongside.
- A change to nothing but `docs/`, `README.md`, `SETUP.md` or `LICENSE` skips all but Quick checks and the skill checks. That list is the only one that may skip anything, and `windows_suite_shards.test.js` keeps it the same everywhere.

Main requires `CI gate`, `Validate skills` and `Claude Code plugin load`. `CI gate` knows which jobs a pull request may skip, so a skipped job never passes it by accident.

The heavy tier runs after the merge, on every push to `main` and on any dispatch: the Windows suite (16 shards), the Windows and macOS legs, the runtime packs, the release dry runs, native Windows and Factory macOS protection. Nothing on `main` is ever cancelled. To check a risky Windows or macOS change before you merge, dispatch the workflow on your branch (`gh workflow run desk-windows-suite.yml --ref <branch>`).

The Desk release waits for `desk MCP tests` and `desk MCP tests on Windows` to pass on the commit it ships (`.github/scripts/main-ci-gate.mjs`). A red `main` stops releases until it is fixed.

## Red main

When a heavy-tier check fails on `main`, its workflow opens a `main is red: <check>` issue labelled `red-main`. The issue closes itself when the check passes on `main` again.

- **Who fixes it:** the author of the pull request whose merge turned `main` red. Fix it or revert it within 30 minutes of the issue opening.
- **If that author is gone** (the session ended, or nothing happens within 30 minutes): whoever reads the issue first reverts the merge commit through a pull request. Agents draining this repository's issues take `red-main` issues before anything else.
- A random failure gets its own issue before anyone reruns it.
