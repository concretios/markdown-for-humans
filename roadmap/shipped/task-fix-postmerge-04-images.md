# Task: Fix image handling findings from post-merge review

## 1. Task Metadata

- **Task name:** Fix image handling findings
- **Slug:** fix-postmerge-04-images
- **Status:** completed, ready for user review
- **Created:** 2026-09-30
- **Last updated:** 2026-09-30
- **Shipped:** 2026-09-30 (implementation verified; PR prepared for review, not released)
- **Base:** `origin/main` @ `1b8244b`
- **Branch:** `feature/image-handling-fixes`
- **Input:** User-provided post-merge findings. The referenced overview was not attached.

---

## 2. Context & Problem

Image paste, save, rename and path resolution have one lock bypass, two ways to bloat the `.md` file with base64, and several edge-case regressions. Security (PDF export) is in chunk 02; resize round-trip bugs are in chunk 01.

Read `vibe-coding-rules/image-and-dom-handling.md` first.

---

## 3. Desired Outcome & Scope

**Success criteria:**
- No image file is written while the document is Feedback-locked
- A failed or undone image save never writes a large data URI into Markdown
- Reference scan is linear
- `npm test` passes

**In scope:** I1 to I7
**Out of scope:** SVG rendering changes

---

## 4. Findings

### I1. MED (#101, commit `4b00ab6`): paste bypasses Feedback and peer locks. Confirmed.

- **Where:** `src/webview/features/imageDragDrop.ts:188`
- **Defect:** the paste handler moved to the capture phase on `.ProseMirror` and is registered at editor creation, before the lock guards (`src/webview/features/feedbackPeerLock.ts:118`, `src/webview/features/feedbackReview.ts:5936`), which are also capture listeners on the same element. The image handler runs first, so their `stopImmediatePropagation()` no longer stops it.
- **Scenario:** during a Feedback lock, pasting a screenshot shows the folder prompt and posts `saveImage`; the host writes the file; the lock's `filterTransaction` rejects the placeholder. Result: orphan image file. A pasted image path can also trigger a workspace copy.
- **Fix direction:** have the paste handler check a shared "editing locked" state before doing anything, instead of relying on listener order.
- **Test first:** with a lock active (guard installed after setup), paste on a child `<p>` posts zero `saveImage` messages.

### I2. LOW (#93): failed image save embeds a huge base64 data URI. Confirmed.

- **Where:** `src/editor/MarkdownEditorProvider.ts:8514-8518` (`resolvePendingImageDestinations`) substitutes `fallbackDataUri` built at `:8242`, `:8255`; per-webview limit 64 MiB at `:742`.
- **Scenario:** disk full or permission error while pasting a 20 MB screenshot writes about 27 MB of base64 into the `.md`. The host then re-parses both documents with markdown-it on every later edit (`isMarkdownStructurallyEquivalent`).
- **Fix direction:** cap the fallback size (for example 256 KB); above it, fail the edit visibly.
- **Test first:** failed save of a large image produces an error and no data URI in the document.

### I3. LOW (pre-existing): completed image save is undoable into base64. Confirmed by regression tests.

- **Where:** `src/webview/features/imageDragDrop.ts:941-951` (`applySavedImageCompletion` dispatches `setNodeMarkup` without `addToHistory: false`)
- **Scenario:** after save completes, Ctrl+Z restores the `data:` preview URL plus a stale placeholder id; next sync writes the blob into the file.
- **Fix direction:** set `addToHistory: false` on the swap transaction.
- **Test first:** paste, complete, undo: document holds no `data:` URL.

### I4. LOW (#101): image reference scan is quadratic. Confirmed, measured.

- **Where:** `src/editor/imageSourceReferences.ts:194`, `:233`
- **Defect:** each `<` and `![` without a closing `>` or `]` scans to end of document. Runs synchronously over up to 1,000 workspace Markdown files.
- **Measured:** 280 KB of `a<b` lines: 4.7s; 220 KB of unclosed `![`: 4.3s; doubling size roughly quadruples time.
- **Triggers:** opening the rename or resize dialog; running a rename.
- **Fix direction:** bound each search to the relevant line or block, or precompute next-closing indices.
- **Test first:** 280 KB pathological doc scans in under 100ms.

