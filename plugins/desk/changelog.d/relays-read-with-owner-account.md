### Relays spend less of a shared GitHub quota

A relay can name a `readAccount`: it reads the repository with that account (for example `arimendelow` for a public ourostack repo) and uses `account` only for the write, so a Microsoft account is no longer billed for reading a personal repository. Every relay with nothing pending now backs off to at least two minutes, and goes back to its own interval as soon as a labelled pull request or a new run appears. `drains status` shows each relay's counted and free (304) calls for the last full hour.
