### Merge-when-green no longer puts AI co-author trailers on the default branch

GitHub copies the `Co-authored-by` trailers of a branch's commits into the squash commit it lands, and a cloud session's commit signer forces the AI trailer onto those commits. The repository's squash-message setting does not stop that. The `merge-when-green` relay now sends an explicit message with every squash or merge: the pull request title plus ` (#n)` and its body with AI and bot `Co-authored-by` lines removed. See [relays](docs/relays.md).
