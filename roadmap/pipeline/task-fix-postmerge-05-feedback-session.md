# Task: Fix Feedback session reliability findings from post-merge review

## 1. Task Metadata

- **Task name:** Fix Feedback session reliability findings
- **Slug:** fix-postmerge-05-feedback-session
- **Status:** in-progress
- **Created:** 2026-09-30
- **Last updated:** 2026-10-01
- **Shipped:** _(pending)_
- **Base:** `origin/main` @ `1b8244b`
- **Overview:** `task-fix-postmerge-00-overview.md`

---

## 2. Context & Problem

Feedback session lifecycle (start, save item, discard, locks) has failure modes that leave the user stuck or with duplicate data, especially on remote hosts, CRLF files and slow disks.

---

## 3. Desired Outcome & Scope

**Success criteria:**
- Discard works on Remote-SSH, WSL and dev containers
- Start Feedback succeeds first time on CRLF files and on dirty files with save participants
- No pending request can leave the UI in "Saving..." forever
- No duplicate items after a slow save
- `npm test` and Ext Host tests pass

**In scope:** F1 to F7
**Out of scope:** capture and rendering (chunk 06), entry UX (chunk 07)

---

## 4. Findings

### F1. MED (#93): Discard always fails on remote hosts. Plausible-high.

- **Where:** `src/editor/MarkdownEditorProvider.ts:5518`, `:7473` (`workspace.fs.delete(..., { useTrash: true })`)
- **Defect:** VS Code throws "Unable to delete file via trash because provider does not support it" when the provider lacks the Trash capability. The node `DiskFileSystemProvider` on remote hosts does not declare it. `package.json` sets `extensionKind: ["workspace"]`, so the extension runs remote.
- **Scenario:** Discard errors on every remote setup; drafts accumulate under `.md4h/feedback`.
- **Fix direction:** check `workspace.fs.isWritableFileSystem` / provider capabilities or catch the error; fall back to permanent delete after a confirmation prompt.
- **Test first:** mocked `fs.delete` throwing the trash error triggers the confirm-and-delete path.

### F2. MED (#93): screenshot save timeout can create duplicate items. Logic confirmed; timing plausible.

- **Where:** `src/webview/features/feedbackReview.ts:5202-5209`; modal re-enables at `src/webview/features/feedbackCaptureWorkflow.ts:332-341`
- **Defect:** after 15s the webview drops the pending entry and rejects, but the host request is not cancelled.
- **Scenario:** slow host (queued mutations, large PNG). User clicks Add again; the first write commits late as an ordinary `feedback.updated`; session has two identical screenshot items.
- **Fix direction:** idempotency key per add request; host dedupes by key. Or send a cancel and have the host honor it before commit.
- **Test first:** delayed first write plus retry yields one item.

### F3. MED-LOW (#93): text save or edit stuck on "Saving..." forever. Plausible.

- **Where:** `src/webview/features/feedbackReview.ts:5495-5500` drops `feedback.error` without `sessionId` while a session is active. Host omits `sessionId` when `requireFeedbackSession` throws "This feedback session is no longer active" (`src/editor/MarkdownEditorProvider.ts:4013`; catch at `:5586-5591` adds it only when `requestSession` is set).
- **Scenario:** only screenshots have a timeout. Text add, edit, delete or restore never settles; composer stays on "Saving..." with Cancel disabled and Escape ignored (`feedbackReview.ts:4764`, `:4783-4786`).
- **Fix direction:** host always echoes the request id; webview settles pending requests by request id, not session id. Add a timeout to all mutation requests.
- **Test first:** host error without `sessionId` for a pending text add settles the request and re-enables the composer.

### F4. LOW (#93): Start Feedback fails on CRLF files with a pending edit. Confirmed by code.

