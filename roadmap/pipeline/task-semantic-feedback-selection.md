# Task: Semantic Feedback Selection

## 1. Task Metadata

- **Task name:** Semantic Feedback selection for sections and containers
- **Slug:** semantic-feedback-selection
- **Status:** implemented, awaiting desktop release gates
- **Created:** 2026-09-10
- **Last updated:** 2026-09-10
- **Shipped:** _(pending)_
- **Planning baseline:** `2a75861` on `feature/feedback-native-selection`
- **Related plans:** `task-rich-view-feedback.md`, `task-feedback-selection-evidence-v2.md`, `task-feedback-reliability-architecture.md` in this directory.
- **Authorization:** User approved the interactive HTML mock and implementation on 2026-09-10.

## 2. Context & Problem

The rail action currently selects one complete top-level block. Selecting the heading “Mocks” therefore excludes the list beneath it. Nested DOM targets resolve upward to the enclosing top-level block, so the same mechanism cannot precisely select a parent list item and its descendants.

Users need one action to address a coherent section or container, while preserving exact partial text selection and unambiguous LLM feedback. A heading section is a semantic range of sibling blocks. A nested list item or quote is a real subtree. These require different boundary rules and source validation.

The recent pointer-capture repair must remain intact. Structural selection must never capture, cancel, replace or broaden an ordinary text drag.

The v2 evidence implementation is authoritative over older plan descriptions: it has closed target scopes, strict field validation, canonical report text, immutable sealed reports and host-derived source evidence. Adding informal metadata or extra report lines to v2 would break compatibility.

## 3. Desired Outcome & Scope

### Recommended product decisions

The user asked for recommendations, with i5/i7 processors and 8–16 GB RAM in mind. These defaults were approved through the interactive HTML mock; they are not previously shipped behavior:

1. **Click the heading rail control to target the whole section immediately.** The composer opens with “Section: Mocks, including subsections” and a Change scope action. Heading only remains available. A menu-first interaction does not materially save CPU or memory.
2. **One coherent target per comment.** A section may contain every descendant; unrelated branches receive separate comments. Existing contiguous manual block ranges and typed table rectangles remain available. A table column is one logical rectangular target even though its Markdown source is not one contiguous substring.
3. **One restrained rail control and a compact scope chooser.** Do not build a permanent full-document tree panel or thousands of buttons. The chooser exposes relevant ancestors and explicit table scopes.
4. **Source authority belongs to the host.** Renderer highlighting, labels and previews must agree with a validated target. Surrounding context is never represented as the exact selected subtree.

### Success criteria

- Clicking “Mocks” selects its heading, paragraphs, lists, nested subsections and other content up to the next equal/higher heading in the same container.
- Selecting a parent list item includes all its children and excludes its next sibling.
- Composer, saved annotation and LLM report agree about the target and its completeness.
- Every supported element has a documented structural action or an explicit safe boundary.
- Forward/reverse text drags, keyboard selection, table-cell selection, area capture and legacy feedback continue to work.
- Selecting large sections causes no document-wide work on each hover or keystroke.
- Required checks pass on realistic low-memory hardware before performance is claimed.

### Delivery scope

- **Phase A:** Top-level heading sections and current whole top-level containers using existing v2 block spans; scope chooser and exact extent preview; scalable range lookup.
- **Phase B:** Supported nested list items, paragraphs, quotes and parent-bounded heading sections, using the existing exact rendered-text locator. Authored-source subtree identity and persisted semantic labels are deferred to a separately reviewed v3 contract.
- **Phase C:** Explicit cell/row/column/whole-table entry points, keyboard navigation, lifecycle integration and acceptance testing. Inline atoms and opaque nested content retain honest whole-container/area alternatives.

Disconnected multiselection, document editing/reordering, cross-file targets, diagram-internal shape trees, automatic LLM invocation and changes to sealed old bundles are outside this implementation. Inline atoms without proven exact mapping retain their clearly labelled containing-block option. No library upgrades are planned.

## 4. UX & Behavior

### Scope matrix

