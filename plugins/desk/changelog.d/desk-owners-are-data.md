### Each desk declares the repository owners it serves

Desk no longer names any organization. A desk lists the owners it serves in `_meta/desk.json` (`{"repo_owners": ["acme"]}`), besides the owner of its own Git remote, and a session in a repository by one of them binds that desk. An owner served by two desks, or by none, binds nothing.
