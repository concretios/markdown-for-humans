# Task Plan: Scope-First Feedback Evidence v2

## 1. Task Metadata

- **Task name:** Scope-first Feedback evidence v2
- **Slug:** feedback-selection-evidence-v2
- **Status:** implementation complete; pending user review
- **Created:** 2026-08-31
- **Last updated:** 2026-08-31
- **Pipeline:** `roadmap/pipeline/task-feedback-selection-evidence-v2.md`
- **Shipped:** _(pending)_

---

## 2. Context and Problem

The current `md4h-feedback/v1` item model overloads one `Focus` string with several meanings:

- exact selected rendered text;
- row-major semantic table-cell text;
- whole-block semantic context;
- an opaque or unmappable fallback;
- a degraded former exact selection.

Whole-block table feedback exposes the failure clearly. ProseMirror's generic `textBetween(..., '\n', '\n')` traversal uses the same separator for table cells and rows. A five-row by three-column table becomes fifteen newline-separated values before the host stores it. The source path, saved-byte SHA-256, and source lines remain authoritative, but the item loses visible table structure.

This is not only a table formatting defect. Generic whole-block text also loses heading syntax, links, list markers and nesting, quote or alert markers, code fences, Mermaid and math wrappers, image syntax, and raw HTML details. A table-specific TSV patch would leave the underlying contract ambiguous.

Two independent council reviewers and three repository-local audits converged on one governing rule:

> Persist evidence according to the selected scope. Complete source-addressable
> blocks use frozen source when exact mapping and embedding budgets permit it;
> otherwise record an explicit omission or degradation. Partial selections use
> the smallest honest rendered or structured evidence. Visual sub-regions use
> screenshots.

This plan supersedes the no-source-duplication and generic whole-block Focus rules in `roadmap/pipeline/task-rich-view-feedback.md` section 15.3 for new v2 writes only. It does not rewrite, reinterpret, or invalidate existing sealed v1 bundles.

---

## 3. Desired Outcome and Scope

### Success criteria

- New Feedback rounds have a strict, versioned target and evidence contract.
- A full GFM or parity-proven HTML table retains its authored source, when it
  fits the source-evidence budget, rather than flattened cell text or TSV.
- A rectangular cell selection retains a typed matrix and exact cell locator. Escaped TSV is only its human-readable projection.
- Partial prose and code retain exact rendered text plus a valid rendered-range locator. They are never presented as exact Markdown.
- Full code, Mermaid, math, image, list, quote, alert, frontmatter,
  horizontal-rule, and mapped opaque blocks retain frozen source evidence when
  exact mapping and source-evidence budgets permit it. Otherwise the report
  records an explicit omission or degradation.
- Visual sub-regions of Mermaid, rendered math, and images use flattened screenshot evidence.
- Degradation preserves requested scope, effective scope, reason, and original evidence. It never silently broadens a partial selection.
- The composer stays renderer-light. The highlighted document remains the canonical rich preview.
- Sealed v1 bundles remain byte-immutable and readable.
- New dependencies are not introduced.

### In scope

- `md4h-feedback/v2` report grammar and strict parser.
- A discriminated target/evidence envelope.
- Host-derived frozen-source evidence.
- Typed table-cell matrices and deterministic escaped TSV projection.
- Requested versus effective scope and closed degradation reasons.
- v1 read compatibility and atomic draft migration.
- Golden report fixtures, protocol tests, storage tests, provider tests, renderer tests, and performance limits.
- Target-aware plain or literal composer summaries without a second rich renderer.

### Out of scope

- Raw Markdown character offsets for arbitrary rendered selections.
- Synthesized partial Markdown fragments.
- Fuzzy matching or nearest-target recovery.
- A Markdown, Mermaid, KaTeX, syntax-highlighting, image, or table renderer inside the composer.
- Invented grids for merged or irregular tables.
- Rewriting sealed v1 reports.
- General raw-HTML support beyond constructs whose source and rendered block parity are already proven.
- New dependencies or unrelated library upgrades.

---

## 4. Locked Product Semantics

### 4.1 Governing rule

Representation is selected by evidence grain first, then by block kind:

1. **Complete source-addressable grain:** persist frozen source evidence when
   exact mapping and embedding budgets permit it; otherwise persist an explicit
   omission or degradation.
2. **Partial rendered-text grain:** persist exact rendered text plus a rendered locator.
3. **Partial structured grain:** persist typed semantic structure plus a structural locator.
4. **Visual grain:** persist a flattened image plus containing source reference.
5. **Coarsened grain:** persist requested and effective scope, the reason, original evidence when available, and honest containing-block evidence.

Selection origin disambiguates intent. A native drag remains a rendered-text
selection even when its offsets happen to cover an entire rendered block.
Only explicit structural actions, including the hover block action and keyboard
block-range selection, request complete authored-source blocks. This preserves
the existing text-selection bubble semantics while making block mode precise.

### 4.2 Selection matrix

