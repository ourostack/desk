### Catching a checkout up keeps Git LFS files whole

When a sync moved a checkout forward, Desk wrote every Git LFS file that changed as its small pointer, so a demo video or image in the checkout would not open and `git status` still read clean. The catch-up now lets Git LFS fetch the real content for the files it writes. A checkout already holding pointers is repaired with `git lfs pull`.
