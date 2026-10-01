# Task: Fix document sync and save findings from post-merge review

## 1. Task Metadata

- **Task name:** Fix document sync and save findings
- **Slug:** fix-postmerge-03-document-sync-save
- **Status:** in-progress (implemented and tested; awaiting user review, not committed)
- **Created:** 2026-09-30
- **Last updated:** 2026-10-01
- **Shipped:** _(pending)_
- **Base:** `origin/main` @ `1b8244b` (review); implemented on `39dfe56` (includes #106)
- **Branch:** `fix/postmerge-03-document-sync-save`
- **Overview:** `task-fix-postmerge-00-overview.md`

---

## 2. Context & Problem

#93 added a version and ack sync protocol between host and webview but kept the older timing and content-cache skips. The two models disagree, and the webview's universal recovery ("request a forced replay") overwrites local state with no retry cap. Result: lost keystrokes, a possible message loop, and saves that silently do nothing.

Read `vibe-coding-rules/common-pitfalls.md` before touching sync.

---

## 3. Desired Outcome & Scope

**Success criteria:**
- No keystroke is dropped when a save participant or blank-line-only change bumps the document version
- Reconciliation is bounded and a persistent failure is visible to the user
- Ctrl+S never fails silently
- Typing latency stays under 16ms
- `npm test` and Ext Host tests pass

**In scope:** Y1 to Y4
**Out of scope:** full extraction of `DocumentSyncHost` (recommended follow-up)

---

## 4. Findings

### Y1. MED (#93): keystrokes silently lost. Plausible; every step traced. Found independently by host and webview reviewers.

- **Host side:**
  - `src/editor/MarkdownEditorProvider.ts:1305-1311`: 100ms echo window skips `updateWebview`
  - `:1280-1289`: skips when content after blank-line policy is unchanged
  - `:11021-11026` (`applyEditNow`): rejects edits whose base version is stale
- **Webview side:**
  - `src/webview/editor.ts:1531-1534`: rejected edit triggers forced host replay
  - `~:490` (`resumeHostReconciliation`) and `~:1499-1505` (forced update calls `acceptAuthoritativeState()`): replay replaces content and clears dirty state
- **Scenario A:** user types, presses Ctrl+S inside the debounce. Save policy edit bumps to v6. `document.save()` runs a save participant (trimTrailingWhitespace on TipTap two-space hard breaks, markdownlint fixAll, formatOnSave): v7 within 100ms. Host skips the update; webview still holds v6. Next keystroke's edit carries base v6 and is rejected; forced replay discards it.
- **Scenario B (default strip mode):** a blank-line-only change in the source split bumps the version, policy-applied content is identical, no update sent. Same outcome.
- **Scenario C:** user types continuously while an external writer (LLM agent, git) changes the file. Characters typed during the replay round trip disappear.
- **Fix direction:** always send a version-only update when `document.version` changes; delete the 100ms timestamp skip. In the webview, do not clear unacknowledged local edits on forced replay; reapply or surface a conflict.
- **Test first:** simulate a save participant bumping the version within 100ms of an edit; blank-line-only external change in strip mode; typing during replay. Assert no text lost. No existing test covers save participants.

### Y2. MED (#93): possible endless reconciliation loop. Plausible (needs a parser exception).

- **Where:** `src/webview/editor.ts ~:2322` (`updateEditorContent` catch) and the `setContentResult === false` branch, both calling `requestHostReconciliation()`; host answers `document.sync.request` with another forced update at `MarkdownEditorProvider.ts:1748-1753`.
- **Scenario:** external change introduces Markdown that makes a custom `parseMarkdown` throw. Webview and host ping-pong forever, pegging CPU. `hostReconciliationPending` makes every `flushPendingEdit` return ok=false, so saves fail.
- **Fix direction:** attempt counter with backoff; after N failures show a visible "out of sync" state with a reload action.
- **Test first:** mock `parseMarkdown` to throw; assert bounded number of sync requests and a visible error.

### Y3. MED (#93): Ctrl+S can silently do nothing. Confirmed.

- **Where:** `src/editor/MarkdownEditorProvider.ts:10917-10930` (`executeSaveAfterDocumentEdits`) returns with no message and no log when `flushRendererAtDocumentBoundary` fails; flush timeout is 2s at `:422`.
- **Triggers:** webview waiting in `waitForPendingImageSaves` (large paste, slow disk); `hostReconciliationPending`; any rejected edit including Y1.
- **Before #93:** Ctrl+S always ran `workbench.action.files.save`.
- **Fix direction (decision needed):** show an error with Retry, or fall back to saving the current `TextDocument` state and warn that the latest edits may be missing.
- **Test first:** flush failure path shows a message; flush timeout path shows a message.

### Y4. LOW (#93): `waitForPendingImageSaves` has no timeout. Plausible.

- **Where:** `src/webview/editor.ts ~:1980` (`flushPendingEdit`), `src/webview/features/imageDragDrop.ts:88-91`
- **Scenario:** an image completion never arrives; the flush ACK is never posted. If the image completes later, a stale ACK and edit are sent long after the host barrier expired.
- **Fix direction:** bound the wait to the host flush timeout and drop the late ACK by request id.
- **Test first:** never-completing image save; assert the flush settles and a late completion does not send a stale ACK.

---

## 5. Progress

All four findings reproduced on `39dfe56` (new tests failed for the expected reason before the fix).

| ID | Test (RED first) | Fix | Verified |
|---|---|---|---|
| Y1 | Host: save participant within the old 100 ms window gets no update; echo and strip-mode blank-line change get no version. Webview: forced replay calls `setContent` and drops dirty typing | Host `updateWebview` sends `document.version` for content the split already has; 100 ms skip and `pendingEdits` removed. Webview adopts `document.version`; `rebaseUnacceptedLocalEdits` keeps local typing on a forced replay and resends it | Jest green |
| Y2 | Webview: forced replay whose `setContent` throws produced 13 sync requests in 12 rounds | `requestHostReconciliation` backs off (0, 250, 500, 1000 ms), stops after 4 attempts, posts `document.sync.failed`; host shows error with Reload Editor | Jest green |
| Y3 | Host: rejected flush, flush timeout and throwing `save()` showed nothing | `executeSaveAfterDocumentEdits` shows an error with Retry (reruns flush and save); throwing save shows an error | Jest green |
| Y4 | Webview: never-completing image save left the flush unanswered, then sent a late ACK | `waitForPendingImageSaves(timeoutMs)` returns false and drops its waiter; flush handler bounds the wait to 2000 ms (host flush timeout) | Jest green |

**Gates (2026-10-01, on `39dfe56` plus this change):** `npm ci` ok; `npm test` 184 suites passed, 3406 tests passed (27 skipped, 120 todo); `npm run lint` clean; `npx tsc --noEmit` clean; `npm run test:integration` 7 passing on VS Code 1.140.0 (run twice, both green, no flake).

### Decisions

- **Y3 (confirmed by the user, 2026-10-01):** when the renderer flush fails or times out, Ctrl+S shows a VS Code error notification with a "Retry" action that reruns the flush and save. It never saves the possibly stale `TextDocument`. A `save()` that throws now also shows "VS Code could not save this Markdown document."
- **Y1 replay policy (confirmed by the user, 2026-10-01, decision #1):** a forced replay that answers this renderer's own reconciliation request, while it holds unaccepted local work (a rejected edit or dirty typing), keeps the renderer's content, adopts the replayed version and resends. If no visible host change was deferred, this is silent (invisible version bumps: echo, strip-mode blank lines, a save participant that changes nothing visible racing an edit in flight). A visible save participant change is a conflict like any other (03-F5). If a visible host change was deferred (recent-typing guard or apply failure), the renderer posts `document.sync.conflict` before resending; the host captures the text being replaced and shows a warning with "Open Replaced Version" (opens it as an untitled Markdown document). Local typing wins; the replaced text stays recoverable. Alternatives not taken: file wins with "Open My Typing", or a block-level three-way merge (feature-sized).
- **Y1 echo detail:** without the 100 ms skip, every Ctrl+S echoed a full update because `applyEditNow` counted the MD047 trailing newline as a policy modification. `contentWasModified` now ignores the trailing newline, so only real blank-line stripping refreshes the renderer.
- **Y1 stale versus hard rejection:** only a rejection whose ACK version differs from the edit's base version (`lastSentEditBaseVersion`) is rebased. A rejection without a version change (read-only file, unknown pending image marker, Feedback lock) would fail again on resend, so its replay is applied as before, even over typing made after the rejection (03-F4). This avoids four identical "Failed to save changes" errors and an out-of-sync notice for a read-only file.
- **Y1 version-only safety:** the renderer ignores `document.version` while it has deferred a visible host update (`hostContentDeferred`), so a version bump never rebases typing onto content it has not shown.
- **Y2 visible state:** the out-of-sync state is a VS Code error notification with "Reload Editor" (resets `webview.html`, same path as a recreated hidden webview) plus, since decision #2, a persistent in-webview banner with a "Reload editor" button that asks the host for the same reload (`document.sync.reload`). See Decisions applied. Feedback-locked views keep the old authoritative-apply behavior.
- **Y4 bound:** 2000 ms, equal to `FEEDBACK_FLUSH_ACK_TIMEOUT_MS`. The host already drops an ACK whose request id has no resolver.

### Tests

- `src/__tests__/editor/documentSyncRecovery.test.ts` (new)
  - Y1: `delivers a save participant change made right after a rich-editor edit`
  - Y1: `sends a version-only update for the echo of a rich-editor edit`
  - Y1: `echoes a Ctrl+S save-policy edit that only gains the trailing newline as document.version`
  - Y1: `echoes a Ctrl+S save-policy edit that has blank lines stripped by policy as update`
  - Y1: `sends a version-only update when a blank-line-only change keeps the strip view identical`
  - Y1: `offers the replaced file version after the renderer keeps typing over a concurrent change`
  - Y2: `shows an out-of-sync error with a reload action when the renderer stops reconciling`
  - Y3: `shows a retryable error when the renderer cannot flush, and retries the save`
  - Y3: `never saves stale document content when the error is dismissed`
  - Y3: `shows a retryable error when the renderer flush times out`
  - Y3: `reports a VS Code save that throws`
- `src/__tests__/webview/undo-sync.test.ts`, describe `host replay recovery (post-merge 03)`
  - Y1: `adopts a version-only host update as the base of the next edit`
  - Y1: `ignores a version-only update while a visible host change is deferred` (guard; passes before and after)
  - Y1: `keeps typing made during a forced replay and resends it on the replayed version`
  - Y1: `applies the replay when the host rejected an edit without a version change` (it.each; second case adds a keystroke before the replay, 03-F4)
  - Y1: `surfaces a conflict when a visible host change raced local typing`
  - Y2: `stops requesting forced replays after repeated failures and reports out of sync`
  - Y2: `backs off before retrying a failed forced replay`
  - Y4: `settles a flush barrier when an image save never completes and sends no late ACK`
- `src/__tests__/webview/pendingImageCapacity.test.ts`
  - Y4: `bounds an explicit-action wait when an image save never completes`
- Review fix round tests: listed in the table under Review fix round.
- Adjusted existing tests: `undoSync.test.ts` (count only `update` payloads in corrective-revert tests; echo test now expects `document.version`; removed `pendingEdits` assertions), `feedbackSplitLifecycle.test.ts` (removed `pendingEdits` field, renamed test).

### Known limits

- Two forced replays in flight (a retry fired before the first replay arrived, host latency over 250 ms) can still apply the second replay over the resend. Rare; behaves like the pre-fix code.
- A non-forced host update applied while the renderer is dirty but idle for over 2 s (image save deferring the debounce) still replaces unsent typing. Pre-existing, not in Y1 scope.
- A visible save participant change (for example `files.trimTrailingWhitespace` removing a TipTap hard break's two spaces) that lands while the user keeps typing is treated like any concurrent change: conflict warning, then the resend restores the removed text. With autosave this repeats each cycle (03-F5). Decision #4: accepted as mitigated by chunk 01 decision #3 (separate change: hard breaks keep their authored source form, and breaks created in the editor are written as backslash breaks, which `files.trimTrailingWhitespace` does not touch). The residual case, a hard break authored as two trailing spaces, stays recorded here.

### Review fix round (2026-10-01)

Findings from `findings-03.json`, fixed in severity order. Each fix started with a test that failed on the previous code for the stated reason. Mutation check: the guarded production change was reverted in the editor (no git), the named test failed, then the change was restored and the test passed.

| ID | Sev | Outcome | Change | Test(s) | Mutation check |
|---|---|---|---|---|---|
| 03-F1 | high | fixed | `updateWebview` treats the source split's echo cache as proof only while nothing was posted to that split after its accepted edit (`pendingHostContent` and `lastHostContent` both undefined; `applyEditNow` clears both). A -> B -> A now resends A instead of a version-only update. Also covers Feedback paths that set `lastHostContentByWebview` directly. | documentSyncRecovery: `resends reverted content to a split that was shown a newer version, after the intermediate update was delivered` and `..., while the intermediate update is still in flight` | Both conditions removed: both cases fail with `document.version` posted. Only the `lastHostContent` condition removed: the delivered case fails. Only the `pendingHostContent` condition removed: the in-flight case fails. |
| 03-F3 | medium | fixed | The echo comparison ignores CRLF versus LF, so a CRLF file in preserve mode gets a version-only echo instead of a full update and replay. | documentSyncRecovery: `sends a version-only update for the echo of an edit to a CRLF file in preserve mode` | Exact comparison restored: fails with a full `update` carrying CRLF content. |
| 03-F2 | medium | fixed | The renderer records the Ctrl+S edit id (`savePolicyEditId`). Its ACK disarms `allowNextHostSyncDespiteRecentEdit` and `allowNextHostSyncDespiteEchoHash`; the host posts the policy echo before that ACK, so a full policy echo still uses them. Replaced in round 3 by a host tag (03-R1). | undo-sync: `Y1: defers a save participant change that races typing after a version-only Ctrl+S echo`; guard `Y1: still applies a Ctrl+S save-policy echo that arrives before its ACK over recent typing` | Clearing on ACK removed: the race test fails (`setContent` replaced the typing). Flag arming on send removed: the guard test fails. |
| 03-F4 | low | fixed | New `localEditHardRejected`: after a rejection without a version change, `rebaseUnacceptedLocalEdits` returns false even when typing is dirty, so the replay is applied as the plan decision states. Cleared by an accepted ACK and `resetHostReconciliation`. | undo-sync: `Y1: applies the replay when the host rejected an edit without a version change even after a keystroke before the replay` (it.each with the original case, now at document version 5) | Guard neutralized (`localEditHardRejected && false`): the keystroke case fails, the no-typing case still passes. |
| 03-F5 | low | decision_for_user | No code change. See Decisions needed below. | none | not applicable |
| 03-F6 | low | fixed (test only) | Pins Scenario C with no rejected edit: the `hasPendingSync()` disjunct keeps typing made during the replay round trip. | undo-sync: `Y1: keeps typing made during the replay round trip when no edit was rejected` | `!(localEditRejected \|\| hasPendingSync())` changed to `!localEditRejected`: fails. |
| 03-F7 | low | fixed (tests only) | One test per surviving mutation. | undo-sync: (1) `Y1: applies a requested replay over local edits while Feedback editing is locked`; (2) `Y2: gives each stale rejection a fresh retry budget after an accepted edit`; (3) the hard-rejection tests above, now at version 5; (4) `Y1: adopts a version-only update again once a later host update was applied`; (5) `Y1: ignores a version-only update after the editor rejects host content` and `... throws on host content`; (6) `Y1: applies a forced update this view did not request, even while it is dirty`; (7) `Y2: does not schedule a second retry while one is already waiting` and `Y2: drops a waiting retry once a replay rebased local edits` | All nine mutations (1, 2, 3, 4, 5a, 5b, 6, 7a, 7b) each fail exactly their named test. |
| 03-F8 | low | fixed (tests only) | Host tests for the pending-delivery version-only post and the `document.sync.failed` generation check. | documentSyncRecovery: `sends a version-only update when a blank-line-only change matches an update still being delivered`; `shows an out-of-sync error with a reload action when the renderer stops reconciling` (now sends a wrong generation first) | Version post removed from the pending branch: fails. Generation check removed: fails. |

**Decisions needed (03-F5).** Resolved by decision #4 (see Decisions applied): option A, mitigated by chunk 01 decision #3. Original analysis: with `files.trimTrailingWhitespace` on, autosave on, a hard break in the document and typing across autosaves, each cycle shows "This file changed outside the rich editor..." about the user's own save, and the resend restores the trimmed spaces. No data is lost; before this chunk the same race dropped keystrokes. After the 03-F2 fix, a manual Ctrl+S followed by typing during the save can show the same warning (before, those keystrokes were silently replaced). VS Code exposes no reliable "change made by a save participant" signal for saves the extension did not start (`files.autoSave`), so a precise fix is not a one-liner. Options:
- A. Keep as is and document it (current state).
- B. Show at most one conflict warning while one is still visible (host-side dedupe; message text unchanged).
- C. Treat changes made while the provider's own `document.save()` runs as silent (covers Ctrl+S and `markdownForHumans.autoSave`, not VS Code `files.autoSave`).
- D. Reword the warning to name save actions as a possible source.

**Gates after the fix round (2026-10-01):** `npm test` 184 suites passed, 3422 tests passed (27 skipped, 120 todo); `npm run lint` clean; `npx tsc --noEmit` clean; `npm run test:integration` 7 passing.

### Review fix round 3, iteration 1 (2026-10-01)

Claims from `claims-03.json` (round 3). Same method: a test that fails on the previous code for the stated reason, the fix, then an editor-level mutation check (no git).

| ID | Kind | Outcome | Change | Test(s) | Mutation check |
|---|---|---|---|---|---|
| 03-R1 | unresolved | fixed | The Ctrl+S bypass is now per message. The host tags the one update that carries the save-time policy result of a split's own Ctrl+S edit (`savePolicyEcho: true`). `savePolicyEchoByWebview` holds that result only while the edit's `applyEdit` runs, and the tag needs an exact content match. The renderer arms `allowNextHostSyncDespite*` only for a tagged update, which consumes them. Send-time arming, `savePolicyEditId` and the ACK disarm block are removed. So neither a Ctrl+S edit retired by a rebase (path a) nor an external write during its round trip (path b) can use the bypass. | undo-sync: `Y1: keeps the typing guard after a replay rebase retires an in-flight Ctrl+S edit` (a); `Y1: keeps the typing guard for an external change that lands before the Ctrl+S edit` (b, now a conflict notice and a resend); guard renamed to `Y1: still applies the host-tagged Ctrl+S save-policy echo over recent typing`. documentSyncRecovery: `tags the update that carries a Ctrl+S edit with its save-policy result` (it.each; second case `... and leaves an external change during the save untagged`) | Pre-iteration `editor.ts` restored: (a) and (b) fail (`setContent` replaced the typing). Renderer tag branch disabled: the guard fails. Host tag not posted: both host cases fail. Tag never set: both fail. Content match replaced by presence: the external-change case fails. `finally` delete removed: both fail (a later revert to the saved text was tagged). |
| 03-R5 | unresolved | fixed | Same change as 03-R1 (path a). | undo-sync: `Y1: keeps the typing guard after a replay rebase retires an in-flight Ctrl+S edit` | As 03-R1. |
| 03-R2 | unresolved | decision_for_user | No code change. Still recorded under Known limits and "Decisions needed (03-F5)". Resolved by decision #4 (see Decisions applied). | none | not applicable |
| 03-R3 | vacuous_test | fixed (test only) | Pins the hard-flag reset in `resetHostReconciliation`: replay applied after a hard rejection, a visible change deferred within the typing window, typing before its replay. | undo-sync: `Y1: rebases later typing once the replay after a hard rejection was applied` | Reset line removed: fails (`setContent` called a second time, typing lost). |
| 03-R4 | vacuous_test | fixed (test only) | Pins the hard-flag reset on an accepted ACK using the retry backoff path (the order the real host produces), not hand-ordered delivery: stale rejection and rebase, the resend hard-rejected, typing accepted inside the 250 ms wait, more typing, then the delayed replay. | undo-sync: `Y1: rebases typing when an accepted edit settled a hard rejection before the delayed replay` | Reset line removed: fails (`setContent('A B')` over 'A B C'). |

**Ordering assumption.** The tag relies on VS Code firing the edit's `onDidChangeTextDocument` before `workspace.applyEdit` resolves. The 03-F2 fix relied on the same order, since the ACK is posted only after `applyEdit` resolves. Jest simulates it; no Ext Host test covers it, so it is a manual check.

**Gates after round 3, iteration 1 (2026-10-01):** `npm test -- --maxWorkers=4` 184 suites passed, 3428 tests passed (27 skipped, 120 todo); `npm run lint` clean; `npx tsc --noEmit` clean; `npm run test:integration` 7 passing on VS Code 1.140.0.

### Decisions applied (2026-10-01)

The user approved all recommendations. Same method as the review rounds: test first and seen failing, then the change, then an editor-level mutation check from a private backup (no git).

| Item | Outcome | Change | Test(s) | Mutation check |
|---|---|---|---|---|
| Decision #1 (Y1 replay policy: typing wins over a racing outside change; replaced text offered through "Open Replaced Version") | confirmed, no code change | Decision text above marked confirmed. | Existing Y1 tests (Tests list and review rounds) | not applicable |
| Decision #2 (Y2 persistent out-of-sync banner) | done | New `src/webview/features/outOfSyncBanner.ts`: one `role="alert"` banner with a "Reload editor" button; never takes focus, so typing cannot press it. `requestHostReconciliation` shows it only where it posts `document.sync.failed` (retry budget exhausted), so retries in progress never show it. `resetHostReconciliation` (applied replay, Feedback authoritative apply) and an accepted edit ACK remove it. The button posts `document.sync.reload` (protocol version and view generation); the host checks both and calls `reloadOutOfSyncRenderer`, the same `webview.html` reset the notification's "Reload Editor" uses. The VS Code notification is unchanged. CSS uses theme variables only; Find moves into the toolbar row while the banner is shown, like the Feedback banners. | outOfSyncBanner: `shows one alert with a Reload editor action, without taking focus from typing`; `removes the alert once sync recovers and can show it again later`; `uses theme variables only and moves Find into the toolbar row while shown`. undo-sync, describe `Y2: out-of-sync banner (decision #2)`: `Y2: shows the banner only once replays are exhausted, and its action asks the host to reload`; `Y2: removes the banner when a later replay is applied`; `Y2: removes the banner when the host accepts a later edit`. documentSyncRecovery: `reloads the editor from the out-of-sync banner's Reload editor action` | Show call disabled: the "only once replays are exhausted" test fails. Banner shown on every transient request: same test fails. Reload posts `document.sync.request`: same test fails. Hide removed from `resetHostReconciliation`: the "later replay" test fails. Hide removed from the accepted ACK: the "accepts a later edit" test fails. Host `document.sync.reload` case removed: the host test fails. Host generation check removed: the host test fails. Notification no longer calls `reloadOutOfSyncRenderer`: the existing Y2 notification test fails. Banner module: idempotent guard removed, `role` removed, button focused on show, `hide` not removing, click not calling `onReload`: each fails a banner test. CSS: a literal color in a banner rule, or the Find selector removed: the CSS test fails. Every mutation failed only its named test(s). |
| Decision #4 (03-F5 / 03-R2 false conflict warning from save participants) | confirmed, no code change | Option A: mitigated by chunk 01 decision #3 (separate change); the residual for hard breaks authored as two trailing spaces stays under Known limits. | none | not applicable |
| Y3 wording (error with Retry; never saves a possibly stale `TextDocument`) | confirmed, no code change | Decision text above marked confirmed. | Existing Y3 tests | not applicable |
| Missing test: the gate that limits the `savePolicyEcho` tag to a modified Ctrl+S edit (`shouldEnforcePolicy && contentWasModified` in `applyEditNow`) | done (test only) | An external write during the edit leaves a delivery in flight, so the edit's own change is posted as a full update; that update must stay untagged unless it carries a policy-modified Ctrl+S result. | documentSyncRecovery: `leaves the update carrying %s untagged` (it.each: `a Ctrl+S edit the save-time policy left unchanged`; `a typing edit whose blank lines the strip policy removed`) | `contentWasModified` dropped: the unchanged Ctrl+S case fails (tagged). `shouldEnforcePolicy` dropped: the typing case fails (tagged). Both mutations survived the suite before this test. |

**Banner notes.**
- Placement: fixed at the top center (48 px), z-index 230, above the Feedback banners, since unsaved edits are the more urgent state. It can overlap a Feedback peer-lock banner; Feedback-locked views keep the old authoritative-apply behavior, so both at once is unlikely.
- The VS Code notification is not withdrawn when sync recovers or when the banner's button reloads the editor. Its "Reload Editor" stays live and reloads whichever renderer is current if clicked later (an unneeded reload). Pre-existing for recovery; the banner adds the reload-first path. Not changed here (open question: ignore a stale notification action when the view generation changed).

**Gates after decisions applied (2026-10-01):** `npm test -- --maxWorkers=3` 185 suites passed (1 skipped), 3437 tests passed (27 skipped, 120 todo); `npm run lint` clean; `npx tsc --noEmit` clean; `npm run test:integration` 7 passing on VS Code 1.140.0 (first run, no rerun). `editor.css` was already not Prettier-formatted at `39dfe56`; the new banner block matches Prettier output.

---

## 6. Refactor notes

Files over 1000 lines touched by this task.

**`src/editor/MarkdownEditorProvider.ts` (~11.6k lines).** Responsibility clusters (approximate current lines):
- Panel lifecycle and settings: `resolveCustomTextEditor` (1017-1260), `getHtmlForWebview` (~11383).
- Document sync host: `updateWebview`, `postDocumentVersion` (1263-1405), message routing for `edit`, `save`, `flushPendingEditAck`, `document.sync.*` inside `handleWebviewMessage` (1452-1980), version and generation bookkeeping (`getDocumentVersion` to `hashDocumentEditEnvelope`, 10624-10820), edit queue and save (`applyDocumentTeardownEdit` to `applyEditNow`, 10824-11300), frontmatter wrap/unwrap (11307-11380).
- Feedback controller: transports, peer locks, session transfer, peer release, snapshots, lifecycle (1982-7520, about 5.5k lines).
- Image host operations: save, completion delivery, resize, rename, references, reveal (7922-10240).
- Export, audit, links and file search (7526-7920, 9811-10120).
- Autosave bridge (10393-10600).
- Candidate extractions: `DocumentSyncHost` (delivery caches, `postDocumentVersion`, ACK history, flush barrier, `executeSaveAfterDocumentEdits`, `applyEditNow`), `FeedbackController`, `ImageHostService`. Pattern: Facade plus delegation. The provider stays the VS Code `CustomTextEditorProvider` facade and forwards typed messages to per-concern services that receive narrow ports (post, document, coordinator). Message routing fits a Command map (`type` to handler) instead of the 500-line switch.

**`src/webview/editor.ts` (~3.1k lines).**
- Module-level sync state: `hostReconciliationPending`, `localEditRejected`, `lastSentEditBaseVersion`, `hostContentDeferred`, attempt counters, `allowNextHostSyncDespite*`, `acceptedDocumentVersion` (175-235).
- Sync functions: `requestHostReconciliation`, `resetHostReconciliation`, `resumeHostReconciliation` (470-527), `getDocumentSyncController` (741-811), `updateEditorContent`, `updateEditorContentFromHost`, `rebaseUnacceptedLocalEdits`, `applyFeedbackPeerAuthoritativeContent` (2315-2465).
- Host message listener: one switch from 1414 to 2275 (update, version, ack, image, audit, flush, Feedback, navigation).
- Editor construction `initializeEditor` (846-1410), Feedback UI menus (2546-2810), settings and shortcuts (2812-2960).
- Candidate extraction: move the sync globals and functions above into the existing `DocumentSyncController` or a sibling `HostReconciliation` class. Pattern: State (explicit states: in sync, deferred host content, awaiting replay, out of sync) replaces seven flags and counters, which would also make the Y1/Y2 transitions testable without the module harness. The message switch fits a handler registry keyed by type.

**`src/webview/features/imageDragDrop.ts` (~1.2k lines).**
- Pending-save registry and waiters (42-150), drag/drop/paste wiring (166-680), file validation (685-775), insertion and completion mutations (836-1000), naming and conversion utilities (1004-1178).
- Candidate extraction: the pending-save registry (`tryReservePendingImageSave`, `releasePendingImageSave`, `waitForPendingImageSaves`) into `pendingImageSaves.ts`; it is shared state used by `editor.ts` sync, not drag/drop logic. Pattern: a small Monitor-style object with bounded waiters.