- **Where:** expected flush hash is SHA-256 of LF-normalized content (`src/editor/MarkdownEditorProvider.ts:1689-1692`); `handleFeedbackDocumentChange` (`:6912-6924`) compares against `e.document.getText()`, which VS Code normalized to CRLF. Throws "source changed" at `:6773`.
- **Fix direction:** normalize EOL on both sides before hashing.
- **Test first:** CRLF document with a pending debounced edit starts Feedback.

### F5. LOW (#93): Start Feedback on a dirty doc fails when a save participant edits text. Confirmed.

- **Where:** `flushFeedbackSnapshot` captures version then calls `document.save()` (`src/editor/MarkdownEditorProvider.ts:3866-3872`); `prepareSource` rejects on version change (`src/editor/feedbackSnapshotService.ts:397`).
- **Scenario:** first Start after typing fails; retry succeeds.
- **Fix direction:** capture the version after `save()` resolves.
- **Test first:** save participant that edits text; Start succeeds first time.

### F6. LOW (#93): stale report lock can block a bundle permanently. Plausible.

- **Where:** `src/editor/feedbackSessionStore.ts:5138`, `:5192` recover only on `process.kill(pid, 0)` ESRCH.
- **Scenario:** crash mid-write; PID reused (likely in containers). EPERM or an unrelated live process means "blocked" forever: "Another window or process is updating..." until the user deletes `.lock` manually. Lock has no host or boot identity.
- **Related:** `writeFileAtomically` (`:4927`) does not fsync before rename.
- **Fix direction:** store hostname, boot time or extension session id plus a timestamp in the lock; treat locks older than a threshold as stale.
- **Test first:** lock owned by a live unrelated PID with an old timestamp is recovered.

### F7. LOW (#93): Undo-delete button re-enables while a restore is in flight. Confirmed.

- **Where:** `src/webview/features/feedbackReview.ts:2779` uses only `hasWritableSession()`; delete buttons check pending requests (`:2804-2811`).
- **Scenario:** any card re-render during the round trip re-enables Undo; second click sends a duplicate `feedback.item.restore` and a spurious error.
- **Fix direction:** apply the same pending-request check as delete.
- **Test first:** re-render during pending restore keeps Undo disabled.

---

## 5. Progress

Worktree `fix/postmerge-05-feedback-session` on `origin/main` @ `6412d17`. All tests below were written first and observed failing for the stated reason before the fix.

| ID | Test | Fix | Verified |
|---|---|---|---|
| F1 | 3 new provider tests; 1 existing test updated | done | `npm test` |
| F2 | 1 provider, 1 protocol, 1 review, 1 capture workflow test | done | `npm test` |
| F3 | 2 review tests | done | `npm test` |
| F4 | 1 provider test | done | `npm test` |
| F5 | 1 provider test | done | `npm test` |
| F6 | 3 store tests | done (no fsync) | `npm test` |
| F7 | 1 review test | done | `npm test` |

### Tests

- `src/__tests__/editor/feedbackProvider.test.ts`, describe `post-merge session reliability (task-fix-postmerge-05)`:
  - `F1: permanently deletes a live draft after a second confirmation when Trash is unsupported`
  - `F1: keeps a live draft active when permanent deletion is declined`
  - `F1: permanently deletes an inactive draft after a second confirmation when Trash is unsupported`
  - `F2: dedupes a retried screenshot add by idempotency key while the first write is still queued`
  - `F4: starts Feedback on a CRLF document whose pending flush edit arrives as LF`
  - `F5: starts Feedback on the first try when a save participant edits the dirty document`
  - Updated: `correlates and unlocks the inactive-draft discard owner on error` now accepts the permanent-delete prompt so the error path still runs (2 delete calls).
