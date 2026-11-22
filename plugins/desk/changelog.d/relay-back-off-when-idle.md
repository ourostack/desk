### A relay can stay on its own interval while idle

A relay can set `backOffWhenIdle: false` to keep polling on its `everySeconds` when nothing is pending, instead of backing off to at least two minutes. Its idle polls are conditional reads that GitHub answers with a free 304, so it spends no quota, and the event it watches is heard within one poll: the relay that tells Tandem's Ouro update bot of a new ouro-ui release took 67 to 89 seconds after the release on the three latest releases, almost all of it the two-minute idle floor. Relays without the field back off as before.
