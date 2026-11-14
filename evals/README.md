# Skill evaluations

These files are behavior contracts for external agent runs.

Regex prose checks can remain textually correct while composed runtime behavior regresses; these cases preserve external-run contracts, while CI validates schema, coverage, and source freshness only.

CI does not run or judge a model.

A real behavior claim requires an external harness result whose complete, current receipt passes `verify`.

Declared source completeness is a maintainer-reviewed mapping that the script cannot infer; any change to a declared owner requires review.

The pilot fingerprints each declared owner as a whole file; do not add section or anchor extraction unless whole-file review becomes insufficient.

Run `node scripts/skill-evals.cjs validate`, `node scripts/skill-evals.cjs fingerprint evals/investigation-boundaries.json`, or `node scripts/skill-evals.cjs verify path/to/result.json`. The fingerprint command prints both hashes a receipt must carry; use its output instead of reserializing the contract.

A suite whose eval was rerun and still fails may carry `"knownFailure": {"issue": "<issue URL>", "case": "<case id>", "observed": "YYYY-MM-DD"}` beside `reviewedSourceFingerprint`, or a list of such objects when several cases fail (one entry per case, each with its issue). Add it only after you reran the eval and the case failed, and refresh the fingerprint as usual. `validate` accepts it only with an issue URL and prints a `KNOWN FAILURE` line, `verify` refuses a receipt while it remains, and it does not change `contractFingerprint`. Delete it when the eval passes again.

A suite's fingerprint may move only with evidence of a real run. `validate` fails a suite whose `contractFingerprint` differs from the one in `evals/receipts/_baseline.json` (today's frozen state; never add to it) unless `evals/receipts/<suite id>.json` is a current, passing receipt or the suite carries a `knownFailure`. Run the eval and write its receipt with one command, `node scripts/skill-evals.cjs run <suite>` for one suite or `node scripts/skill-evals.cjs run --changed` for every suite whose contract or reviewed sources differ from where your branch left main (see below). To record a result from some other harness instead, use `node scripts/skill-evals.cjs record evals/<suite>.json --result <harness-result.json>` (`-` reads stdin, so `<harness> | node scripts/skill-evals.cjs record evals/<suite>.json --result -` runs and records in one step). The harness result carries `run` (`actor`, `model`, `runtimeRevision`, `startedAt`, `completedAt`) and per-check `cases`; `record` adds the suite id and both fingerprints, applies `verify`'s checks and writes the receipt only if they pass. Commit the receipt with the fingerprint change.

## Running a suite

`node scripts/skill-evals.cjs run <suite-file|suite-id|--changed>` runs each case through the GitHub Copilot CLI in headless mode and writes `evals/receipts/<suite id>.json`. Each case gets a fresh subject process that loads the plugin owning the suite's sources from your checkout and runs as that plugin's default agent, the way the app starts a session. A separate judge process then rules on every check from the subject's final response, its tool requests and the workspace state the harness collects afterwards. Both need a signed-in `copilot`; the run takes about 30 to 60 seconds per case, up to three cases at a time.

The subject works in a scratch desk that Desk binds through `$DESK`, so the startup text matches a bound session instead of the first-run setup path. A suite whose sources include `evals/fixtures/<name>/` also gets a scratch copy of that repository (frozen dependencies installed, one baseline commit) as the working folder. Each case gets its own copies, removed afterwards. The subject has shell and write tools, the built-in GitHub tools are off, and its GitHub, npm and Git credential files and Desk state are replaced with empty scratch ones. It still inherits environment tokens, so run where none are set. The prompt starts with a short note that the scenario is true even where the scratch workspace does not show it, because the workspace cannot hold the repository, package or pull request a scenario names. The judge also sees the scratch repositories' uncommitted changes, new commits, changed files and test results, which is the only evidence for `state` and `git` checks.