- `src/__tests__/shared/feedbackProtocol.test.ts`: `F2: carries an optional bounded idempotency key on screenshot additions only`
- `src/__tests__/webview/feedbackReview.test.ts`:
  - `F7: keeps Undo disabled across a re-render while its restore is in flight`
  - `F3: settles a pending text add when the host error omits the session id`
  - `F3: ignores a sessionless host error that matches no pending request` (regression guard, passed before and after)
  - `F2: forwards the capture idempotency key and attempt on screenshot additions` (renamed by decision #7)
- `src/__tests__/webview/feedbackCaptureWorkflow.test.ts`: `F2: reuses one idempotency key when Add is retried within the same annotation`
- `src/__tests__/editor/feedbackSessionStore.test.ts`:
  - `F6: recovers an old identity-stamped lock even when an unrelated process reuses its PID`
  - `F6: recovers an old lock left by an earlier extension host that had this same PID`
  - `D8: stamps locks with only a per-instance tag and never reclaims an old lock owned by this live host` (was `F6: stamps locks with host identity ...`, changed by decision #8)
  - `F6: does not reclaim an old-stamped lock whose file was written within 5 minutes` (characterization of the existing ctime guard)
- `src/__tests__/editor/feedbackProvider.test.ts`, banner Resume entry point (`feedback.draft.resume`) with real on-disk lock lines:
  - `F6: surfaces a durable error when a fresh report lock blocks banner Resume`
  - `F6: banner Resume reclaims an old identity-stamped lock whose PID is alive`
- `src/__tests__/webview/feedbackReview.test.ts`: `F6: surfaces a saved-draft Resume error that arrives while the transition lock is held` (regression guard for the pre-session toast path, passed before and after; the F6 fix is host side)

### Decisions

- **F1, research.** VS Code `FileService.doValidateDelete` throws "Unable to delete file '{0}' via trash because provider does not support it." when `useTrash` is set and the provider lacks `FileSystemProviderCapabilities.Trash`. `workspace.fs.delete` with `useTrash` always routes through that service (`extHostFileSystemConsumer.delete`). The node `DiskFileSystemProvider` (used by the remote server) does not declare Trash; only the desktop client adds it via `extraCapabilities.trash`. The message is localized and arrives as a plain `Error`, so the code does not match on text. It mirrors the Explorer (`fileActions.ts` "Failed to delete using the Trash. Do you want to permanently delete instead?"): any Trash failure gets a second modal, "Delete permanently". Declining keeps the draft and the session (live: `phase` back to `active`, no error; inactive: transition unlocks normally). Session state and path containment are revalidated after the second answer. Helper: `MarkdownEditorProvider.deleteFeedbackBundle`.
- **F2.** Idempotency key, not a cancel protocol. Key is created once per annotation dialog in `openAnnotation` (`feedbackCaptureWorkflow.ts`) and reused by every Add click in that dialog; replace requests do not carry it (replace is already idempotent per item id). Host keeps `ActiveFeedbackSession.screenshotAddKeys` (key to item id, optional field, carried across resume by the existing spread) and answers a repeat with `feedback.updated` while that item still exists. Host mutations are already serialized by `mutationPlanningQueue`, so a retry that arrives while the first write is queued sees the committed key. Tradeoff: a retry with edited text or annotation in the same dialog returns the first committed item unchanged. _Superseded by decision #7 (see Decisions applied)._
- **F3.** The protocol already carries `requestId` on `feedback.error`, and the host always echoes it. Only the webview filter was wrong. The fix admits a sessionless `feedback.error` when its `requestId` matches a pending mutation. Pending mutations are cleared on deactivate, so this cannot cross sessions. **No timeout was added to text, edit, delete or restore requests**: with request-id settlement every host path answers, and a timeout would reopen the F2 duplicate race for text adds. Needs a human call if a lost-message guard is still wanted.
- **F4.** Both sides of the flush hash comparison are normalized `\r\n` to `\n` (`expectedFlushContentSha256` and `handleFeedbackDocumentChange`).
- **F5.** Two defects, not one: the version was captured before `save()`, and the participant's change event invalidated the transition. `flushFeedbackSnapshot` now marks `FeedbackTransition.acceptingSaveEdits` around `save()` and captures version and text after it. Changes accepted that way set `recoveryRequired` so a later failure still resyncs the renderers. Peers are locked and the queue drained before save, so only save participants or other extensions can edit in that window; the snapshot binds to whatever save wrote.
- **F6.** Lock line gains `<hostTag> <instanceTag>` (16 hex SHA-256 prefix of `os.hostname()`, so no machine name is written to the workspace, and 24 hex random per extension host). An old (5 min, existing threshold) identity-stamped lock is stale unless it belongs to this exact live host instance. Legacy 3-field locks keep the old PID-death rule. Tradeoff: a different live process on the same machine that holds the lock for more than 5 minutes loses it; Feedback writes hold it for milliseconds. **fsync not added**: `writeFileAtomically` uses `writeFile` plus `rename`, so fsync needs an explicit file handle (open, write, sync, close), not a one-line change. _Lock line format superseded by decision #8 (see Decisions applied): the host tag is gone._
- **F6 follow-up (manual check failed).** Two causes. (1) Recovery requires the lock's timestamp and the file's mtime and ctime to be 5 minutes old. `touch -t` backdates mtime but not ctime, so a lock written by hand stays blocked for 5 real minutes; the manual check clicked Resume about 1 minute after writing it. This guard is intended and unchanged. (2) The blocked Resume error was easy to miss. Resume wrapped the lock error as "The feedback draft could not be read: ...", the only visible channel was a webview toast that appears after the ~2 s lock wait and auto-dismisses after 3 s, and in-session errors only reach the screen-reader live region. Fix: `FeedbackReportLockBusyError` (store) keeps its own message through Resume, the message now says a lock left by a closed window clears after 5 minutes, and the provider also raises `vscode.window.showErrorMessage` for it.
- **F7.** Undo render checks pending `restore` mutations, like Delete. On restore error the live button is found by `data-feedback-undo-id` because a re-render replaces the clicked element; the stored `button` reference was removed.
- Out of scope, noted: the image rename overwrite path (`handleRenameImage`) also uses `useTrash: true` and silently falls back to permanent delete without a prompt.

### Review fix round

Findings from the post-implementation review (`05-F1` to `05-F10`). Each mutation check reverted only the guarded production line in an editor, ran the named tests, confirmed they failed, then restored the line.

| ID | Outcome | Tests | Mutation check |
|---|---|---|---|
| 05-F1 (MED) sessionless error for a pending Finish or finish preview was dropped | fixed: the webview filter also admits a sessionless `feedback.error` whose `requestId` equals `pendingFinishRequestId` or `pendingPreviewRequestId` (both cleared when the session or dialog ends) | review: `F3: reopens the completion checkpoint when a Finish error omits the session id`, `F3: lets a finish preview retry when its error omits the session id` (both failed first: state stayed `finishing` / `loading`) | dropping the Finish clause failed the Finish test; dropping the preview clause failed the preview test |
| 05-F2 (MED, coverage) no test for the revalidation after "Delete permanently" or for declining it on an inactive draft | fixed (tests only) | provider: `F1: rechecks the live session after the permanent-delete answer before deleting`, `F1: rechecks inactive-draft path containment after the permanent-delete answer`, `F1: keeps an inactive draft when permanent deletion is declined` | `await revalidate()` replaced by `void revalidate` failed both recheck tests (bundle deleted, `feedback.discarded` / `feedback.draft.discarded` posted); removing `if (!deleted) return;` on the inactive path failed the decline test |
| 05-F3 (MED) in-session failures were visible only in the screen-reader live region | fixed: the provider raises `vscode.window.showErrorMessage` for `FeedbackReportLockBusyError` (as before) and for in-session actions without their own error surface (`FEEDBACK_NOTIFIED_ERROR_MESSAGES`: text add, edit, delete, restore, discard, reveal, reveal in OS, copy diagnostics). Screenshot, Finish and preview failures keep their in-dialog messages and are not notified twice | provider: `F3: raises a VS Code notification when an in-session item action fails` (in-session delete, sessionless text add, and a screenshot add that must not notify), `F3: raises a VS Code notification when the permanent delete of a live draft fails` (both failed first) | making the set check always false failed both tests; making it always true failed the screenshot no-notification assertion |
| 05-F4 (LOW) Retake after a screenshot timeout mints a new key, so the late first write and the retake both commit | resolved by decision #7 (see Decisions applied) | none | n/a |
| 05-F5 (LOW) a same-dialog retry with edited text or annotation returns the first committed item | resolved by decision #7 (see Decisions applied) | none | n/a |
| 05-F6 (LOW) F3 guard test was vacuous (watched `.feedback-frame-label` synchronously) | fixed (test only): it now flushes the `announce()` task and asserts `.feedback-live-region` never receives the message | review: `F3: ignores a sessionless host error that matches no pending request` | dropping the pending-request clause (admit every sessionless error with a request id), and admitting every `feedback.error` with a request id, both failed it |
| 05-F7 (LOW) frozen `Date.now` spy turned a Resume regression into a hang | fixed (test only): the spy shifts the real clock by 10 minutes instead of freezing it | provider: `F6: banner Resume reclaims an old identity-stamped lock whose PID is alive` | with the identity-stamped branch regressed to the PID rule: old spy gave a generic 10 s timeout, "Jest did not exit", killed at 45 s; new spy fails in about 3 s with "Timed out waiting for feedback.started" and exits |
| 05-F8 (LOW) webview F6 test was listed as failing first but passes on pre-chunk code | fixed: relabeled above as a regression guard; fixture now uses the exact `FeedbackReportLockBusyError` text | review: `F6: surfaces a saved-draft Resume error that arrives while the transition lock is held` | changing the pre-session toast condition (`!session`) so it never fires failed it |
| 05-F9 (LOW) stale store header and `handleFeedbackDocumentChange` JSDoc | fixed (comments only) | none | n/a, comment-only |
| 05-F10 (LOW) lock host tag never changes the ownership decision; it writes a hostname hash | resolved by decision #8 (see Decisions applied) | none | n/a |

Notes:
- A sessionless error for a request the webview no longer tracks (it already deactivated) can show both the webview toast and the new notification. This needs a request racing session end and is accepted.
- Decision options are in the agent report for this round: 05-F4/05-F5 (retry semantics after a screenshot timeout) and 05-F10 (drop the host tag, a lock-line format change). Both were decided; see Decisions applied.

### Review fix round 3, iteration 1

Claims `05-R1` and `05-R2` are coverage gaps left by the round above. The production code was already correct, so both fixes are tests only. Each mutation edited `src/editor/MarkdownEditorProvider.ts` in place (no stash or checkout), ran `src/__tests__/editor/feedbackProvider.test.ts`, then restored the file from a private backup.

| ID | Outcome | Tests | Mutation check |
|---|---|---|---|
| 05-R1 (LOW) the post-"Delete permanently" revalidate had no test for the inactive-draft transition check or the live-draft containment check | fixed (tests only) | provider: `F1: rechecks live-draft path containment after the permanent-delete answer` (the report becomes a symlink out of the bundle while the modal is open), `F1: rechecks the inactive-draft transition after the permanent-delete answer` (an outside source change invalidates the locked transition while the modal is open) | removing only `await session.store.validateContainedPaths()` from the live callback failed the live containment test; removing only `this.assertFeedbackTransition(...)` from the inactive callback failed the transition test. In both, the bundle was deleted and the discard succeeded; 1 failed of 178 each |
| 05-R2 (LOW) 5 of 8 `FEEDBACK_NOTIFIED_ERROR_MESSAGES` members, and the Finish, preview, replace and close exclusions, were unpinned | fixed (tests only) | provider: `F3: a failed $type request notifies: $notified`, one `it.each` case per webview request type. The table is a `Record<FeedbackWebviewMessage['type'], ...>`, so a new request type does not compile until it is classified. Each case removes the workspace and has no live session, checks that the error is `recoverable` (it reached the shared catch, not the malformed path) and that `showErrorMessage` ran exactly once or not at all. Five acknowledgement and navigation types (`peer.reveal`, `controller.ready`, `peer.lock.acquired`, `peer.released`, `session.transfer.ack`) are `null`: they ignore stale input or report it before the shared catch, so set membership cannot change their behavior | 24 runs: removing each of the 8 members, and adding each of the 16 failing non-members (screenshot add and replace, capture error, Finish, preview, the 4 close messages, start, start new, draft resume, reveal and discard, transition applied and retry), each failed exactly its own case (1 failed, 23 passed) |

### Decisions applied

User-approved product decisions #7 (resolves `05-F4`, `05-F5`) and #8 (resolves `05-F10`). Tests were written first and observed failing before the change: provider and protocol cases as malformed requests, store and banner Resume cases on the unparsed new lock line, the workflow Retake case on a fresh key. Each mutation changed one production line in place, ran the named tests, confirmed the failure, then restored the file from a private backup (no stash, checkout or reset).

**#7 protocol: one retry identity per capture.** The key lives from the first annotation until the capture is saved or cancelled, across every Add click and every Retake. Each Add click carries the next `attempt`.

```
webview (feedbackCaptureWorkflow.openAnnotation)
  first annotation: key K = new, attempts = 0
  Retake: next annotation reuses { K, attempts }
  each Add click: attempts += 1 -> screenshot.add { idempotencyKey: K, attempt }

host (screenshotAddKeys: K -> { itemId, attempt, contentSha256 })
  no entry, or newer attempt after the item was deleted -> add item, record it
  attempt <= recorded attempt                            -> no write, feedback.updated
  same content hash, item live                           -> no write, keep max attempt
  newer attempt, different content, item live            -> replace item in place
```

- Why not `replacesKey`: after two Retakes where the middle dialog never sent an Add, the third dialog would have to carry every earlier key. One key plus a monotonic attempt covers any chain and both commit orders with one integer.
- Host mutations are FIFO through `mutationPlanningQueue`, so the late first write normally commits first. The attempt number makes the outcome independent of that order.
- `attempt` is required with `idempotencyKey` and is a positive safe integer; either alone is malformed. The webview and host ship together, so no protocol version bump.
- The content hash covers start and end ordinal, comment and PNG data URL, so a Retake of a different area counts as different content.
- The key map is in-memory session state, like `previewRevisions`. A replaced item keeps its ID and asset path; `replaceFeedbackScreenshot` is now shared with `feedback.screenshot.replace`, whose behavior is unchanged.

| Item | Outcome | Tests | Mutation check |
|---|---|---|---|
| #7a same-dialog Add retry after the timeout with edited text or annotation replaces the first committed item; identical content still dedupes | done | provider: `D7: a same-dialog retry with edited text and annotation replaces the late first item`, `F2: dedupes a retried screenshot add by idempotency key while the first write is still queued` (now sends attempts 1 and 2 and asserts the preview URI is unchanged). Protocol: `D7: requires a positive integer attempt with every screenshot idempotency key`, `F2: carries an optional bounded idempotency key on screenshot additions only` (updated). Review: `F2: forwards the capture idempotency key and attempt on screenshot additions`. Workflow: `F2: reuses one idempotency key when Add is retried within the same annotation` (now asserts attempts 1 then 2, and 1 for the next capture) | disabling the host replace branch failed the edited-retry and Retake-after tests (2 failed of 4 run); dropping the identical-content check failed only the F2 dedupe test; dropping the parser's attempt check failed only the D7 protocol test; dropping `attempt` from the controller post failed only the review F2 test; removing `retry.attempts += 1` failed both workflow tests; removing the preview revision bump from `replaceFeedbackScreenshot` failed the edited-retry test and the existing `returns a scoped capture preview URI and changes it after replacement` |
| #7b Retake after a timeout replaces the earlier capture; the session ends with one item holding the Retake whichever commits first | done | provider: `D7: a Retake that commits after the late first write replaces that item`, `D7: a late first write that commits after the Retake leaves the Retake in place`. Workflow: `D7: keeps the idempotency key across Retake with a newer attempt` | dropping `attempt <= prior.attempt` failed only the late-after-Retake test; not passing `addRetry` into Retake failed only the workflow Retake test |
| #8 drop the hostname hash from the report lock line, keep the per-instance tag | done | store: `D8: stamps locks with only a per-instance tag and never reclaims an old lock owned by this live host`, `D8: recovers an old lock in the earlier format that also carried a host hash` (regression guard, passed before). Fixtures moved to the new line: store `F6: recovers an old identity-stamped lock even when an unrelated process reuses its PID`, `F6: recovers an old lock left by an earlier extension host that had this same PID`, `F6: does not reclaim an old-stamped lock whose file was written within 5 minutes`; provider `F6: surfaces a durable error when a fresh report lock blocks banner Resume`, `F6: banner Resume reclaims an old identity-stamped lock whose PID is alive` | writing the host hash back into the line failed only the D8 stamp test (format assertion); removing the optional 16-hex group from the parser failed only the D8 earlier-format test; never protecting this host's own instance tag failed only the D8 stamp test (lock reclaimed); reverting the whole store file to its pre-#8 backup failed the D8 stamp test and both F6 recovery tests |

**#8 lock line.** `<pid> <ISO time> <24 hex token> <24 hex instance tag>`. The instance tag is random per extension host and records nothing about the machine.

- The unreleased 5-field line (`... <16 hex host hash> <instance tag>`) still parses; the hash is ignored and the instance tag decides ownership, so an old one is recovered after 5 minutes. An unparseable lock would block the bundle forever.
- The released 3-field line keeps the PID-death rule. Any other malformed line stays blocked, as before.
- The D8 stamp test removes its lock with `rm(..., { force: true })`, so a lock-stealing regression reports its assertion instead of ENOENT.

**Manual check line (replaces the 5-field line).** `1 2026-01-01T00:00:00.000Z aaaaaaaaaaaaaaaaaaaaaaaa bbbbbbbbbbbbbbbbbbbbbbbb`, written to `<bundle>/feedback.md.lock`. Banner Resume shows the "clears after 5 minutes" notification until the lock file's ctime is 5 minutes old, then Resume reclaims it.

## 6. Refactor notes

Observations from this task, for a later refactoring plan. Line numbers are approximate at this branch.

### `src/editor/MarkdownEditorProvider.ts` (~11.5k lines)

| Cluster | Approx. lines and symbols | Candidate extraction | Pattern and why |
|---|---|---|---|
| Feedback message router | 4748-5660 `handleFeedbackWebviewMessage` (one ~900 line switch: close handshake, text/screenshot add, edit, delete, restore, finish, discard, diagnostics) | `FeedbackSessionCommands` with one handler per message type | Command: each case already has its own validation, store call and reply; a handler map makes them testable without the provider. |
| Transition lifecycle | 5723-6000 `startFeedbackSession`, `beginFeedbackTransition`; 6802-6990 `assertFeedbackTransition`, `lockFeedbackTransition`, `endFeedbackTransition`, `handleFeedbackDocumentChange`; 6988-7340 resume paths; 7476-7560 `discardInactiveFeedbackDraft` | `FeedbackTransitionController` owning the `FeedbackTransition` record | State machine: flags `acceptingFlushEdit`, `acceptingSaveEdits`, `invalidated`, `recoveryRequired`, `ownerLockPosted`, `ownerDisposed` encode implicit states (flushing, saving, locked, recovering). Explicit states would make F4/F5 style holes visible. |
| Snapshot flush and verify | 3648-4025 `flushFeedbackWebview(s)`, `inspectFeedbackSnapshotSplits`, `flushFeedbackSnapshot`, `finalizeFeedbackRendererSnapshot` | `FeedbackSnapshotCoordinator` beside `feedbackSnapshotService.ts` | Facade over drain, save, read bytes and renderer apply; the stateless verifier already exists. |
| Peer locks and release | 2221-2410 lock acquisition; 2924-3280 peer release; 6283-6800 register, unregister, retire | `FeedbackPeerLockRegistry` | Mediator: coordinates many webviews per document; today the provider is the mediator by accident. |
| Session transfer | 2413-2925 `beginFeedbackSessionTransfer` and staging/commit/rollback | `FeedbackSessionTransfer` | State machine (apply, commit, abort phases are already explicit in the protocol). |
| Critical delivery and ACK transport | 1959-2220, 3278-3430 | `FeedbackDeliveryChannel` | Facade with retry policy; isolates `postMessage` vs application ACK semantics (pitfall 5). |
| Document sync and edit queue | 1444-1960 `handleWebviewMessage` edit branch; 10699-11320 edit ACKs, drains, `applyEdit` | `DocumentSyncHost` | Already separated by concern in pitfalls 1 to 4; extraction is mostly a move. |
| Image handling | 7986-10420 (image save, resize, rename, references, reveal, search) | `ImageMessageHandlers` | Command; unrelated to Feedback and the largest single block. |
| Audit and links | 7611-7990, 10056-10305 | `AuditHandlers`, `LinkHandlers` | Command. |

### `src/webview/features/feedbackReview.ts` (~6k lines)

| Cluster | Approx. lines and symbols | Candidate extraction | Pattern and why |
|---|---|---|---|
| Controller closure state | 960-1110: ~60 `let` variables in `createFeedbackReviewController` | Group into typed sub-states (session, composer, completion, transition) | State machine for the request lifecycle; `pendingMutations` is the de facto request registry (F3, F7 both came from it being consulted inconsistently). |
| Pending request registry | `pendingMutations` set at 2795, 2935, 3005, 4788, 5210; settled at 5580-5610 and 5795-5850 | `FeedbackRequestTracker` with `register`, `settleById`, `isPending(kind, id)` | Repository plus single settlement path; render code asks it instead of re-deriving sets. |
| Rail and cards rendering | 2738-3100 `renderCards`; 3747-3880 `renderMarkers` | `FeedbackRailView` | Pure view from state; makes re-render safety (F7) testable. |
| Annotation layout | 3263-3720 measure, layout, brackets | `feedbackAnnotationLayout.ts` already holds the algorithm; move the DOM measuring adapter next to it | Adapter. |
| Block action and selection | 1648-2025, 3917-3980, 5929-5995 | `FeedbackBlockActionController` | Mediator between selection events and the action button. |
| Completion dialog | 2158-2590 | `FeedbackCompletionDialog` | Facade, mirrors `feedbackDiscardDialog.ts`. |
| Host message dispatch | 5495-5910 `handleHostMessage` | Handler map per message type | Command, symmetric with the host side. |

### `src/editor/feedbackSessionStore.ts` (~5.2k lines)

| Cluster | Approx. lines and symbols | Candidate extraction | Pattern and why |
|---|---|---|---|
| Store aggregate | 960-3160 `FeedbackSessionStore` create/resume/add/replace/update/delete/restore/seal | Keep as the aggregate root | Repository already; the class is large because V1 and V2 paths coexist. |
| V1 report codec | 3162-4040 parse/render V1 report | `feedbackReportV1.ts` beside the existing `feedbackReportV2.ts` | Strategy per schema version. |
| PNG validation | 611-890 `decodeAndValidateFeedbackPng`, CRC, Adam7 | `feedbackPng.ts` | Pure module, no store state. |
| Validation helpers | 4038-4330, 4693-4790 | `feedbackValidation.ts` | Pure functions. |
| Safe filesystem and locking | 4795-5260 `readBoundedRegularFile`, `writeFileAtomically`, screenshot backups, `withExclusiveReportLock`, stale-lock recovery | `feedbackFileSafety.ts` (or `ReportLock` class) | Facade over fs; isolates the F6 policy and makes a future fsync change one place. |
