### A sync conflict no longer reads as a block on Desk's own writes

When the session-start pull hits a conflict, Desk's sync failure now says that its own writes still publish from a clean copy of the remote, so the agent keeps working and does not stash, rebase or reset the shared checkout. The failure before said that Desk delivers its local commits "once it can", which read as a block on every write. Nothing else about the sync or the delivery changed.