| Element | Default structural action | Additional explicit scopes | Boundary and evidence |
| --- | --- | --- | --- |
| Heading H1–H6 | Section including heading and subsections | Heading only; ancestor section/container | Before next equal/higher rank in same structural parent, or parent end; complete source span when provable |
| Paragraph | Whole paragraph | Containing item, list, quote/alert, section | Exact paragraph node; a nested paragraph needs validated nested scope before being called exact |
| Bullet, ordered or task list | Entire list | Containing item/container/section | All items and descendants in that list |
| List item | Item and children | Whole containing list; parent item and ancestors | Item subtree including loose paragraphs, nested lists and other blocks; exclude sibling items |
| Blockquote | Entire quote | Nested quote or contained block; parent quote/section | Quote subtree, preserving authored quote markers |
| GitHub alert | Entire alert | Contained block or parent scope | Include alert type and descendants |
| Table | Entire table | Current cell, full row, full column, current rectangle | Whole source for table; typed cell coordinates and matrix for subsets |
| Table cell | Cell through explicit table scope chooser | Row, column, table; existing rectangle | Native text drag stays text; selecting a cell never implies editing its neighbors |
| Fenced or indented code | Whole code block | Existing partial code selection; ancestor scope | Preserve authored fence/indentation, language and whitespace |
| Mermaid | Whole diagram source | Existing area capture; parent scope | No inferred child nodes from SVG or diagram text |
| Block math | Whole equation source | Existing area capture; parent scope | Preserve authored syntax; rendered geometry is visual evidence |
| Image or inline math | Exact atom only with validated source mapping | Containing paragraph/item/section; area capture | These can be inline atoms; never claim a whole paragraph is exactly one image |
| Horizontal rule | Whole divider | Parent section/container | Does not terminate a heading section |
| Frontmatter, supported HTML, preserved literal/opaque block | Proven complete block | Valid containing scope or area capture where supported | No inferred hierarchy from arbitrary HTML or rendered widget DOM |
| Bold, italic, link, inline code, hard break | Native text selection | Containing block/ancestor | Marks are not artificial structural containers |
| Unknown/custom/empty unmapped content | No invented exact action | Valid parent explicitly labelled; visual capture where available | Fail closed when source or structure cannot be proven |

The matrix records the full design. This implementation supports complete rendered-text scopes for nested text-only containers. It does not implement exact authored-source subtrees or standalone inline-atom source scopes. Unsupported or oversized subtrees retain a clearly labelled whole top-level container or area alternative. Descendants are targeted directly from the document or caret, then the chooser exposes their ancestors. Quote/alert child options in the matrix do not imply a downward tree inside the chooser.

“Item own content without children” is not a default scope: loose list items may interleave paragraphs and child containers, making this a disconnected target. Use native text selection, a contained paragraph, or the complete item.

### Heading boundaries

Use parsed heading nodes and numeric levels, never regex matching of `#` in text. Include the initiating heading. A following deeper heading belongs to the section; a following same/higher heading does not. Handle skipped levels, duplicate/empty labels, Setext headings and EOF deterministically.

Sections do not cross their structural parent. A heading inside a quote, list item or table cell cannot consume content outside that parent. A heading inside a nested container does not terminate an outer sibling-level section. Preamble before the first heading remains individually selectable; it is not silently assigned to that heading.

### Rail and scope chooser

1. One active rail control aligns with the current semantic block or caret. Merely moving over document text must not paint an entire section.
2. Hovering or focusing the rail action previews its default extent. Clicking it opens the composer with that target; it never changes the document's native text selection.
3. A noncollapsed native selection has priority. The structural rail action stays suppressed until the user clears it or explicitly invokes Choose feedback scope.
4. Change scope shows the current target and valid ancestors. Example: `Paragraph → Item and children → List → Mocks section`. Heading only remains available for headings.
5. Prefer a bounded ancestor list over a full tree. Users target descendants from the document/caret; the chooser promotes to their parents. Truncate visual labels, not target identity. Distinguish duplicate labels with type and source location.
6. Show one preview bracket or bounded visible overlay, semantic name, extent and useful counts. Do not allocate highlights for every descendant. Preview abbreviations do not truncate the saved target.
7. Scope changes preserve the unsaved feedback text. Cancel/Escape restores focus and clears temporary preview without changing the source or a previously saved target.
8. Keep one draft/composer owner through the existing draft-surface gate. Opening another action focuses or changes that draft safely rather than creating overlapping composers.