| User selection | Authoritative mapping | Durable evidence | Composer presentation |
| --- | --- | --- | --- |
| Whole prose or heading | Source SHA and complete source lines | Frozen source | Block kind and bounded literal source only when useful |
| Partial prose, formatting, or link text | Source lines plus `renderedRange` | Exact rendered text | `Selected text` and bounded quote |
| Whole code block | Complete source lines | Frozen source including fence, language spelling, and whitespace | Language and line count, no second highlighter |
| Partial code | Source lines plus `renderedRange` | Whitespace-preserving rendered text plus language hint | Literal `<pre><code>` excerpt |
| Whole GFM table | Complete source lines | Original pipe-table source | `Whole table`, rows by columns, no duplicate rendered table |
| Whole parity-proven HTML, merged, or irregular table | Complete source lines | Original HTML or authored source when exact mapping and budgets permit; otherwise explicit omission or degradation | Whole-table descriptor and honest fallback explanation |
| Rectangular regular cells | Source lines plus `cellTarget` | Typed cell matrix with role and text | Existing bounded mini-grid |
| Text inside one table cell | Source lines plus `renderedRange` | Exact rendered text | Selected text, never a one-cell Markdown table |
| Whole Mermaid block | Complete source lines | Original fenced Mermaid source | Mermaid descriptor, no Mermaid renderer |
| Visual Mermaid sub-region | Containing source lines plus screenshot asset | Flattened PNG and source reference | Area Capture preview |
| Whole block math | Complete source lines | Original math source | Math descriptor, no KaTeX renderer |
| Rendered math sub-region | Containing source lines plus screenshot asset | Flattened PNG and source reference | Area Capture preview |
| Whole image or image paragraph | Complete source lines | Original image Markdown | Image descriptor |
| Visual image sub-region | Containing source lines plus screenshot asset | Flattened PNG and source reference | Area Capture preview |
| Whole nested list, quote, or alert | Complete top-level source lines | Original source including nesting and markers | Block-kind descriptor |
| Exact partial text inside nested content | Source lines plus `renderedRange` | Exact rendered text | Selected-text preview |
| Structural multi-block range | Contiguous complete source lines | Frozen source span | Block count and endpoint kinds |
| Exact text crossing blocks | Source lines plus cross-block `renderedRange` | Exact rendered text | Endpoint summary and bounded quote |
| Horizontal rule, frontmatter, mapped opaque block | Complete source lines | Frozen source | Type descriptor |
| Unmapped empty or unsupported block | No proven target | No item, or screenshot if visual evidence is possible | Visible fail-closed explanation |

### 4.3 Table rule

- Whole tables never use TSV as canonical evidence.
- Regular rectangular cell selections never use synthesized GFM tables.
- Typed cell matrices retain every cell separately with:
  - header or data role;
  - exact bounded cell text;
  - per-cell completeness;
  - row and column position from the validated rectangle.
- The report derives escaped TSV from the matrix for people and LLMs.
- Escape backslash first, then tab, carriage return, and line feed as `\\`, `\t`, `\r`, and `\n` inside a cell. Structural row and column separators remain real newlines and tabs.
- Never decode a legacy v1 TSV Focus string back into a matrix.
- Merged and irregular tables retain original source when exact mapping and
  budgets permit it, plus a degradation reason when a cell request coarsens.
  Otherwise they receive an explicit omission or fail closed. They never receive
  a fake rectangular grid.

### 4.4 Composer rule

- The highlighted rich document remains the canonical visual preview.
- The composer shows target type, scope, dimensions or line count, and a bounded plain or literal excerpt where useful.
- Whole tables show dimensions and no duplicate rich table.
- Selected cells keep the existing bounded semantic mini-grid.
- Whole code, Mermaid, math, and images use descriptors rather than another renderer.
- A visible explanation directs opaque visual sub-selections to Area Capture.
- No persisted evidence is executed or inserted with `innerHTML`; UI text remains `textContent`-based.

---

## 5. Versioned Contract

### 5.1 Target envelope

Conceptual contract:

```ts
type FeedbackScopeV2 =
  | 'rendered-text'
  | 'table-cells'
  | 'blocks'
  | 'visual-region';

type FeedbackResolutionV2 = 'exact' | 'degraded';

type FeedbackBlockKindV2 =
  | 'paragraph'
  | 'heading'
  | 'code'
  | 'table'
  | 'mermaid'
  | 'math'
  | 'image'
  | 'list'
  | 'blockquote'
  | 'alert'
  | 'horizontal-rule'
  | 'frontmatter'
  | 'html'
  | 'other';

interface FeedbackResolvedTargetBaseV2 {
  version: 2;
  requestedScope: FeedbackScopeV2;
  effectiveScope: FeedbackScopeV2;
  blockSpan: {
    startOrdinal: number;
    endOrdinal: number;
    startKind: FeedbackBlockKindV2;
    endKind: FeedbackBlockKindV2;
    startBlockSha256: string;
    endBlockSha256: string;
  };
  locator?:
    | { kind: 'rendered-range'; value: FeedbackRenderedRangeV1 }
    | { kind: 'table-cells'; value: FeedbackCellTargetV1 };
}

type FeedbackResolvedTargetV2 = FeedbackResolvedTargetBaseV2 &
  (
    | { resolution: 'exact'; coarsening?: never }
    | {
        resolution: 'degraded';
        coarsening: {
          reason: FeedbackCoarsenedReasonV2;
          origin: 'renderer' | 'host';
        };
      }
  );

interface FeedbackLegacyUnknownTargetV2 {
  version: 2;
  effectiveScope: 'blocks';
  resolution: 'legacy-unknown';
  legacyOrigin: 'v1-no-locator';
  blockSpan: FeedbackResolvedTargetV2['blockSpan'];
}

type FeedbackTargetContextV2 = FeedbackResolvedTargetV2 | FeedbackLegacyUnknownTargetV2;
```

