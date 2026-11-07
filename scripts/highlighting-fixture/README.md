# Highlighting fixture

Run `npm run build:release`, then:

```sh
node scripts/highlighting-fixture/prepare.mjs --source /absolute/path/to/read-only.md
```

`--source` and `--serve` are optional. The runner creates a new temporary directory, copies the source and referenced sibling images, and verifies the source hash without writing it. It generates language, 1,000-block and 10,000-line single-block documents. The printed JSON contains a real Extension Development Host launch argument list and an optional local browser URL. Open a copied Markdown file using **Open with Markdown Editor for Humans**. Only operate on the disposable copies.

The native fixture retains the release extension backend, packaged worker and CSS. Build overrides wrap the production client for measurement and append a QA panel to the generated editor bundle. The default fixture uses the production highlighting implementation with no production diagnostic global. The browser variant uses a simulated host bridge and cannot prove host sync, CSP or native theme behavior. Test those in the real Extension Development Host.

Two optional flags isolate performance causes without editing production files. `--disable-highlighting` removes only the highlighting plugin from the fixture, while preserving code nodes and editing controls. `--guard-language-class` skips the NodeView's existing repeated class assignment when its value has not changed. The flags can be combined; the panel heading and `fixture.json` identify the variant. Compare the same document, operation, and settled state across variants.

**20 code edits** makes twenty synchronous production transactions, after selecting the code block. Wait for worker results to settle before recording the panel. Service requests include cache hits and fallback calls; worker jobs count actual transport requests. Coalescing may reduce twenty edits to fewer than twenty worker jobs. Worker round-trip time includes transport and worker scheduling, not just tokenization. Synchronous dispatch reports document edits, color publications and other transactions separately, and excludes layout and paint. Native beforeinput-to-next-animation-frame measures event arrival through the next frame callback. It is not presentation latency and excludes OS-to-event delay; synthetic button edits do not produce beforeinput samples. Long-task count/duration use the browser Long Tasks API where available, filtered to work starting after the most recent reset. The reset does not recreate the worker or clear its cache.

For physical keyboard input, press **Reset metrics**, then **Focus code** and type after the editor receives focus. Focus code selects the beginning of the first TypeScript or SQL block without resetting measurements or changing content.

Color sampling scans computed styles only when **Sample colors** is pressed, so it is kept outside timing probes. Metrics refresh every 300 ms as separate accessible rows. Hide metrics collapses the readings while leaving the existing controls available; Show metrics restores them. Browser assertions can read each `[data-metric]` row and its `data-value` instead of parsing one large text blob. The panel is testing overhead and is excluded from the production bundle. Native physical typing, input-to-paint timing, memory and the ten-minute reading gate remain separate checks.

Document-only phase attribution wraps state application, DOM update, editor events, and plugin state/append hooks. These measurements include instrumentation overhead and help locate expensive work; nested timings are not additive. The panel shows the three slowest phase p95 values. Use uninstrumented release measurements for a final latency budget claim.

The generated `fixture.json` records source and packaged-worker hashes. The source path is local evidence only and is never shipped.
