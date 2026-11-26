### The mine browser no longer reads an unopenable cookie file as a clean copy

When the copied cookie file can't be opened as a database on macOS, `browser_context open` with browser `mine` now says `COOKIES_NOT_INSPECTED` in `sessionWarning` instead of staying silent, and its note no longer promises that every signed-in GitHub account carried over whenever a `sessionWarning` is present ([#1853](https://github.com/ourostack/desk/issues/1853)).
