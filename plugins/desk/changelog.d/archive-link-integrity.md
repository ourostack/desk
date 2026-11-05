Preserve inbound and outbound Markdown link intent when archiving a task in a
non-Git macOS/Linux desk. Observe original files and directory referents before
the move, guard replacement writes, and retain unfinished-operation markers so
partial archives cannot report false completion on a later invocation.

Git and Windows keep their existing archive route. All routes recognize an
unfinished marker as pending rather than adopting its current contents.
