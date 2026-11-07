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

describe('toolbar Copy Reference for AI button', () => {
  it('sits right after the Feedback button, which stays first', () => {
    const toolbar = createFormattingToolbar(createEditor());
    const button = toolbar.querySelector('.copy-reference-button') as HTMLElement;

    expect(button).toBeTruthy();
    expect(toolbar.firstElementChild?.hasAttribute('data-feedback-start')).toBe(true);
    expect(button.previousElementSibling).toBe(toolbar.firstElementChild);
    // The two AI actions form one group: Add to GitHub Copilot follows, then the separator.
    expect(button.nextElementSibling?.classList.contains('copilot-add-button')).toBe(true);
    expect(
      button.nextElementSibling?.nextElementSibling?.classList.contains('toolbar-separator')
    ).toBe(true);
  });

  it('says what it copies and shows the @ icon', () => {
    const toolbar = createFormattingToolbar(createEditor());
    const button = toolbar.querySelector('.copy-reference-button') as HTMLElement;

    expect(button.getAttribute('title')).toBe('Copy reference for AI (@file#L10-14)');
    expect(button.getAttribute('aria-label')).toBe('Copy reference for AI (@file#L10-14)');
    expect(button.querySelector('.codicon-mention')).not.toBeNull();
  });

  it('starts the same copy the command starts', () => {
    const toolbar = createFormattingToolbar(createEditor());
    const listener = jest.fn();
    window.addEventListener('copyReferenceForAi', listener);

    (toolbar.querySelector('.copy-reference-button') as HTMLElement).click();

    expect(listener).toHaveBeenCalledTimes(1);
    window.removeEventListener('copyReferenceForAi', listener);
  });
});
