# Desk changelog fragments

A pull request that changes Desk adds one fragment here and leaves every version surface and `CHANGELOG.md` alone. Parallel pull requests then never conflict on the changelog head or on the next version.

- Name the file after the change, such as `coverage-shards.md`. The name only has to be unique among open pull requests.
- Write the changelog paragraph or paragraphs the change deserves: what changed for the reader and why, with links relative to `plugins/desk/`. Leave out the version heading and the `Ships desk-mcp@…` line; the release adds both.
- Changes only under `__tests__/` need no fragment.

After the merge, the [Desk release workflow](../../../.github/workflows/desk-release.yml) runs [`scripts/release-desk.cjs`](../../../scripts/release-desk.cjs) on `main`. It takes the next alpha on every release surface, folds every pending fragment into one `CHANGELOG.md` entry in name order, deletes the fragments and commits the release to `main`. `node scripts/check-release-integrity.cjs` enforces the rule on every pull request: a Desk change needs a new, non-empty fragment and an unchanged version.