### Keyboard and accessibility

Provide a discoverable Choose feedback scope command using the caret/current block. The compact chooser uses ordinary menu/list navigation, Enter to apply and Escape to cancel with focus restoration. Do not install global shortcuts that conflict with VS Code. Expose action names such as “Add feedback to section Mocks, including subsections.” Use a small number of focus stops; no per-node tab sequence. Preview communicates scope with labels/brackets as well as color. Test narrow windows, high contrast, 200% zoom and reduced motion.

### Preservation contract

| Existing behavior | Required treatment |
| --- | --- |
| Partial native prose/list/table/code selection | Same character endpoints and exact-text evidence; never promote based on coverage |
| Whole heading/block action | Still reachable explicitly; heading's default action intentionally becomes section |
| Manual first/last block range | Retain with existing contiguous-range meaning |
| Table CellSelection | Retain typed rectangle, structural identity, limits and existing CellSelection authority; native text takes precedence over rail actions, not over a real CellSelection |
| Whole table beyond cell limits | Still available; no forced expansion of a cell request |
| Area capture | Remains a separate explicit gesture with its own pointer capture |
| Existing source hash/invalidation | Preserve; stale targets cannot be sealed as exact or fuzzily relocated |
| Draft editing, reload, split/hidden views | Restore validated identity and scope, not stale DOM references |
| Sealed v1/v2 reports | Read without rewriting or reinterpreting their scope |

## 5. Technical Plan

### A. Frozen semantic index

Build an O(n) index once per frozen document revision, using actual canonical ordinals and immutable node structure. Store compact parent/child identity, node kind, bounds and heading rank. Calculate heading intervals with a stack per structural parent. Do not store copied text for every subtree, which grows quadratically for deep nesting.

Keep top-level source anchors authoritative. Canonical ordinals can be sparse when empty paragraphs are skipped; do not assume every integer between endpoints is an anchor. Replace repeated `anchorMap.blocks.find` in large source-format/range lookup with indexed actual anchors and precomputed format summaries. Cache source-line indexes once. Do not resolve source or collect descendant DOM rectangles on pointer movement.

Modules likely affected: `feedbackBlockAction.ts`, `feedbackReview.ts`, `feedbackTargetPresentation.ts`, `feedbackAnnotationLayout.ts`, `feedbackRenderedRange.ts`, `feedbackSelectionMapping.ts`, `editor.css`, and host source-format/anchor lookup in `MarkdownEditorProvider.ts`. Introduce a small pure semantic-index/resolver module rather than adding tree traversal throughout the controller.

### B. Phase A compatibility

A top-level heading section is a contiguous complete-block range. Reuse v2 `requestedScope: blocks`, the existing block span and host-derived source evidence. Do not add fields, visible report lines or guide wording to the strict v2 grammar. The report accurately contains Selected blocks and the authored section source. During the current interaction the composer can name the section; saved/reopened v2 cards keep the existing block-range label because v2 does not persist semantic selection intent.

Legacy block ranges remain block ranges on reload. Do not infer new intent merely because an old range happens to match a section. Persisted semantic provenance arrives with Phase B; this is an explicit limitation of the compatible first phase.

### C. Implemented nested rendered-text scopes

After reviewing the closed v2 grammar, the implementation uses the existing exact rendered-text contract for supported nested scopes. The authored-source v3 alternative was presented to the user; no answer had arrived, so the recommended compatible default was stated and taken. This is a deliberate revision of the initial v3-first plan, not an implementation of that proposed format.

