/**
 * Copyright (c) 2025-2026 Concret.io
 *
 * Licensed under the MIT License. See LICENSE file in the project root for details.
 *
 * @fileoverview Cross-process recovery destination shared by the host and
 * renderer Feedback lifecycle reducers.
 *
 * The two reducers previously diverged on their non-draft recovery target
 * (`HostRecoveryTarget` used `'Idle'`, `RendererRecoveryTarget` used `'Editing'`),
 * which meant a recovery target relayed across the host↔renderer boundary could
 * not be compared directly. They now share this single vocabulary and each maps
 * it to its own local resting state:
 *
 * - `'DraftAvailable'` — the failed operation left a resumable saved draft; both
 *   sides settle in their `DraftAvailable` state.
 * - `'NoDraft'` — no draft was retained; the host settles in `Idle` and the
 *   renderer settles in `Editing` (each process's normal no-session rest state).
 */

export type FeedbackRecoveryTarget = 'NoDraft' | 'DraftAvailable';