Rules:

- New v2 items always carry requested and effective scope.
- `legacy-unknown` is a tagged migration-only target and is never emitted for a
  new selection. It omits `requestedScope` because v1 did not record enough
  information to recover the user's intent honestly. Its effective scope is the
  validated containing block span.
- Target resolution describes anchor validity only. An exact cell rectangle is
  an exact target even though its evidence fidelity is semantic structure.
- Exact rendered text requires a validated `renderedRange` locator.
- Exact table cells require a validated `cellTarget` locator.
- A block target carries no partial locator.
- `startBlockSha256`, `endBlockSha256`, and `tableBlockSha256` bind the canonical
  TipTap block Markdown enumerated at Feedback start. They are deliberately
  distinct from `sourceSliceSha256`, which binds the normalized authored-source
  line projection. HTML-origin blocks can and often do have different values.
- At most one locator is permitted.
- When requested and effective scope differ, `resolution` must be `degraded` and
  one closed coarsening record is required.
- Renderer reasons are bounded provenance, not trusted authority. The host
  validates their closed value, scope compatibility, locator state, and frozen
  block span, then records `origin: renderer`. Host budget or seal failures use
  `origin: host`. An incompatible renderer reason rejects the add request.

Closed degradation reasons initially cover:

- `opaque-node`
- `unmappable-range`
- `merged-cells`
- `irregular-table`
- `item-cell-limit`
- `session-cell-budget`
- `stale-locator`
- `unsupported-block`

### 5.2 Evidence union

```ts
type FeedbackEvidenceV2 =
  | FeedbackSourceEvidenceV2
  | FeedbackRenderedTextEvidenceV2
  | FeedbackTableCellsEvidenceV2
  | FeedbackSemanticTextEvidenceV2
  | FeedbackLegacyFocusEvidenceV2
  | FeedbackVisualEvidenceV2;
```

Source evidence is host-owned:

```ts
type FeedbackSourceEvidenceBaseV2 = {
  kind: 'source';
  relationship: 'selected-blocks' | 'containing-blocks';
  format: 'markdown' | 'html' | 'text';
  normalization: 'lf';
  sourceSliceSha256: string;
};

type FeedbackSourceEvidenceV2 = FeedbackSourceEvidenceBaseV2 & (
  | {
      fidelity: 'source-exact';
      availability: 'embedded';
      text: string;
      utf8Bytes: number;
    }
  | {
      fidelity: 'source-reference';
      availability: 'omitted';
      omittedReason: 'evidence-budget' | 'unsafe-control';
      omittedUtf8Bytes: number;
    }
);
```

- `source_sha256` in frontmatter remains the exact saved-byte authority, including
  an optional UTF-8 BOM and original line endings.
- The evidence slice is a deterministic logical-line projection: decode the
  validated UTF-8 source, remove only a leading BOM from line content, take the
  inclusive start and end lines, exclude the line terminator after the final
  selected line, and normalize internal CRLF or CR terminators to LF.
- `sourceSliceSha256`, `utf8Bytes`, and `omittedUtf8Bytes` bind that normalized
  projection. They do not claim to be a second raw-file hash.
- A final source newline is excluded unless it occurs inside the selected span.
- Embedded report text uses the same normalized projection, so its hash and byte
  count can be recomputed directly from the report.
- A complete source excerpt is all-or-none. A prefix is never labelled exact source.
- The webview never sends source evidence.

Rendered-text evidence has `fidelity: rendered-exact`, requires a valid rendered
locator, contains exact visible text, an optional validated code-language token,
and requires `complete: true`. Evidence that does not fit is omitted or the
target is coarsened; it is never silently truncated while still labelled exact.

Table-cell evidence contains bounded rows of cell objects:

```ts
interface FeedbackTableCellEvidenceV2 {
  role: 'header' | 'data';
  text: string;
  complete: boolean;
}
```

The matrix has `fidelity: structured-semantic`. It is canonical semantic
evidence, while its locator remains exact. TSV is derived and never reparsed as
authority.

`semantic-text` is bounded, unanchored renderer fallback context and always
records `fidelity: semantic-context` plus `provenance: renderer-fallback`.
`legacy-focus` is migration-only secondary evidence with
`fidelity: legacy-unclassified`. Neither may claim exact rendered text.

