Semantic recall refreshes its pre-evaluation event fence and lexical proof after waiting for convergence, so a queued change that finishes indexing before evaluation does not leave the request using stale readiness facts. Results are still discarded if readiness or generation identity changes during evaluation; the semantic backend is never replayed.

When no current lexical snapshot is proven, semantic reads report the missing proof instead of incorrectly describing it as an embedding-specification mismatch. Actual specification mismatches remain rejected.