### I5. LOW (#101): filenames containing `#` or `?` no longer resolve. Confirmed.

- **Where:** `normalizeImagePath` in `src/editor/MarkdownEditorProvider.ts`, via `splitImageSource` (`src/shared/imageSource.ts`)
- **Defect:** raw `#` or `?` is now treated as a URL suffix: `images/C#-logo.png` resolves to `images/C`.
- **Scenario:** Explorer drag-drops by earlier versions wrote raw relative paths. Those images now show "Unable to load image". CommonMark-correct, but a regression for existing documents.
- **Fix direction:** if the unsplit path exists on disk, prefer it; always encode `#` and `?` when writing new destinations.
- **Test first:** existing file `images/C#-logo.png` referenced raw still resolves.

### I6. LOW (#101): rename can report failure after the file was renamed. Confirmed by regression tests.

- **Where:** `src/editor/MarkdownEditorProvider.ts:9166` (`updateImageReferences` no longer catches per file)
- **Scenario:** an `openTextDocument` or `applyEdit` rejection aborts the loop after `fs.rename` ran; webview is told the rename failed, although the file moved and some references were rewritten.
- **Fix direction:** per-file try/catch; report partial success with the list of files not updated.
- **Test first:** one failing document in the reference set yields a partial-success result.

### I7. NON-BUG (#101): new destinations are fully percent-encoded.

- `Screen Shot (1)/图片 café.png` becomes `Screen%20Shot%20%281%29/%E5%9B%BE%E7%89%87%20caf%C3%A9.png`.
- **Decision needed:** for a "Markdown for Humans" editor, consider encoding only what CommonMark requires (spaces via `<...>`, unbalanced parentheses, `#`, `?`, `%`) and keeping Unicode readable.

---

## 5. Progress

| ID | Test | Fix | Verified |
|---|---|---|---|
| I1 | File/path child paste with later capture guard | Live owner/peer lock callback before import | Jest and native owner/peer raster paste |
| I2 | Persistence error/rejection with oversized bytes | 256 KiB serialized fallback cap before encoding | Jest and native 787 KB failed-save smoke |
| I3 | Saved/failed completion undo; insertion undo/redo | Completion transactions outside history | Real ProseMirror tests and native undo |
| I4 | Four malformed 280 KB fixtures plus valid trailing image | Indexed delimiters, block-only parsing | Under 100 ms, parity tests pass |
| I5 | Real raw delimiter files and rename after move | Prefer existing literal path, preserve known rename target | Jest and native rendering |
| I6 | Per-document open/apply failure followed by good document | Continue updates; report success plus failed files and warning | Host adapter regression tests |
| I7 | Existing encoding tests | Retain current encoding; no redesign | Existing round-trip and host integration coverage |


## 6. Implementation decisions and verified corrections

- I1's capture-order defect is real, but the current host already blocks `saveImage` and workspace-image messages while Feedback is locked. The reproduced consequence was premature renderer prompts/messages; an orphan file bypass was not established. Both layers now guard the workflow.
- I2 measures the complete serialized URI before base64 allocation, including header and expansion. Oversized failures reject the edit; the renderer receives `imageError` and removes its preview. Existing small-image fallback remains supported. Dense transfer buffers are released on either settlement path.
- I3 applies the history exclusion to failed-preview deletion as well as saved-path replacement. Undo/redo of the original insertion keeps the final saved destination.
- I4 avoids full inline markdown-it parsing because only block maps and source are used. Existing supported Markdown/HTML grammar and source-span parity tests stay intact. Measurements address the reported malformed openers, not a formal complexity proof for all third-party parser inputs.
- I5 checks disk existence only for ambiguous local raw delimiters. Existing authored URL suffixes retain their meaning when the complete literal path does not exist. A known original path keeps rename identity stable after the file moves.
- I6 never rolls back a successful file move after a reference failure. Each document is attempted independently, and the warning names the files that still need repair.

## 7. Verification

