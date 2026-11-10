### Fixed

- The `mine` browser now works through ordinary tool calls on busy web apps, first try. `wait` pauses for 1 to 60 seconds, or reads snapshots until text shows (or goes, with `--gone`) and returns the last one, so an agent can let a page load without a script. `press <key>` without a ref presses the key on whatever has focus.
- A snapshot reads only what the page shows. Text with no layout or hidden by CSS, and elements holding nothing shown, are left out, so a hidden error template no longer reads as an error. Hidden controls and private regions still read as redacted. A small page that does read as an error gets advice to reload and wait.
- Every refusal now ends with what to do instead: an unknown command lists the commands `mine` supports and says `eval` is never needed, a stale ref says to snapshot again, and a closed context says to open a new one.
