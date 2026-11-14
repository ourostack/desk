# Sessions on this machine

Agents often need to know what another session on the same machine last said, or to message it. [`sessions.js`](../mcp/scripts/sessions.js) does both, and finds out which session you are. It covers this machine only; to reach a session on another machine, run the same command there. The logic is in [sessions-cli.js](../mcp/src/runtime/sessions-cli.js).

```sh
node <desk>/plugins/desk/mcp/scripts/sessions.js whoami [--hint <text from your own command>]
node <desk>/plugins/desk/mcp/scripts/sessions.js tail <session> [<count>]
node <desk>/plugins/desk/mcp/scripts/sessions.js send <session> "<message>" [--from <session id>|none] [--as-user] [--wait <seconds>]
```

`<session>` is a full id, an id prefix of at least six characters, or an exact name. Output is one JSON value; a failure is one Desk failure line on stderr with a code for `friction_add`.

- **`whoami`** finds the session whose live host process is this process or one of its parents. When one runtime hosts several sessions, `--hint` picks the one whose recent history contains the text, because an agent's own command line is in its history.
- **`tail`** prints the last messages (default 6) of a session, user and assistant only, each cut to 2,000 characters, with the session's name and when its history was last written.
- **`send`** wraps the message in a header that names the sender and how to reply, hands it to the GitHub Copilot app's local socket, and then waits for the message to show in the target's own history. `delivered: true` means it did. `accepted: true` with `delivered: false` means the app took it but it is not in the history yet: read the target with `tail` before sending again, so it is not sent twice. `--from none` leaves out the reply address; `--as-user` sends the words alone as the person's own message, for words they authorized in their voice. A send to a session the app has not loaded waits for the app to load it, up to two minutes, because closing the socket early cancels the send.

When you are already in an app session, the app's own `send_session_message` reaches another session on the same machine too; this command adds the delivery check and a reply address that also works from a session without that tool.