`feedbackStructureIndex.ts` builds block parent pointers and heading endpoints once per frozen ProseMirror document. Hit queries use resolved positions and ancestor pointers. Section opacity is precomputed, so hover does not walk section siblings. Indexing stops at depth 64; deeper subtrees are opaque. Nested candidate extents over 64 Ki document positions are unavailable. No subtree text copies are retained in the index.

At explicit activation, the chosen half-open range is converted to the existing block-relative locator, reconstructed through the DOM, checked against the ProseMirror document text to reject NodeView control text, and bounded to the existing 64 KiB evidence limit. The host applies the existing canonical endpoint hash and locator validation. The saved report says rendered text and containing source lines, never exact authored Markdown for the nested node. V2 does not persist whether this range was selected as an item, quote or section; saved cards reopen with their existing exact-text presentation.

Top-level blocks and sections continue using host-derived complete source spans. A nested subtree containing images, opaque nodes, unsupported controls, or excessive depth/size cannot be called complete rendered text. Users retain explicitly labelled whole-container, native text and visual capture alternatives. Exact atom source mapping is not enabled.

### D. LLM reporting contract

A future v3 semantic-source contract would additionally persist the following intent. This implementation retains the v2 exact range, hashes, evidence and containing source lines, but not semantic scope names:

- What did the user request: section including subsections, item and descendants, quote, table row, etc.?
- Which frozen source file and SHA-256 bind it?
- What is the exact selected extent or structural locator? Which source lines are merely containing context?
- Which evidence is complete, abbreviated in the UI, omitted due to budget, or degraded?
- What feedback instruction belongs to this ID?

Proposed v3 data includes a closed semantic scope, snapshot-bound structural locator, heading/container ancestry for explanation, selected source region where provable, validated containing block span and explicit evidence relationship. A source-region encoding must define byte/character units, exclusive endpoints and CRLF/Unicode normalization before implementation. Host-computed hashes and structural identity carry authority; display labels and headings do not.

A conceptual human-readable section report could say:

```text
F7
Target: Section “Mocks”, including subsections
Selected source: docs/guide.md, lines 40–86
Boundary: ends before the next H2 “Delivery”
Evidence: complete authored Markdown, bound to the session source SHA-256
Feedback: Add one realistic example to each subsection.
```

A nested target must distinguish itself from its enclosing context:

```text
F8
Target: List item “Mocks should examine…”, including its children
Container: Mocks section / bullet list
Selected extent: host-validated structural locator and exact source region
Containing source context: whole list, lines 42–69
Feedback: Clarify how the API examples are checked.
```

These are design examples, not additions to the current v2 grammar. The v3 serializer, parser, guide and golden fixtures must agree. Text inside evidence, including instruction-like Markdown, remains document data; the user's Feedback field contains the requested change. The LLM verifies the original source hash before editing and addresses every feedback ID. It must not treat context-only text as selected or overwrite outside the target merely because it was supplied as evidence. Related edits can be explained when needed to fulfill the actual instruction; scope defines what the feedback concerns, not an invented prohibition on all supporting edits.

Retain today's evidence rules: whole source blocks preserve Markdown/HTML; partial text preserves rendered text; table subsets preserve typed matrices, not synthesized Markdown tables; visual selections use screenshots. For source over the embedding budget, preserve the complete validated target and disclose omission; never silently select only the first 64 KiB. The LLM reads the referenced file only after hash verification. A changed source remains a mismatch, not an invitation to guess.

### E. Versions and lifecycle

This implementation reads v1/v2 unchanged and continues writing v2. It reuses the existing exact-text/cell lifecycle and introduces no v3 grammar. The following v3 migration policy remains future design, not shipped behavior: write v3 only for new rounds once a separate source-scope contract is implemented. Preserve existing atomic v1-draft-to-v2 migration on mutation/seal. Do not automatically migrate v2 drafts to v3. Disable unsupported new semantic actions in old rounds with guidance to finish that round and start a new one. Do not introduce a v2-to-v3 schema change halfway through a comment or silently migrate sealed files. If v2-to-v3 draft migration is later required, design it explicitly and atomically using existing migration patterns.

