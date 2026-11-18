### Desk binds the desk that owns the session's repository

An operator with a personal desk and a work desk no longer has an ouro-ui session land in the work desk. When nothing names a desk, Desk now binds the one whose kind matches the owner of the repository the session was opened in (personal for the operator's own repositories, work for Microsoft ones) before any home-folder fallback, and `desk_status` reports the source as `repo_owner_desk`.

`desk_save` refuses a path that belongs to another desk on the machine, instead of answering `nothing_to_commit`, and names that desk. `desk_search` and `desk_recall` return `desk_searched` with the root and name of the desk they searched.
