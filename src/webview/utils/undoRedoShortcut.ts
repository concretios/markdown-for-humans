/**
 * Copyright (c) 2025-2026 Concret.io
 *
 * Licensed under the MIT License. See LICENSE file in the project root for details.
 */

/**
 * Undo/redo chord detection.
 *
 * VS Code's webview host forwards every keydown that reaches the window to the
 * workbench, which then runs its own `undo` on the TextDocument. ProseMirror has
 * already undone the edit by then, so one Ctrl+Z undid the document twice and the
 * renderer reported "This file changed outside the rich editor". The editor stops
 * these chords from propagating so only its own history runs.
 */

/**
 * Whether a keydown is Cmd/Ctrl+Z (undo), Cmd/Ctrl+Shift+Z (redo) or Ctrl+Y (redo).
 * Alt chords are left alone: they belong to other commands.
 *
 * @param event - The keydown event
 * @returns true when the event is an undo or redo chord
 */
export function isUndoRedoShortcut(event: KeyboardEvent): boolean {
  if (event.altKey) return false;
  if (!event.ctrlKey && !event.metaKey) return false;
  const key = event.key.toLowerCase();
  return key === 'z' || key === 'y';
}
