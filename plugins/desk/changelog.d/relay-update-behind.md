### Added
- A merge-when-green relay can set `updateBehind`: a labelled pull request whose checks failed while it is behind its base is updated from the base once, in case the base has fixed the failure, without needing a `strict` block.
