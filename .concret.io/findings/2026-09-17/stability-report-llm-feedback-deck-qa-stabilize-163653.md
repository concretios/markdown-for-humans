---
title: "QA Stabilization: LLM feedback on deck.md"
type: findings
created_at: "2026-09-17 16:36 +0530"
source: skill
owner: qa-stabilize
status: final
slug: llm-feedback-deck
kind: stability-report
tags: [cio-record, qa-stabilize, qa]
source_qa_report: /private/tmp/deck-feedback-investigation/qa-report-llm-feedback-deck-feature-qa-162426.md
base_commit: 8cd2214a5322e73a77b0e714c113f68ae61293da
branch: feature/feedback-inline-mark-snapshot-parity
cycle_count: 1
overall_status: blocked
evidence:
  - path: roadmap/pipeline/task-feedback-inline-mark-snapshot-parity.md
  - path: src/editor/markdownAstEquivalence.ts
  - path: src/__tests__/editor/markdownAstEquivalence.test.ts
  - path: src/__tests__/editor/feedbackSnapshotService.test.ts
  - path: src/__tests__/webview/feedbackSnapshotRoundTrip.realEditor.test.ts
  - path: /private/tmp/deck-feedback-fix-validation/results.json
  - path: /private/tmp/deck-feedback-investigation/full-suite-final.log
  - path: /private/tmp/feedback-native-api-xesg5nix/installed-results.json
  - path: /private/tmp/feedback-inline-mark-review.json
---
# QA Stabilization: LLM feedback on deck.md

## Context

The user authorized creating a plan and fixing QA-001 after the read-only investigation reproduced a false Feedback snapshot mismatch. Started from a clean worktree at the recorded base and created the recorded branch in `/Users/abhinav/code/markdown-for-humans-public`. There were no pre-existing changes. The user's original deck and normal VS Code installation were preserved.

## Summary

- QA-001 is fixed in code and passes real-editor, snapshot-service, and native Extension Host checks.
- Added 29 regression cases; 15 positive cases were verified failing before implementation.
- Final full suite: 145 suites and 2,728 tests passed; 27 existing skips and 120 TODO cases remain.
- Lint, release build verification, package creation, independent review, and diff checks pass.
- Overall stability sign-off is blocked only by the locked Mac preventing the required visual reading check. The plan remains in pipeline.

## Findings

### Imported issue and repair cycle

**QA-001, medium:** continuous italic/bold spans across source newlines are reserialized as separate spans around a hard break. Equivalent visible content was rejected by Feedback startup.

**Cycle 1, RED:** seven renderer comparison cases and eight real TipTap cases failed at the expected equivalence assertion. Controls remained green. Fixtures contain synthetic prose, not the private deck.

**Cycle 1, GREEN:** a linear token pass merges only matching `em`/`strong` boundary pairs around an existing inline break. The pass runs only in renderer equivalence, after raw-HTML validation. It preserves break count, nesting, text, links, code, and actual mark changes. Ordinary document-write equivalence and blank-line policy are unchanged.

**Cycle 1, VERIFY:** all added positive and adversarial cases pass, including host source hashes, exact line spans, and rejection of formatting loss despite a matching reported digest. The frozen original deck now passes the unchanged-source comparison and full snapshot finalization. Both original evidence and the live deck were preserved.

### Verification

| Gate | Result |
|---|---|
| Regression tests fail against baseline | 15 positive cases failed before implementation |
| Regression tests pass with fix | 29 new cases pass |
| Original nine diagnostic variants | Comparison, source preparation, anchors, finalization all pass |
| Full `npm test -- --runInBand` | 145 suites, 2,728 passed; existing skips/TODOs listed above |
| `npm run lint` | Passed |
| `npm run build:release` | Passed, bundle features verified |
| `npx vsce package --out ...` | Passed, 72 files, approximately 3 MB |
| Native VS Code 1.138 release-bundle harness | All five cases pass |
| Independent code review and diff check | No actionable findings |
| Visual reading in light/dark for ten minutes | Blocked by locked Mac |

The native harness uses supported VS Code test APIs in an isolated profile, extensions directory, and temporary workspace. It covers the frozen original deck, a current deck copy, repeat startup of the original, and minimal italic/bold cases. Each case creates an exact-hash draft and completes a session-dependent renderer-to-host Reveal request that opens the report. Each source remains byte-identical. The test host exits 0. This proves real webview startup and bidirectional session communication, but is not a visual inspection.

Independent comparator benchmark medians after warmup: 3,000 words, 1.10 ms patched versus 1.13 ms baseline; 10,000 marked lines, 17.87 ms versus 17.78 ms. This is a local regression observation, not a platform-wide performance guarantee.

### Diff and delivery

Production change is confined to `markdownAstEquivalence.ts`; three test files cover the behavior and safety boundaries. The environment guide and new task plan document the contract. No dependency, schema, source-file rewrite, or UI styling change was needed.

Installable build: `/private/tmp/markdown-for-humans-0.3.0-inline-mark-fix.vsix`.
SHA-256: `2e599b823212444132c8bbff332bcae81e8b2de5438aa00fdc7f065cf998338b`.
The package was not installed into the user's normal VS Code profile. No commit, push, publication, or external issue update was performed.

### Final state and residual risk

QA-001: **fixed, automated and native startup validation passed**.
Stability gate: **blocked**, because the required 3,000-word, ten-minute light/dark reading check cannot run while the Mac is locked. The user was asked to unlock the Mac or accept automated-only verification; no answer had arrived at report creation. No other unresolved defect was found in scope. The existing suite's skipped/TODO cases were not treated as passing.

## Next Action

After the Mac is unlocked, complete the visual reading check in the prepared isolated host at `/private/tmp/md4h-inline-mark-native/`, then close the remaining plan gate. Alternatively, record an explicit user acceptance of automated-only verification.

## Provenance

Created using qa-stabilize and cio-record, with independent test implementation and review agents. Source QA evidence was retained without modification. Commands and disposable native fixtures are local. The plan remains in pipeline rather than being marked shipped with an incomplete gate.
