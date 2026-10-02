### Protected-checkout guard: fewer false denials

The protected-checkout guard keeps denying any PowerShell statement that names `git` outside the plain forms, and now allows two narrow statement shapes that provably run nothing: `Get-Command`/`gcm` with only literal names and common parameters, and `Write-Output`/`Write-Host`/`echo` with only literal arguments. They may be piped only to Select-Object, Format-*, Where-Object, Out-String or Out-Null (Get-Command) or to Out-String or Out-Null (Write-*), and only at the top level of the command. A string piped to `iex`, `cmd`, `bash` or any other element, a group, a member access, a redirect or a variable keeps the old denial.

With a checkout Desk cannot resolve (for example `git -C $r …` inside a `foreach`), plain read-only Git already passes, and a fetch into remote-tracking refs, tags or notes (`+refs/heads/*:refs/remotes/origin/*`) now passes too. A fetch into a local branch, `--update-head-ok`, and every mutating subcommand still fail closed. Bash and PowerShell share this rule.

Denial messages now lead with the fix, because hosts cut a denial at about one line: "Desk blocked this: run each git command as its own plain statement, e.g. git -C <path> status; git -C <path> fetch." and "Desk could not resolve which checkout this Git command runs in; write it literally or set it in a separate command first."
