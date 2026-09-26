# Task: Fix PR #93 Codex review findings (F01–F11)

## 1. Task Metadata

- **Task name:** Fix PR #93 review findings
- **Slug:** fix-pr93-review-findings
- **Status:** in-progress
- **Created:** 2026-09-26
- **Last updated:** 2026-09-26
- **Shipped:** _(pending)_
- **Base:** `feature/llm-feedback` @ `79ddb23`
- **Branch:** `cursor/fix-pr93-review-findings-dc93`
- **Authenticity:** Confirmed real — see Project store `internal/pr-93-review-authenticity.md`

---

## 2. Context & Problem

Codex pre-merge review of PR #93 found eleven confirmed defects. Two P1s can lose or corrupt user content; CI is red on Windows Ext Host (F10) and Node 22 timing (F11).

**Pain points:**
- Pending image saves can overwrite newer document edits (F01)
- Loose numbered checklists duplicate on serialize (F02)
- Entity spellings, angle-bracket links, reference links, BOM restore, transfer drafts, screenshot durability, and error UI (F03–F09)
- Release gates fail (F10–F11)

---

## 3. Desired Outcome & Scope

**Success criteria:**
- Each finding has a failing test first, then a green fix
- `npm test` and `npm run lint` pass
- Ext Host integration suite passes against VS Code in this env
- PR into `feature/llm-feedback` with walkthrough evidence

**In scope:** F01–F11 as described in the Codex review  
**Out of scope:** Unrelated Feedback features; physical Windows high-DPI; 10-minute reading ritual beyond Ext Host smoke

---

## 4. Fix order

1. F01 — revalidate version after image persistence await  
2. F02 — loose ordered-task prefix without duplication  
3. F10 — CRLF-aware Ext Host assertions  
4. F11 — separate algorithmic vs wall-clock layout gate  
5. F03 — preserve nested entity escaping  
6. F04 — keep angle-bracket autolinks as links  
7. F05 — seed references in snapshot equivalence fallback  
8. F06 — compare text hash vs byte hash correctly on restore/transfer  
9. F07 — protect unfinished comments on ownership transfer  
10. F08 — durable screenshot asset/report recovery  
11. F09 — keep screenshot submission errors visible  

---

## 5. Technical Plan

| ID | Primary files |
| --- | --- |
| F01 | `MarkdownEditorProvider.ts`, `documentEditCoordinator` / undo-sync tests |
| F02 | `orderedListMarkdownFix.ts`, real-editor escape suite |
| F03 | `markdownSerialization.ts`, entity real-editor tests |
| F04 | `markdownCompatibilityMarks.ts`, escape real-editor tests |
| F05 | `feedbackSnapshotService.ts`, snapshot/equivalence tests |
| F06 | `MarkdownEditorProvider.ts`, feedback provider restore tests |
| F07 | `feedbackReview.ts`, review/transfer tests |
| F08 | `feedbackSessionStore.ts`, store crash/recovery tests |
| F09 | `feedbackCapture.ts`, annotation modal tests |
| F10 | `test/integration/extensionHost.test.cjs` |
| F11 | `feedbackAnnotationLayout.test.ts` |

---

## 6. Testing

- TDD for each finding
- Full `npm test` after batches
- `npm run test:integration` (VS Code Ext Host) before ship
- Manual Ext Host / GUI smoke for Feedback + save paths where feasible

---

## 7. Progress

| ID | Tests | Fix | Verified |
| --- | --- | --- | --- |
| F01 | done | done | unit |
| F02 | done | done | real TipTap |
| F03 | done | done | real TipTap |
| F04 | done | done | real TipTap |
| F05 | done | done | snapshot service |
| F06 | done | done | code + helpers |
| F07 | done | done | review controller |
| F08 | done | done | store resume |
| F09 | done | done | annotation modal |
| F10 | done | done | pending Ext Host |
| F11 | done | done | unit |
