# Factory roadmap

The factory captures, derives and publishes each finished job's facts, labels its waste with the headless evaluator, and runs the improvement loop (route, evaluate, mirror, reconcile, verify, measure). The capabilities below were removed. Rebuild one only when real work needs it, and record which work.

| Removed capability | Problem it would solve |
| --- | --- |
| Headless improvement-card triage (the loop's triage step, its runner, runner qualification, owned catalog and publication of `triage/<batch>.json` to the store) | Keeping a route recommendation (`agent_ready`, `investigate` or `human_decision`) on every open improvement card without a person asking. Today `curator` triages cards in a normal session. The runner never qualified on a real machine (status read `scope_unqualified`, `engine_unpinned`; 0 of 75 cards reviewed). The store's triage validator (`triage-schema.js`) and the shared launch ledger's triage windows are kept, so a rebuild can start from them. |