Visual evidence retains the existing flattened PNG path, asset SHA-256, dimensions, and containing source reference.

The Markdown report stores content-free evidence descriptors separately from
evidence bodies. A descriptor contains only closed enums, counts, byte lengths,
dimensions, paths, and hashes. Source text, rendered text, cell text, and any
other user-controlled content never appears inside an HTML comment.

### 5.3 Degraded targets

- Preserve `requestedScope` and original selected evidence when it remains safe and bounded.
- Change only `effectiveScope`, `resolution`, and `coarsening`.
- Add exact containing-block source evidence when it fits completely.
- Remove an invalid locator, but never leave the item claiming exact partial scope.
- The report visibly states the requested and effective scopes when they differ.
- No degradation path searches Focus, clamps offsets, guesses a cell grid, or invents source syntax.

---

## 6. Report Grammar v2

### 6.1 Frontmatter

- New rounds write `schema: md4h-feedback/v2`.
- Add `guide_version: 2` so agent-guide wording is not part of schema detection.
- Preserve source path, source base, exact saved-byte SHA-256, line numbering, state, round, timestamps, and monotonic `next_id`.

### 6.2 Text items

Every v2 item has one canonical machine target comment, one content-free evidence
descriptor comment, and writer-derived visible summaries:

````markdown
## F1 · text

**Source lines:** 45-50

<!-- md4h-target-v2:{...canonical target JSON...} -->

<!-- md4h-evidence-v2:{...canonical content-free descriptor JSON...} -->

**Target:** Whole table · exact · block 3

**Fidelity:** Frozen source

### Selected source

```markdown
| Situation | Assistant action | Human involvement |
|---|---|---|
...
```

### Feedback

```markdown
Clarify the decision rules.
```
````

Evidence headings are type-specific:

- `### Selected source`
- `### Selected content`
- `### Cell matrix`, followed by `### Selected cells (escaped TSV)`
- `### Evidence`
- `### Effective source` for degraded or legacy-unknown source evidence
- `### Original selection` for a degraded item when retained

For typed table-cell evidence, the report stores the canonical matrix in an
adaptive `json` fence and follows it with an escaped `tsv` projection for people
and LLMs. The JSON matrix is authoritative because it retains cell roles,
completeness, boundaries, and literal tabs or line breaks without ambiguity. TSV
is derived, never parsed back into authority, and never used for a whole table.

For source and rendered-text evidence, the descriptor comment carries only its
kind, fidelity, relationship, format, availability, completeness, validated
language token, sizes, and hashes. The actual text appears only in its adaptive
evidence fence. Over-budget source emits an omitted descriptor and no source
prefix.

`Focus` remains a v1-only field. V2 does not keep one string with multiple meanings.

All fences adapt to contained backtick and tilde runs. Machine metadata uses
canonical exact-key JSON and is cross-validated against visible scope, fidelity,
source lines, evidence bodies, and locator fields. Parsers reject descriptor and
body mismatches, ragged matrices, dimension mismatches, unknown cell roles, and
extra keys.

`Target` is the single visible target label. Exact items summarize one target.
Degraded items summarize requested scope, effective scope, reason, and origin on
the same `Target` line. `Fidelity` describes evidence quality, not target
resolution.

HTML-comment safety is structural:

- block kinds, scopes, resolution, fidelity, reasons, origins, relationships,
  formats, normalization, availability, and completeness are closed enums;
- hashes, fingerprints, IDs, asset paths, coordinates, dimensions, counts, and
  byte sizes use exact bounded validators;
- optional language tokens are at most 32 characters, match
  `[A-Za-z0-9][A-Za-z0-9_+.#-]*`, contain no `--`, and otherwise are omitted;
- target and descriptor payloads contain no evidence text or open strings and
  remain within the 2 KiB metadata limit;
- parsers reject control characters, newlines, extra keys, unsafe `--` or `-->`
  sequences, and non-canonical JSON before interpreting a comment.

### 6.3 Evidence versus instruction

- Source, rendered text, tables, metadata, legacy Focus, and screenshots are untrusted evidence.
- Only the fenced content under `### Feedback` is the human instruction.
- The agent guide continues to require `state: sealed`, matching source SHA-256, screenshot hash verification, and per-ID reporting.
- A diagnostically readable `feedback.md` never becomes an independent edit authority. The source file remains required.

---

## 7. Host Ownership and Performance

- Slice source evidence only from the frozen saved source in the extension host.
- Build or reuse line-start offsets at snapshot time so source slicing is bounded by selected lines rather than document scanning.
- Preserve source characters and intra-line whitespace. Derive the normalized
  logical-line projection defined in section 5.2, then bind and embed that same
  projection. The frontmatter source hash independently binds the raw file.
