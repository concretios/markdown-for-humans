# Task: Fix Markdown round-trip regressions from post-merge review

## 1. Task Metadata

- **Task name:** Fix Markdown round-trip regressions
- **Slug:** fix-postmerge-01-markdown-roundtrip
- **Status:** planned
- **Created:** 2026-09-30
- **Last updated:** 2026-09-30
- **Shipped:** _(pending)_
- **Base:** `origin/main` @ `1b8244b`
- **Overview:** `task-fix-postmerge-00-overview.md`

---

## 2. Context & Problem

Saving rewrites user Markdown in ways the user did not ask for. This is the product's core promise ("write markdown naturally") and it also produces noisy Git diffs. R1 and R2 are the two highest-severity findings of the whole review.

---

## 3. Desired Outcome & Scope

**Success criteria:**
- Each repro below saves byte-identical after an unrelated edit
- A round-trip corpus test exists and runs in `npm test`
- `npm test` passes

**In scope:** R1 to R5, corpus test, guard for TipTap private-method patches
**Out of scope:** broader serializer rewrite

---

## 4. Findings

### R1. HIGH (#93): `>` becomes `&gt;` in normal text on save. Confirmed.

- **Where:** `src/webview/utils/markdownSerialization.ts:89-97` (`decodeNonTagHtmlEntities`)
- **Defect:** the "line start" check runs per ProseMirror text node, not per output line. Any text node starting with 0 to 3 spaces and `>` is treated as a blockquote position and keeps `&gt;`.
- **Repro (real TipTap 3.30.5):**
  - `Click **File** > **Save**` saves as `Click **File** &gt; **Save**`
  - `` `a` > `b` `` and `[docs](x) > more` behave the same
  - First sync serializes every block (empty cache), so the first edit anywhere rewrites every such line
- **History:** introduced by the round-3 fix T04 ("keep line-leading `>` escaped", `task-fix-pr93-round3-findings.md`). The fix must keep T04 behavior for genuine line-leading `>`.
- **Fix direction:** decide "line start" from the serialized output (previous emitted char is a newline or start of block), not from the text node boundary.
- **Test first:** real-editor tests for the three repros above, plus the existing T04 line-leading case.

### R2. HIGH (#101): resizing an image corrupts the next line. Confirmed.

- **Where:** `src/webview/extensions/customImage.ts:479` with `src/webview/extensions/markdownParagraph.ts:61`
- **Defect:** a sized image serializes as `<img ... />` alone on its line. The paragraph renderer guards against a following hard break but not a soft break (bare `\n`). CommonMark then starts an HTML block (type 7) and swallows the next line.
- **Repro:**
  - `![a](a.svg)\n**bold** text`, set Display size: saves `<img src="a.svg" alt="a" width="200" />\n**bold** text`. On reopen line 2 is literal; the next save writes `\*\*bold\*\*`.
  - `![a](a.svg)\n![b](b.svg)`, resize first: second image becomes text `!\[b\](b.svg)` (image lost).
  - Same inside list items and blockquotes. GitHub renders the saved file the same broken way.
- **Fix direction (decision needed):**
  - a) Serialize a soft break that follows an HTML-image-only line as a space (render-equivalent; changes source line layout)
  - b) Emit a blank line (changes paragraph structure; not render-equivalent)
  - c) Keep other content on the image's line so it never stands alone
- **Test first:** the three repros, asserting both saved text and reparsed document.

### R3. MED (#101): resizing a hand-written HTML `<img>` drops attributes. Confirmed.

- **Where:** `src/webview/extensions/customImage.ts:479`
- **Defect:** on any change to width, height, alt, title or src, the tag is rebuilt from those five attributes only.
- **Repro:** `<img src="a.svg" alt="A" align="right" class="hero" style="border:1px solid" loading="lazy">` saves as `<img src="a.svg" alt="A" width="200" />`. `width="50%"` is also replaced. `align="center"` is common in READMEs. PR #101 description claims attributes are preserved.
- **Fix direction:** keep the original attribute list and order; update only changed attributes in place.
- **Test first:** repro above; percent width; attribute order preserved.

### R4. MED (pre-existing, kept by #93): escaped Markdown literals become formatting. Confirmed.

- **Where:** `src/webview/utils/markdownSerialization.ts:69-71` and `:111-112` (`escapeMarkdownSyntax` replaced with identity)
- **Repro:** `escaped \*star\* here` saves as `escaped *star* here`, which reopens as italic. Same for `\_`, `\[`, `` \` ``.
- **Fix direction:** restore TipTap escaping and undo it only where needed (for example inside autolink URLs), instead of disabling it for all prose.
- **Test first:** repro above for each delimiter; autolink URL case that motivated the patch.

### R5. LOW (likely pre-existing): list round-trip changes. Confirmed output, not confirmed as regression.

- **Where:** `src/webview/extensions/orderedListMarkdownFix.ts`, `markdownListItem.ts`
- **Repro:** `- item\n\n  1. nested` saves as `- item\n  1. nested` (loose becomes tight); `1)` becomes `1.`
- **Action:** add pinning tests; decide whether to preserve.

---

## 5. Cross-cutting work in this chunk

- **Round-trip corpus test:** every fixture saves byte-identical after an unrelated edit. Seed it with all repros above.
- **Patch guard:** `escapeMarkdownSyntax` and `encodeTextForMarkdown` are TipTap private methods that we monkey-patch. Add a test asserting they exist and are patched, so a TipTap bump fails loudly instead of silently bypassing the patch.

---

## 6. Progress

| ID | Test | Fix | Verified |
|---|---|---|---|
| R1 | | | |
| R2 | | | |
| R3 | | | |
| R4 | | | |
| R5 | | | |
| Corpus | | | |
