### Fixed

- In `mine`, refs from the last three reads of a tab stay usable. An agent that finds a field, reads again to check something, then acts on the field no longer has its ref refused. Every action still re-resolves its ref against the page as it is now, so an older ref acts only on its own unchanged node, and anything older than three reads is refused with advice to snapshot again.