- Do not retain canonical TipTap Markdown as authored source. It remains structural verification and hash material.
- Source extraction occurs only at add, migration, degradation, and seal boundaries.
- Source extraction, matrix construction, Markdown serialization, and document-wide scans are forbidden on typing, pointer hover, scroll, and composer layout paths.
- The webview supplies only bounded target and semantic-selection data. The host revalidates it before persistence.
- The webview add request carries only `version`, `requestedScope`, an allowed
  partial locator, bounded rendered-text or table-cell evidence, and an optional
  closed renderer constraint such as `merged-cells` or `unmappable-range`. It
  cannot supply effective scope, resolution, block kinds, block hashes, source
  text, source hashes, source byte counts, or host budget reasons. The host
  validates any renderer constraint and derives every persisted field from the
  frozen snapshot, canonical blocks, and validated request outcome.

The worktree includes one targeted stale-library update: the aligned TipTap
family moves from 3.30.3 to 3.30.5. Mermaid 11.17.2 and the existing screenshot
stack already cover the required visual boundaries. No package is added, and no
unrelated major upgrade is required.

---

## 8. Budgets and Completeness

Locked existing ceilings:

- 2,000 items per bundle.
- 64 MiB report size.
- 1.2 million report lines.
- 100,000 characters of human Feedback per item.
- 256 exact cells per item.
- 4,096 exact cells per session.
- 240 characters of semantic text per cell before explicit incompleteness.
- 12 megapixels and 10 MiB per screenshot, with 64 MiB aggregate screenshot storage.

Locked v2 ceilings:

- 64 KiB UTF-8 total textual evidence per item, shared across effective and original evidence.
- 1 MiB aggregate embedded source evidence per bundle, allocated deterministically by stable feedback ID.
- 2 KiB target-context metadata per item.

Rules:

- Measure UTF-8 bytes, not JavaScript string length.
- Complete exact-source evidence is all-or-none.
- Over-budget source records `availability: omitted`, the normalized projection
  hash, byte count, and `evidence-budget` omission reason. Evidence omission does
  not change target scope or target resolution.
- A line-bounded prefix may be introduced later only with a different fidelity such as `source-prefix`; it is not part of this phase.
- Apply budgets before copying source, walking cells, joining projections, rendering reports, or calculating annotation geometry.

---

## 9. Migration and Compatibility

- Keep sealed v1 reports byte-immutable.
- Maintain separate strict v1 and v2 readers. Never recognize a version heuristically.
- Discovery and Resume do not rewrite a v1 draft.
- Migrate a v1 draft atomically only with its first explicit mutation or seal.
- A valid v1 `renderedRange` migrates to rendered-text evidence.
- A valid v1 `cellTarget` migrates to typed cell evidence only after the frozen rich document re-derives the matrix. Never parse legacy TSV into cells.
- If matrix re-derivation is unavailable, preserve legacy Focus as explicitly labelled legacy evidence with its validated locator.
- A locator-free v1 item becomes `legacy-unknown`. Its effective evidence is the
  exact host-derived containing source when available, while its former Focus is
  retained only as labelled `legacy-focus` secondary evidence. Do not infer its
  requested scope or treat legacy Focus as structural authority.
- Invalid v1 locators migrate as degraded targets while retaining original evidence and honest containing source context.
- Migration and the triggering mutation or seal share one guarded atomic write. Any guard failure restores the exact v1 draft.
- Never downgrade v2 to v1.

---

## 10. Golden Fixtures Before Implementation

The first implementation boundary is a dedicated contract suite on new paths. It must not modify current Phase 11/12 production or tests.

Required golden cases:

1. Whole GFM table preserving header, delimiter, alignment, padding, escaped pipes, and links.
2. Whole parity-proven HTML or merged table preserving original HTML and carrying no cell matrix.
3. A rectangular cell matrix containing literal tabs, newlines, backslashes, empty cells, trailing empty cells, and mixed header/data roles.
4. Partial formatted prose and link text with rendered content but no synthesized Markdown.
5. Partial code preserving whitespace and language metadata without synthetic source fences.
6. Whole fenced code preserving its authored fence and source.
7. Structural multi-block source versus exact text crossing the same blocks.
8. Full Mermaid and an attempted visual sub-selection degraded to the containing block.
9. Screenshot evidence with containing source reference.
10. Seal-time locator degradation preserving requested scope and original evidence.
11. Valid locator-based v1 migration and locator-free `legacy-unknown` migration.
12. Oversized source omission backed by a real over-budget slice, aggregate
    report budget, malformed scope/evidence combinations, unsafe controls,
    Unicode, BOM, CRLF and CR normalization, final-line delimiter handling, and
    adaptive fences.
13. Host-enriched rendered locators, coherent block hashes, source line spans,
    canonical kinds, and cell matrices that actually match their located table.
14. Hostile metadata candidates containing `--`, `-->`, newlines, controls,
    oversized tokens, unknown enums, extra keys, and non-canonical JSON.

Every golden must describe a physically possible single-source bundle. No runtime
implementation begins until the foundational golden fixtures fail for the
intended missing-v2 reason and the existing v1 suites remain green.

---

## 11. RED, GREEN, REFACTOR, VERIFY

### Phase A: Contract RED

