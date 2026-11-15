Desk now exposes 19 tools instead of 21: moving a task and renaming a track were never used in two weeks of real sessions, so they became options on the update tools. Old skill text that names a removed tool needs the new call:

- `task_move` is now `task_update` with `to_track`, `to_slug`, `unarchive` or `into_task`, plus `handle` and `allow_dirty` as before. A move is sent alone: with `status`, `note` or any other update field the call refuses and changes nothing, so update the card in a second call.
- `track_rename` is now `track_update` with `rename_to` (its old `to`), naming the track by `slug` (its old `track`) or `handle`. A rename is sent alone too.
- The errors, error codes and commit messages of both now name `task_update` and `track_update`.
