Factory now accepts a repository owner with a single underscore in it, such as a managed GitHub login, in the account chooser, the store route and team lessons. The 39-character owner limit stays, and a leading, trailing or doubled underscore is still refused.

A Factory loop worker started by an older Desk release than the newest one installed now claims no work and records `stale_release` as its skip reason.

Ended Copilot sessions that Factory holds without deriving are no longer held silently. The sweep records why each is held, `desk_doctor` and `desk_status` name the route and count, and a `held_sessions` alarm is raised once a hold is over a day old. The route appears only in local status, never on an improvement card.
