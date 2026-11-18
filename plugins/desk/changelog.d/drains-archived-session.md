A drain whose target session is archived or gone now recovers by itself. When the wake runner reports that error, Desk starts a successor session through Shepherd (its first kickoff line is `Succeeds: <old id>`), keeps the new id in the drain's state and sends later wakes there; a failed start is retried after ten minutes. See [issue drains](docs/issue-drains.md).

The drains poll also retries a GitHub CLI token read that times out or hits a busy keyring, up to three times, and only tells the person to sign in when `gh` says the account has no token.
