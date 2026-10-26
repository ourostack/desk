# Small removals roadmap

Small pieces removed in the 2026-10-25 polish. Rebuild one only when a real session needs it, and record which session.

| Removed capability | Problem it would solve |
| --- | --- |
| Manual index build script (`mcp/scripts/rebuild-index.js`) | Rebuilding a desk's search index by hand from a terminal. Search now rebuilds inside each session. |
| Status migration (`03-normalize-task-status`) and its helper | Mapping old task statuses (active, doing, in progress, planning, backlog, needs review, waiting) to the eight lifecycle states. `task_create` and `task_update` reject any other status now, and every desk checked held only normal values. |
| The `desk:superpowers-integration` skill | Sending old standing instructions that name it, or the retired Work Suite skills (work-ideator, work-planner, work-doer, work-merger, autopilot, stay-in-turn, inch-worm, watchdog-mode, visual-qa-dogfood, deep-research), to their successors. Every shipped skill and doc now names `desk:using-superpowers-with-desk` directly. |
