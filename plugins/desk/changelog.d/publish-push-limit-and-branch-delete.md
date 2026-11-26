Publishing a workspace no longer cuts a slow pre-push hook off before its own limit: the first push still gets 60 seconds, and the repeat gets 330 seconds, enough for a bounded hook such as CIT's publication guard (up to about 280 seconds). When a push is cut off twice, the error names the 330 second limit and says a hook still running at the limit is the likely cause.

Desk now deletes the `desk/publish/<commit>` branch once its pull request is merged, so publishing no longer leaves a branch behind on the remote for every save.