- Add standalone v2 source, case, and expected-report fixtures.
- Add one isolated golden contract suite using only current public production boundaries and locally declared future types.
- Add strict v2 webview and host message expectations without importing nonexistent symbols.
- Confirm current production compiles and the v2 assertions fail because scope, evidence, matrix, and grammar are absent.
- Rerun current v1 store and protocol suites and keep them green.

### Phase B: Pure schema GREEN

- Add pure v2 target/evidence types, exact-key validators, compatibility rules, byte budgets, cell-matrix validation, escaped TSV projection, and adaptive-fence helpers.
- Keep v1 types and readers untouched.
- Make malformed, competing, or partial fields fail closed.

### Phase C: Writer and reader GREEN

- Implement the strict v2 report writer and reader.
- Cross-validate machine metadata and visible summaries.
- Render source, content, cell, visual, original-selection, and omission evidence distinctly.
- Keep agent instructions independent through `guide_version`.

### Phase D: Host authority GREEN

- Derive source evidence from frozen host bytes and line spans.
- Bind exact source-slice hashes and normalized report text.
- Validate renderer target claims against canonical block kind, content size, hashes, fingerprints, and budgets.
- Preserve requested/effective scope through degradation.
- Add guarded migration and rollback.

### Phase E: Renderer integration GREEN

- Send v2 target inputs without source excerpts.
- Build typed regular-cell matrices only within existing cell budgets.
- Preserve current selection precedence, hover animation, mini-grid, dynamic composer sizing, pending geometry, and screenshot flow.
- Keep source extraction and document serialization out of interaction paths.

### Phase F: Refactor and verification

- Centralize source slicing, target compatibility, evidence budgets, TSV escaping, adaptive fences, and degradation rules.
- Update JSDoc, architecture, agent guide, roadmap, and third-party notices only if dependencies change.
- Run focused Feedback, protocol, storage, provider, selection, table, migration, layout, and real-editor suites.
- Run full Jest and coverage, repository lint, strict TypeScript, debug and production builds, build-content verification, dependency policy, both npm audits, Electron annotation and capture gates, VSIX inspection, and `git diff --check`.
- Inspect v2 sealed reports for every selection family in a real Extension Development Host.
- Complete the outstanding 3,000-word, ten-minute light/dark keyboard and pointer reading pass.

---

## 12. Risks and Mitigations

| Risk | Level | Mitigation |
| --- | --- | --- |
| V1 ambiguity | High | Migrate locator-free items as `legacy-unknown`; never infer intent |
| Silent scope broadening | High | Persist requested and effective scope plus a closed reason |
| Renderer-supplied source | High | Host derives and hashes all source evidence |
| Partial Markdown invention | High | Partial selections use rendered or structured evidence only |
| Parser compatibility | Medium-high | Separate strict v1 and v2 readers; explicit schema and guide version |
| Migration rollback | High | One guarded atomic rewrite with exact v1 restoration |
| UTF-8 and CRLF slicing | Medium | Byte and line-offset fixtures across Unicode, CRLF, BOM, and final lines |
| Merged and irregular tables | Medium | Frozen source only; never synthesize rectangular data |
| Cell projection ambiguity | Medium | Typed matrix authority and reversible escaped TSV projection |
| Report amplification | Medium | Shared per-item and aggregate byte budgets, all-or-none source embedding |
| Prompt injection through evidence | Medium | Strict fences, canonical metadata, evidence labels, instruction-only Feedback section |
| Composer complexity | Low-medium | No second renderer; bounded type-aware summaries only |
| Interaction regressions | Medium | No new typing, hover, scroll, or layout serialization work |
| Dependency drift | Low | Keep the intentional TipTap 3.30.3 to 3.30.5 patch alignment exact and exclude unrelated upgrades |

---

## 13. Research and Decision Record

- Council job: `20260831T024149Z-aa68aee9fa5a`
- Participants: Claude and Grok, independent parallel review at high effort.
- Host verdict: typed scope-first hybrid.
- Shared conclusion: full tables use frozen source, not TSV; partial cells keep structured semantic evidence; arbitrary partial Markdown is never synthesized.
- Preserved dissent: a smaller Focus-only source-slice patch would fix the immediate table but would leave locator-free provenance and complex-cell escaping unresolved.
- Repository-local audits covered block taxonomy, selection semantics, persistence and migration, and WIP boundaries.

---

## 14. Current Safe Boundary

- The scope-first Feedback evidence v2 implementation is complete across the
  shared contract, host source projection and resolution, report reader and
  writer, store migration, screenshot handling, provider integration, renderer
  capture, and report presentation.
- Existing selection behavior remains intact:
  - explicit block feedback captures authored whole-block source;
  - native drag selection captures exact rendered text, including a drag that
    happens to cover all visible code;
  - selected regular table cells capture a typed matrix with derived escaped
    TSV, while parity-proven whole tables retain original Markdown or HTML when
    exact mapping and embedding budgets permit it;
  - visual subregions use screenshot evidence tied to containing source.
- Draft v1 sessions migrate atomically on first mutation or seal. Sealed v1
  sessions remain immutable. Stale targets preserve requested and effective
  scope, reason, origin, and original evidence.
