# Task: Feedback list snapshot parity

## 1. Task Metadata

- **Slug:** `feedback-list-snapshot-parity`
- **Status:** complete
- **Created:** 2026-09-11
- **Base commit:** `82b8bfa`
- **Branch:** `feature/feedback-list-snapshot-parity`
- **Constraint:** keep `CONTRIBUTING.md` byte-identical.

## 2. Context & Problem

Clicking Log feedback for an LLM on CONTRIBUTING.md fails with "A rich editor split applied a different Feedback snapshot revision." Reproduced in a single editor in VS Code 1.137.0 with installed 0.3.0 bundles matching local dist hashes.

QA-001: TipTap serializes children of numbered items with two spaces, changing CommonMark nesting. QA-002: the Feedback comparison regex leaves inconsistent paragraph-boundary whitespace when canonicalizing loose lists. Existing 46 focused tests pass, while temporary tests reproduce both defects.

## 3. Desired Outcome & Scope

Feedback starts on the untouched contribution guide, anchors remain correct, and actual source divergence still fails closed. Fix list-item serialization and Feedback-only equivalence; distinguish revision/content errors. No public API, protocol, dependency, configuration, or persisted-format changes.

## 4. UX & Behavior

Start/cancel works in one and multiple rich editors. An actual mismatch reports whether its descriptor revision or rendered Markdown differs, preserves recovery, and never activates an invalid session. Test annotation edits and draft save/resume on disposable copies.

## 5. Technical Plan

- Local ListItem extension preserves upstream parsing, commands and keymaps while indenting nested blocks according to the emitted ordered-list marker width. Register it with ListKit's list item disabled and align real-editor fixtures.
- Normalize Markdown-it paragraph tokens only for list items with one direct paragraph and optional nested lists or verbatim code blocks. Keep ordinary write equivalence and raw HTML/code/multiple-paragraph guards strict.
- Split provider descriptor/content validation messages, retaining MD4H-FB-SNAPSHOT-001 and recovery behavior.
- Keep normalization linear and serialization at existing debounce/flush boundaries.

## 6. Work Breakdown

- [x] Add regressions and record RED.
- [x] Implement serializer, comparison and error-message fixes.
- [x] Verify focused and full tests, lint, release build and performance fixture.
- [x] Verify Extension Host 1.98.0 and stable, then isolated packaged toolbar flows.
- [x] Review a 3000+ word document for 10+ minutes across light/dark themes.
- [x] Review diff, record limitations, and verify original document hash.

## 7. Implementation Log

- Baseline CONTRIBUTING.md SHA-256: `24aa33d8b5eb77cab80401c4340f2ec395c91584f3474a0da723c7989fd5f885`.
- Planned tests: exact source; ordered parents 1/4/10 and 9-to-10; mixed/deep nested lists; paragraphs and code blocks; loose/tight equivalence; reject real text/link/nesting/code/raw-HTML changes; preserve-mode policy; provider success, both failures, and recovery.
- Evidence directory was local and is not in the repository.
- RED: 16 failures and 206 passes in three focused suites, recorded in `red.log`.
- First implementation passed the exact guide but exposed upstream numeric-list tokenizer defects in the planned deep-nesting, code and checkbox cases. Standard numeric lists now defer to marked's built-in CommonMark lexer; nonnumeric upstream handling is retained.
- Code-containing list items need the same single-paragraph token normalization as nested lists. Code bodies continue to compare verbatim; changed-code tests remain negative.
- Focused intermediate verification: 223 tests passed. Zero-based numbering added as an additional failing regression before preserving start=0 in serialization.
- Final full Jest run: 145 suites passed, one existing suite skipped; 2,699 tests passed, 27 existing skips and 120 existing TODOs. No failing tests. See `full-tests.log`.
- Lint and release build verification passed (`lint.log`, `build.log`). Deterministic Feedback performance contract and production fixture passed (`performance-contract.log`, `performance.log`): 10,000-line document, 500 annotations, 10,000 typing transactions, zero typing-path serializations.
- Extension Host: all three tests passed on both VS Code 1.98.0 and stable (resolved to 1.137.0), on macOS arm64. See `host-1.98.0.log` and `host-stable.log`.
- Packaged a local VSIX and installed it only in isolated user-data and extensions directories. Installed extension/webview SHA-256 values match the tested release bundles.
- Native toolbar QA passed on the unchanged original CONTRIBUTING.md: start reported snapshot saved, discard returned to normal editing, source hash stayed identical.
- Disposable nested-list QA passed: nested child selection saved as exact rendered text; close/reopen offered the draft; Resume restored F1 with its original quote. A second editor joined an active snapshot read-only. Finish restored editing; starting with two existing editors and discarding released both. A later edit synchronized to the peer and saved.
- Reading review: README.md (3,409 rendered words), native UI inspection from 06:58:39 to 07:08:48 UTC (10 minutes 9 seconds), Default Light Modern and Default Dark Modern. Reviewed prose, list indentation, tables, code, images and footer with scrolling and stationary checks. No clipping, overlapping blocks, unexpected reflow or scroll movement observed. This was an agent visual review, not a human comfort assessment.
- Final `git diff --check` passed; HEAD remains `82b8bfa17ffe2f4118581cecbffd3744887b65f6`. CONTRIBUTING.md remains at the baseline SHA-256. README.md, dependency manifests, configuration and stored Feedback schema were not changed.
- Detailed GUI evidence and the stability report were local artifacts and are not in the repository.

## 8. Decisions & Tradeoffs

- Preserve source formatting and the strict snapshot safety check. Correct serialization instead of accepting structural changes.
- Use existing Markdown-it token metadata instead of HTML regex matching for list tightness.
- Keep the exact dependency family; do not modify node_modules.

## 9. Follow-up & Future Work

No unresolved defects from this scope. Native UI checks ran on macOS arm64 only; Windows/Linux UI checks and physical-device performance measurements were not run. The deterministic performance fixture is not a physical-device latency benchmark. The user's regular VS Code profile still uses its existing installed extension; install the packaged VSIX there to use this fix.
