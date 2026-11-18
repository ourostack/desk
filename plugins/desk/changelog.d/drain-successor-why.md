### A drain's successor passes `--why` when Shepherd creates it

Drain recovery now sends `--why` with the `shepherd create` call that starts a drain's successor, so it is not refused once Shepherd requires a reason on every action others see.
