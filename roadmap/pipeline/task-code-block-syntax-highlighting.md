# Task: Correct, responsive code-block syntax highlighting

## 1. Task Metadata

- **Task name:** Correct, responsive code-block syntax highlighting
- **Slug:** code-block-syntax-highlighting
- **Status:** implementation complete for phases 1–4; release verification in progress
- **Created / last updated:** 2026-09-30 / 2026-10-01
- **Shipped:** pending
- **Implementation baseline:** Started from freshly fetched main at `1b8244b220f8ba9f2e476a542c754e7ce4fca41a` on branch `feature/syntax-highlighting`. Merged latest main `6412d17` before final PR validation at `c961e438`. Full acceptance remains open.
- **Planning provenance:** The earlier analysis used the same baseline. Raw benchmark outputs, QA reports and screenshots are local-only supporting evidence; the reviewable results and limits are summarized here.
- **Initial estimate:** 5–8 engineering days including worker integration and verification, plus 2–3 days if viewport projection was required. That rendering branch is now implemented; remaining release gates are listed below.
- **Implementation status:** Production integration, the full automated suite, lint, TypeScript, release packaging and both supported host integration runs pass. Native correctness and small-block measurements are recorded below. Phase 5 remains open for the long-block foreground budget, startup, memory, remaining interaction/readability checks and physical reference hardware. The plan remains in `roadmap/pipeline/`.

## 2. Context & Problem

The reference Markdown fixture contains 38 authored fenced blocks: 16 TypeScript, seven SQL, and 15 unlabeled diagrams/aligned text. The provider also renders YAML frontmatter as a code block, giving 39 blocks in the real host.

The initial review identified:

1. The live NodeView drops the configured CSS class. Tokens exist but their colors never apply.
2. Restoring that class exposes high contrast dark colors with poor contrast.
3. The entire fence info string is treated as a language, so a title can cause incorrect automatic detection.
4. Two Lowlight plugins retokenize the whole document after ordinary code edits. The raw deck incurs 76 highlighting calls per edit; the host's extra YAML block makes that 78.

### Measurements gathered during planning

Node tokenization only, local Apple M4 Pro / Node 26.10.0 / macOS arm64. Figures are p50 / approximate p95 in milliseconds. They exclude ProseMirror, worker transport, decorations, DOM layout and paint.

| Engine | Deck's 23 tagged blocks | 1,000 small blocks | One 10,000-line TypeScript block | Cold import + setup + first small highlight |
|---|---:|---:|---:|---:|
| Current Lowlight 2.9 | 1.73 / 2.62 | 33.35 / 37.60 | 97.52 / 105.62 | 15.62 / 15.98 |
| Scoped Lowlight 3.3 | 1.51 / 2.39 | 33.27 / 37.92 | 97.74 / 108.63 | 10.27 / 10.89 |
| Direct highlight.js | 2.41 / 2.95 | 40.75 / 43.93 | 132.55 / 153.80 | 10.07 / 10.32 |
| Refractor 5.0 / Prism | 1.78 / 1.93 | 23.98 / 27.33 | 68.94 / 83.56 | 9.14 / 9.76 |
| Shiki 4.4, JavaScript engine | 27.24 / 33.46 | 297.99 / 363.01 | 962.42 / 996.99 | 96.78 / 97.80 |

Lowlight uses 20 warm samples; Refractor and Shiki five; direct highlight.js three. Cold runs use five fresh processes, excluding process startup. These sample sizes are useful for direction, not precise cross-engine rankings. Direct long-block results measure HTML generation only; a separate HTML-to-range conversion trial was capped after about two minutes. That adapter also normalized CRLF in a correctness probe.

One small TypeScript block takes current Lowlight **0.025 ms p50 / 0.055 ms p95** over 100 samples. This is the relevant amount of lexical work for an ordinary single-block edit.

The deck yields 835 Lowlight ranges, 1,572 Refractor ranges and 1,993 Shiki ranges. Counts are not equivalent measures of grammar quality, but they show why tokenizer speed alone cannot predict editor performance.

**Bundle comparison, engine-only, minified raw / gzip:** scoped 12-language Lowlight 2.9: 77,621 / 24,846 B; Lowlight 3.3: 76,184 / 24,335 B; direct highlight.js: 74,212 / 23,762 B; Refractor: 65,864 / 23,762 B; Shiki JS with two themes: 935,111 / 150,694 B. Editor integration and CSS are excluded.

The current broad Lowlight import is 213,838 / 62,385 B and supports **38 names**, including YAML frontmatter. A Lowlight 3 variant preserving the inventory is 175,308 / 53,094 B. The smaller 12-language experiments are not a safe drop-in replacement.

Version caveat: current Lowlight 2.9 uses highlight.js 11.8 internally with root 11.12 grammar overrides; Lowlight 3.3 uses 11.11.2 internally. Results cannot isolate wrapper overhead from dependency versions. Implementation must document and test the selected engine/grammar version combination.

The engine comparison scripts, raw timings, bundle inventories and version/license records are local-only supporting evidence and are not included in this PR. The tables above preserve the measured results, sample sizes and comparison limits. The decision is to retain the current Lowlight engine and effective grammar inventory.

### Native feasibility experiment

An isolated copy of the extension loads the production editor with build-time overrides. It compares the current integration with one synchronous changed-block plugin using the same Lowlight engine. It restores the missing class only in the optimized variant.

