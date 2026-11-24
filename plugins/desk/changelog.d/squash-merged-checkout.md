### A squash-merged checkout takes content-home writes again

A checkout whose commits were published by a squash or rebase merge used to refuse every content-home write with `content_home_unpublished_base`. When the base already holds those files' bytes, Desk now moves the checkout onto the base and keeps local edits.
