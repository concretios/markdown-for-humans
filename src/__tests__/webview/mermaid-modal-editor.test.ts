/**
 * @jest-environment jsdom
 *
 * Tests for mermaid modal editor and content updates
 */

import { showMermaidEditor } from '../../webview/features/mermaidEditor';
import * as l10n from '../../webview/l10n';

describe('Mermaid Modal Editor', () => {
  it('should return edited code when saved', async () => {
    const initialCode = 'graph TD\nA-->B';

    // Simulate user clicking Save button quickly
    setTimeout(() => {
      const saveBtn = document.querySelector('#save-btn') as HTMLButtonElement;
      if (saveBtn) saveBtn.click();
    }, 10);

    const result = await showMermaidEditor(initialCode);

    expect(result.wasSaved).toBe(true);
    expect(result.code).toBe(initialCode);
  });

  it('should return edited code with changes when saved', async () => {
    const initialCode = 'graph TD\nA-->B';
    const newCode = 'graph LR\nX-->Y';

    // Simulate user editing and saving
    setTimeout(() => {
      const textarea = document.querySelector('.mermaid-editor-textarea') as HTMLTextAreaElement;
      const saveBtn = document.querySelector('#save-btn') as HTMLButtonElement;

      if (textarea) textarea.value = newCode;
      if (saveBtn) saveBtn.click();
    }, 10);

    const result = await showMermaidEditor(initialCode);

    expect(result.wasSaved).toBe(true);
    expect(result.code).toBe(newCode);
  });

  it('should return original code when cancelled', async () => {
    const initialCode = 'graph TD\nA-->B';

    // Simulate user clicking Cancel
    setTimeout(() => {
      const cancelBtn = document.querySelector('#cancel-btn') as HTMLButtonElement;
      if (cancelBtn) cancelBtn.click();
    }, 10);

    const result = await showMermaidEditor(initialCode);

    expect(result.wasSaved).toBe(false);
    expect(result.code).toBe(initialCode);
  });

  it('should close on Escape key', async () => {
    const initialCode = 'graph TD\nA-->B';

    // Simulate user pressing Escape
    setTimeout(() => {
      const overlay = document.querySelector('.mermaid-editor-overlay') as HTMLElement;
      if (overlay) {
        const event = new KeyboardEvent('keydown', { key: 'Escape' });
        overlay.dispatchEvent(event);
      }
    }, 10);

    const result = await showMermaidEditor(initialCode);

    expect(result.wasSaved).toBe(false);
  });
});

describe('Mermaid Modal Editor localization', () => {
  const sampleBundle: Record<string, string> = {
    'Edit Mermaid Diagram': '编辑 Mermaid 图表',
    'Close (Esc)': '关闭 (Esc)',
    Close: '关闭',
    Cancel: '取消',
  };

  afterEach(() => {
    document.body.innerHTML = '';
    l10n.resetL10n();
  });

  it('shows English when no bundle is loaded', () => {
    const pending = showMermaidEditor('graph TD');

    expect(document.querySelector('h3')?.textContent?.trim()).toBe('Edit Mermaid Diagram');
    expect(document.querySelector('#save-btn')?.textContent).toBe('Save');
    (document.querySelector('#cancel-btn') as HTMLButtonElement).click();
    return pending;
  });

  it('shows the translated title, buttons and tooltips', async () => {
    l10n.configureL10n(sampleBundle);
    const pending = showMermaidEditor('graph TD');

    const closeBtn = document.querySelector('#close-btn') as HTMLButtonElement;
    expect(document.querySelector('h3')?.textContent?.trim()).toBe('编辑 Mermaid 图表');
    expect(closeBtn.title).toBe('关闭 (Esc)');
    expect(closeBtn.getAttribute('aria-label')).toBe('关闭');
    expect(document.querySelector('#cancel-btn')?.textContent).toBe('取消');
    // Not in the bundle: falls back to English.
    expect(document.querySelector('#save-btn')?.textContent).toBe('Save');
    closeBtn.click();
    await pending;
  });
});
