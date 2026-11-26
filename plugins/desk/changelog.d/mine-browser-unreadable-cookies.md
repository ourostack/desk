### The mine browser says when its copied sign-ins may be missing

When `browser_context open` with browser `mine` copies a profile whose encrypted cookies could not be made readable on macOS (the browser's Safe Storage key was refused or timed out, or a cookie would not decrypt), the reply now carries `sessionWarning` (`SESSION_MAY_BE_MISSING`) with the count and the keychain failure reason, instead of passing off a signed-out copy as a normal open. The copy itself, the source profile and the access Desk asks for are unchanged ([#1853](https://github.com/ourostack/desk/issues/1853)).
