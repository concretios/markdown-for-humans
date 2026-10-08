/** @jest-environment jsdom */

/**
 * Ctrl/Cmd+Z must undo once.
 *
 * ProseMirror undoes the edit itself, but VS Code's webview host forwards every
 * keydown that reaches the window to the workbench, which then runs its own
 * `undo` on the TextDocument as well. The second undo changes the file under the
 * renderer and surfaces "This file changed outside the rich editor" on every
 * Ctrl+Z. The editor keeps the chord to itself by stopping its propagation.
 */

import { isUndoRedoShortcut } from '../../webview/utils/undoRedoShortcut';

function keydown(init: KeyboardEventInit): KeyboardEvent {
  return new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
}

describe('isUndoRedoShortcut', () => {
  it('recognizes undo on Windows/Linux and macOS', () => {
    expect(isUndoRedoShortcut(keydown({ key: 'z', ctrlKey: true }))).toBe(true);
    expect(isUndoRedoShortcut(keydown({ key: 'z', metaKey: true }))).toBe(true);
  });

  it('recognizes redo as Ctrl+Shift+Z and Ctrl+Y', () => {
    expect(isUndoRedoShortcut(keydown({ key: 'Z', ctrlKey: true, shiftKey: true }))).toBe(true);
    expect(isUndoRedoShortcut(keydown({ key: 'z', metaKey: true, shiftKey: true }))).toBe(true);
    expect(isUndoRedoShortcut(keydown({ key: 'y', ctrlKey: true }))).toBe(true);
  });

  it('ignores Z and Y without a modifier', () => {
    expect(isUndoRedoShortcut(keydown({ key: 'z' }))).toBe(false);
    expect(isUndoRedoShortcut(keydown({ key: 'y' }))).toBe(false);
  });

  it('ignores chords that include Alt, which belong to other commands', () => {
    expect(isUndoRedoShortcut(keydown({ key: 'z', ctrlKey: true, altKey: true }))).toBe(false);
  });

  it('ignores other Ctrl/Cmd chords', () => {
    expect(isUndoRedoShortcut(keydown({ key: 'c', ctrlKey: true }))).toBe(false);
    expect(isUndoRedoShortcut(keydown({ key: 's', ctrlKey: true }))).toBe(false);
    expect(isUndoRedoShortcut(keydown({ key: 'b', metaKey: true }))).toBe(false);
  });
});
