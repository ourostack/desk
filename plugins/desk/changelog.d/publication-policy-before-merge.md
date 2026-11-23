Workspace publication waits for the published policy's required checks before requesting any merge, including in repositories without branch protection. It no longer calls `gh pr merge --auto`, which can merge immediately, and attaches the merge relay's label only after the checks pass.

Pending checks are requalified by the background worker even after its network retry budget ends. Concurrent merges by the qualified relay are verified against the exact PR and actual upstream instead of reported as failed publication.
