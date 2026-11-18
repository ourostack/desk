### Session hooks no longer wait on a timed-out migration check's cleanup

On Windows, a session-start hook that timed out a pending-migration check could wait up to 30 s for `taskkill` to end that check's process tree, past the hook's 10 s limit when a runner was loaded. A read-only check now stops waiting 1 s after its timeout and reports as not checked, while the cleanup carries on in the background.