Update strict protocol parsing, snapshot/transfer version negotiation, item summaries, persisted report grammar, reopening, annotation recovery and handoff guide together. Unknown future versions fail clearly. Existing old-format feedback must still display its actual recorded scope without upgrading it by inference.

Relevant host/shared files: `feedbackProtocol.ts`, `feedbackEvidenceV2.ts` (compatibility reference), `feedbackAnchors.ts`, `feedbackSnapshotService.ts`, `feedbackTargetEvidenceV2.ts`, `feedbackSourceEvidence.ts`, `feedbackReportV2.ts`, `feedbackSessionStore.ts`, `feedbackItemSummaryV2.ts`, `feedbackMigrationV2.ts` and `feedbackHandoffPrompt.ts`. Prefer version-specific modules for new grammar over weakening v2 validation.

### F. Tables and bounded fallback

Whole-table selection remains source-exact, including supported HTML/merged tables. Row/column selection is a typed rectangle of existing cells. Keep the current 256-cell per-item and 4,096-cell per-session limits; cell text beyond 240 characters is explicitly incomplete. Columns must not claim contiguous exact Markdown source.

For a merged/irregular grid or a rectangle over budget, show the limitation and offer a whole-table action explicitly. Retain compatibility with existing recorded degradation reasons; never make the preview appear exact when the report is coarsened. Native partial text inside a cell remains exact rendered-text evidence.

### G. Low-memory performance strategy

Processor branding alone is not a performance guarantee. Record CPU generation, RAM, OS, VS Code version, display/zoom and document size for reference runs. Target an available Windows i5-class/8 GB machine and an i7-class/16 GB machine; a Mac or throttled browser is supplementary evidence, not proof for those devices.

- No semantic indexing, serialization, Markdown parsing or source hashing in typing callbacks.
- One bounded index per snapshot; O(depth) ancestor choices and O(1) indexed section bounds after construction.
- Lazy bounded excerpts and evidence extraction only for the chosen target. Reuse cached source-line and format indexes.
- One rail control, one preview surface and one scope chooser; no tree-wide DOM rendering or descendant overlay allocation.
- No geometry reads for every item on scrolling. Preserve existing annotation layout work limits.
- Dispose index caches, observers, handlers and previews when the session ends or view unloads. Persist only bounded identity/view state.
- Retain current textual evidence caps: 64 KiB per item, 1 MiB embedded source per report and existing metadata limits unless the v3 feasibility review explicitly justifies a bounded revision. Deep ancestry must not produce an unbounded metadata path. Retain the existing 2,000-item and 64 MiB report limits.

Gates: no typing-latency regression against baseline; existing <16 ms keystroke and <50 ms ordinary-interaction budgets; rail/menu response within 300 ms; measure p95 on target hardware. On 10,000-line fixtures, assert one index pass, no repeated full scans on hover, and linear retained index growth as node count doubles. Compare heap after repeated start/cancel/dispose cycles. Establish and record an index-memory ceiling during the Phase B spike before accepting the implementation; do not invent a performance claim from processor labels.

## 6. Work Breakdown & Validation

Each phase follows RED → GREEN → REFACTOR → VERIFY. No phase is complete solely because its resolver tests pass.