The prototype's 16 focused checks passed, including attribute-only language changes, multi-step transactions, undo/redo, insertion/deletion, and comparison with a fresh full tokenization. That prototype did not include background work, full lifecycle handling, exhaustive mapping or theme fixes; the production implementation below adds those contracts.

Computer use drove the native VS Code 1.139.1 Extension Development Host on this Mac. Each code-edit probe performs 20 synchronous transactions in the actual editor after a native button click.

| Native case | Plugins | Tokenizer calls | Synchronous dispatch p95 | Colored token spans |
|---|---:|---:|---:|---:|
| Deck, current integration | 2 | 1,560 | 12.0 ms | 0 / 843 |
| Deck, changed-block prototype | 1 | 20 | 2.3 ms | 834 / 843 |
| 1,000 blocks / 10,001 lines, prototype | 1 | 20 | 3.5 ms | 7,000 / 7,000 |

Nine deck spans retain the base foreground, which is valid for punctuation. Separate native prose-edit and selection probes perform zero tokenizer calls. The native deck has eight additional YAML tokens from rendered frontmatter, explaining its 843 tokens versus the raw Markdown benchmark's 835.

The prototype reports synchronous dispatch duration, not physical keystroke-to-paint latency. Its instrumentation also scans styles periodically. Baseline code-edit probes must place the selection inside the edited block: the current upstream plugin can otherwise skip tokenization of programmatic edits. The baseline 1,000-block native comparison is inconclusive because the isolated harness opened a blank webview after reload; this was not isolated as a product defect. The successful deck comparison and optimized large-document run are retained. A worker and native single-long-block performance are not verified by this prototype.

Planning QA reports and screenshots remain local-only supporting evidence. The measured long-block cost justified worker/lifecycle work and increased the scope estimate from 3–5 to 5–8 engineering days, before the additional viewport-projection branch.

## 3. Desired Outcome & Scope

### Success criteria

- Supported fences show correct, readable token colors on first open and after edits, language changes, undo/redo, source updates and reopening.
- Blank/plain-text/unknown fences remain readable literal text with no automatic language guessing.
- Preserve the existing 38-name language inventory and aliases. Add no silent language-support reduction for bundle savings.
- Preserve authored code, fence metadata, indentation, marker style, and raw copy output. Highlighting never enters Markdown or creates document edits.
- Exactly one highlighting plugin. One code-block edit invalidates only affected blocks. Selection, theme changes and unrelated prose edits enqueue no new tokenizer work. Scrolling does not invalidate valid tokens; after cache eviction it may enqueue bounded background work for missing projected results, with zero foreground tokenization.
- No full-document block enumeration on ordinary typing or language changes. A bounded, explicit fallback is permitted for unknown structural steps/full replacement.
- Uncached lexical work runs outside the typing thread. Out-of-order/stale results cannot color the wrong block.
- Native p95 input handling remains under 16 ms, editor input-ready initialization under 500 ms, cursor/formatting under 50 ms, toolbar actions under 300 ms on reference hardware.
- Supported large fixtures include 10,000+ mixed lines, 1,000 small blocks, and one 10,000-line block. Measure tokenization, decoration application, layout and paint separately.
- Target color settling within 100 ms for an ordinary block when its grammar is warmed and the worker is idle. Measure saturated-queue wait and total settle time separately; queue priority cannot interrupt an active synchronous tokenizer. Every current pending block must eventually settle or report its explicit fallback after editing stops.
- A changed-block canonical token result and a full fresh highlight of the same content agree after work settles. With viewport projection, compare live decorations with the expected visible-plus-overscan subset of those canonical tokens.

### In scope

Live NodeView attributes, one incremental plugin, grammar resolution, preserved fence info, worker packaging/protocol/lifecycle, bounded caching, theme colors, deterministic performance gates, real-host regression tests and long-document verification.

### Out of scope

A new editor inside each code block, IntelliSense, semantic diagnostics, line numbers, code execution, automatic detection, adding every language grammar, exact matching of arbitrary TextMate themes, and colored PDF/DOCX export.

## 4. UX & Behavior

- Existing open, code-block insertion and language menu flows remain the entry points.
- Show text immediately. Colors can arrive asynchronously; input, selection, copy and save do not wait for colors.
- Remove colors that touch edited text while the block's new result is pending. Keep mapped colors elsewhere in that block and in unrelated blocks, so typing does not flash the block uncolored.
- Unknown languages, explicit `text/txt/plaintext/none/nohighlight`, and unlabeled diagrams stay plain. Preserve their authored fence labels.
- Resolve only the first info-string token as a grammar; preserve its metadata suffix. Choosing a new menu language replaces only the first token.
- Keep copy controls outside ProseMirror's managed content DOM. Preserve focus, keyboard behavior, raw clipboard text and accessibility names.
- Decouple token styling from geometry so restoring the missing class does not unexpectedly activate the old 60 px padding rule. Preserve the current compact layout and copy-button clearance.
- Code surface, foreground, borders and font inherit VS Code variables. Syntax colors use extension-contributed theme color IDs; theme switching requires no tokenization.
- High contrast prioritizes legibility. Defaults may use editor foreground plus keyword weight/comment style rather than unsafe accent colors.
- Worker failure leaves editable plain code and a recoverable highlighting state. Do not mark the document dirty or discard text.

## 5. Technical Plan

### A. Retain Lowlight behind a small adapter

Keep Lowlight for the first implementation. Its AST maps directly to source-relative spans; switching engines does not remove the measured whole-document work or the large-block problem. Refractor is a credible future candidate, but its modest tokenizer gains and extra ranges do not yet justify migration. Shiki JS is not justified for this performance goal.

