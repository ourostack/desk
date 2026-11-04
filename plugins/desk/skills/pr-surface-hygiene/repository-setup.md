# Opt-in repository visual-proof check

For repository maintainers: adopt this only with explicit approval to change this repository's template and workflows. It does not change user-wide rules, repository permissions or required-check settings.

1. Read the existing template and workflow conventions. Merge the [visual-proof section](resources/pull-request-template.md) into the repository's existing PR template rather than replacing it.
2. Copy [check-visual-proof.cjs](check-visual-proof.cjs) to `.github/scripts/check-pr-visual-proof.cjs` and [the workflow example](resources/pr-visual-proof.yml) to `.github/workflows/pr-visual-proof.yml`, adapting action pins and runner policy to the repository. Review and merge those files through the normal contribution path. The check becomes available after its trusted base contains them.
3. Exercise an empty body, a real inline image and a specific nonvisual reason on a test PR within the approved scope. Confirm that editing the body reruns the check and removing proof fails it. A maintainer can then make `PR visual proof` required under the repository's normal settings process; installing the files alone does not make it required.

The workflow uses `pull_request_target` only to run the trusted base's checker against the event body. It checks out the exact base SHA with credentials disabled, has read-only contents permission, never checks out or executes the PR head, never interpolates body text into a shell command and does not upload or fetch images. Preserve these boundaries when adapting it. See [GitHub's event security warning](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#pull_request_target).

The check enforces presence, not truth. CI cannot infer that a change is nonvisual, verify an image's pixels, guarantee reviewer access or establish that a synthetic capture proves private behavior. Human review must confirm the reason against the full diff or inspect the actual capture under [PSH-010](SKILL.md#psh-010--visual-proof-blocks-creation-and-readiness). Local preparation supplies `--visual-change yes` for visible work so that a reason cannot bypass it. Keep malformed or unsupported markup blocked until it is replaced with a plain inline image.

To check an existing draft locally without network access or writes:

```sh
node .github/scripts/check-pr-visual-proof.cjs --body /path/to/pr-body.md --visual-change yes
```

Exit `0` means accepted presence only; `1` means missing or conflicting proof; `2` means invalid input or a read/parse failure. For wholly nonvisual work, use `--visual-change no` and an accurate standalone `No visual change: ...` line. The CI event path leaves classification unknown and therefore still requires review.