- Final automated verification is green:
  - 139 Jest suites passed and 1 remained intentionally skipped;
  - 2,533 tests passed, 27 remained intentionally skipped, and 120 existing
    todos remained;
  - the coverage run passed its configured gate;
  - lint, strict TypeScript, integration tests, release build verification,
    dependency policy, both npm audits, Electron capture and annotation gates,
    VSIX inspection, and `git diff --check` passed;
  - npm audit reported 0 production and 0 full-tree vulnerabilities.
- Final VS Code Computer Use validation sealed four evidence families from the
  golden document, verified the report and screenshot hashes, exercised hover
  preview and adaptive composer sizing, and completed a 667-second reading pass
  through a 3,368-word document across Light+ and Dark+ with no unsaved edits.
- The final VSIX contains 72 files, is 2.99 MB, and excludes source, tests,
  roadmap, council, and map artifacts.
- The targeted TipTap patch upgrade from 3.30.3 to 3.30.5 is complete. The
  installed graph is deduplicated at 3.30.5 and ProseMirror model at 1.25.11.
  No package or unrelated major upgrade was added.
- Known boundary: arbitrary raw HTML table source fidelity is not universal.
  Strict capture supports the tested stable subset, but tables with structural
  wrappers, styling, alternate attributes, or inline HTML can fail Start rather
  than silently emit inaccurate evidence. Universal HTML fidelity remains out
  of scope.
- All work remains uncommitted and unpushed for user review.

---

## 15. Implementation Log

### 2026-08-31: Council-backed contract draft

- **What:** Converted the table-storage question into a scope-first evidence architecture covering full, partial, structured, visual, degraded, and legacy targets.
- **Decision:** Whole blocks use frozen source, partial text uses rendered evidence, selected cells use a typed matrix with TSV projection, and visual sub-regions use screenshots.
- **Compatibility:** New v2 writes with strict dual-read compatibility. Sealed v1 stays immutable.
- **Dependencies:** Limit any stale-library work to an aligned TipTap patch
  update. Do not mix unrelated major upgrades into this feature.
- **Production changes:** None.

### 2026-08-31: Contract fixture boundary

- **Baseline:** Current Phase 11/12 WIP is green with 128 suites and 2,273 tests; diff check passes.
- **Fixture tranche 1:** Added isolated whole-GFM-table, selected-cell,
  partial-code, merged-table degradation, and over-budget source cases.
- **Expected RED:** The new suite compiles and reports 7 intended missing-v2
  failures with 7 fixture, real-editor, and trust-boundary checks passing.
- **Compatibility check:** The existing v1 storage and protocol suites remain
  green with 199 tests passing.
- **Static check:** The new TypeScript fixture suite passes ESLint, and the
  worktree passes `git diff --check`.
- **Next action:** Complete the remaining contract fixture families in section
  10 before touching the current production implementation.

### 2026-08-31: Independent contract consistency review

- **Corrections:** Replaced impossible synthetic bundles with source-coherent
  cases, including a real 200,012-byte generated source slice and a regular GFM
  table whose rendered cells match the typed matrix.
- **Semantics:** Separated exact target anchoring from semantic evidence
  fidelity, added tagged legacy and semantic fallback evidence, and made
  renderer-versus-host coarsening provenance explicit.
- **Hashing:** Defined `sourceSliceSha256` over one deterministic LF-normalized
  logical-line projection while retaining frontmatter `source_sha256` as the raw
  saved-byte authority.
- **Safety:** Closed comment metadata values, added canonical descriptor checks,
  and kept a literal `-->` cell value exclusively inside fenced evidence.
- **Real model check:** Verified canonical block kinds and Markdown hashes,
  actual table fingerprint, matrix contents, and oversized-code binding through
  a real TipTap editor instance.
- **Final review:** The independent recheck found no remaining high- or
  medium-severity issue in the scoped plan and fixture tranche.
- **Gate at review time:** Production remained blocked until the remaining
  section 10 fixtures were added. The next log entry records that completed gate.

### 2026-08-31: Complete contract RED and implementation gate

- **Coverage:** Added formatted-link, authored-fence, structural and rendered
  cross-block, Mermaid full and degraded, screenshot, stale-locator,
  locator-free legacy, normalization, unsafe-control, aggregate-budget,
  malformed-combination, and hostile-metadata cases.
- **Table edge cases:** Added a typed matrix containing literal tabs, line
  breaks, backslashes, empty cells, trailing empty cells, mixed roles, and a
  literal comment terminator. TSV remains a derived escaped view only.
- **Trust boundary:** V2 renderer requests omit Focus and reject every
  host-owned source, hash, effective-scope, resolution, and host-reason field.
- **Expected RED:** The isolated shared suite reports 17 intended failures and
  4 fixture/security passes. The extended golden suite fails on the missing v2
  writer, protocol, and rich Mermaid kind while its physical-coherence checks
  remain active.
- **Compatibility:** Current v1 storage and protocol suites still pass all 199
  tests. Both v2 suites pass ESLint.
