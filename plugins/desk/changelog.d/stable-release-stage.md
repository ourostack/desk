The Desk release workflow has a new `stable` stage, so Desk can leave alpha. Run it by hand from the Actions tab (or `gh workflow run desk-release.yml --ref main -f stage=stable`). From any `X.Y.Z-alpha.N` or `X.Y.Z-rc.N` it releases plain `X.Y.Z`, with or without pending changes.

After a stable release, the default `auto` stage releases the next patch as a plain version: the next merged change ships `X.Y.(Z+1)`. The `rc` stage after a stable release starts `X.Y.(Z+1)-rc.1`. The "Released in Desk …" note on merged pull requests also works for plain versions.
