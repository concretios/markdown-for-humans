/**
 * Copyright (c) 2025-2026 Concret.io
 *
 * Licensed under the MIT License. See LICENSE file in the project root for details.
 */

/**
 * Caret restore after the VS Code window regains focus.
 *
 * Recorded in VS Code 1.147 after Alt+Tab back to the window: Chromium first
 * restores focus to the editor, then about 50ms later the workbench's own
 * webview focus handling blurs the renderer frame (the active element drops to
 * <body>) and refocuses only the frame with `contentWindow.focus()`. Nothing
 * puts focus back on the editor, so keystrokes reach <body> and typing does
 * nothing until the user clicks the document. The host already works around
 * this for paste (`execCommand` refocuses the last focused element), which is
 * why Ctrl+V kept working while typing did not.
 *
 * The editor's ownership of focus is tracked through `focusin`, not sampled at
 * window blur: by the host's second blur the active element is already <body>.
 * When the window regains focus, focus is back on the editor if it was the last
 * focused surface and nothing else has claimed focus since.
 *
 * The same round trip can also move focus to the File menu. The webview host
 * forwards every key event to the workbench. Alt+Tab's Alt press is forwarded
 * while the editor has focus, and the workbench never resets it: its modifier
 * tracker resets on main-window blur, which already happened when focus
 * entered the webview frame. When the Alt release of the return trip reaches
 * this frame, the workbench reads press plus release as a clean Alt tap and
 * focuses the menu bar. An Alt release with no Alt press since this frame last
 * lost focus is the tail of a window switch, so it is kept from the host. A real
 * Alt tap (press and release both here) still opens the menu bar.
 */

export interface WindowFocusRestoreOptions {
  /** The renderer window whose focus events are observed. */
  win: Window;
  /** The editor's contenteditable root. */
  editorDom: HTMLElement;
  /** Focuses the editor while keeping its current selection (no scroll). */
  focusEditor: () => void;
}

/**
 * Installs the window focus restore listeners.
 *
 * @param options - Window, editor root and focus callback
 * @returns A function that removes the listeners
 */
export function installWindowFocusRestore({
  win,
  editorDom,
  focusEditor,
}: WindowFocusRestoreOptions): () => void {
  const doc = editorDom.ownerDocument;
  // Whether the editor was the last element in this document to take focus.
  // Focus falling back to <body> (window blur, host blur) does not change it.
  let editorOwnsFocus = editorDom.contains(doc.activeElement);
  let restoreTimer: number | null = null;
  // Whether this frame saw an Alt press since it last lost focus.
  let altPressedHere = false;

  const handleKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Alt') altPressedHere = true;
  };

  const handleKeyUp = (event: KeyboardEvent): void => {
    if (event.key !== 'Alt') return;
    const pressedHere = altPressedHere;
    altPressedHere = false;
    if (pressedHere) return;
    // Capture phase on the window runs before the host's forwarding listener.
    event.stopImmediatePropagation();
  };

  const handleWindowBlur = (): void => {
    altPressedHere = false;
  };

  const focusIsUnclaimed = (): boolean => {
    const active = doc.activeElement;
    return !active || active === doc.body || active === doc.documentElement;
  };

  const handleFocusIn = (event: FocusEvent): void => {
    const target = event.target;
    if (!(target instanceof Node) || target === doc.body || target === doc.documentElement) {
      return;
    }
    editorOwnsFocus = editorDom.contains(target);
  };

  const handleWindowFocus = (): void => {
    if (!editorOwnsFocus) return;
    if (restoreTimer !== null) win.clearTimeout(restoreTimer);
    // Wait one task: a click that brought the window back focuses its own
    // target during the same mousedown, and that choice must win.
    restoreTimer = win.setTimeout(() => {
      restoreTimer = null;
      if (!editorOwnsFocus || !editorDom.isConnected || !focusIsUnclaimed()) return;
      try {
        focusEditor();
      } catch (error) {
        console.error('[MD4H] Could not restore editor focus after window focus:', error);
      }
    }, 0);
  };

  doc.addEventListener('focusin', handleFocusIn, true);
  win.addEventListener('focus', handleWindowFocus);
  win.addEventListener('blur', handleWindowBlur);
  win.addEventListener('keydown', handleKeyDown, true);
  win.addEventListener('keyup', handleKeyUp, true);

  return () => {
    doc.removeEventListener('focusin', handleFocusIn, true);
    win.removeEventListener('focus', handleWindowFocus);
    win.removeEventListener('blur', handleWindowBlur);
    win.removeEventListener('keydown', handleKeyDown, true);
    win.removeEventListener('keyup', handleKeyUp, true);
    if (restoreTimer !== null) {
      win.clearTimeout(restoreTimer);
      restoreTimer = null;
    }
  };
}
