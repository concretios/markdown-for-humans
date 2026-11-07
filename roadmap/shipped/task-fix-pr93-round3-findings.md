# Task: Fix PR #93 round-3 audit findings (T01–T04)

## 1. Task Metadata

- **Task name:** Fix PR #93 round-3 audit findings
- **Slug:** fix-pr93-round3-findings
- **Status:** shipped in 0.4.0
- **Created:** 2026-09-27
- **Last updated:** 2026-09-27
- **Shipped:** 2026-10-01 (0.4.0)
- **Base:** `feature/llm-feedback` @ `7d64c6c`
- **Branch:** `cursor/fix-pr93-round3-findings-dc93`
- **Authenticity:** Confirmed — `internal/pr-93-round3-authenticity.md`

---

## 2. Context & Problem

Third read-only audit found four remaining defects (T01–T04). T01 is P1 screenshot data loss on concurrent Resume; T02–T04 are P2 transfer/serialization gaps from incomplete R02/R05/R06 fixes plus a new `&gt;` blockquote regression.

---

## 3. Desired Outcome & Scope

**Success criteria:**
- Failing tests first, then green fixes for T01–T04
- `npm test` + Ext Host pass
- PR into `feature/llm-feedback` only (no merge to `main` without explicit ask)

**In scope:** T01–T04  
**Out of scope:** Merging #93 to main

---

## 4. Fix order

1. T01 — lock full Resume + publish screenshot assets under the same report lock  
2. T02 — retain refusal identity so abort ACKs complete rollback  
3. T04 — keep line-leading `>` escaped  
4. T03 — preserve intentionally literal entity spellings across parse/serialize  

---

## 5. Technical Plan

| ID | Primary files |
| --- | --- |
| T01 | `feedbackSessionStore.ts`, store concurrency tests |
| T02 | `feedbackSessionTransferClient.ts`, transfer client + provider tests |
| T03 | `markdownSerialization.ts` (+ parse path if needed), real-editor tests |
| T04 | `markdownSerialization.ts`, real-editor tests |

---

## 6. Progress

| ID | Tests | Fix | Verified |
| --- | --- | --- | --- |
| T01 | done | done | store concurrency (Resume vs screenshot) |
| T02 | done | done | transfer client abort after refusal |
| T03 | done | done | real TipTap literal `&amp;entity;` |
| T04 | done | done | real TipTap line-leading `&gt;` |

**Gates:** `npm test` 2724 passed; Ext Host 4/4 passed @ VS Code 1.139.1
