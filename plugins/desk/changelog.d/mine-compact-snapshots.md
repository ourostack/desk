### Fixed

- `mine` replies fit in one read on large web apps. A chat app's snapshot was about 300 KB, which a host sets aside in a file an agent may never open. A reply now carries only the snapshot's text, not the same tree again. The text leaves out unnamed wrappers, handing a wrapper's ref to the one thing it holds so its text stays clickable, and caps very long texts. Past a fixed budget, controls and named lines stay, then text in page order, and the reply says how many lines it left out and how to see them.
- `find <text>` returns only the lines holding that text, with their refs and what contains them. `snapshot --interactive` returns only refs and named controls. `snapshot --save` still writes the whole tree to a file.