- [x] **A1: Boundaries and compatibility tests.** Top-level heading intervals, sparse ordinals, invalid anchors and preserved legacy behavior.
- [x] **A2: Heading UX.** Indexed section targeting, rail-only preview, Change scope, keyboard navigation, heading-only and original manual-range retention.
- [x] **A3: Large-range work.** Sparse source-format prefix index, invalidated on transfer; existing evidence omission limits retained.
- [x] **B1: Compatible nested contract.** Reuse strict v2 rendered-text evidence; exact authored-source mapping and semantic provenance explicitly deferred.
- [x] **B2: Nested scope index.** Parent items and descendants, nested heading boundaries, opaque/depth/size limits, no subtree scans during repeated hits.
- [x] **B3: Nested composer/report inputs.** Scope switch preserves the comment; exact selected text and offsets exclude siblings; NodeView control text is rejected.
- [x] **C1: Table/atom boundaries.** Explicit cell, row and column choices use existing typed geometry; merged grids fail closed; matrices are lazy until Change scope opens. Atom-only source scopes remain unavailable.
- [x] **C2: Automated lifecycle/access.** Existing lifecycle tests, new command routing, focus, Escape, arrow/Home/End navigation and selection-preservation checks pass.
- [ ] **C3: Desktop acceptance and physical hardware.** Mac is now unlocked. Targeted packaged secondary-display checks passed for the reported heading, table, following paragraphs and scrolling. A 4,271-word reading check across light and dark themes passed over 14 minutes on September 10. The full desktop matrix and physical Windows low-memory measurements remain unverified. The known high-contrast 125% border gate also remains open.

### Required test matrix

| Area | Cases and assertions |
| --- | --- |
| Heading tree | H1–H6, skipped levels, Setext, duplicates, empty section, EOF, preamble, embedded heading in quote/item/cell, mixed content; exact end before next peer/higher heading |
| Lists | Bullet/ordered/task, arbitrary ordered starts, tight/loose items, mixed nesting, long wrapped text, multiple item paragraphs and intervening child containers; selected subtree excludes next sibling |
| Quotes/alerts | Nested quotes, lazy continuation, alert type, lists/code/tables inside, heading boundary confined to parent |
| Tables | Cell text versus cell rectangle, whole table, row/column, header, merged HTML, irregular grid, oversized rectangle and exhausted session budget |
| Atoms/opaque nodes | Inline image alongside prose, image-only paragraph, inline/block math, Mermaid, divider, frontmatter, literal HTML, empty/unmapped node; honest scope and source fidelity |
| Existing selection | Forward/reverse character drags and Shift+keyboard within/across every supported structure, before/after scope selection and cancel; no pointer capture on text |
| LLM/report | Exact source delimiters/nesting, immutable hashes, target versus context, omission/completeness, dangerous-looking document text as data, duplicate labels, v1/v2 byte immutability, v3 golden parse/serialize/reopen |
| Robustness | Forged target ID, stale revision, unknown version, invalid path/range, missing anchors, CRLF, Unicode/emoji, deeply nested and oversized content; no approximate acceptance |
| Performance | 3,000+ words, 10,000+ lines, 500 comments, deep nesting, repeated target changes and disposal; indexed work counts plus reference-hardware latency/heap |

Extend `feedbackBlockAction.test.ts`, `feedbackSelectionMapping.test.ts`, `feedbackTargetPresentation.test.ts`, `feedbackReviewLifecycle.realEditor.test.ts`, host protocol/evidence/report tests and golden fixtures. Extend `scripts/feedback-annotation-fixture/selection.ts` with real Chromium mouse input and `scripts/feedback-performance-fixture/` with index work/memory cases.

Run full Jest, lint, TypeScript, release build/package verification and relevant Electron/Extension Host suites. Perform computer-use acceptance on the secondary MacBook Retina display with the installed VSIX, including long nested lists and accurate composer/report endpoints. Read a 3,000+ word document for at least ten minutes across light/dark checks as required by the repo. Validate on minimum-supported and current stable VS Code, Windows and macOS where available; record missing hardware as a limitation, not a pass.

The existing high-contrast 125% border gate remains a separate known release issue. The prior selection fix also still needs its final packaged desktop retest. Neither is silently waived by this plan.

## 7. Implementation Log

### 2026-09-10: Original planning

Reviewed source resolver, registered node types, v2 strict contracts, evidence budgets, source lookup and existing QA findings. Two independent read-only planning reviews covered container semantics and host/report authority. No product implementation or new protocol files were changed.

The recommended interaction is immediate whole-section selection plus Change scope, with one coherent target per comment. This avoids a mandatory menu and an expensive, complicated document-wide selection tree. User priorities include exact partial selection, LLM reportability and practical performance on 8–16 GB machines.

### 2026-09-10: Implementation and verification

