# Factory store playbook

This playbook sets up a new factory store: the GitHub repository that receives a boundary's published session facts, validates them, merges them and publishes the job reports. A maintainer with temporary admin rights on the repository can finish it in one sitting. Every step below was proven on the public [`ourostack/factory`](https://github.com/ourostack/factory) store, whose pull requests 1 to 6 are the receipts; the one exception is the private-store fork setting in step 4.

The store design, the published schema and the "no who, no when, just how" stance are in section 4 of the [Agentic Engineering V2 RFC](agentic-engineering-v2-rfc.md#4-the-factory-measuring-and-designing-the-work). The store-side commands are described in [Factory local session capture](factory-local-capture.md#store-side-validation-and-reports).

## What you end with

- A repository whose `main` holds `README.md`, `.github/workflows/` and two data paths: published facts at `facts/<host>-<session id>.json` and published waste labels at `labels/<job>/<session id>.json`. Anyone may add data files, grow a facts file or replace labels with a newer evaluator's; every other change, including any other file under those folders and every removal, is maintenance.
- A ruleset on `main`: every change arrives by pull request, the `factory-validate` check must pass, and nobody can force-push or delete the branch. Admins can bypass only while merging a pull request.
- `factory-validate`, which checks every pull request with Desk's validator. Our workflow file never runs the candidate's files, but GitHub runs a pull request's own workflow files, so the check alone is not evidence (see "Merging by hand" below).
- `factory-merge`, which validates each intake pull request again and merges it or closes it with `factory-rejected: <code>` comments. It never merges maintenance pull requests.
- `factory-build`, which rebuilds the reports and publishes them on the `reports` branch as one commit with no history.
- The labels `maintenance`, `kaizen`, `andon`, `confirmed` and `not-confirmed`.
- Three proof pull requests: one intake merged automatically, one intake rejected and closed, and one maintenance cleanup merged by a maintainer.

## Before you start

- **Admin rights.** You need admin on the store repository for the settings, and permission to create repositories in the owner account or organization.
- **Maintainers are people with write access.** The workflows treat a pull request's author as a maintainer when their permission on the store repository is `admin` or `write` (the `maintain` role reads as `write`). They read it from `GET /repos/{owner}/{repo}/collaborators/{author}/permission` with the workflow's own read-only token. They do not use GitHub's author association, which reports an organization member whose membership is private as `CONTRIBUTOR`. Give each maintainer write access or more, directly or through a team; nothing else is needed.
- **Private stores need a paid plan.** Rulesets on a private repository need GitHub Team or higher. A private store also needs the fork pull request settings in step 4.
- **Tools.** The GitHub CLI (`gh`), `git` and `jq`, and a token with the `repo` and `workflow` scopes. Pass the token per command as `GH_TOKEN=$(gh auth token --user <login>)`; do not switch the CLI's active account. The commands below assume `export GH_TOKEN=$(gh auth token --user <login>)` in the same shell.
- **Desk.** The workflows run `plugins/desk/mcp/scripts/factory.js` from `ourostack/desk` `main`, which must provide the `validate-pr` and `build` commands, and the runner's Git must be 2.38 or later, which GitHub-hosted runners provide. On an older Git, `validate-pr` fails closed with `git_too_old` and nothing merges.

Set the store name once:

```sh
STORE=<owner>/<repository>
```

## 1. Create the repository

Create the repository with no files, then push one bootstrap commit that holds only `README.md`. Protection goes on before any workflow lands.

```sh
gh repo create "$STORE" --public --disable-wiki \
  --description "Desk factory store: published session facts and CI-built job reports. No who, no when, just how."
```

Use `--private` instead of `--public` for a private store. The README must say:

- what the store holds, and that it measures the work, never the people;
- the stance: no who, no when, just how;
- the published schema's guarantees, with a link to section 4 of the RFC;
- how to read the `reports` branch (`index.md`, `jobs/<job>.md`, `jobs/<job>.json`);
- that contribution is opt-in through Desk;
- that an intake pull request's author, a GitHub account, is visible to anyone who can read the store, as are the times of the pull request and its commits, and that a rejected pull request stays readable after it is closed.

Copy the README of `ourostack/factory` and change the store name and links. Then:

```sh
git clone "https://github.com/$STORE" store && cd store
git add README.md
git commit -m "Bootstrap the factory store"
git push origin main
gh api "repos/$STORE" --jq '{full_name, visibility, default_branch}'
```

The read-back must show the visibility you chose and `default_branch: "main"`.

## 2. Repository settings

Merge commits only, so each intake keeps its own commit. Branches a maintainer merges are deleted after merge; GitHub skips this for merges made with the workflow token, which suits Desk's reused intake branches. Auto-merge stays off because `factory-merge` does the merging.

```sh
gh api -X PATCH "repos/$STORE" --input - <<'EOF'
{"has_issues":true,"has_projects":false,"has_wiki":false,"has_discussions":false,"allow_merge_commit":true,"allow_squash_merge":false,"allow_rebase_merge":false,"allow_auto_merge":false,"delete_branch_on_merge":true,"allow_update_branch":false,"merge_commit_title":"PR_TITLE","merge_commit_message":"PR_BODY","web_commit_signoff_required":false}
EOF
gh api "repos/$STORE" --jq '{has_issues,has_wiki,allow_merge_commit,allow_squash_merge,allow_rebase_merge,allow_auto_merge,delete_branch_on_merge}'
```

Issues stay on: the kaizen and andon steps added in milestone 5 open issues.

## 3. Labels

```sh
label() { gh api -X POST "repos/$STORE/labels" -f name="$1" -f color="$2" -f description="$3" --jq .name; }
label maintenance fbca04 "Maintainer change outside facts/ and labels/; never auto-merged"
label kaizen 0e8a16 "Improvement proposal raised from factory evidence"
label andon d93f0b "Stop-the-line signal raised from factory evidence"
label confirmed 1d76db "A kaizen or andon finding confirmed by review"
label not-confirmed bfd4f2 "A kaizen or andon finding that review did not confirm"
gh api "repos/$STORE/labels?per_page=100" --jq '[.[].name]'
```

`factory-merge` adds `maintenance` to maintenance pull requests and skips every pull request that carries it. The other four are used from milestone 5.

## 4. Actions settings

Allow only GitHub-owned actions, keep the default workflow token read-only (each workflow declares the permissions it needs), and let workflows run on pull requests from first-time contributors unless they are new to GitHub.

```sh
A="repos/$STORE/actions/permissions"
gh api -X PUT "$A" --input - <<<'{"enabled":true,"allowed_actions":"selected","sha_pinning_required":false}'
gh api -X PUT "$A/selected-actions" --input - <<<'{"github_owned_allowed":true,"verified_allowed":false,"patterns_allowed":[]}'
gh api -X PUT "$A/workflow" --input - <<<'{"default_workflow_permissions":"read","can_approve_pull_request_reviews":false}'
gh api -X PUT "$A/fork-pr-contributor-approval" --input - <<<'{"approval_policy":"first_time_contributors_new_to_github"}'
for p in "" /selected-actions /workflow /fork-pr-contributor-approval; do gh api "$A$p"; echo; done
```

`factory-validate` runs with a read-only token and no secrets, so running it on outside contributions without approval is safe. A stricter policy (`first_time_contributors` or `all_external_contributors`) makes a maintainer approve each new contributor's first run before the intake can merge.

**Private store only.** Workflows do not run on fork pull requests to a private repository until you allow it. Allow the runs without write tokens or secrets:

```sh
gh api -X PUT "$A/fork-pr-workflows-private-repos" --input - <<<'{"run_workflows_from_fork_pull_requests":true,"send_write_tokens_to_workflows":false,"send_secrets_and_variables":false,"require_approval_for_fork_pr_workflows":false}'
gh api "$A/fork-pr-workflows-private-repos"
```

In the web UI this is Settings → Actions → General → Fork pull request workflows. The organization's Actions policy must allow the same; an organization owner sets it under the organization's Settings → Actions → General. This setting was not exercised on `ourostack/factory`, which is public; read it back after setting it.

## 5. The ruleset on `main`

```sh
gh api -X POST "repos/$STORE/rulesets" --input - <<'EOF'
{
  "name": "main",
  "target": "branch",
  "enforcement": "active",
  "conditions": {
    "ref_name": {
      "include": [
        "~DEFAULT_BRANCH"
      ],
      "exclude": []
    }
  },
  "bypass_actors": [
    {
      "actor_id": 5,
      "actor_type": "RepositoryRole",
      "bypass_mode": "pull_request"
    }
  ],
  "rules": [
    {
      "type": "deletion"
    },
    {
      "type": "non_fast_forward"
    },
    {
      "type": "pull_request",
      "parameters": {
        "required_approving_review_count": 0,
        "dismiss_stale_reviews_on_push": false,
        "require_code_owner_review": false,
        "require_last_push_approval": false,
        "required_review_thread_resolution": false,
        "allowed_merge_methods": [
          "merge"
        ],
        "require_extra_approval_for_unattributed_changes": false
      }
    },
    {
      "type": "required_status_checks",
      "parameters": {
        "strict_required_status_checks_policy": false,
        "do_not_enforce_on_create": false,
        "required_status_checks": [
          {
            "context": "factory-validate",
            "integration_id": 15368
          }
        ]
      }
    }
  ]
}
EOF
gh api "repos/$STORE/rulesets" --jq '.[] | {id, name, enforcement}'
gh api "repos/$STORE/rules/branches/main" --jq '[.[].type]'
```

What each part does:

- `deletion` and `non_fast_forward`: nobody can delete `main` or force-push it.
- `pull_request` with no required approvals and merge method `merge`: every change arrives through a pull request; no human review is required, because the validator decides.
- `require_extra_approval_for_unattributed_changes: false`: GitHub turns this on when a ruleset leaves it out. It demands a human approval for commits whose author email maps to no GitHub account, which would stall automatic intake merges.
- `required_status_checks` with `factory-validate` from integration `15368` (GitHub Actions): the validator's check must pass, and only GitHub Actions can supply it. A pull request's own workflow files also run on GitHub Actions, so a pull request can supply a green `factory-validate` of its own; the ruleset keeps unvalidated changes off `main` only together with the rule in "Merging by hand". It is not strict, so an intake does not need to be rebased onto the latest `main`.
- The bypass: the repository Admin role (actor `5`) in `pull_request` mode. Admins cannot push to `main` directly; they can only merge a pull request past a failing requirement, and GitHub records the bypass on the pull request. Use it only for a maintenance pull request that cannot pass, such as a fix to a broken validator.

The check can be required before it has ever run. Prove the protection by trying a direct push; it must be refused with "push declined due to repository rule violations":

```sh
git commit --allow-empty -m "Probe protection" && git push origin HEAD:main; git reset --hard HEAD~1
```

## 6. The workflows

Add the three files below unchanged, on a branch, and open the pull request with the `maintenance` label so `factory-merge` leaves it alone:

```sh
git switch -c maintenance/workflows
git add .github/workflows/validate.yml .github/workflows/merge.yml .github/workflows/build.yml
git commit -m "Add the factory workflows"
git push -u origin maintenance/workflows
gh pr create --repo "$STORE" --base main --head maintenance/workflows --label maintenance \
  --title "Add the factory workflows" --body "Adds factory-validate, factory-merge and factory-build."
gh pr checks --repo "$STORE" --watch maintenance/workflows
gh pr merge --repo "$STORE" maintenance/workflows --merge
```

`factory-validate` must pass before you merge; when it passes for a maintenance change, its summary reads `factory-validate: passed (maintenance)`. If it fails with `path`, your permission on the repository is below `write`, or the summary also says `maintainer_check_unavailable` because the permission lookup failed; fix the permission or re-run the check.

### `.github/workflows/validate.yml`

```yaml
# Validates every pull request against the published facts schema.
#
# The candidate is untrusted data. This workflow checks out the base, fetches
# the pull request's exact head commit as Git objects only, and runs Desk's
# validator, cloned from ourostack/desk main, on what merging that head into
# the base would land. This file never checks out, installs or executes the
# candidate's files. Failures report stable reason codes only.
#
# GitHub runs the workflow files of the pull request's own merge commit on
# `pull_request`, so a pull request that edits this file, or adds a workflow
# with a job named `factory-validate`, runs its own code here instead, with
# a read-only token and no secrets, and can post a green check. A green
# `factory-validate` is therefore not evidence on its own: factory-merge
# validates again from main before it merges, and a maintainer merges
# someone else's pull request only through factory-merge or after running
# validate-pr at its exact head.
#
# A maintainer is the pull request author when their permission on this
# repository is `admin` or `write` (`maintain` reads as `write`), read from
# the collaborator permission API with the read-only workflow token. The
# author association is not used: it depends on whether a member's
# organization membership is public. Any API error means "not a maintainer".
name: factory-validate

on:
  pull_request:

permissions:
  contents: read

concurrency:
  group: factory-validate-${{ github.event.pull_request.number }}
  cancel-in-progress: true

jobs:
  factory-validate:
    name: factory-validate
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - name: Set up Node
        uses: actions/setup-node@v7
        with:
          node-version: 22

      - name: Check out the base
        uses: actions/checkout@v7
        with:
          ref: ${{ github.event.pull_request.base.sha }}
          fetch-depth: 0
          persist-credentials: false

      - name: Fetch the candidate as data
        env:
          HEAD_SHA: ${{ github.event.pull_request.head.sha }}
        run: |
          set -euo pipefail
          git fetch --quiet --no-tags origin "$HEAD_SHA"
          test "$(git rev-parse --verify "$HEAD_SHA^{commit}")" = "$HEAD_SHA"

      - name: Clone Desk main
        run: |
          set -euo pipefail
          git clone --quiet --depth 1 --branch main https://github.com/ourostack/desk "$RUNNER_TEMP/desk"
          echo "Desk main: $(git -C "$RUNNER_TEMP/desk" rev-parse HEAD)"

      - name: Decide whether the author maintains this repository
        id: maintainer
        env:
          GH_TOKEN: ${{ github.token }}
          REPOSITORY: ${{ github.repository }}
          AUTHOR: ${{ github.event.pull_request.user.login }}
        run: |
          set -uo pipefail
          association=NONE
          if printf '%s' "$AUTHOR" | grep -Eq '^[A-Za-z0-9][A-Za-z0-9-]{0,38}$'; then
            if permission=$(gh api "repos/$REPOSITORY/collaborators/$AUTHOR/permission" --jq '.permission' 2> /dev/null); then
              case "$permission" in
                admin|write) association=COLLABORATOR ;;
              esac
            else
              printf 'factory-validate: maintainer_check_unavailable\n' | tee -a "$GITHUB_STEP_SUMMARY"
            fi
          fi
          echo "association=$association" >> "$GITHUB_OUTPUT"
          echo "Maintainer association: $association"

      - name: Validate the pull request
        env:
          BASE_SHA: ${{ github.event.pull_request.base.sha }}
          HEAD_SHA: ${{ github.event.pull_request.head.sha }}
          AUTHOR_ASSOCIATION: ${{ steps.maintainer.outputs.association }}
        run: |
          set -uo pipefail
          result="$RUNNER_TEMP/factory-validate.json"
          node "$RUNNER_TEMP/desk/plugins/desk/mcp/scripts/factory.js" validate-pr \
            --base "$BASE_SHA" --head "$HEAD_SHA" --author-association "$AUTHOR_ASSOCIATION" \
            > "$result" 2> /dev/null || true
          if ! jq -e '(.ok | type) == "boolean"' "$result" > /dev/null 2>&1; then
            printf 'factory-validate: validator_unavailable\n' | tee -a "$GITHUB_STEP_SUMMARY"
            exit 1
          fi
          if jq -e '.ok == true' "$result" > /dev/null; then
            if jq -e '.maintenance == true' "$result" > /dev/null; then
              printf 'factory-validate: passed (maintenance)\n' | tee -a "$GITHUB_STEP_SUMMARY"
            else
              printf 'factory-validate: passed\n' | tee -a "$GITHUB_STEP_SUMMARY"
            fi
            exit 0
          fi
          printf 'factory-validate: failed\n' | tee -a "$GITHUB_STEP_SUMMARY"
          jq -r '[.errors[].code | if type == "string" and test("^[a-z][a-z0-9_]{0,63}$") then . else "unknown_code" end] | unique[] | "factory-rejected: \(.)"' "$result" | tee -a "$GITHUB_STEP_SUMMARY"
          exit 1
```

### `.github/workflows/merge.yml`

```yaml
# Merges or rejects intake pull requests after factory-validate completes.
#
# This workflow always runs from main, so a pull request cannot change it.
# It never trusts the triggering run: a pull request's own workflow files run
# on its `pull_request` event and can post a green `factory-validate`, or name
# a workflow `factory-validate`, so the only field of the `workflow_run`
# event used here is `head_sha`, and that head is validated again with Desk
# main, fetched as Git objects only. Keep it that way: never read any other
# event field, and never trust the triggering conclusion alone.
#
# Three steps keep the write token away from candidate data: the first finds
# the open pull requests at that head and their authors' permission; the
# second, which holds no token, runs Desk's validator; the third acts on the
# results. It merges only when both validations pass and the pull request
# still has that head, and the merge call passes that head as `sha`, so
# GitHub refuses the merge if the head moved. It rejects only when the
# trusted validation fails and the head is unchanged, with a comment of
# `factory-rejected: <code>` lines and nothing else. Maintenance pull
# requests (changes outside the data paths facts/ and labels/, including
# .github/, by a maintainer) are labeled `maintenance` and left for a
# maintainer; the same changes from anyone else fail validation with `path`
# and are rejected. A maintainer is the pull request author when their
# permission on this repository is `admin` or `write`; any API error means
# "not a maintainer".
name: factory-merge

on:
  workflow_run:
    workflows: [factory-validate]
    types: [completed]

permissions:
  contents: write
  pull-requests: write

concurrency:
  group: factory-merge-${{ github.event.workflow_run.head_sha }}
  cancel-in-progress: false

jobs:
  factory-merge:
    name: factory-merge
    if: >-
      github.event.workflow_run.event == 'pull_request' &&
      (github.event.workflow_run.conclusion == 'success' || github.event.workflow_run.conclusion == 'failure')
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - name: Set up Node
        uses: actions/setup-node@v7
        with:
          node-version: 22

      - name: Check out main
        uses: actions/checkout@v7
        with:
          ref: ${{ github.event.repository.default_branch }}
          fetch-depth: 0
          persist-credentials: false

      - name: Clone Desk main
        run: |
          set -euo pipefail
          git clone --quiet --depth 1 --branch main https://github.com/ourostack/desk "$RUNNER_TEMP/desk"
          echo "Desk main: $(git -C "$RUNNER_TEMP/desk" rev-parse HEAD)"

      - name: Find the pull requests at the validated head
        env:
          GH_TOKEN: ${{ github.token }}
          REPOSITORY: ${{ github.repository }}
          DEFAULT_BRANCH: ${{ github.event.repository.default_branch }}
          HEAD_SHA: ${{ github.event.workflow_run.head_sha }}
        run: |
          set -euo pipefail
          summary() { printf '%s\n' "$1" | tee -a "$GITHUB_STEP_SUMMARY"; }
          : > "$RUNNER_TEMP/factory-prs.tsv"

          if ! printf '%s' "$HEAD_SHA" | grep -Eq '^[0-9a-f]{40}$'; then
            summary "factory-merge: invalid head"
            exit 1
          fi

          # Fork pull requests leave workflow_run.pull_requests empty, so find
          # the open pull requests whose head is the validated commit.
          numbers=$(gh api "repos/$REPOSITORY/pulls?state=open&base=$DEFAULT_BRANCH&per_page=100" --paginate \
            --jq ".[] | select(.head.sha == \"$HEAD_SHA\") | .number")
          if [ -z "$numbers" ]; then
            summary "factory-merge: no open pull request has head $HEAD_SHA"
            exit 0
          fi

          for number in $numbers; do
            pr=$(gh api "repos/$REPOSITORY/pulls/$number")
            if [ "$(jq -r '.state' <<<"$pr")" != "open" ] || [ "$(jq -r '.head.sha' <<<"$pr")" != "$HEAD_SHA" ]; then
              summary "factory-merge: #$number head moved; skipped"
              continue
            fi
            if jq -e '[.labels[].name] | index("maintenance")' <<<"$pr" > /dev/null; then
              summary "factory-merge: #$number is maintenance; left for a maintainer"
              continue
            fi
            author=$(jq -r '.user.login' <<<"$pr")
            association=NONE
            if printf '%s' "$author" | grep -Eq '^[A-Za-z0-9][A-Za-z0-9-]{0,38}$'; then
              if permission=$(gh api "repos/$REPOSITORY/collaborators/$author/permission" --jq '.permission' 2> /dev/null); then
                case "$permission" in
                  admin|write) association=COLLABORATOR ;;
                esac
              else
                summary "factory-merge: #$number maintainer_check_unavailable"
              fi
            fi
            printf '%s\t%s\n' "$number" "$association" >> "$RUNNER_TEMP/factory-prs.tsv"
          done

      - name: Validate with Desk main (no token)
        env:
          DEFAULT_BRANCH: ${{ github.event.repository.default_branch }}
          HEAD_SHA: ${{ github.event.workflow_run.head_sha }}
        run: |
          set -euo pipefail
          if [ ! -s "$RUNNER_TEMP/factory-prs.tsv" ]; then
            exit 0
          fi
          git fetch --quiet --no-tags origin "+refs/heads/$DEFAULT_BRANCH:refs/remotes/origin/$DEFAULT_BRANCH"
          git fetch --quiet --no-tags origin "$HEAD_SHA"
          test "$(git rev-parse --verify "$HEAD_SHA^{commit}")" = "$HEAD_SHA"
          base_sha=$(git rev-parse "refs/remotes/origin/$DEFAULT_BRANCH")
          while IFS=$'\t' read -r number association; do
            node "$RUNNER_TEMP/desk/plugins/desk/mcp/scripts/factory.js" validate-pr \
              --base "$base_sha" --head "$HEAD_SHA" --author-association "$association" \
              > "$RUNNER_TEMP/factory-validate-$number.json" 2> /dev/null || true
          done < "$RUNNER_TEMP/factory-prs.tsv"

      - name: Merge or reject
        env:
          GH_TOKEN: ${{ github.token }}
          REPOSITORY: ${{ github.repository }}
          HEAD_SHA: ${{ github.event.workflow_run.head_sha }}
          CONCLUSION: ${{ github.event.workflow_run.conclusion }}
        run: |
          set -euo pipefail
          summary() { printf '%s\n' "$1" | tee -a "$GITHUB_STEP_SUMMARY"; }
          unavailable=0
          while IFS=$'\t' read -r number association; do
            result="$RUNNER_TEMP/factory-validate-$number.json"
            if ! jq -e '(.ok | type) == "boolean"' "$result" > /dev/null 2>&1; then
              summary "factory-merge: #$number validator_unavailable; no action"
              unavailable=1
              continue
            fi

            if jq -e '.ok == true' "$result" > /dev/null; then
              if jq -e '.maintenance == true' "$result" > /dev/null; then
                gh api -X POST "repos/$REPOSITORY/issues/$number/labels" -f 'labels[]=maintenance' > /dev/null
                summary "factory-merge: #$number labeled maintenance; left for a maintainer"
                continue
              fi
              if [ "$CONCLUSION" != "success" ]; then
                summary "factory-merge: #$number passed revalidation but its validation run failed; no action"
                continue
              fi
              # The sha parameter makes GitHub refuse the merge if the head moved.
              gh api -X PUT "repos/$REPOSITORY/pulls/$number/merge" \
                -f merge_method=merge -f sha="$HEAD_SHA" > /dev/null
              summary "factory-merge: #$number merged at head $HEAD_SHA"
              continue
            fi

            codes=$(jq -r '[.errors[].code | if type == "string" and test("^[a-z][a-z0-9_]{0,63}$") then . else "unknown_code" end] | unique[] | "factory-rejected: \(.)"' "$result")
            if [ -z "$codes" ]; then
              codes="factory-rejected: unknown_code"
            fi
            current=$(gh api "repos/$REPOSITORY/pulls/$number" --jq '.head.sha')
            if [ "$current" != "$HEAD_SHA" ]; then
              summary "factory-merge: #$number head moved before rejection; skipped"
              continue
            fi
            gh api -X POST "repos/$REPOSITORY/issues/$number/comments" -f body="$codes" > /dev/null
            gh api -X PATCH "repos/$REPOSITORY/pulls/$number" -f state=closed > /dev/null
            summary "factory-merge: #$number rejected and closed"
            summary "$codes"
          done < "$RUNNER_TEMP/factory-prs.tsv"
          exit "$unavailable"
```

### `.github/workflows/build.yml`

```yaml
# Rebuilds the reports from the facts on main and publishes them on the
# `reports` branch as a single orphan commit.
#
# Runs on pushes to main (maintainer merges), after factory-merge completes
# (merges made with the workflow token do not start push workflows), daily,
# and on demand. The build is deterministic and the commit has fixed metadata,
# so the same facts always produce the same commit and an unchanged build
# pushes nothing. The commit has no parent and holds only the build output.
#
# A pull request can name one of its own workflows `factory-merge` and start
# this workflow through `workflow_run`. That is harmless because this
# workflow reads no event data: it always builds main. Keep it that way.
name: factory-build

on:
  push:
    branches: [main]
  workflow_run:
    workflows: [factory-merge]
    types: [completed]
  schedule:
    - cron: "23 4 * * *"
  workflow_dispatch:

permissions:
  contents: write
  issues: write

concurrency:
  group: factory-build
  cancel-in-progress: false

jobs:
  factory-build:
    name: factory-build
    if: github.event_name != 'workflow_run' || github.event.workflow_run.conclusion == 'success'
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - name: Set up Node
        uses: actions/setup-node@v7
        with:
          node-version: 22

      - name: Check out main
        uses: actions/checkout@v7
        with:
          ref: ${{ github.event.repository.default_branch }}
          persist-credentials: false

      - name: Clone Desk main
        run: |
          set -euo pipefail
          git clone --quiet --depth 1 --branch main https://github.com/ourostack/desk "$RUNNER_TEMP/desk"
          echo "Desk main: $(git -C "$RUNNER_TEMP/desk" rev-parse HEAD)"

      - name: Build the reports
        run: |
          set -euo pipefail
          echo "Store main: $(git rev-parse HEAD)"
          # Git keeps no empty folders, so a store with no facts has none.
          mkdir -p facts
          node "$RUNNER_TEMP/desk/plugins/desk/mcp/scripts/factory.js" build --store . --out _out

      - name: Publish the reports branch
        env:
          GH_TOKEN: ${{ github.token }}
          REPOSITORY: ${{ github.repository }}
        run: |
          set -euo pipefail
          cd _out
          git init --quiet --initial-branch=reports
          git add --all
          export GIT_AUTHOR_NAME="github-actions[bot]"
          export GIT_AUTHOR_EMAIL="41898282+github-actions[bot]@users.noreply.github.com"
          export GIT_COMMITTER_NAME="$GIT_AUTHOR_NAME"
          export GIT_COMMITTER_EMAIL="$GIT_AUTHOR_EMAIL"
          export GIT_AUTHOR_DATE="1970-01-01T00:00:00Z"
          export GIT_COMMITTER_DATE="1970-01-01T00:00:00Z"
          git -c commit.gpgsign=false commit --quiet --message "Build factory reports"
          built=$(git rev-parse HEAD)
          published=$(git ls-remote "https://github.com/$REPOSITORY" refs/heads/reports | cut -f1)
          echo "Reports commit: $built (tree $(git rev-parse 'HEAD^{tree}'))" | tee -a "$GITHUB_STEP_SUMMARY"
          if [ "$built" = "$published" ]; then
            echo "Reports unchanged; nothing to publish." | tee -a "$GITHUB_STEP_SUMMARY"
            exit 0
          fi
          auth=$(printf 'x-access-token:%s' "$GH_TOKEN" | base64 | tr -d '\n')
          echo "::add-mask::$auth"
          git -c "http.https://github.com/.extraheader=AUTHORIZATION: basic $auth" \
            push --quiet --force "https://github.com/$REPOSITORY" HEAD:refs/heads/reports
          echo "Published reports: $built" | tee -a "$GITHUB_STEP_SUMMARY"
```

Why the workflows are shaped this way:

- **The candidate's workflow runs; its files are data.** `factory-validate` runs on `pull_request`, so GitHub uses the pull request's copy of the workflow files, with a read-only token and no secrets. A pull request that rewrites `validate.yml`, or adds any workflow with a job named `factory-validate`, can post a green check, and one that names a workflow `factory-validate` or `factory-merge` can start `factory-merge` or `factory-build`. That is why `factory-merge` runs from `main`, reads only `head_sha` from the event, validates again with Desk `main` in a step that holds no token, and rejects anything that fails there, and why `factory-build` reads no event data at all. Changes under `.github/` are outside the data paths, so a non-maintainer's are always rejected.
- **The merge, not a diff.** `validate-pr` judges the tree that merging the head into `main` produces (`git merge-tree`, Git 2.38 or later), refuses heads whose merge conflicts or that carry merge commits of their own, and fails closed on an older Git. A `main...head` diff reads only one merge base and can miss what a crafted merge changes.
- **Maintainers by permission.** Both workflows read the author's repository permission and pass `COLLABORATOR` to `validate-pr` for `admin` or `write`, and `NONE` otherwise. A login that is not a plain GitHub user name, or any API error, gives `NONE`, so the check fails closed. No token is widened: the permission API works with the default read-only workflow token.
- **Fork pull requests.** `workflow_run.pull_requests` is empty for a pull request from a fork, so `factory-merge` finds pull requests by the validated head commit.
- **No stale merges.** The merge call passes the validated head as `sha`, so GitHub refuses it if the head moved after validation.
- **Builds after automatic merges.** A merge made with the workflow token starts no `push` workflow, so `factory-build` also runs when `factory-merge` completes. `factory-validate` → `factory-merge` → `factory-build` is three `workflow_run` levels, GitHub's limit.
- **Deterministic reports.** The build output is byte-stable and the reports commit has fixed metadata, so the same facts produce the same commit and an unchanged build pushes nothing. The `reports` branch is outside the ruleset, and each build replaces it.

### Merging by hand

Maintainers merge by hand only maintenance pull requests. Follow these rules:

- **Your own maintenance pull requests.** Merge after `factory-validate` passes; you know what the pull request contains.
- **Anyone else's pull request.** Let `factory-merge` merge it, or run `validate-pr` yourself at its exact head before merging. A green `factory-validate` on someone else's pull request is not evidence on its own, because the pull request's own workflow files may have produced it. This matters most when `factory-merge` took no action (`validator_unavailable`) or the pull request carries `maintenance`.

To validate a pull request yourself, from a clone of the store and a clone of `ourostack/desk` `main`:

```sh
git fetch origin main "pull/<n>/head"
node <desk clone>/plugins/desk/mcp/scripts/factory.js validate-pr \
  --base "$(git rev-parse origin/main)" --head <the pull request's head sha> --author-association NONE
```

Use `COLLABORATOR` instead of `NONE` only when the author has write access or more. Merge with `gh pr merge <n> --merge --match-head-commit <the same sha>`.

**Rejection comments.** `factory-merge` posts `factory-rejected: <code>` as `github-actions[bot]`. Anyone can post a comment that looks the same on a public pull request, so anything that reads these comments must accept them only from `github-actions[bot]`.

## 7. Point desks at the store

Desk picks the store for a desk in this order:

1. The desk's committed `_meta/factory.json`:

   ```json
   { "schema_version": 1, "store": "<owner>/<repository>" }
   ```

2. An overlay plugin installed beside Desk whose manifest (`plugin.json`, `.claude-plugin/plugin.json` or `.codex-plugin/plugin.json`) declares:

   ```json
   { "desk": { "factory": { "store": "<owner>/<repository>" } } }
   ```

3. Otherwise `ourostack/factory`.

A declaration that is present but malformed holds the desk's facts locally instead of falling through to a later source, so a desk meant for a private store never reports to a public one by mistake. Each machine then opts in once, with the account `factory.js account` names (it asks GitHub which signed-in account can open pull requests on the store, and never assumes gh's active account):