Define an adapter returning coalesced **UTF-16-relative** spans with approved token classes, not HTML. Do not use private highlight.js emitter internals or insert highlighted HTML into the editable DOM. Validate ranges and text preservation on Unicode, CRLF, entities, malformed/incomplete code and nested token scopes.

Preserve the full effective current registry: Lowlight 2.9's common grammars from its nested highlight.js 11.8 dependency, followed by the same existing root highlight.js 11.12 overrides. Move that registration sequence into the worker, including embedded-language dependencies and aliases. Do not replace all 38 names with root-version grammar imports just because the names match. Capture canonical names, alias mappings, effective grammar versions and representative token outputs before migration, then compare the worker registry against that baseline. The existing experimental names-only inventory is not sufficient for this gate. Do not bundle a Lowlight major upgrade or broader grammar replacement into the integration fix without separate compatibility evidence.

### B. One plugin and correct NodeView composition

Change [codeBlockWithCopy.ts](../../src/webview/extensions/codeBlockWithCopy.ts) to extend plain `@tiptap/extension-code-block`, added as a direct dependency pinned to 3.30.5. Preserve its parent behavior, including VS Code code-paste handling. Remove the old Lowlight extension dependency when no imports remain.

Register one local highlighting plugin. Merge extension-configured and runtime HTML attributes with TipTap `mergeAttributes`. The existing [copy NodeView](../../src/webview/extensions/codeBlockCopyNodeView.ts) retains managed `contentDOM`; no `innerHTML` replacement or direct content mutation.

### C. Grammar lookup without changing the Markdown schema

Keep `attrs.language` as the currently preserved authored info string. `parseFenceInfo(info)` returns a lowercase first token and the exact metadata suffix. The separate, grammar-free `resolveGrammar(token)` resolves aliases to supported grammars or `null`; neither helper rewrites the document attribute. `replaceFenceLanguage(info, language)` preserves the suffix when the user explicitly changes language.

Use normalized grammar only for the tokenizer and DOM language class. Preserve [parse/render handlers](../../src/webview/extensions/preservedCodeBlock.ts) and update [BubbleMenuView.ts](../../src/webview/BubbleMenuView.ts) to preserve suffixes and compare aliases correctly. Normalize unknown/plain-text values to no highlighting, not auto-detection.

### D. Incremental decorations and occurrence tracking

Plugin state owns a persistent DecorationSet, code-block occurrence index and pending revisions. Cache token spans independently of document positions.

1. Return existing state immediately for unrelated metadata/selection transactions.
2. Map existing decorations and occurrences through the transaction mapping.
3. Derive each step's changed range in its own output document, then map it through subsequent steps into final coordinates.
4. Inspect only affected ranges and boundary ancestors. Handle language-only AttrStep changes explicitly because their StepMap can be empty. For ReplaceAroundStep, inspect the complete structural output region, including its preserved gap: wrapping/lifting can otherwise lose node-index decorations even when the text survives.
5. Invalidate changed/deleted occurrences, preserve unchanged identities, and enqueue affected blocks whose text or normalized grammar changed. Separately allow a missing projected result to be restored after cache eviction without invalidating any surviving tokens.
6. Reuse relative spans for identical content where cache limits allow, including undo and moved blocks. Do not use a document position as permanent identity.
7. For an unknown empty-map step, clear potentially stale decorations and rebuild the occurrence index conservatively. The service can reuse cached canonical spans when the grammar/source still match. Count and test this fallback so it cannot silently become the typing path.

Retokenize the complete changed block, not arbitrary lines/chunks. Multiline strings and comments cross line boundaries. Compare canonical incremental results with a full reference highlight under randomized edit sequences; if viewport projection is active, separately compare its live decoration subset.

### E. Worker, queue and bounded memory

Use one worker per live webview, initialized once, with one active job and coalesced pending revisions. Prefer the edited/visible blocks when choosing the next job; enqueue remaining initial work incrementally. An active synchronous tokenizer is not preempted by queue priority, so the 100 ms ordinary-block target applies to a warmed idle worker. Record queue-wait latency under a long active job, and verify eventual completion of current pending work after editing stops. Do not eagerly copy every code block's text into an unbounded queue.

The worker transport correlates a view-scoped session, request ID, normalized grammar and source length. The plugin retains occurrence ID, per-block revision and the immutable source node for each request/publication. Validate the transport envelope and spans, then recheck the live occurrence and source and find its current mapped position. Reject results from earlier edits, A→B→A races, deleted/replaced blocks and disposed views. A global document revision alone is insufficient because unrelated prose edits should not discard useful results.

Large-result validation, freezing and cache-byte accounting yield after at most 1,000 spans or a cooperative 4 ms deadline, checked every 64 spans. Continuations recheck job/session ownership and stop on disposal or worker replacement. The worker timeout ends when its response arrives; main-thread validation scheduling is measured separately. No partially validated result enters the cache or publication queue. These slices are an implementation mechanism, not proof that every browser task or input-to-paint interval stays below 4 ms.

Publish decorations through a metadata-only transaction with `addToHistory: false`. Revalidate view generation, occurrence, revision, grammar and source identity before every deferred publication batch, not only when the worker result arrives; cancel remaining batches when any check fails. Assert zero document sync messages, dirty-state changes, undo entries and autosaves caused by highlighting.

Start with explicit provisional resource limits, then verify and tune them through the release gate:

