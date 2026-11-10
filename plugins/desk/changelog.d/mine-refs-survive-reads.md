### Fixed

- In `mine`, refs from the last three reads of a tab stay usable. An agent that finds a field, reads again or waits for text, then acts on the field no longer has its ref refused; a `wait` counts as one read however often it looks. Every action still re-resolves its ref against the page as it is now, so an older ref acts only on its own unchanged node, and anything older than three reads is refused with advice to snapshot again.
