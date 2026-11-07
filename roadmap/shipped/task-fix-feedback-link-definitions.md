# Task: Start Feedback on documents with link reference definitions

## 1. Task Metadata

- **Task name:** Start Feedback on documents with link reference definitions
- **Slug:** fix-feedback-link-definitions
- **Status:** shipped in 0.4.4 (2026-10-12)
- **Created:** 2026-10-11
- **Last updated:** 2026-10-11
- **Shipped:** 2026-10-12 (0.4.4)

---

## 2. Context & Problem

**Current state:**
- "Log feedback for an LLM" freezes the document and maps each top-level block of the rich view to exact lines of the saved file (`buildFeedbackAnchorMap` in `src/editor/feedbackAnchors.ts`).
- The map pairs rich-view blocks with markdown-it's top-level blocks by position. Count, order and kind must agree.
- Since 0.4.2 the editor keeps every link reference definition (`[label]: https://...`) as a visible marker block (`htmlComment` node, kind `html`), so saving no longer deletes it (pitfall 17).

**Pain points:**
- **Feedback does not start:** markdown-it emits no block for a definition. The marker block had nothing to pair with, and the map failed with `invalid-canonical-block: Block ordinal N produced 0 top-level Markdown blocks`.
- **Common documents are affected:** any changelog in Keep a Changelog format ends in definitions. This repository's own `CHANGELOG.md` fails (ordinal 154).
- **The message does not help:** the user reads "Feedback could not match this document to the saved file" and is sent to the known issues list, which does not name definitions.

**Why it matters:**
- **Regression:** before 0.4.2 there was no marker block, so these documents worked. The data-loss fix in 0.4.2 broke Feedback for them.
- **Trust:** Feedback is the headline feature. It must work on the project's own changelog.

```
rich view (marked)            saved file (markdown-it)
------------------            ------------------------
heading        --------->     heading_open      line 1
paragraph      --------->     paragraph_open    line 3
html [docs]:   ----X          (no token)        line 5
html [site]:   ----X          (no token)        line 6
```

---

## 3. Desired Outcome & Scope

**Success criteria:**
- Feedback starts on a document with definitions at the start, between blocks and at the end, including this repository's `CHANGELOG.md`.
- Each definition marker is anchored to its own exact source lines. Never an estimated line.
- When the marker text and the source lines cannot be proven equal, Feedback refuses to start, as before.
- Every existing Feedback test stays green.

**In scope:**
- `buildFeedbackAnchorMap` and the content fingerprint in `FeedbackSnapshotService.finalize`.
- Jest unit, real-editor and service tests; one Extension Host fixture and case.

**Out of scope:**
- The "Copy Reference for AI" branch (`claude/copy-ai-reference-bee5b0`), which has its own workaround for the same gap. See section 9.
- A duplicate definition (a second `[a]: ...` for a label already defined) gets no marker block and is deleted on save. See section 9.
- Changing the failure message.

---

## 4. UX & Behavior

**Entry points:**
- "Log feedback for an LLM" (`markdownForHumans.feedback.start`).

**Behavior rules:**
- A definition marker behaves like an HTML comment marker in Feedback: it is one block, and a comment on it quotes its own source line or lines.
- A definition written over several lines is one block covering those lines.
- Whitespace at the edges of a definition line (indentation of up to three spaces, trailing spaces) does not block the match. The editor drops it from the marker, and it has no meaning in a definition.
- Feedback refuses to start (unchanged message) when, between two parsed blocks, the source holds text that the marker blocks there do not account for, in order and in full. Example: a duplicate definition the editor shows no marker for.

---

## 5. Technical Plan

**Surfaces:**
- Extension host only. No webview, protocol, UI text or dependency change.

**Key changes:**
- `src/editor/feedbackAnchors.ts`: `canonicalKindForBlock` returns `null` for an `html` block that parses to no block. `buildFeedbackAnchorMap` leaves such blocks out of the count and kind comparison, then anchors each one with `findUnparsedBlockLines` to the first non-blank lines after the previous block, and checks that nothing but blank lines remains before the next parsed block.
- `src/editor/feedbackSnapshotService.ts`: when a block renders to nothing, its fingerprint is taken from its text, so each definition has its own content proof instead of one shared empty one.
- `vibe-coding-rules/common-pitfalls.md`: pitfall 17 now says a new rich-view block needs an anchor counterpart.

**Architecture notes:**

```
canonical blocks:   H   P   [d1]  [d2]   P
kinds:              h   p   null  null   p        null = no parsed block
raw blocks:         h   p                p        count and kind compared on these only
                            |      |
                            v      v
                  lines between "P" above and "P" below:
                  skip blank lines, match d1 text, match d2 text, rest must be blank
```

- Every descriptor still gets exactly one anchor, in document order, with no overlap. That keeps the by-index pairing in `FeedbackSnapshotService.finalize`, the report builder, restored item lookup and the binary search in `findFeedbackOrdinalsForLines` valid without changes.
- Only `html` blocks can be unparsed. Any other kind that parses to no block is still rejected.