- One active job. Pending current revisions remain in the occurrence index instead of an eager source queue. Completed results wait in a publication queue with a 64-descriptor cap and a 4,000-range admission threshold; that threshold does not cap an individual result, which is governed by the per-job limits and viewport projection.
- A bounded token LRU with both entry and byte/range accounting; initial limits 128 entries, 8 MiB accounted storage and 100,000 cached ranges.
- At most 1,048,576 UTF-16 code units per job, 100,000 returned coalesced ranges, and 4 MiB per serialized result. Check source size before transport, enforce output limits while collecting/serializing spans in the worker, and validate limits and ranges again before accepting a result. A cache limit alone does not bound a single job or result.
- Account separately for active source snapshots, worker transport copies, accepted result arrays, deferred publication batches and live decorations. The client LRU is the sole strong canonical-result cache. Projection keeps at most 128 occurrence/revision metadata entries with `WeakRef` references, so it does not add another strong canonical token store. Active jobs/publications still temporarily own their results. Measure peak main-thread and worker memory, including tokenizer AST allocation that output limits cannot prevent; these accounting limits are not a measured process-memory ceiling.
- Deduplicate queued work for each occurrence; invalidated in-flight output is discarded.
- Time out a worker job after 2 seconds, terminate that worker, and permit at most one automatic retry for the same grammar and exact source within a view session. Cache eviction, scrolling and repeated requests must not reset that retry budget. Explicitly rejected size/range limits are not automatically retried. Do not pretend a promise timeout interrupts synchronous regex work.
- Over-limit input/output or exhausted error recovery leaves editable plain code with an unobtrusive explanation outside the managed content DOM. Source text, save and copy remain intact. The supported 10,000-line fixture must fit comfortably within the measured limits and complete normally; fallback is not a passing result for that fixture.
- Terminate workers, revoke blob URLs, clear queues and drop caches on view destruction. Never persist code/cache authority in `vscode.setState`.

Add one bundled worker asset to [build-webview.js](../../scripts/build-webview.js). Pass its webview URI through the provider's existing trusted asset mechanism, fetch locally and create a blob worker. Add only `worker-src blob:` to the CSP in [MarkdownEditorProvider.ts](../../src/editor/MarkdownEditorProvider.ts). No remote grammars, eval, network service or workspace script loading.

Extend build verification to require/package the worker, enforce source-map policy and report main-plus-worker raw/gzip sizes. Keep total JavaScript near the existing 5 MB budget; measure total shipped assets, not just the main bundle.

### F. Large-block rendering gate

Moving lexing to a worker does not make 48,000 decoration ranges cheap. Coalesce equal adjacent classes, measure result conversion/application and input-to-paint independently, and publish bounded batches outside the immediate input event. Every batch uses the live validation rules above; an edit or disposal between batches cancels the remaining publication.

Viewport projection is now implemented for results above 2,000 ranges. It selects complete intersecting spans from the full canonical result using binary search and source-position overscan. It never tokenizes independent viewport text fragments. The client owns the sole strong canonical cache; when a weak projection reference is no longer available, scrolling can request one coalesced background job for the current complete source. Keep surviving valid decorations until replacement is ready, perform no foreground tokenization, and do not invalidate other blocks. Compare canonical tokens against the full reference output and live decorations against the expected visible-plus-overscan subset. Cover cache eviction followed by return scrolling, wrapping, zoom, selection, copy and source positions. A 10,000-line block left permanently uncolored is not an undocumented substitute for passing this gate.

The rendering branch was activated after the browser long-block fixture reported color-publication dispatch p95 of **77.2 ms**. Its initial projection run reported **7.6 ms**. These local-only timing snapshots contain no native beforeinput events and are not input-to-paint measurements or a native acceptance pass. They still reported initialization long tasks above 400 ms; end-to-end startup, the later yielding-validation change and physical-memory behavior require fresh verification. Subsequent native attribution in section 7 leaves the long-block foreground gate open.

### G. Theme contract

Declare a small `markdownForHumans.code*` palette through `contributes.colors`, with light, dark, highContrast and highContrastLight defaults. Reference these generated `--vscode-*` variables from [editor.css](../../src/webview/editor.css), with `editor.foreground` fallbacks. Let punctuation inherit the base foreground.

Use actual VS Code surface/font variables. Audit normal-text contrast on built-in theme fixtures; HC defaults favor foreground plus token typography. Verify contributed color overrides on VS Code 1.98 and stable. Do not invent CSS variables for arbitrary TextMate scopes.

## 6. Work Breakdown

- [x] **Phase 1, correctness contract and failing tests:** Production live-DOM attributes, one-plugin count, fence-info cases, four-theme palette expectations, full-reference token oracle and effective language inventory have focused automated contracts. Native computed-color acceptance remains in phase 5.
- [x] **Phase 2, synchronous correctness:** Plain CodeBlock base, merged attributes, grammar adapter, incremental mapping, bounded cache and empty-map attribute invalidation implemented. Focused correctness regressions include structural conversion, wrapping/lifting and 100 seeded operations against fresh tokenization.
- [x] **Phase 3, worker integration:** Local asset/CSP integration, serial queue, stale-result protocol, yielding validation, bounded failure recovery and teardown implemented with focused automated tests. Native packaging/lifecycle acceptance remains in phase 5.
- [x] **Phase 4, appearance and preservation:** Contributed four-theme palette, geometry isolation, metadata-preserving menu, raw copy and fallback status implemented with automated tests. Four native themes have been observed; the complete override/zoom/readability matrix remains in phase 5.
- [ ] **Phase 5, scale and release verification:** Deterministic work counts, real-host timing and source-sync regression, full suite, build/license/docs review, prolonged reading and physical Windows evidence. Verification is in progress.
- [x] **Viewport projection implementation:** Activated by browser rendering evidence; canonical-result projection, weak references and lifecycle/scroll tests are implemented. Native long-block timing and full acceptance remain open.