The subject defaults to `gpt-6.1-sol`, the model the accepted receipts were recorded with, and the judge to `claude-opus-5.5`. Change them with `--subject-model` and `--judge-model` (or `DESK_EVAL_SUBJECT_MODEL` and `DESK_EVAL_JUDGE_MODEL`). The run refuses to use one model for both unless you pass `--self-judge`, and then the receipt says `self-judged` in `run.judge` and `run.model`, and `verify` repeats it. A headless run cannot ask the human a question, so a case that requires ending with a request for go can fail for that reason alone; record it as a `knownFailure`.

The receipt's `run` records the harness command and version, the plugins loaded, the models, whether the judge was independent, and the case and check pass counts, beside the per-check evidence. A run with any failed check writes no receipt and exits non-zero, because a receipt records only a passing run. A suite with a `knownFailure` still runs: while only the named case fails it exits zero, writes nothing and keeps the annotation; once everything passes it writes the receipt and tells you to delete the annotation.

`--dry-run` runs and judges without writing. `--harness <command>` replaces `copilot` with another command that accepts the same flags (a `.js`, `.cjs` or `.mjs` path runs under Node), which is how `scripts/test-skill-evals.cjs` tests the runner with a fake. `--base <ref>` changes the `--changed` comparison point from `origin/main`, then `main`.

Add scenarios from observed regressions, not to inflate counts.

## Core meeting capture

`core-meeting-capture.json` exercises receipt-only publication, useful recording stills, excluded private screens, unknown multipart clocks, and absent, unavailable or irrelevant video. Its inputs are synthetic. Run fresh-context no-guidance controls before guided samples; manually inspect each output for invented decisions, progress, pixels and completion. Simulated adapter plans prove instruction-following only, not actual media retrieval or visual inspection.

The absent-price-catalogue case uses a real synthetic PNG, `fixtures/core-meeting-capture-diagram.png`. Its external run must actually supply that approved raster to an available economical capable visual model. Exact price remains unknown; it is not an inspection prerequisite. The source-contract regression `scripts/test-core-meeting-capture-model-choice.cjs` runs inside `node scripts/test-skill-evals.cjs`; CI still does not run a model.

## Engineering V2 preview

The [experimental outcome ledger](engineering-v2-results.md) records the initial comparisons and both completed method rounds, including failed delivery qualification, invalid judgments and actual-consumption limits. It is not a source-current behavioral receipt for the published fixture variant.

The [experiment design and arm definitions](engineering-v2-experiments.md) publish the historical source pins, invocation modes, original coding task and frozen rubric. They distinguish the original recordings from a new run of the publication variant.

`engineering-v2-kernel.json` preserves three model-facing contracts: first-step alignment, already-approved local implementation, and primary-source status in the presence of a green proxy. The writable fixture and available tools must make premature implementation possible; a denied write capability is containment evidence, not voluntary restraint.

Use a fresh subject and independent judge, and retain the actual prompt, model and runtime identity, exact plugin/source pins, complete available tool trace, committed and uncommitted state, deterministic results, and semantic findings. Record the invocation mode: an unattended/autopilot run is a pressure test, not a substitute for a real multi-turn alignment conversation. Source-contract validation does not establish that a skill was consumed; inspect the trace.

Keep valid failures and incomplete setup attempts. Do not rerun a valid failure to improve its score, convert passing-criterion counts into quality points, or treat runtime API duration as task elapsed time or employee productivity. A source-current complete receipt is necessary for a behavior claim, not sufficient evidence that the judge was right.

The preview's feedback storage, installation, and rollback have separate runtime tests. This method-slice suite does not certify those surfaces or the full worker startup path. New production regressions should become small, independently falsifiable cases rather than another evaluation framework.

## Fixed offline alpha tooling

The [offline tooling](offline/README.md) adds versioned generic fixtures, role-separated materialization, bounded sealed evidence, pure report admission, committed artifact inventories and an executable `offline validate` / `offline compare` interface. Those static commands remain SDK-free and do not claim a scored evaluation. The native subject/judge producer is not yet admitted: `offline run` returns an explicit unavailable qualification result rather than using a mock or arbitrary shell runner. Historical preview receipts and the legacy CLI/library contracts remain unchanged.
