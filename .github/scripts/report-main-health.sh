#!/usr/bin/env bash
# Keeps one open "main is red: <check>" issue, labelled red-main, while a check that runs on main after the merge fails there, and closes it
# when the check passes on main again. Pull requests run the same checks (AGENTS.md, "CI tiers"), so a failure here is a merge that interacts
# badly with another; this issue is how a red main reaches its owner, the PR clock, the next agent and the Desk release, which refuses to build while it is open. Run only on pushes to main, with GH_TOKEN allowed to write issues.
# Usage: report-main-health.sh "<check name>" <success|failure|cancelled|skipped> <run url> <commit sha>
set -euo pipefail
check="$1"
result="$2"
run_url="$3"
sha="$4"
repo="${GITHUB_REPOSITORY:?}"
title="main is red: $check"
label="red-main"

open="$(gh issue list --repo "$repo" --state open --label "$label" --search "\"$title\" in:title" --json number,title --jq "map(select(.title == \"$title\")) | .[0].number // empty")"

if [ "$result" = "success" ]; then
  if [ -n "$open" ]; then
    # Main's runs finish out of order, so a green result closes the issue only when its commit carries every failure the issue
    # records. A compare that fails leaves the issue open.
    for failed in $(gh issue view "$open" --repo "$repo" --json body,comments --jq '[.body, .comments[].body] | map(scan("red-main-sha: ([0-9a-f]{40})") | .[0]) | unique | .[]'); do
      status="$(gh api "repos/$repo/compare/$failed...$sha" --jq .status || echo unknown)"
      if [ "$status" != "ahead" ] && [ "$status" != "identical" ]; then
        echo "Green on ${sha:0:12}, which does not carry the failure on ${failed:0:12} (compare: $status); the issue stays open."
        exit 0
      fi
    done
    gh issue close "$open" --repo "$repo" --comment "Green again on \`${sha:0:12}\`: $run_url"
  fi
  exit 0
fi
# A cancelled or skipped gate is not a verdict on main; only a failure opens the issue.
[ "$result" = "failure" ] || exit 0

body="\`$check\` failed on main at \`${sha:0:12}\`: $run_url

Who fixes it (AGENTS.md, \"Red main\"): the author of the pull request that turned it red, within 30 minutes, by a fix or a revert. If that agent is gone, whoever reads this first reverts the commit. The Desk release ships nothing until main is green again.

<!-- red-main-sha: $sha -->"
if [ -n "$open" ]; then
  gh issue comment "$open" --repo "$repo" --body "$body"
else
  if ! gh label create "$label" --repo "$repo" --color B60205 --description "A check that runs on main after the merge is failing there" 2> /dev/null; then
    gh api "repos/$repo/labels/$label" --jq .name > /dev/null
  fi
  gh issue create --repo "$repo" --title "$title" --label "$label" --body "$body"
fi
