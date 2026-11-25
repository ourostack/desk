### Issue drains: a GitHub 5xx is no longer worded as an auth problem

When GitHub answers a drain's read with a 5xx (500, 502, 503, 504), the poll now asks once more in the same poll. If the retry fails too, the drain's last error says GitHub's server failed and needs nothing from you (`drains_github_server_error`) instead of sending an agent to `Check gh auth status`, which stays for a refused credential. Writes are never retried, and a persistent failure still wakes nobody and leaves what the drain has seen untouched. See [issue drains](docs/issue-drains.md).