Implemented on `feature/semantic-feedback-selection`, based on `2a75861`. No commit or push performed. Followed failing-test-first iterations for section resolution, preview reset/focus, nested index, table choices, command parsing and NodeView control-text rejection.

New modules: `feedbackSectionIndex.ts`, `feedbackStructureIndex.ts`, `feedbackTableScopes.ts` and host `feedbackSourceFormatIndex.ts`. Updated the existing controller, presentation, command protocol, CSS and documentation. No dependencies or report schemas changed.

Validation includes the full Jest suite, lint, TypeScript and release package; the real Chromium annotation fixture exercises the parent-item rail with native mouse input and all eight forward/reverse drag cases. The existing deterministic performance fixture passes; new coverage builds 10,000 structural blocks once and verifies repeated scope queries do not call root or child walkers. This is not a physical Windows latency or heap measurement.

The visual matrix retains the known high-contrast 125% border failure. CUA reported that the Mac is locked and automatic unlock could not unlock it. Therefore packaged desktop acceptance and the required ten-minute reading gate are blocked, not passed. V3 authored-source subtree semantics remain future scope as explained above.

### Final verification snapshot

- Jest: **2,667 passed**, 27 skipped and 120 pre-existing todos; 145 passing suites, one skipped suite.
- Lint, TypeScript, release build and package verification: passed.
- Deterministic performance evaluator: passed; all seven verifier tests passed.
- Chromium: all eight native forward/reverse selections passed; parent-item rail selection, real-controller lifecycle and stress gates passed. Visual matrix: **13/14 passed**. The existing high-contrast 125% border check remains the sole failing scenario.
- Final desktop CUA retry: blocked because the Mac is locked. No secondary-display/manual reading pass is claimed.
- Review VSIX: `markdown-for-humans-0.3.0-semantic-selection.vsix`, 72 packaged files, approximately 3 MB. Successfully installed into the isolated `/tmp/md4h-selection-qa-20260910` profile; a running window still needs reload and acceptance testing after unlock.
- VSIX SHA-256: `f1813da4349830998a052c8d2b0ea3ff7dadceff4759fa141f7c6b34590d439a`.
- Final logs: `/tmp/semantic-final-tests.log`, `/tmp/semantic-final-lint.log`, `/tmp/semantic-final-types.log`, `/tmp/semantic-final-build.log`, `/tmp/semantic-final-electron.log`, `/tmp/semantic-perf.log`.
- No commit or push. Physical Windows i5/i7 low-memory coverage and v3 semantic-source provenance remain unverified/unimplemented respectively.

### 2026-09-10: Reported rail disappearance

Used a byte-exact disposable copy of the user-supplied external AGENTS.md, treating its contents as test data and leaving the original read-only. Its final heading, table and three paragraphs all parse and resolve correctly. The first probe tested standard ProseMirror decorations and did not exercise the failing composer lifecycle.

Confirmed QA-RAIL-001: the action's viewport clamp was not refreshed during scroll, and repeated hover within the same table reused the old position. Added a passive capture scroll listener and a single animation frame that only repositions the current action. Ending Feedback cancels the pending frame. Native text selection and document indexes are unchanged.

The new real-wheel regression fails before the fix (button top -512 px after scrolling 700 px inside a table) and passes afterwards (top 64 px, below toolbar bottom 60 px). All seven scroll/hover observations, eight existing native drag cases, parent-item scope, real-controller lifecycle and stress checks pass. The original high-contrast 125% matrix issue remains unchanged.

Further testing isolated QA-RAIL-002, the exact section-wide cutoff: opening section feedback applies pending highlighting, and ProseMirror reconciles it by replacing the selected DOM elements without changing the frozen document. After Cancel, cached detached elements prevent every block in that section from resolving. The cache now rejects detached entries, recovers replacements through frozen positions and exact canonical `nodeDOM` identity, and refuses a changed document or editor root. Normal cached hover does no position lookup or additional document scan. Injected widgets cannot borrow a neighboring block's identity.