- **Dependency audit:** TipTap 3.30.5, Mermaid 11.17.2, and modern-screenshot
  4.7.0 are current in the installed dependency graph. Unrelated Babel,
  ESLint, Node type, VS Code type, KaTeX, lowlight, Markdown-it, Jest, and
  TypeScript major updates are deliberately excluded from this feature.
- **Next action:** Implement the pure v2 schema, source projection, and strict
  report grammar in new modules before touching the high-collision provider and
  renderer paths.

### 2026-08-31: Production implementation

- **Contract:** Added strict v2 target and evidence unions, exact-key parsing,
  compatibility checks, aggregate budgets, Unicode-safe cell limits, adaptive
  fences, and reversible escaped-TSV projection.
- **Host authority:** Added saved-byte indexing for UTF-8, BOM, CRLF, source
  lines, hashes, canonical block kinds, table fingerprints, and bounded source
  evidence. Renderer messages cannot provide host-owned source fields.
- **Persistence:** Added deterministic v2 report writing and reading, strict
  resume validation, screenshot lifecycle operations, atomic draft-v1
  migration, and immutable sealed-v1 compatibility.
- **Resolution:** Added stale-locator degradation that preserves requested and
  effective scope, reason, origin, and original evidence without inventing
  Markdown.
- **Renderer:** Integrated whole-block, rendered-text, selected-cell, and
  visual-region capture while retaining hover preview, pending geometry,
  selection precedence, compact summaries, adaptive composer sizing, and the
  existing chat-bubble interaction.
- **Dependencies:** Updated the aligned TipTap family from 3.30.3 to 3.30.5,
  added no packages, and performed no broad or unrelated upgrades.

### 2026-08-31: Live serializer and selection corrections

- **Serializer fidelity:** The real editor exposed a literal-pipe escaping bug
  in GFM tables and loss of integer `colspan` and `rowspan` attributes. The
  serializer now preserves those values, and the golden hashes were regenerated
  from the corrected canonical document.
- **Selection semantics:** A native drag over all visible code remains
  `rendered-text`; only explicit block feedback becomes `whole-block`.
- **Routing:** An inactive split editor can no longer steal the active Feedback
  command.
- **Real-editor coverage:** Added whole-table, selected-cell, partial-Mermaid,
  and full-content-code cases against a real TipTap editor instance.

### 2026-08-31: Adversarial self-review hardening

- **Filesystem safety:** Screenshot restoration now revalidates the destination
  directory chain immediately before writing, closing a symlink-swap escape.
- **Seal integrity:** V2 sealing accepts unchanged targets or one narrow trusted
  stale-locator transition. It rejects unrelated evidence substitution while
  retaining the allowed source-hash refresh.
- **Lifecycle:** Duplicate Finish and Discard requests are rejected before the
  in-flight close operation can be replaced.
- **Grammar:** New exact-cell captures reject the migration-only `legacy-focus`
  evidence kind. Writer and parser share the 4,096-cell aggregate cap and the
  actual LF line-count rule.
- **Unicode:** Per-cell length is measured in Unicode code points, so 240 astral
  characters pass and 241 fail.
- **Resume trust:** Every v2 block span is checked against mapped canonical
  ordinals, normalized kinds, and SHA hashes before any locator degradation.

### 2026-08-31: Final verification and Computer Use

- **Focused checks:** Eight focused suites passed all 307 tests.
- **Full checks:** The final Jest and coverage runs passed 139 suites and 2,533
  tests, with 1 suite and 27 tests intentionally skipped and 120 existing todos.
- **Build and policy:** Lint, strict TypeScript, release build verification,
  VS Code 1.135.0 integration tests, package-boundary tests, exact dependency
  graph checks, both npm audits, Electron capture and annotation gates, and
  `git diff --check` passed.
- **Package:** The inspected final VSIX contains 72 files, is 2.99 MB, and has
  no development-only artifacts.
- **Extension host:** Sealed one whole table, one 2x2 cell matrix, one partial
  code selection, and one Mermaid screenshot. The report source hash and asset
  hash matched independently computed values. Hover preview, compact and
  expanded summaries, dynamic composer sizing, and handoff copy were exercised.
- **Reading gate:** Read a 3,368-word document for 667 seconds across Light+ and
  Dark+, then restored Light+. The editor remained clean with no unsaved edits.
- **Handoff:** The plan stays in `roadmap/pipeline/` with status pending user
  review. Nothing was committed or pushed.

### 2026-09-01: Whole-block saved-card preview correction

- **Presentation:** V2 reports continue to persist exact Markdown source for
  whole blocks. Reopened human-facing cards now derive their bounded quote from
  the frozen ProseMirror block instead of reusing that source evidence, so rich
  paragraphs, headings, and formatted lists do not expose Markdown markers.
- **Coverage:** Added red-green presentation cases for formatted paragraphs,
  headings, and bullet lists, plus a card-level reopening regression test.
- **Live verification:** In an isolated Extension Development Host fixture, a
  formatted list first opened with semantic text, its draft retained exact
  source Markdown, and the reopened card again showed semantic text.
