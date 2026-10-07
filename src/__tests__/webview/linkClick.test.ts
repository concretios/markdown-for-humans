import { shouldOpenLinkFromClick } from '../../webview/utils/linkClick';

describe('shouldOpenLinkFromClick', () => {
  it('does not open a link on a plain click, so the caret can be placed in its text', () => {
    expect(shouldOpenLinkFromClick({ metaKey: false, ctrlKey: false })).toBe(false);
  });

  it('opens on Cmd+click (macOS)', () => {
    expect(shouldOpenLinkFromClick({ metaKey: true, ctrlKey: false })).toBe(true);
  });

  it('opens on Ctrl+click (Windows and Linux)', () => {
    expect(shouldOpenLinkFromClick({ metaKey: false, ctrlKey: true })).toBe(true);
  });
});
