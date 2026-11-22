/** @jest-environment jsdom */

/**
 * The caret must survive the VS Code window losing and regaining focus.
 *
 * When the window comes back (Alt+Tab, a system emoji picker closing), VS Code's
 * webview host only calls `contentWindow.focus()` on the renderer frame. The
 * document's active element can be left on <body>, so typing went nowhere until
 * the user clicked into the document again. The renderer puts focus back on the
 * editor when it was the focused surface before the window lost focus.
 */

import { installWindowFocusRestore } from '../../webview/utils/windowFocusRestore';

describe('installWindowFocusRestore', () => {
  let editorDom: HTMLDivElement;
  let field: HTMLInputElement;
  let focusEditor: jest.Mock;
  let dispose: () => void;

  beforeEach(() => {
    jest.useFakeTimers();
    document.body.innerHTML = '';
    editorDom = document.createElement('div');
    editorDom.tabIndex = 0;
    editorDom.contentEditable = 'true';
    const child = document.createElement('p');
    child.tabIndex = 0;
    editorDom.appendChild(child);
    field = document.createElement('input');
    document.body.append(editorDom, field);
    focusEditor = jest.fn(() => editorDom.focus());
    dispose = installWindowFocusRestore({ win: window, editorDom, focusEditor });
  });

  afterEach(() => {
    dispose();
    jest.useRealTimers();
  });

  /** Simulates the window losing focus, optionally dropping the active element to body. */
  function leaveWindow({ dropFocus }: { dropFocus: boolean }): void {
    window.dispatchEvent(new FocusEvent('blur'));
    if (dropFocus) (document.activeElement as HTMLElement | null)?.blur();
  }

  function returnToWindow(): void {
    window.dispatchEvent(new FocusEvent('focus'));
    jest.runOnlyPendingTimers();
  }

  it('refocuses the editor when focus fell back to body after the window returns', () => {
    editorDom.focus();
    leaveWindow({ dropFocus: true });
    expect(document.activeElement).toBe(document.body);

    returnToWindow();

    expect(focusEditor).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(editorDom);
  });

  it('treats focus on an element inside the editor as editor focus', () => {
    (editorDom.firstElementChild as HTMLElement).focus();
    leaveWindow({ dropFocus: true });

    returnToWindow();

    expect(focusEditor).toHaveBeenCalledTimes(1);
  });

  it('does nothing when the editor still holds focus', () => {
    editorDom.focus();
    leaveWindow({ dropFocus: false });

    returnToWindow();

    expect(focusEditor).not.toHaveBeenCalled();
  });

  it('does not steal focus when another field was focused before the window left', () => {
    field.focus();
    leaveWindow({ dropFocus: true });

    returnToWindow();

    expect(focusEditor).not.toHaveBeenCalled();
  });

  it('does not override a focus target the user picked on return, such as a clicked field', () => {
    editorDom.focus();
    leaveWindow({ dropFocus: true });

    window.dispatchEvent(new FocusEvent('focus'));
    field.focus();
    jest.runOnlyPendingTimers();

    expect(focusEditor).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(field);
  });

  it('does not refocus a detached editor', () => {
    editorDom.focus();
    leaveWindow({ dropFocus: true });
    editorDom.remove();

    returnToWindow();

    expect(focusEditor).not.toHaveBeenCalled();
  });

  it('restores after VS Code blurs the frame again right after the native restore', () => {
    // Sequence recorded in VS Code 1.147 on Windows after Alt+Tab back:
    // native restore focuses the editor, the host blurs the frame ~50ms later
    // with focus already on <body>, then refocuses only the frame.
    editorDom.focus();
    leaveWindow({ dropFocus: false });
    window.dispatchEvent(new FocusEvent('focus'));
    jest.runOnlyPendingTimers();
    expect(focusEditor).not.toHaveBeenCalled();

    editorDom.blur();
    window.dispatchEvent(new FocusEvent('blur'));
    returnToWindow();

    expect(focusEditor).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(editorDom);
  });

  it('does not restore after focus moved to another field inside the webview', () => {
    editorDom.focus();
    field.focus();
    field.blur();
    leaveWindow({ dropFocus: true });

    returnToWindow();

    expect(focusEditor).not.toHaveBeenCalled();
  });

  it('stops listening after dispose', () => {
    dispose();
    editorDom.focus();
    leaveWindow({ dropFocus: true });

    returnToWindow();

    expect(focusEditor).not.toHaveBeenCalled();
  });

  describe('Alt release from a window switch', () => {
    /** Stands in for VS Code's webview host, which forwards key events from a bubble listener on the window. */
    let forwarded: string[];
    const forward = (event: KeyboardEvent): void => {
      forwarded.push(`${event.type}:${event.key}`);
    };

    beforeEach(() => {
      forwarded = [];
      window.addEventListener('keydown', forward);
      window.addEventListener('keyup', forward);
    });

    afterEach(() => {
      window.removeEventListener('keydown', forward);
      window.removeEventListener('keyup', forward);
    });

    function key(type: 'keydown' | 'keyup', init: KeyboardEventInit): KeyboardEvent {
      const event = new KeyboardEvent(type, { bubbles: true, cancelable: true, ...init });
      (document.activeElement ?? document.body).dispatchEvent(event);
      return event;
    }

    it('does not forward an Alt release whose press happened before the window left', () => {
      // Recorded in VS Code 1.147: the forwarded Alt press of Alt+Tab is never
      // reset in the workbench, so this release reads as a clean Alt tap and
      // moves focus to the File menu.
      editorDom.focus();
      key('keydown', { key: 'Alt', altKey: true });
      leaveWindow({ dropFocus: false });
      returnToWindow();

      key('keyup', { key: 'Alt' });

      expect(forwarded).toEqual(['keydown:Alt']);
    });

    it('does not forward an Alt release that arrives with no press at all', () => {
      editorDom.focus();

      key('keyup', { key: 'Alt' });

      expect(forwarded).toEqual([]);
    });

    it('still forwards a real Alt tap so Alt keeps opening the menu bar', () => {
      editorDom.focus();
      leaveWindow({ dropFocus: false });
      returnToWindow();

      key('keydown', { key: 'Alt', altKey: true });
      key('keyup', { key: 'Alt' });

      expect(forwarded).toEqual(['keydown:Alt', 'keyup:Alt']);
    });

    it('forwards other key releases untouched', () => {
      editorDom.focus();
      key('keydown', { key: 'Alt', altKey: true });
      leaveWindow({ dropFocus: false });
      returnToWindow();

      key('keyup', { key: 'b' });
      key('keyup', { key: 'Control' });

      expect(forwarded).toEqual(['keydown:Alt', 'keyup:b', 'keyup:Control']);
    });

    it('forwards Alt releases again after dispose', () => {
      dispose();
      editorDom.focus();

      key('keyup', { key: 'Alt' });

      expect(forwarded).toEqual(['keyup:Alt']);
    });
  });

  it('keeps working when focusing the editor throws', () => {
    focusEditor.mockImplementation(() => {
      throw new Error('view destroyed');
    });
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    editorDom.focus();
    leaveWindow({ dropFocus: true });

    expect(() => returnToWindow()).not.toThrow();
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
