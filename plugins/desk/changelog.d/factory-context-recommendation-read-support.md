Factory validators can now read evidence-linked improvement proposals in
context/2 while keeping context/1 unchanged. Proposals name their observed
events, a concrete change, a hypothesis and a way to check it. They retain the
same independent privacy review, exact-payload hash and source-freshness gates;
they never authorize work or claim a proven benefit. Ordinary producers still
emit context/1 so store readers can be upgraded before the new format is used.