On the Retina display, the final installed package preserves the table action through scrolling and opens the correct whole-table composer. The reported heading opens a section covering source lines 74–99. After opening and cancelling that section composer, the heading, table and all three following paragraphs still expose their actions in light mode. The original file retains SHA-256 `05137375cb0b187dabf40de6ab0fe41f66c0a0e05d6596a1b8b183c69daf2ff4`.

Final review build: `markdown-for-humans-0.3.0-rail-fix.vsix`, SHA-256 `113530842a16b94a8dc364f3d617afe5858e7f268d7a9a5f87021ca66223f687`. Installed and reloaded in the isolated QA profile. New native acceptance: 11 section-recovery checks and seven scroll checks pass. Baseline/fixed evidence: `/tmp/md4h-native-recovery-red/result.json`, `/tmp/md4h-native-recovery-green/result.json`. The new real-editor Jest case repeats cancellation twice while preserving document identity. See the dedicated rail QA and stability reports for final test status. The earlier scrolling-only package is retained as a reproduction baseline, not the recommended build.

Final verification: **2,673 Jest tests passed**, 27 skipped, 120 pre-existing todos, 145 passing suites and one skipped suite. Lint, TypeScript, release build/package verification and diff whitespace checks passed. The full native Chromium run passes both new regression groups, all eight forward/reverse drag checks, semantic parent-item scope, real-controller lifecycle and the 10,000-line/500-comment stress scenario. Visual matrix remains **13/14** with the same pre-existing high-contrast 125% border failure. Evidence: `/tmp/md4h-rail-final-confirmation.log` and `/tmp/md4h-rail-final-chromium.json`.

Reading acceptance: opened an unchanged disposable copy of `docs/ARCHITECTURE.md` (4,271 words) in the final packaged rich editor on the secondary Retina display. Conservatively measured 15:08–15:22 IST, September 10, with light and dark themes, paragraphs, headings, nested lists, code and long tables. Opening/cancelling the Feature Modules section and targeting its descendant paragraph also passed. No new reading obstruction was observed. Both the reading copy and the user's source retained their original SHA-256. This completes the local long-reading check, not the missing physical Windows qualification. Final stabilization details are in `.concret.io/findings/2026-09-10/stability-report-feedback-rail-visibility-qa-stabilize-152209.md`.

## 8. Decisions & Tradeoffs

- **Semantic selection complements native selection.** It never owns a text drag.
- **Simple first interaction, explicit scope adjustment.** Parent selection is useful without requiring users to learn the entire document tree.
- **One target per comment.** Nested descendants belong to that target; unrelated branches do not. Multiple comments preserve clear LLM attribution.
- **Use the proven reporting contract.** Heading sections use v2 source spans; supported nested text scopes use exact v2 rendered ranges. Authored-source subtree proof and persisted semantic provenance need a future versioned contract.
- **Keep source and rendering distinct.** Host-proven source bounds are authority; the document supplies the visual preview. Do not create a second renderer in the composer.
- **Limit complexity by failing closed.** Unsupported nested structures get an explicit parent/native-text alternative instead of an invented exact source region.
- **Estimate after the mapping spike.** The heading UI is the smaller change. Exact nested source mapping and format compatibility dominate the broader effort; the earlier informal timing estimate is not a delivery commitment for this expanded scope.

## 9. Follow-up & Open Implementation Questions

The plan uses the recommended product defaults above; no further user answer is needed to review it. Before implementing future v3 authored-source scopes, resolve through a separate bounded technical spike:

1. Which supported raw-source constructs provide exact nested extents using current parser adapters, and which must remain parent-only?
2. What compact host-minted locator, metadata budget and index-memory ceiling fit the worst supported nesting without weakening validation?
3. Which actual i5/8 GB and i7/16 GB devices are available for measurement? Record any coverage gap before release.

Potential later work: grouped comments referencing separate existing feedback IDs, nonadjacent targets with an explicit multi-target contract, and an optional document tree navigator if actual usage justifies it. These are not prerequisites for selecting all descendants of one section or container.
