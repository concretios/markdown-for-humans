# Performance Guidelines

> Performance budgets, implemented hot-path protections and the evidence required before making a performance claim.

## Product Budgets

| Metric                             |                        Target |
| ---------------------------------- | ----------------------------: |
| Editor initialization              |                  under 500 ms |
| Keystroke handling                 |                   under 16 ms |
| Cursor and formatting interactions |                   under 50 ms |
| Menu and toolbar actions           |                  under 300 ms |
| Large-document handling            | 10,000 or more lines smoothly |
| Ordinary sync debounce             |                        500 ms |

Elapsed budgets must be measured on relevant hardware. CI primarily gates deterministic work counts because shared runners do not represent the reference Windows i5/16 GB machine.

## Typing and Serialization

The immediate TipTap update path must remain independent of document size.

- `DocumentSyncController.markDirty()` records a dirty bit and schedules at most one timer.
- Markdown is serialized only when the 500 ms timer drains or an explicit save/flush boundary runs.
- Pending image work defers the boundary without retaining an older Markdown snapshot.
- Only one emitted edit remains unacknowledged before later dirty work derives from the accepted host version.
- Immutable ProseMirror top-level nodes are weakly cached after the first serialization. A one-block edit should reserialize only the changed branch.
- Transient serializer failures are not cached as successful content.

Do not compute Markdown, an outline, annotation geometry or other document-wide state directly in a keystroke callback.

## Code Block Highlighting

Use the single plugin in `src/webview/highlighting/plugin.ts`. Ordinary document
changes inspect changed ranges and map existing decorations; attribute-only steps
also invalidate the affected block. Selection and unrelated metadata transactions
do not schedule lexical work. Unknown step types may conservatively rebuild the
occurrence index, so measure that fallback separately from ordinary typing.

The plugin defers source extraction and submits one active lexical job to the
view-owned service in `client.ts`. The service lazily loads the packaged Blob
worker, shares cached relative spans for identical grammar/source pairs, and does
not accumulate another pending-source queue. Plain and unsupported fences never
load the grammar bundle or run automatic language detection.

`HIGHLIGHT_LIMITS` in `types.ts` is the source of truth for provisional resource
limits. It caps source size, result ranges, serialized result bytes, cache entries,
cache bytes and cached ranges. Worker attempts time out and allow at most one
automatic retry per grammar/source per view session. Over-limit and failed work
keeps editable plain code. Dispose the worker, Blob URL, timers, cache and pending
publication work with the view; do not retain them in `vscode.setState()`.

Worker timing is only part of highlighting cost. Validate result checking,
decoration construction/mapping, DOM updates and paint separately on the main
thread. Token-cache bounds do not bound total decoration or DOM memory. A supported
10,000-line single block must receive complete tokens and remain responsive; do
not silently truncate its result to meet a frame target. Long-result publication,
saturated queues, replacement/undo, stale-result rejection and disposal require
their own tests and real-host measurements.

Focused regression suites are `codeHighlightingPlugin.test.ts`,
`highlighting/client.test.ts`, `highlighting/tokenize.test.ts`,
`codeFenceMenu.test.ts` and `codeHighlightAppearance.test.ts` under
`src/__tests__/webview/`. Keep measured dispatch time, lexical worker time and
input-to-paint time distinct. The product budgets above remain release targets,
not guarantees established by worker adoption or passing unit tests.

## Extension-Host Edit Cost

- Every mutation uses the per-document `DocumentEditCoordinator`.
- Compatible adjacent pending typing may coalesce; started edits, operations and barriers may not.
- Save and Feedback operations drain the coordinator through an ordered barrier.
- Documents of at least 32 KiB use one minimal prefix/suffix `WorkspaceEdit` rather than a whole-buffer replacement.
- Minimal ranges preserve UTF-16 surrogate-pair and CRLF boundaries.

This is intentionally a single-replacement strategy. Add a general diff algorithm only with measurements that show the added CPU and complexity improve real documents.

## Feedback Layout and Capture

