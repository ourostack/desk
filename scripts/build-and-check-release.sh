#!/usr/bin/env bash
# Builds the Desk release on the checked-out tree and runs every check on the exact commit that would be pushed.
# The Desk release workflow (.github/workflows/desk-release.yml) and the release dry run in pull request CI
# (.github/workflows/desk-mcp-tests.yml) both call this script, so the two lists of steps cannot drift apart.
#
#   scripts/build-and-check-release.sh [--dry-run]
#
# Run from the repository root with the Desk MCP dependencies installed (npm ci in plugins/desk/mcp) and a clean tree.
# Folds the pending changelog fragments with scripts/release-desk.cjs, commits the result, then checks that commit.
#   - A release run leaves the release commit on the checked-out branch.
#   - A --dry-run puts the same commit on a detached HEAD, runs the same checks, then restores the checked-out commit
#     and tree, so nothing it built survives. A failed check fails the dry run, which fails the pull request.
# Environment: RELEASE_RUN_URL (named in the commit message; default "a release dry run"),
#   RELEASE_OUTPUT (a file that receives released=, summary=, sha= and base= lines; default none),
#   RELEASE_JSON (where release-desk.cjs writes its result; default a temporary file).
set -euo pipefail

dry_run=false
case "${1:-}" in
  "") ;;
  --dry-run) dry_run=true ;;
  *) echo "usage: $0 [--dry-run]" >&2; exit 2 ;;
esac

test -z "$(git status --porcelain)" || { echo "::error::The working tree must be clean before the release is built."; exit 1; }
base="$(git rev-parse HEAD)"
original_ref="$(git symbolic-ref -q HEAD || true)"
scratch="$(mktemp -d)"
release_json="${RELEASE_JSON:-$scratch/release.json}"
output() { [ -z "${RELEASE_OUTPUT:-}" ] || printf '%s\n' "$@" >> "$RELEASE_OUTPUT"; }

restore() {
  rm -rf "$scratch"
  if [ "$dry_run" = true ]; then
    git reset --hard --quiet "$base"
    if [ -n "$original_ref" ]; then git checkout --quiet "${original_ref#refs/heads/}"; fi
  fi
}
trap restore EXIT
[ "$dry_run" != true ] || git checkout --quiet --detach

node scripts/release-desk.cjs --date "$(date -u +%F)" > "$release_json"
if [ "$(node -p 'require(process.argv[1]).released' "$release_json")" != "true" ]; then
  echo "No changelog fragment is pending; nothing to release."
  output "released=false"
  exit 0
fi
summary="$(node -p 'const r = require(process.argv[1]); `Desk ${r.to} from ${r.fragments.length} changelog fragment(s): ${r.fragments.map((f) => f.split("/").pop()).join(", ")}`' "$release_json")"
version="$(node -p 'require(process.argv[1]).to' "$release_json")"
git add --all -- .claude-plugin plugins/desk tests/desk
git -c user.name="github-actions[bot]" -c user.email="41898282+github-actions[bot]@users.noreply.github.com" \
  commit --quiet --message "Release Desk $version" --message "$summary. Released by ${RELEASE_RUN_URL:-a release dry run}."
sha="$(git rev-parse HEAD)"

# The checks run on the commit that will be pushed: some list tracked files, which must not include the fragments the
# release deleted. The release commit has no pull request base, so the integrity check sees only the manifests.
test -z "$(git status --porcelain)"
env -u GITHUB_BASE_REF -u DESK_RELEASE_BASE node scripts/check-release-integrity.cjs
for check in validate-skills test-desk-docs test-desk-host-manifests test-desk-generated-artifacts test-desk-contracts; do
  node "scripts/$check.cjs"
done

# A pattern that matches no file, or a run that counts no test, passes silently under node --test, which hid a release
# whose Node tests matched none. Both fail here.
patterns=(release activation artifacts docs scripts)
globs=()
for name in "${patterns[@]}"; do globs+=("../../../tests/desk/mcp/__tests__/$name/**/*.test.js"); done
(
  cd plugins/desk/mcp
  for glob in "${globs[@]}"; do
    matched="$(node --no-warnings -e 'console.log(require("node:fs").globSync(process.argv[1]).length)' "$glob")"
    [ "$matched" -gt 0 ] || { echo "::error::The test pattern $glob matches no test file."; exit 1; }
  done
  tap="$scratch/tests.tap"
  node --import ../../../tests/desk/mcp/__tests__/_isolated_env.mjs --test \
    --test-reporter=spec --test-reporter-destination=stdout --test-reporter=tap --test-reporter-destination="$tap" "${globs[@]}"
  ran="$(sed -n 's/^# tests \([0-9][0-9]*\)$/\1/p' "$tap")"
  [ "${ran:-0}" -gt 0 ] || { echo "::error::The release test step ran ${ran:-0} tests; a step that runs no test is a failure."; exit 1; }
  echo "The release test step ran $ran tests."
)

output "released=true" "summary=$summary" "sha=$sha" "base=$base"
echo "The release of $version builds and passes every check."
