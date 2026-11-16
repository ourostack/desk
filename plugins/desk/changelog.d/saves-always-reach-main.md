### A Desk save always reaches main, or says loudly that it has not

A save that goes out as a `desk/publish/<commit>` pull request no longer depends on one repository setting to merge. Every publication PR now carries the `merge-when-green` label (or the policy's `merge_label`) that a merge-when-green relay polls, and Desk still asks for auto-merge where the repository allows it; a repository that refuses auto-merge no longer strands the save.

A publication PR that conflicts with the default branch is rebuilt on the newest default branch (Desk's card and log conflict rules apply) and published again, and the old PR is closed in its favour. A PR whose changes are already on the default branch is closed as superseded, with the evidence in its closing comment. A save that cannot land keeps its PR.

A save still unmerged after ten minutes is named, with its PR link, in the next reply of every Desk tool in any session of that desk, under `## Unmerged saves` in desk boot, and in `drains status`. Desk records each waiting PR in the desk's sync status and settles it on the next write or session start.