```sh
node <desk plugin root>/mcp/scripts/factory.js account --store <owner>/<repository>
node <desk plugin root>/mcp/scripts/factory.js consent --store <owner>/<repository> --contribute yes --account <login>
```

## 8. Prove the store

Run the three proof pull requests in order and keep each receipt. The facts files come from Desk's synthetic store fixture, `plugins/desk/mcp/__tests__/factory/fixtures/store/facts/`, in a clone of `ourostack/desk` `main`. Never use real facts for the proof.

```sh
FIXTURES=<desk clone>/plugins/desk/mcp/__tests__/factory/fixtures/store/facts
```

### Proof 1: a valid intake merges itself

```sh
git switch main && git pull
git switch -c intake/proof-valid
mkdir -p facts
cp "$FIXTURES/claude-code-11111111-1111-4111-8111-111111111111.json" facts/
git add facts && git commit -m "Factory intake" && git push -u origin intake/proof-valid
gh pr create --repo "$STORE" --base main --head intake/proof-valid --title "Factory intake" --body "1 file."
```

Expected, within a few minutes:

- `factory-validate` passes with the summary `factory-validate: passed`.
- `factory-merge` merges the pull request with a merge commit; its summary reads `#<n> merged at head <sha>`.
- `factory-build` starts when `factory-merge` completes and publishes `reports`: `index.md`, `README.md`, and `jobs/<job>.md` and `jobs/<job>.json` for the fixture's job (`aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`).
- The head branch stays: GitHub does not delete a branch merged with the workflow token. Delete it with `git push origin --delete intake/proof-valid`. Desk reuses one intake branch per machine, so real intake branches are meant to stay.

