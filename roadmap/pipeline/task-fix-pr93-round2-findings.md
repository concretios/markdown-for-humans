# Task: Fix PR #93 round-2 audit findings (R01–R07)

## 1. Task Metadata

- **Task name:** Fix PR #93 round-2 audit findings
- **Slug:** fix-pr93-round2-findings
- **Status:** in-progress
- **Created:** 2026-09-27
- **Last updated:** 2026-09-27
- **Shipped:** _(pending)_
- **Base:** `feature/llm-feedback` @ `4895fa4`
- **Branch:** `cursor/fix-pr93-round2-findings-dc93`
- **Authenticity:** Confirmed — `internal/pr-93-round2-authenticity.md`

---

## 2. Context & Problem

Second read-only audit of PR #93 at `4895fa4` found seven remaining defects. Two P1s can lose document or screenshot data; five P2s affect serialization, transfer recovery, or ownership.

Prior F01–F11 fixes (#94/#95) partially closed several items; R01–R07 are the remaining gaps.

---

## 3. Desired Outcome & Scope

**Success criteria:**
- Each finding has a failing test first, then a green fix
- `npm test` and lint pass
- Ext Host integration suite passes where applicable
- PR into `feature/llm-feedback`

**In scope:** R01–R07  
**Out of scope:** Unrelated Feedback features; AI review `diff too_large`

---

## 4. Fix order

1. R01 — teardown passes `baseDocumentVersion` through image await  
2. R04 — second transfer validation uses text digest  
3. R06 — entity decode/serialize agreement for common entities  
4. R07 — escape quotes in link title serialization  
5. R02 — serialize discovery orphan cleanup with report writes  
6. R03 — retain `.prev` during metadata discovery  
7. R05 — explicit busy refusal + recoverable transfer state  

---

## 5. Technical Plan

| ID | Primary files |
| --- | --- |
| R01 | `MarkdownEditorProvider.ts`, `undoSync.test.ts` |
| R02 | `feedbackSessionStore.ts`, store concurrency tests |
| R03 | `feedbackSessionStore.ts`, discovery+resume tests |
| R04 | `MarkdownEditorProvider.ts`, transfer/BOM tests |
| R05 | `feedbackReview.ts`, `MarkdownEditorProvider.ts`, transfer tests |
| R06 | `markdownSerialization.ts`, real-editor entity tests |
| R07 | `markdownCompatibilityMarks.ts`, link round-trip tests |

---

## 6. Testing

- TDD for each finding
- Full `npm test` after batches
- `npm run test:integration` before ship

---

## 7. Progress

| ID | Tests | Fix | Verified |
| --- | --- | --- | --- |
| R01 | done | done | unit (teardown + pending image) |
| R02 | done | done | store concurrency (discovery during write) |
| R03 | done | done | discovery then resume restores `.prev` |
| R04 | done | done | digest contract + transfer second guard |
| R05 | done | done | transfer client applied:false + host rollback |
| R06 | done | done | real TipTap entity round-trips |
| R07 | done | done | real TipTap quoted-title link round-trip |
