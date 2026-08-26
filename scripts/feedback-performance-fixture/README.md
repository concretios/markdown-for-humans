# Feedback deterministic performance fixture

This fixture gates algorithmic work, not elapsed milliseconds. Shared CI runners
cannot represent the reference Windows i5/16 GB machine reliably.

The harness executes the production deferred-sync controller and pure annotation
layout against generated 3,000-word and 10,000-line Markdown corpora. It fails
when typing serializes before the virtual debounce drains, timers survive drain or
disposal, annotation indexing exceeds one source pass, geometry work exceeds two
reads per Feedback item plus fixed slack, or layout misses an item.

Run the contract tests and gate directly:

```sh
node --test scripts/feedback-performance-fixture/verification.test.mjs
node scripts/feedback-performance-fixture/run.mjs
```

Reference-machine p95 timings, memory snapshots, real VS Code host runs, and the
physical DPI pass remain separate profiling and integration requirements.