**Performance considerations:**
- The source is split into lines once, and only when a document has an unparsed block. The pass is linear in the number of blocks.

---

## 6. Work Breakdown

- [x] **Reproduce** in the Jest real-editor harness (small document and `CHANGELOG.md`)
- [x] **Reproduce** in the Extension Development Host (VS Code 1.141.0, fixture `link-definitions.md`)
- [x] **Failing tests first**
  - [x] `src/__tests__/editor/feedbackAnchors.test.ts`: 11 cases under "link reference definitions"
  - [x] `src/__tests__/webview/feedbackSnapshotRoundTrip.realEditor.test.ts`: 2 cases
  - [x] `src/__tests__/editor/feedbackSnapshotService.test.ts`: 2 cases
  - [x] `test/integration/feedbackParity.extHost.test.cjs`: 1 case
- [x] **Fix** in `feedbackAnchors.ts` and `feedbackSnapshotService.ts`
- [x] **Verify**: `npm run lint`, `npx jest`, `npm run test:integration`
- [ ] **Hands-on check in a real VS Code window**: comment on a definition and read the report (not done, see section 7)

---

## 7. Implementation Log

### 2026-10-11 - Reproduced, fixed, verified

- **Reproduced (Jest):** every layout tried failed with `Block ordinal N produced 0 top-level Markdown blocks`; `CHANGELOG.md` fails at ordinal 154. Each definition is its own marker block, also when several sit on consecutive lines.
- **Reproduced (Extension Host, VS Code 1.141.0):** `markdownForHumans.feedback.start` returned true but no draft appeared under `.md4h/feedback` within 30 s. No VS Code error or warning notification was raised; the refusal is shown inside the editor.
- **Files:** `src/editor/feedbackAnchors.ts`, `src/editor/feedbackSnapshotService.ts`, the four test files above, `test/integration/workspace/link-definitions.md`, `CHANGELOG.md`, `vibe-coding-rules/common-pitfalls.md`.
- **Results:** `npm run lint` clean. `npx jest`: 4792 passed, 0 failed (239 suites; 27 skipped and 121 todo tests were already there). `npm run test:integration` on VS Code 1.141.0: 11 passing, including the new case. 16 new tests (15 Jest, 1 Extension Host): 14 failed before the fix; 2 are guards that passed before and after.
- **Test helper:** `assertFeedbackStarts` now includes the error and warning notifications it captured in its timeout message.
- **Not verified by hand:** no click-through in a real window (placing a comment on a definition and reading the exported report). The Extension Host test proves Feedback starts and creates its draft on the fixture; the line a comment lands on is proven by the Jest tests only.

---

## 8. Decisions & Tradeoffs

- **A real line span, not exclusion.** Options were: (a) leave the marker out of the anchor map and refuse comments on it, or (b) anchor it to its exact lines. Chosen: (b).
  - The same `htmlComment` node already gets a real `html` span when it holds an HTML comment. Definitions now behave the same way.
  - One anchor per descriptor keeps every consumer valid as written. (a) would have needed changes in `finalize`, the report builder and the webview's handling of a selection in a block with no anchor.
  - The user can comment on a definition, for example a wrong URL.
- **Proof, not position alone.** The span is accepted only when the marker text equals the source lines and the whole gap between the neighboring parsed blocks is accounted for. Otherwise the map fails with `invalid-canonical-block` and Feedback does not start.
- **Edge whitespace is ignored in that comparison.** The editor trims a marker's text, so an indented definition or one with trailing spaces would otherwise keep failing on an unedited file. Whole lines are still matched in order, so this cannot select a different line.
- **No new failure reason.** `invalid-canonical-block` is reused with a new detail text, so the protocol and its validators are unchanged.

---

## 9. Follow-up & Future Work

- **Copy Reference for AI** (`claude/copy-ai-reference-bee5b0`) filters these blocks out before calling `buildFeedbackAnchorMap` and resolves them itself (`isRenderless`, `resolveMarkerBlock` in `src/editor/aiReference.ts`). It stays correct with this change. Once both are merged it can pass every block and read the span from the map. That branch also touches `feedbackSnapshotService.ts`, so expect a small merge conflict near `semanticBlockPayload`.
- **Duplicate definitions are deleted on save.** Fixed on 2026-10-11, see `task-fix-duplicate-link-definitions.md`. Original note: Marked emits no token for a second definition of a label, so there is no marker block and the line is lost on the next save (seen in the real-editor harness: `[a]: one` + `[a]: two` saves as one line). Feedback now refuses such a file instead of mis-anchoring it. The data loss is an editor bug in `markedLexerNormalizer.ts` territory, not fixed here.
- **Name the cause in the refusal message** when the mismatch is in a definitions gap.
