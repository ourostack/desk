### Publication runs `gh` as the account that can reach the repository

When the active `gh` account cannot reach a repository, as with a work repository while a personal account is active, Desk's publication and unmerged-save steps used to fail with "GitHub CLI pr view failed". They now find a signed-in account that can push to (else read) the repository and run `gh` with that account's token, unless the caller already set a token.
