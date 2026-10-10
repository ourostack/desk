### Bounded triage intake contract (validator only)

Adds the closed `desk.factory.triage/1` public batch and `desk.factory.triage-result/1` protected candidate validators. Triage intake requires a trusted API permission check for the current PR actor and accepts only new regular files at `triage/<16 lowercase hex digits>.json`. An accepted batch cannot be replaced, removed, renamed, copied, or changed in type/mode; corrections and withdrawals must be new batches.

Candidate prose is not Git-safe data. The candidate validator returns it only to a protected parent and writes nothing. Facts, labels, capture records, and canonical improvement/kaizen fields retain their existing contracts. This change includes synthetic fixtures and intake tests, not an emitter, a model launcher, a triage command, or execution authority.

Public producer versions also pass the existing credential refusal, and a batch cannot repeat an annotation ID even with identical content. Supplementary Git copy detection is exact-only, so a similar new higher-revision correction batch can be added without changing its historical batch. The paired synthetic fixture includes credential-shaped version refusals for store validator parity.
