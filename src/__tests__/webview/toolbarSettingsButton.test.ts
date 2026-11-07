/**
 * @jest-environment jsdom
 */

import type { Editor } from '@tiptap/core';
import { createFormattingToolbar } from '../../webview/BubbleMenuView';

const createEditor = () => {
  const chain: Record<string, unknown> = {};
  const chainProxy: unknown = new Proxy(chain, { get: () => () => chainProxy });
  return { chain: () => chainProxy, isActive: () => false, on: jest.fn() } as unknown as Editor;
};

describe('toolbar settings button', () => {
  it('is labeled for what it does: opening the extension settings', () => {
    const toolbar = createFormattingToolbar(createEditor());
    const gear = toolbar.querySelector('.settings-button') as HTMLElement;

    expect(gear).toBeTruthy();
    expect(gear.getAttribute('aria-label')).toBe('Extension settings');
    expect(gear.getAttribute('title')).toBe('Extension settings');
  });

  it('dispatches openExtensionSettings when clicked', () => {
    const toolbar = createFormattingToolbar(createEditor());
    const listener = jest.fn();
    window.addEventListener('openExtensionSettings', listener);

    (toolbar.querySelector('.settings-button') as HTMLElement).click();

    expect(listener).toHaveBeenCalledTimes(1);
    window.removeEventListener('openExtensionSettings', listener);
  });
});
