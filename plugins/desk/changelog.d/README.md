# Desk changelog fragments

A pull request that changes Desk adds one fragment here and leaves every version surface and `CHANGELOG.md` alone. Parallel pull requests then never conflict on the changelog head or on the next version.

- Put the fragment directly in this folder, as one Markdown file named after the change, such as `coverage-shards.md`. The name must differ from every other open pull request's fragment and from any fragment still waiting here on `main`.
- Write the changelog paragraph or paragraphs the change deserves: what changed for the reader and why, with links relative to `plugins/desk/`. Leave out the version heading and the `Ships desk-mcp@…` line; the release adds both. Do not use `#` or `##` headings, because the release writes the version heading; `###` and plain paragraphs are fine.
- Leave other fragments alone. A fragment already here belongs to a merged change, and only the release removes it.
- Changes only under `__tests__/` need no fragment.

After the merge, the [Desk release workflow](../../../.github/workflows/desk-release.yml) runs [`scripts/release-desk.cjs`](../../../scripts/release-desk.cjs) on `main`. It takes the next alpha on every release surface, folds every pending fragment into one `CHANGELOG.md` entry in name order, deletes the fragments and commits the release to `main`. If a release fails, the workflow opens or comments on a "Desk release needs attention" issue, and a daily run releases whatever is still pending. `node scripts/check-release-integrity.cjs` enforces the rule on every pull request with the same fragment check the release uses: a Desk change needs a new fragment the release accepts and an unchanged version, and may not add anything else here or touch a pending fragment.
