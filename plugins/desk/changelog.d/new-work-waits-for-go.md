### New engineering work waits for an explicit go

The always-on rule in [`using-desk`](skills/using-desk/SKILL.md) that an agent never hands a person a chore, sign-in or deploy was read as permission to start new engineering work on a first request. It now says it covers chores and work already approved, and never lets an agent start new work before alignment and an explicit go. The `engineering-v2-kernel` eval's `v2-new-work-alignment` case, which failed on `main`, passes again, and the six suites that read `using-desk` have fresh receipts.
