### A pull request names the session that opened it

Every brief a Superpowers mapping produces now tells the child to put `Desk-Session: <its session id>` and, when the coordinator has one, `Desk-Parent-Session: <the coordinator's id>` in each pull-request body it opens, beside the Desk-Task line. A drain or coordinator can read the owner of an orphaned pull request straight off it.
