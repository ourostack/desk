# Retry budget proposal (draft)

Alex, 2026-11-12, for the reliability card: allow at most three retries per request, with jittered backoff; report the retries as one metric; alerts keep counting only failures that reach the client. Uncertain: not load-tested yet.