- RED before implementation: renderer lock, completion history, scanner, large fallback, raw path and partial-rename regressions. See the baseline QA report under `.concret.io/findings/2026-09-30/`.
- Full Jest: 165 suites passed, 1 existing suite skipped; 3,094 passed, 27 skipped, 120 TODO. `/tmp/md4h-final-tests.log`.
- TypeScript, lint, debug build and release build/bundle checks passed. `/tmp/md4h-final-tsc.log`, `/tmp/md4h-final-lint.log`, `/tmp/md4h-release.log`.
- Actual Extension Development Host: all 6 integration tests passed on both VS Code 1.98.0 and 1.139.1. `/tmp/md4h-integration-min.log`, `/tmp/md4h-integration-stable.log`. Temporary short profile paths worked around macOS IPC socket path limits; no runner config changes are included.
- Native clipboard QA: raw `C#-logo.png` and `draft?review.png` render; normal raster paste writes a file and source path; undo saves without preview data. Feedback owner and peer paste show no save dialog and create no extra file. A 787,252-byte raster pasted to a regular file used as the destination folder shows an error and leaves Markdown byte-identical, including after undo.
- Scanner spot measurements on this Mac: 280 KB fixtures 4.9 to 20.7 ms; 560 KB fixtures 10.8 to 32.0 ms. Each finds the valid trailing image. These are local observations, not Windows performance certification.
- Long-document check: read and exercised the 8,598-word fixture over a 10+ minute native-host session, interleaved with clipboard, Feedback, undo, and save checks. Light and dark themes, prose, lists, tables, images and code blocks were inspected with no new layout failure. This is macOS smoke evidence, not a physical Windows latency claim.
- Per-document rename IO failures are deterministic host-adapter tests, not physical disk-failure injection. Physical Windows i5/16 GB latency/high-DPI release checks remain outside this macOS run. No browser-page tests were used, per user instruction.
- Diff reviewed; no dependency, package-lock, or unrelated source changes. Commit and PR publication were subsequently authorized by the user.

## 8. PR #105 review follow-up: CRLF reference scanning

- Finding: bypassing markdown-it's core normalization made CRLF blank lines part of paragraphs. Rename could skip standalone space-containing image paths and rewrite image examples inside mixed indented code.
- RED: eight regression cases added before the fix; the focused run failed six cases and passed 70, reproducing both CRLF defects plus CR and mixed-newline offset failures.
- Fix: normalize CRLF/CR to LF only for block parsing; map token line numbers through the original source's LF/CRLF/CR boundaries. All destination scanning and replacement continue to use the authored source. Inline parsing stays disabled to retain the malformed-input performance improvement.
- Coverage: scanner classification and exact spans for LF, CRLF, CR and mixed endings, Unicode before references, image-only indented blocks and fenced exclusions; provider rename preserves code examples, CRLF bytes, URL suffixes and HTML attributes.
- Focused GREEN: both suites pass, 76 tests, including the existing four 280 KB scanner performance gates. Release build and bundle verification pass.
- Full Jest: 165 suites and 3,102 tests passed; existing 1 skipped suite, 27 skipped tests and 120 TODOs unchanged. Log: `/tmp/md4h-crlf-tests.log`.
- Lint and TypeScript pass. Independent read-only review found no new defects and passed 25 additional in-memory newline/source-span checks.
- Real Extension Host: all six integration tests passed on VS Code 1.98.0 and current stable 1.140.0 with the updated release bundle.
- Native reading/use: 8,598-word synthetic document read for 10 minutes 15 seconds in Light Modern and Dark Modern on VS Code 1.140.0. Images, prose, tables, code, selection, theme transition and sustained scrolling showed no new regression; fixture bytes remained unchanged.
- Focused native CRLF rename smoke: real image destination updated, code example destination unchanged, all ten CRLF endings and image bytes preserved.
- Separate pre-existing issue observed during native save: `serializeBlockMarkdown` in `src/webview/utils/markdownSerialization.ts` applies `.trim()` to non-image blocks, removing the first line's indentation from a mixed indented code block. Reproduced with unchanged HEAD serializer code in memory; both HEAD and fixed scanner replacements preserve indentation. This follow-up does not modify that serializer.
- The user authorized committing and pushing this follow-up after a final code review.
