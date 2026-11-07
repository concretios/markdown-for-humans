/**
 * @jest-environment jsdom
 */

import type { Editor } from '@tiptap/core';
import { createFormattingToolbar, setToolbarCopilotVisible } from '../../webview/BubbleMenuView';

const createEditor = () => {
  const chain: Record<string, unknown> = {};
  const chainProxy: unknown = new Proxy(chain, { get: () => () => chainProxy });
  return { chain: () => chainProxy, isActive: () => false, on: jest.fn() } as unknown as Editor;
};

describe('toolbar Add to GitHub Copilot button', () => {
  beforeEach(() => {
    // Availability starts unknown; every test sets it explicitly.
    setToolbarCopilotVisible(false);
  });

  it('sits in the AI group, right after the Copy AI reference button', () => {
    const toolbar = createFormattingToolbar(createEditor());
    const copyButton = toolbar.querySelector('.copy-reference-button') as HTMLElement;
    const copilotButton = toolbar.querySelector('.copilot-add-button') as HTMLElement;

    expect(copilotButton).toBeTruthy();
    expect(copilotButton.previousElementSibling).toBe(copyButton);
    // The two AI actions form one group: the separator comes after them.
    expect(copilotButton.nextElementSibling?.classList.contains('toolbar-separator')).toBe(true);
  });

  it('says what it does and shows the Copilot icon', () => {
    const toolbar = createFormattingToolbar(createEditor());
    const button = toolbar.querySelector('.copilot-add-button') as HTMLElement;

    expect(button.getAttribute('title')).toBe('Add to GitHub Copilot');
    expect(button.getAttribute('aria-label')).toBe('Add to GitHub Copilot');
    expect(button.querySelector('.codicon-copilot')).not.toBeNull();
  });

  it('stays hidden while GitHub Copilot is unavailable', () => {
    const toolbar = createFormattingToolbar(createEditor());
    const button = toolbar.querySelector('.copilot-add-button') as HTMLElement;

    expect(button.hidden).toBe(true);

    setToolbarCopilotVisible(true);
    expect(button.hidden).toBe(false);

    setToolbarCopilotVisible(false);
    expect(button.hidden).toBe(true);
  });

  it('starts the same add the click starts', () => {
    setToolbarCopilotVisible(true);
    const toolbar = createFormattingToolbar(createEditor());
    const listener = jest.fn();
    window.addEventListener('addToCopilot', listener);

    (toolbar.querySelector('.copilot-add-button') as HTMLElement).click();

    expect(listener).toHaveBeenCalledTimes(1);
    window.removeEventListener('addToCopilot', listener);
  });
});
