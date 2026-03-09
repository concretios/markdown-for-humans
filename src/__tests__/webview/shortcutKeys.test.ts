/** @jest-environment jsdom */

import { isSaveShortcut } from '../../webview/utils/shortcutKeys';

describe('shortcutKeys', () => {
  it('matches Cmd/Ctrl+S with lowercase key', () => {
    expect(isSaveShortcut({ key: 's', metaKey: true, ctrlKey: false } as KeyboardEvent)).toBe(true);
    expect(isSaveShortcut({ key: 's', metaKey: false, ctrlKey: true } as KeyboardEvent)).toBe(true);
  });

  it('matches Cmd/Ctrl+S with uppercase key', () => {
    expect(isSaveShortcut({ key: 'S', metaKey: true, ctrlKey: false } as KeyboardEvent)).toBe(true);
    expect(isSaveShortcut({ key: 'S', metaKey: false, ctrlKey: true } as KeyboardEvent)).toBe(true);
  });

  it('does not match plain s without modifier', () => {
    expect(isSaveShortcut({ key: 's', metaKey: false, ctrlKey: false } as KeyboardEvent)).toBe(
      false
    );
  });
});