### TDD acceptance matrix

Write each failing test before its production change. Spike tests demonstrate feasibility and do not replace production regression tests.

| ID | Risk / test | Required result |
|---|---|---|
| SH-01 | Full configured editor and live NodeView | Merged attributes, token spans and computed colors; getHTML alone is insufficient |
| SH-02 | Plugin composition | Exactly one highlighting plugin, native paste behavior retained |
| SH-03 | Ordinary code edit with 1,000 blocks | One affected-block job/cache miss; zero full-document enumeration |
| SH-04 | Selection, prose, scroll, theme, unrelated metadata | No new jobs for valid results; only bounded background restoration after projection-cache eviction; zero foreground tokenization or new source serialization |
| SH-05 | Language AttrStep / empty StepMap | Correct rehighlight or plain result; metadata-only suffix edit reuses grammar tokens |
| SH-06 | Multi-step edit, insertion, deletion, split/join, move | Canonical tokens equal fresh reference output; projected live decorations equal its visible-plus-overscan subset |
| SH-07 | Undo/redo and full host setContent | Correct content/positions, no stale ranges; original code projection preserved |
| SH-08 | Authored info, aliases, unknown/plain labels | Preserve suffixes and language spelling until explicitly changed; no auto-detection |
| SH-09 | Tabs, indent, fences, emoji, surrogate pairs, CRLF, entities | Exact code/copy preservation and valid UTF-16 offsets |
| SH-10 | Malformed/incomplete code, nested multiline constructs | Correct bounded fallback; no exceptions escaping into typing |
| SH-11 | Worker out-of-order results, A→B→A, deleted/moved blocks, edits between publication batches | Only matching live occurrence/revision may publish; every batch is revalidated and stale remaining batches are canceled |
| SH-12 | Worker crash, timeout, hide/reopen and disposal | Editable text, at most one automatic retry per grammar/source per view session, no restart loop, leaked resources or late writes |
| SH-13 | Async color result and theme switch | No document edit, dirty flag, undo entry, save or sync message |
| SH-14 | Four themes, custom palette, 100/150/200% zoom | Readable tokens and copy controls; no unexpected padding/overflow |
| SH-15 | Many-small and one-long block performance, saturated worker queue | Work-count gates, native p50/p95 and paint; 100 ms ordinary settling measured with warmed idle worker; saturated queue wait and eventual completion measured separately |
| SH-16 | Real-host typing/paste/copy/save/undo/source split/reopen | No code or fence corruption; repeat rapid undo/save boundary from prior review |
| SH-17 | Dependency/package/CSP | Effective canonical/alias/grammar-version and representative-token baseline preserved; embedded grammars covered; worker packaged locally, aligned TipTap family, license entries |
| SH-18 | Mixed document and prolonged reading | Tables/images/Mermaid/math/HTML unaffected; 3,000+ words read/edit for 10 minutes in light/dark |
| SH-19 | Per-job and aggregate resource limits, cache eviction, repeated failures | Source/range/result caps enforced; active/cached/transport/publication memory accounted; eviction cannot reset failure retries; return scrolling restores missing projected tokens in bounded background work |
| SH-20 | Supported 10,000-line block and over-limit fixtures | Supported fixture completes with comfortable limit headroom; over-limit/error fallback preserves editable/copyable source and explains unavailable coloring without dirtying the document |

### Verification surfaces and completion gates

- **Jest / deterministic fixture:** Parser, mapping, worker protocol, bounded work counts and token-reference equivalence. Add a 10,000-transaction run without relying on noisy elapsed CI thresholds.
- **Browser fixture:** Computed styles, range correctness, theme transitions and rendering counters. Label it separately from host evidence.
- **Real VS Code Extension Development Host through computer use:** Native selection, composition, typing, copy, save/undo/source synchronization, theme and lifecycle behavior. Test minimum 1.98 and stable.
- **Reference hardware:** Physical Windows i5/16 GB p50/p95 latency, memory after hide/close, and prolonged reading. Mac timings do not certify this target.
- **Release:** `npm test`, lint, release build/verification, supported host integration matrix, dependency/license checks, diff review and required manual reading. Do not mark shipped while any required performance/correctness branch is unresolved.

## 7. Implementation Log

### 2026-09-30: Planning and feasibility tests

- Fetched origin/main; baseline remained 1b8244b.
- Compared Lowlight, direct highlight.js, Refractor/Prism and Shiki JS using the source deck and generated corpora.
- Built a disposable single-plugin prototype; all 16 focused checks pass.
- Native deck comparison reduced 20 edits from 1,560 tokenization calls to 20; synchronous dispatch p95 fell from 12.0 to 2.3 ms. The optimized 1,000-block fixture achieved 20 calls and 3.5 ms dispatch p95.
- Raw benchmark and prototype outputs remain local-only supporting evidence; they are not production source or public reproduction fixtures.
- Native planning results are summarized above; physical reference-machine gates remain unrun.

### 2026-09-30: Production implementation

Implementation uses `feature/syntax-highlighting`, started at baseline `1b8244b` and subsequently merged main `6412d17`; it is not shipped. Raw execution logs, screenshots and the detailed QA report remain local-only supporting evidence. The implementation links below and the summarized verification results are the public review surface.

