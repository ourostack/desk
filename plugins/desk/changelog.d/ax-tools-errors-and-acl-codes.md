The errors in Desk's tool code (`task_create`, `task_update`, `task_archive`, `task_move`, `task_signoff`, `track_*`, `note_*`, `lesson_add`, `friction_add` and `desk_save`) now open with what to do, then say what went wrong, and keep their meaning. Replies that are successes, statuses or commit messages keep their wording.

The Windows ACL provider now tells the parent why it refused a path with a stable `code` beside the message (for example `acl_inherited_rules`). The one retry for a half-applied access list follows that code (`acl_inherited_rules` or `acl_rule_count`) instead of matching the message, so rewording a message no longer changes the retry.

The Ouro AX baseline drops by 231 findings.
