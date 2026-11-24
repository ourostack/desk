### A session can write cards in a Crew desk, and a progress log no longer needs `content_home`

The card tools' `desk` field now reaches a Crew desk registered on this machine and writes the card as the member this machine's GitHub sign-in is on that desk's roster, so a session homed elsewhere no longer has to open a session there to record progress. If no member resolves, the refusal says so and what to do.

A `task_update` that only records progress (`log`, `child_session`) now declares `content_home` as coordination and current for itself when the repository requires one and the call left it out. Other updates still have to declare it.