| Implemented contract | Production files | Regression tests |
|---|---|---|
| Plain CodeBlock base, exactly one plugin, configured live attributes, normalized DOM class and raw copy | [codeBlockWithCopy.ts](../../src/webview/extensions/codeBlockWithCopy.ts), [codeBlockCopyNodeView.ts](../../src/webview/extensions/codeBlockCopyNodeView.ts) | [codeBlockLiveHighlighting.test.ts](../../src/__tests__/webview/codeBlockLiveHighlighting.test.ts), [codeBlockWithCopy.test.ts](../../src/__tests__/webview/codeBlockWithCopy.test.ts) |
| Existing grammar/alias families, pinned-version tripwires and representative token fingerprints; UTF-16 fidelity and bounded AST conversion | [languageRegistry.ts](../../src/webview/highlighting/languageRegistry.ts), [tokenize.ts](../../src/webview/highlighting/tokenize.ts), [worker.ts](../../src/webview/highlighting/worker.ts) | [languageRegistry.test.ts](../../src/__tests__/webview/highlighting/languageRegistry.test.ts), [tokenize.test.ts](../../src/__tests__/webview/highlighting/tokenize.test.ts) |
| Mapped occurrence identity, local invalidation, attribute-only changes, stale-result rejection and non-document publication | [plugin.ts](../../src/webview/highlighting/plugin.ts) | [codeHighlightingPlugin.test.ts](../../src/__tests__/webview/codeHighlightingPlugin.test.ts), [codeHighlightingAdversarial.test.ts](../../src/__tests__/webview/codeHighlightingAdversarial.test.ts) |
| Wrapped/lifted groups retain their index; conversion and unknown-step fallback remove ghost colors; seeded content/structural edits agree with fresh tokenization | [plugin.ts](../../src/webview/highlighting/plugin.ts) | [codeHighlightingStructure.test.ts](../../src/__tests__/webview/codeHighlightingStructure.test.ts), [highlightingRandomized.test.ts](../../src/__tests__/webview/highlightingRandomized.test.ts) |
| One active worker, bounded sole strong token cache, retry ledger, teardown and validation in 1,000-span/cooperative 4 ms slices | [client.ts](../../src/webview/highlighting/client.ts), [types.ts](../../src/webview/highlighting/types.ts) | [client.test.ts](../../src/__tests__/webview/highlighting/client.test.ts) |
| Complete canonical tokens with visible-plus-overscan projection, at most 128 weak-reference metadata entries, cache-loss restoration and deferred geometry | [projection.ts](../../src/webview/highlighting/projection.ts), [plugin.ts](../../src/webview/highlighting/plugin.ts) | [projection.test.ts](../../src/__tests__/webview/highlighting/projection.test.ts), [codeHighlightingProjectionLifecycle.test.ts](../../src/__tests__/webview/codeHighlightingProjectionLifecycle.test.ts) |
| Lowercase lookup token, exact metadata suffix, alias-aware menu state and per-block suffix preservation across multi-selection/undo | [fenceInfo.ts](../../src/webview/highlighting/fenceInfo.ts), [BubbleMenuView.ts](../../src/webview/BubbleMenuView.ts) | [fenceInfo.test.ts](../../src/__tests__/webview/fenceInfo.test.ts), [codeFenceMenu.test.ts](../../src/__tests__/webview/codeFenceMenu.test.ts) |
| Eight contributed colors, four theme defaults, configured font, 48 px copy clearance independent of coloring, and an external fallback status | [package.json](../../package.json), [editor.css](../../src/webview/editor.css) | [codeHighlightAppearance.test.ts](../../src/__tests__/webview/codeHighlightAppearance.test.ts) |

Worker packaging and CSP are implemented in
[build-webview.js](../../scripts/build-webview.js),
[verify-build.js](../../scripts/verify-build.js)
and [MarkdownEditorProvider.ts](../../src/editor/MarkdownEditorProvider.ts).
Dependency/license changes and environment, styling and performance guides accompany
the implementation. Build checks report combined editor-plus-worker bytes; placing
grammars in a worker is not a claim that their packaged bytes disappear.

The structural regression began with a code-to-prose conversion retaining mapped
inline colors. A seeded test then exposed an earlier cause: wrapping retained
the inline colors but lost the occurrence's node decoration, because the old
changed-range scan skipped ReplaceAroundStep's preserved gap. The implementation
now inspects that structural region and removes invalid colors on conversion.
Unknown empty-map steps clear untrusted colors before rebuilding. Focused tests
cover wrapped groups, lifting, in-flight results and unknown-step conversion.
The randomized generator uses the high-order distribution of its seeded state,
so its 100-operation run actually exercises text, attributes, split/join, moves,
wrapping, insertion and conversion instead of cycling through only three cases.

The active rendering branch also avoids publishing an entire long block's token
set into the DOM. Viewport projection uses complete canonical spans and the same
bounded client cache. Its metadata holds weak references only; a collected or
evicted result can trigger one background full-source job when needed again.
Large returned arrays are validated and accounted incrementally before any result
is accepted. Cache accounting and weak references do not establish physical
memory usage, garbage-collection timing or input-to-paint performance.

### Verification results to complete before release

