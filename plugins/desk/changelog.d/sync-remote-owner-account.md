### Desk sync uses the GitHub account that owns the desk's remote

The Copilot app starts Desk with Git settings that make every GitHub request use the session's own account. A session working in a repository owned by one account therefore got "Repository not found" from a desk whose remote another account owns, and boot reported "sync failed: remote refused this host's credentials" while the desk's commits stayed on the machine.

When those settings are present, Desk's fetch, pull and push now use the signed-in `gh` account that can reach the remote: the account named in the remote's URL, else the repository's owner, else any other account `gh` holds. Organizations own many desks, so Desk asks `gh` whether each account can read the repository (or push to it, for a push). The token is read from `gh` when Git asks, never written into config, and no global Git or `gh` account changes. If no signed-in account can reach the remote, Git behaves as before.

A refused pull now explains itself in one line in the Ouro AX error shape: the probable cause, the command that shows Git's own answer, the one command that files the failure with its evidence, and that local work continues while Desk retries.
