### Fixed

- In `mine`, a `goto`, `reload`, `go-back` or `go-forward` whose page is still loading too fast to read now reports `navigated: true` with advice to `wait` for text, instead of refusing a navigation that already happened.