- Build the source-line index once. Layout should perform bounded lookups and geometry reads only for annotated targets.
- Ordinary document scrolling must not trigger annotation geometry reads or a second panel-scroll synchronization loop.
- Batch resize, zoom, font and asynchronous-content layout into one scheduled pass.
- Limit capture to mapped visible blocks and propagate `AbortSignal` through every asynchronous wait.
- Cap capture staging at 4,096 DOM nodes and 1,024 resource references.
- Cap raster output at 12 megapixels and 10 MiB.

## Hidden Webviews and Memory

The provider uses `retainContextWhenHidden: false`. Hidden editor tabs can release TipTap, Mermaid output, capture surfaces, listeners and transient Feedback UI.

Only a small versioned selection and scroll payload is stored with `vscode.setState()`. Never persist document content or feature-controller state there.

Also:

- dispose subscriptions, transports, timers, abort controllers and event listeners at their real owner boundary
- use weak caches when keys are immutable ProseMirror nodes or webview objects
- keep bounded histories and waiter maps
- avoid redundant long-lived copies of the complete document
- use browser DevTools and Extension Host profiling to verify retained objects after panel disposal

## Deterministic CI Gate

`scripts/feedback-performance-fixture/` executes production sync and annotation-layout code against stable generated data:

| Fixture             |             Minimum |
| ------------------- | ------------------: |
| Reading document    |         3,000 words |
| Stress document     | 10,000 source lines |
| Feedback items      |                 500 |
| Typing transactions |              10,000 |

The gate requires:

- zero serialization during the typing hot path
- at most one pending debounce timer
- exactly one serialization and one send when the burst drains
- no timer or serialization work after disposal
- at most one source-line index pass
- bounded target/card lookups and at most two geometry reads per item plus fixed slack
- zero source-line rescans during layout
- one placement for every item

Run it with:

```sh
node --test scripts/feedback-performance-fixture/verification.test.mjs
node scripts/feedback-performance-fixture/run.mjs
```

CI runs these contracts on both Ubuntu and Windows. Real VS Code Extension Development Host smoke tests also run on those operating systems against VS Code 1.98.0 and stable.

The Jest scanner regressions in `src/__tests__/editor/imageSourceReferencesPerformance.test.ts`
count loop iterations and sliced-character volume in a test-only instrumented copy
of the production scanner. Each 280 KB and 560 KB malformed fixture must stay
within 20 work units per source character and retain the valid trailing image.
A separate spy forbids unnecessary markdown-it inline parsing. These gates catch
the reported repeated-suffix regressions without timing coverage-instrumented
code on a shared runner. They do not prove every parser input is linear or certify
physical-machine latency. Large-input output assertions also run against the
ordinary production import under coverage.

## Bundle Budget

Release artifacts are produced by `npm run build:release`. Measure
`dist/extension.js`, `dist/webview.js`, `dist/highlighting-worker.js` and
`dist/webview.css` from the release output whenever dependencies or bundling change.
`scripts/verify-build.js` checks artifact presence, package boundaries, source-map
policy and broad size ceilings, and reports combined editor-plus-worker JavaScript.

Keep total webview JavaScript, including the worker, near or below 5 MB. Moving
grammars to a worker changes startup and execution ownership, not their packaged
bytes. Before adding a heavy dependency:

1. inspect whether the existing stack already provides the capability
2. compare release bundle output, not installed package size
3. prefer scoped imports and tree-shakable APIs
4. consider lazy loading only when startup or memory measurements justify the complexity

## Required Manual Evidence

Automated gates do not close the original constrained-Windows risk. Before calling the performance work complete, collect:

- p50 and p95 initialization, typing, formatting and Feedback capture timings on the target Windows i5/16 GB machine
- Extension Host and webview memory snapshots after opening, hiding, reopening and closing large documents
- a 10-minute read/edit pass on a 3,000-word document in light and dark themes
- a 10,000-line mixed-content pass with tables, images, Mermaid, math, raw HTML and code
- high-DPI, zoom and capture checks

Report deterministic CI results and physical-machine measurements separately. A green work-count gate is strong regression protection, but it is not a physical latency claim.