Receipts:

```sh
gh pr view <n> --repo "$STORE" --json state,mergedAt,mergeCommit,headRefOid,statusCheckRollup
gh run list --repo "$STORE" --limit 10 --json databaseId,name,event,headSha,conclusion
gh api "repos/$STORE/git/trees/reports?recursive=1" --jq '[.tree[].path]'
gh api "repos/$STORE/commits/reports" --jq '{sha, parents: (.parents | length)}'
```

The reports commit must have no parents.

### Proof 2: an invalid intake is rejected

Put a date inside a field that must never hold one. A model ID is a good target, because its pattern would otherwise accept it:

```sh
git switch main && git pull
git switch -c intake/proof-invalid
mkdir -p facts
sed 's/"model-gamma"/"model-2026-09-27"/g' "$FIXTURES/copilot-cli-22222222-2222-4222-8222-222222222222.json" \
  > facts/copilot-cli-22222222-2222-4222-8222-222222222222.json
git add facts && git commit -m "Factory intake" && git push -u origin intake/proof-invalid
gh pr create --repo "$STORE" --base main --head intake/proof-invalid --title "Factory intake" --body "1 file."
```

Expected: `factory-validate` fails with `factory-rejected: date` in its summary, and `factory-merge` comments `factory-rejected: date` (reason codes only, never the value) and closes the pull request unmerged. Keep `gh pr view <n> --repo "$STORE" --json state,mergedAt,comments` as the receipt. Delete the closed branch with `git push origin --delete intake/proof-invalid`, because only merged branches are deleted automatically.