The final consolidated automated run and release package pass after merging main
`6412d17` at `c961e438`. Both automated native host integration runs were repeated
on that merged tree. The manual native observations below precede this final merge;
the full manual interaction matrix was not repeated after it. Native observations
below cover Visual Studio Code 1.139.1 Extension Development Host on macOS 27.0,
Apple M4 Pro. Phase 5 remains open; these results do not close unmeasured startup,
memory, physical paint or reference-hardware gates. Raw logs, accessibility captures,
screenshots and QA reports are local-only supporting evidence, not public links.
Generated native/browser fixtures can be reproduced using the tracked
[fixture instructions](../../scripts/highlighting-fixture/README.md) and
[fixture builder](../../scripts/highlighting-fixture/prepare.mjs).

Five spaced native keyboard events in the reference fixture measured document-dispatch
p95 **1.6 ms**, color-publication p95 **1.0 ms**, beforeinput-to-next-animation-frame
p95 **4.7 ms**, and worker round-trip p95 **1.1 ms**. They produced five worker jobs,
no fallback and no long task. The next-frame callback is not physical paint or
OS-to-display latency, and five samples are a small functional timing probe.

After five undo operations and save, all **38 authored fences**, including marker,
info string and body, matched exactly. Whole-document bytes differed because the
existing Markdown serializer normalizes non-code formatting. This verifies exact
code-fence preservation, not byte-for-byte preservation of the entire document.

The native 10,000-line single-block fixture still exceeds the 16 ms foreground
budget. A settled 20-edit burst was measured with the same production-derived
editor, first with highlighting enabled, then with highlighting disabled and
redundant language-class writes guarded in the disposable fixture only:

| Native variant | Document dispatch p95 | State apply p95 | DOM update p95 | Editor events p95 | Worker jobs |
|---|---|---|---|---|---|
| Highlighting enabled | 27.1 ms | 0.4 ms | 26.9 ms | 0.3 ms | 1 |
| Highlighting disabled, language-class guard | 27.3 ms | 0.4 ms | 26.7 ms | 0.3 ms | 0 |

The highlighting state field itself measured 0.2 ms p95; the enabled run's worker
round trip was 109.9 ms. These results identify the existing large code-block DOM
update path as the dominant remaining foreground cost. Removing highlighting and
redundant class writes did not improve that cost in this comparison. No production
class guard or broader contentEditable virtualization change was made. The
foreground failure remains open as **QA-001**, affecting SH-15 and SH-20.

These are synchronous dispatch and individual phase measurements on this Mac,
not physical keystroke-to-paint timings or a reference-hardware pass. Phase p95
values are separate distributions and must not be added. Worker round-trip time
does not include main-thread validation, publication or paint. The 10,000-line
performance acceptance gate remains open despite removing foreground tokenization.

| Gate | Current status | Recorded result / evidence limit |
|---|---|---|
| Full automated suite and included deterministic work-count contracts | Passed | 3,380 tests in 182 suites after the 2026-10-01 review fixes; 27 skipped tests, 120 todo, one skipped suite. Logs are local-only supporting evidence. |
| Lint and TypeScript | Passed | `npm run lint` and `npx tsc --noEmit` completed successfully; logs are local-only supporting evidence. |
| Release build, worker packaging/CSP and VSIX | Passed | Post-merge release build and asset verification passed; review package contained 74 files, 3,148,764 bytes. Editor plus worker JS: 4,905,157 bytes; worker: 219,244 bytes. Packaged worker matched the release asset; no source maps or source/test/scripts files were included. The package and build log remain local-only. |
| Native reference fixture and 1,000-block behavior, typing/paste/copy/save/undo/source split/reopen | Partly verified; remaining interaction matrix open | Reference-fixture keyboard/save/undo results are summarized above. A native 1,000-block synthetic burst measured document p95 8.5 ms, color publication 1.0 ms, one worker job and no fallback/long task. |
| Native 10,000-line single block, publication/validation/paint timing and queue settling | Synthetic dispatch probes pass; input-to-paint open | After the review fixes below, QA-001's 20-edit probe measured document dispatch p95 2.3 ms; paced edits at 50% and 95% depth measured 2.4 ms and 1.1 ms with no uncolored frames. Physical keyboard input-to-paint remains unmeasured. |
| Four native themes, custom color overrides and 100/150/200% zoom | Four themes observed; complete override/zoom matrix open | Dark 2026, Light Modern, Dark High Contrast and Light High Contrast showed token colors and readable controls. Screenshots are local-only supporting evidence. |
| Supported VS Code 1.98 and current stable host integration matrix | Passed | VS Code 1.98.0: 7/7; stable 1.140.0: 7/7. Stable used a shorter test profile after the initial profile exceeded macOS's IPC path limit. Host logs are local-only supporting evidence. |
| Input-ready initialization below 500 ms | Unverified | No startup budget claim follows from tokenization or native typing measurements. |
| Main-thread/worker peak and retained memory after hide/reopen/close | Pending measurement | Logical cache limits and deterministic teardown tests do not establish physical memory usage. |
| Physical Windows i5/16 GB p50/p95 and memory acceptance | Unavailable in this run | Mac measurements do not certify the reference target. |
| Required 3,000+ word, 10-minute light/dark read/edit and mixed-content regression | Pending: interrupted visual review only | The review observed readable prose, diagram alignment, SQL colors/wrapping and copy clearance, but did not establish the required continuous ten-minute light/dark read. |

A final native visual check used byte-identical release extension.js, webview.js,
webview.css and highlighting-worker.js in the disposable Extension Development
Host. After Developer: Reload Window, the instrumentation overlay was absent,
SQL colors remained visible, wrapped comments stayed inside the block and copy
controls had clearance. Local-only asset hashes and screenshots record this
separate release-assets check. It does not close the interrupted reading, timing
or memory gates.

