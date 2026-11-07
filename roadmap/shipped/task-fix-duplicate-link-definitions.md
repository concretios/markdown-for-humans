# Task: Keep repeated link reference definitions on save

## 1. Task Metadata

- **Task name:** Keep repeated link reference definitions on save
- **Slug:** fix-duplicate-link-definitions
- **Status:** shipped in 0.4.4 (2026-10-12)
- **Created:** 2026-10-11
- **Last updated:** 2026-10-11
- **Shipped:** 2026-10-12 (0.4.4)

---

## 2. Context & Problem

**Current state:**
- Since 0.4.2 each link reference definition (`[label]: https://...`) is kept as a marker block, so saving no longer deletes it (pitfall 17).
- That marker is made from marked's `def` token.

**Pain points:**
- **Silent deletion:** marked emits no token for a definition whose label is already defined. `[a]: one` followed by `[a]: two`, or `[docs]` followed by `[DOCS]`, left the second line with no marker. The first edit anywhere in the document wrote the file without it.
- **Feedback refused the file:** after the anchor fix (`task-fix-feedback-link-definitions.md`) the unclaimed line made the anchor map fail closed.

**Why it matters:**
- The editor must not delete text the user did not touch. A repeated definition is usually a mistake in the document, but removing it is the author's call.
- Found by the source fidelity audit (`fidelity-audit-2026-10.md`, class A).

---

## 3. Desired Outcome & Scope

**Success criteria:**
- A document with repeated definitions saves byte for byte the same lines, with or without an edit elsewhere.
- Reference links still go to the first definition, as CommonMark specifies.
- Feedback starts on such a document and anchors each definition to its own line.

**In scope:**
- Top-level definitions.

**Out of scope:**
- Definitions inside a list item or blockquote. They get no marker at all today, repeated or not, and are lost when that container is edited (audit class B).

---

## 4. UX & Behavior

- Every definition line shows as its own muted marker line, including a repeated one.
- No new UI text.

---

## 5. Technical Plan

**Surfaces:**
- Webview only: `src/webview/utils/markedLexerNormalizer.ts`.

**Key changes:**
- `keepRepeatedDefinitions` wraps the lexer's `tokenizer.def` once per tokenizer. When the label is already in the lexer's link table, the token's `tag` gets a suffix no reference can use. Marked then registers it under that unused tag and emits the token.
- `NormalizingLexer.lex` calls it before lexing. The existing `toHtmlCommentToken` turns the token into a marker block.

**Architecture notes:**

```
marked lexer, definition branch
    label new      -> register link, push token            (unchanged)
    label known    -> consume the line, push nothing       (before)
    label known    -> tag made unique -> push token        (after)
```

- The first definition stays in the link table under the real label, so link targets do not change.
- A definition directly after a paragraph line is still part of that paragraph (CommonMark), handled by marked before the label check.

**Performance considerations:**
- One extra property read per definition line.

---

## 6. Work Breakdown

- [x] Failing tests first: 12 cases in `linkDefinitionPreservation.realEditor.test.ts`, 1 in `feedbackSnapshotRoundTrip.realEditor.test.ts`
- [x] Fix
- [x] Audit rerun: `duplicate link definitions` and `case-different link definitions` moved from lost to clean; no other shape changed
- [x] Full Jest, lint, Extension Host suite
- [ ] Hands-on check in a real VS Code window (not done)

---

## 7. Implementation Log

### 2026-10-11 - Reproduced and fixed

- **Reproduced:** `[a]: one` + `[a]: two` loaded as one marker; saving after a heading edit dropped the second line and the blank line after it.
- **Root cause:** marked's block lexer pushes a `def` token only when `tokens.links[tag]` is empty.
- **Files:** `src/webview/utils/markedLexerNormalizer.ts`, the two test files, `CHANGELOG.md`.

---

## 8. Decisions & Tradeoffs

- **Wrap the tokenizer, not rebuild the token stream.** The alternative was to find text missing between tokens after lexing. That is more general but depends on every tokenizer conserving its raw text, which TipTap's custom tokenizers are not guaranteed to do.
- **A unique tag instead of a new token type.** It needs no change in marked's lexer, and the existing marker path handles the token as it is.

---

## 9. Follow-up & Future Work

- Definitions inside lists and blockquotes (see Out of scope).
- The generic passthrough in `fidelity-audit-2026-10.md` section 6, item 4, would cover any other source marked consumes without a token.