### Proof 3: a maintainer removes the proof data

```sh
git switch main && git pull
git switch -c maintenance/remove-proof-facts
git rm -r facts && git commit -m "Remove the synthetic proof facts" && git push -u origin maintenance/remove-proof-facts
gh pr create --repo "$STORE" --base main --head maintenance/remove-proof-facts --label maintenance \
  --title "Remove the synthetic proof facts" --body "Removes the proof data."
gh pr checks --repo "$STORE" --watch maintenance/remove-proof-facts
gh pr merge --repo "$STORE" maintenance/remove-proof-facts --merge
```

A maintainer's removal of facts is maintenance: `factory-validate` passes with `passed (maintenance)` and `factory-merge` leaves it for you. Open it with the `maintenance` label: any other author's removal fails with `removal`, and without the label `factory-merge` would then reject and close the pull request. After the merge, `factory-build` runs on the push and republishes `reports` with an `index.md` and no job files:

```sh
gh api "repos/$STORE/git/trees/reports?recursive=1" --jq '[.tree[].path]'
```

## 9. Read-back checklist

A request that was accepted is not proof. Read each setting back from GitHub and keep the output:

- `gh api "repos/$STORE"`: visibility, default branch `main`, merge commits only.
- `gh api "repos/$STORE/rulesets/<id>"`: the four rules, the check from integration `15368`, the admin bypass in `pull_request` mode, `enforcement: active`.
- `gh api "repos/$STORE/actions/permissions"` and its `/selected-actions`, `/workflow` and `/fork-pr-contributor-approval` (and `/fork-pr-workflows-private-repos` for a private store).
- `gh api "repos/$STORE/labels?per_page=100"`.
- The three proof pull requests, their check runs, the workflow runs and the final `reports` tree.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `factory-validate: validator_unavailable` | Desk `main` has no `factory.js` with `validate-pr`, or the clone failed. | Wait for Desk to ship it or re-run the check. `factory-merge` takes no action on this result. |
| A maintainer's change fails with `factory-rejected: path` or `removal` | The author's permission on the store is below `write`, or the permission lookup failed (the summary then also says `maintainer_check_unavailable`). | Grant write access or more and re-run the check. A failed lookup always counts as "not a maintainer". |
| An intake passed but nothing merged | The pull request carries `maintenance`, its head moved after validation, or the pull request is from a first-time contributor waiting for approval. | Read the `factory-merge` run summary; approve the run under the pull request's Checks tab if GitHub asks. |
| `reports` did not update after an automatic merge | `factory-build` did not run after `factory-merge`. | Check the Actions tab for the `workflow_run` build; run `gh workflow run build.yml --repo "$STORE"` to rebuild. |
| An intake is blocked waiting for review | The ruleset's `require_extra_approval_for_unattributed_changes` is on. | Set it to `false` as in step 5. |
