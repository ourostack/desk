# Relay replay fixtures

Recorded, sanitized GitHub data that `../../_relay_replay.js` feeds to the real `pollRelays`, so a relay's decisions can be asked of real histories. The tests are in `../../runtime/relay_replay.test.js`.

| Fixture | What it holds |
| --- | --- |
| `merge-large.json` | The final head of the last 40 pull requests merged in a repository with a large check matrix: every check run including each attempt, skipped and neutral runs and unexpanded matrix names, and the main branch's six latest completed runs of its workflow at merge time. |
| `merge-small.json` | The same for the last 20 merged pull requests of a repository with many small checks. |
| `dispatch-pushed.json`, `dispatch-chained.json` | The busiest 24 hours of runs of two watched workflows, one started by pushes and one by another workflow, for the `dispatch` relay. |

Every name is generic and every time is a number of seconds (before the merge for merge fixtures, after the window start for dispatch ones). No repository, pull request, commit, branch or person survives.

## Recording again

1. `record.mjs` saves the raw API answers to a directory outside the repository: `node record.mjs --repo owner/name --out <raw> --pulls 40 --main-workflow ci.yml`, and `--watch-workflow x.yml --days 3` for a watched workflow. `--gh "<command>"` names the command that runs `gh` as the right account.
2. Write a rules file beside the raw data (never commit it): `rename` maps real check-name prefixes to generic ones, `requiredChecks` lists the generic required names, and `requireMainWorkflowGreen` and `skippedPasses` copy the relay's settings.
3. `node sanitize.mjs merge --raw <raw> --rules <rules.json> --out merge-x.json` (or `dispatch`) writes the fixture. Check it for real names before committing.

A fixture changes a test's counts, so a re-recording updates the numbers the tests pin.