The final native source retest used atomic paste, undo, redo and save on a generated
corner-case fixture. The exact TypeScript fence metadata, 109 CRLF pairs and 27 tabs
were verified on disk, then correct nested colors were observed after reopening
with release assets. An earlier restoration claim was unverified and is not used
as acceptance evidence. Native copy/paste also retained literal code with tabs and
Unicode, while nested TypeScript and embedded HTML/CSS colors were visually checked.

### 2026-10-01: Review fixes for long blocks

A clean-worktree review in a native VS Code 1.139.1 Extension Development Host
found that long-block cost depended on scroll depth, which the block-start probes
above could not show. Five defects were fixed test first:

- `DecorationSet.remove()` is quadratic for many inline decorations in one
  textblock. Every code edit and publication used it; one keystroke in a
  40,000-token block took about 21 s in Node, and native scrolling froze for
  13 to 14 s. Large removals now rebuild the set.
- Viewport probes at the top edge hit the sticky formatting toolbar, so each
  projection started at the block start and grew with scroll depth (40,000
  decorations at the tail). Edge probes now step past overlays, and the viewport
  also reports its visible range before overscan.
- Every scroll frame republished the projection. It now republishes only when the
  visible range leaves the current window.
- Each edit removed every color in the block until the worker replied: 138
  consecutive uncolored frames during paced typing at 50% depth, and a DOM update
  p95 of 77.3 ms from re-rendering the whole text node. Only tokens touching the
  edit are removed now.
- Moving a projection reuses the long text node for a later range. Chromium scroll
  anchoring followed that node, jumped by the projection shift and triggered the
  next projection until the block end. Code blocks now set `overflow-anchor: none`.

| Native probe on the fixed build | Before | After |
|---|---|---|
| 20 synchronous edits at block start (QA-001), document dispatch p95 | 27.1 ms | 2.3 ms |
| 10 paced edits at 50% depth, document dispatch p95 / uncolored frames | 78.3 ms / 138 | 2.4 ms / 0 |
| 10 paced edits at 95% depth, document dispatch p95 / uncolored frames | not measured | 1.1 ms / 0 |
| Mounted spans with the viewport at 50% depth | about 20,000 | 1,067 |
| Jump from 50% to 95% depth | scrolled to block end | stayed at target |

The same session observed correct colors and plain fences in the language matrix,
metadata-preserving language changes, byte-identical files after undo and save in
the language matrix and a mixed Mermaid/math/table/SVG document, raw copy output,
live external file edits, source split sync, three theme switches without worker
jobs and a settled 1,000-block document. The 601 to 631 ms long task while opening
the 1,000-block document also occurs with highlighting disabled, so it belongs to
editor initialization rather than highlighting. These are synthetic dispatch
measurements on an Apple M4 Pro, not physical keystroke-to-paint or reference
hardware results.

The local-only execution report traces SH-01 through SH-20 and records overall
acceptance as incomplete because the remaining gates above are open.
Do not treat a passing automated suite or a final QA report as a release-acceptance
pass.

## 8. Decisions & Tradeoffs

1. **Keep Lowlight initially.** Refractor has some lexical speed advantage, but more output ranges and no solution to whole-document invalidation. Shiki's measured startup/lexing cost is unsuitable for the present goal. Direct HTML output introduces conversion and fidelity risk.
2. **Incremental block invalidation plus worker.** Small-block tokenization is already cheap; large-block tokenization is not. A debounce alone cannot protect the UI thread.
3. **Preserve existing grammar coverage and Markdown schema.** Normalize grammar lookup separately from authored fence info.
4. **Theme-aware palette, not exact TextMate parity.** Custom color IDs integrate with VS Code and support accessibility without inspecting installed theme internals.
5. **Evidence boundaries matter.** Tokenizer, synchronous dispatch, actual input-to-paint, cold startup and memory are distinct metrics. No engine-only microbenchmark proves editor performance.
6. **No silent reduced scope.** If worker transport, decoration application or large-block rendering fails its gate, finish the relevant branch or report it incomplete.

Primary references checked during planning:

- [Lowlight AST API](https://github.com/wooorm/lowlight) and [TipTap CodeBlockLowlight](https://tiptap.dev/docs/editor/extensions/nodes/code-block-lowlight).
- [highlight.js public API](https://highlightjs.readthedocs.io/en/latest/api.html) and [Refractor](https://github.com/wooorm/refractor).
- [Shiki performance guidance](https://shiki.style/guide/best-performance) and [JavaScript engine restrictions](https://shiki.style/guide/regex-engines).
- [VS Code contributed colors](https://code.visualstudio.com/api/references/contribution-points#contributes.colors) and [webview worker restrictions](https://code.visualstudio.com/api/extension-guides/webview#using-web-workers).
- Pinned ProseMirror source for DecorationSet mapping and AttrStep behavior. The public reference site returned HTTP 403 during this session, so installed source was used for exact API inspection.

## 9. Follow-up & Future Work

Evaluate another tokenizer only if profiling after these changes identifies lexical throughput, grammar quality or required theme fidelity as the remaining bottleneck. Export highlighting and additional language packs remain separate features.

Update environment/performance/styling guidance and THIRD_PARTY_LICENSES.md as implementation changes those contracts. When every acceptance gate passes, move this plan to roadmap/shipped with git mv. Never commit or push without the user's review.
