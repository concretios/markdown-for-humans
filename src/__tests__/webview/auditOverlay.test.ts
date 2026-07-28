/**
 * @jest-environment jsdom
 */

import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from '@tiptap/markdown';
import Link from '@tiptap/extension-link';
import { CustomImage } from '../../webview/extensions/customImage';
import {
  showAuditOverlay,
  showToast,
  dismissToast,
  clearToasts,
} from '../../webview/features/auditOverlay';
import { AuditIssue } from '../../webview/features/auditDocument';

let mockVscodeApi: { postMessage: jest.Mock };

describe('Audit Overlay UI', () => {
  let editor: Editor;

  beforeEach(() => {
    document.body.innerHTML = '<div id="editor"></div>';

    // Mock VS Code API so Browse button tests can assert postMessage calls
    mockVscodeApi = { postMessage: jest.fn() };
    (window as any).vscode = mockVscodeApi;

    // Create tiptap editor
    editor = new Editor({
      element: document.getElementById('editor') as HTMLElement,
      extensions: [
        StarterKit,
        CustomImage,
        Link,
        Markdown.configure({
          markedOptions: { gfm: true, breaks: true },
        }),
      ],
      content: '<p>Test content with a [broken link](missing.md)</p>',
    });
  });

  afterEach(() => {
    if (editor) {
      editor.destroy();
    }
    const overlay = document.getElementById('audit-overlay');
    if (overlay) {
      overlay.remove();
    }
    clearToasts();
    delete (window as any).vscode;
    delete (window as any).resolveImagePath;
    jest.clearAllMocks();
  });

  it('shows a toast notification when no issues found', () => {
    showAuditOverlay(editor, []);

    // Verify panel is NOT shown
    const overlay = document.getElementById('audit-overlay');
    expect(overlay).toBeNull();

    // Verify toast is shown
    const toastContainer = document.getElementById('toast-container');
    expect(toastContainer).not.toBeNull();

    const toast = document.querySelector('.toast');
    expect(toast).not.toBeNull();
    expect(toast?.classList.contains('toast-success')).toBe(true);
    expect(toast?.textContent).toContain('healthy');
    expect(toast?.textContent).toContain('no issues found');
  });

  it('shows a hover preview for image suggestion pills', async () => {
    (window as any).resolveImagePath = jest.fn().mockResolvedValue('resolved-image.png');

    const issues: AuditIssue[] = [
      {
        type: 'image',
        message: 'Image file not found',
        target: 'missing.png',
        suggestions: ['assets/missing.png'],
        pos: 1,
        nodeSize: 5,
      },
    ];

    showAuditOverlay(editor, issues);

    const pill = document.querySelector('.audit-suggestion-pill') as HTMLElement;
    expect(pill).not.toBeNull();

    pill.dispatchEvent(new Event('mouseover', { bubbles: true }));
    await new Promise(resolve => setTimeout(resolve, 0));

    const preview = document.querySelector('.audit-preview-popover');
    expect(preview).not.toBeNull();
    expect(preview?.textContent).toContain('Image preview');
    expect(preview?.querySelector('img')?.getAttribute('src')).toBe('resolved-image.png');
  });

  it('shows a hover preview for non-image suggestion pills', async () => {
    const issues: AuditIssue[] = [
      {
        type: 'link',
        message: 'Linked file not found',
        target: 'missing.md',
        suggestions: ['docs/missing.md'],
        pos: 1,
        nodeSize: 5,
      },
    ];

    showAuditOverlay(editor, issues);

    const pill = document.querySelector('.audit-suggestion-pill') as HTMLElement;
    expect(pill).not.toBeNull();

    pill.dispatchEvent(new Event('mouseover', { bubbles: true }));
    await new Promise(resolve => setTimeout(resolve, 0));

    const preview = document.querySelector('.audit-preview-popover');
    expect(preview).not.toBeNull();
    expect(preview?.textContent).toContain('File preview');
    expect(preview?.textContent).toContain('docs/missing.md');
  });

  it('hides the preview when a suggestion fix is applied', async () => {
    const issues: AuditIssue[] = [
      {
        type: 'link',
        message: 'Linked file not found',
        target: 'missing.md',
        suggestions: ['docs/missing.md'],
        pos: 1,
        nodeSize: 5,
      },
    ];

    showAuditOverlay(editor, issues);

    const pill = document.querySelector('.audit-suggestion-pill') as HTMLElement;
    expect(pill).not.toBeNull();

    pill.dispatchEvent(new Event('mouseover', { bubbles: true }));
    await new Promise(resolve => setTimeout(resolve, 0));

    const preview = document.querySelector('.audit-preview-popover') as HTMLElement;
    expect(preview).not.toBeNull();
    expect(preview?.classList.contains('visible')).toBe(true);

    pill.click();
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(preview?.classList.contains('visible')).toBe(false);
  });

  it('keeps preview hidden when async image preview resolves after fix', async () => {
    let resolveImagePathPromise: ((value: string) => void) | undefined;
    (window as any).resolveImagePath = jest.fn(
      () =>
        new Promise<string>(resolve => {
          resolveImagePathPromise = resolve;
        })
    );

    const issues: AuditIssue[] = [
      {
        type: 'image',
        message: 'Image file not found',
        target: 'missing.png',
        suggestions: ['assets/missing.png'],
        pos: 1,
        nodeSize: 1,
      },
    ];

    editor.commands.setContent('<p><img src="missing.png" /></p>', { emitUpdate: false });
    showAuditOverlay(editor, issues);

    const pill = document.querySelector('.audit-suggestion-pill') as HTMLButtonElement;
    pill.dispatchEvent(new Event('mouseover', { bubbles: true }));
    await new Promise(resolve => setTimeout(resolve, 0));

    const preview = document.querySelector('.audit-preview-popover') as HTMLElement;
    expect(preview).not.toBeNull();

    pill.click();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(preview.classList.contains('visible')).toBe(false);

    // Resolve the delayed preview request after fix; popover must stay hidden.
    if (typeof resolveImagePathPromise === 'function') {
      resolveImagePathPromise('resolved-image.png');
    }
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(preview.classList.contains('visible')).toBe(false);
  });

  it('applies auto-fix ONLY when clicking the fix button', () => {
    const issues: AuditIssue[] = [
      {
        type: 'link',
        message: 'Linked file not found',
        target: 'missing.md',
        suggestions: ['found.md'],
        pos: 1,
        nodeSize: 5,
      },
    ];

    // Initial HTML setup inside Tiptap
    editor.commands.setContent('<p><a href="missing.md">Text</a></p>', { emitUpdate: false });

    showAuditOverlay(editor, issues);

    const item = document.querySelector('.audit-overlay-item') as HTMLElement;
    const fixPill = document.querySelector('.audit-suggestion-pill') as HTMLButtonElement;

    expect(fixPill).not.toBeNull();

    // Clicking the item should simply navigate, but NOT alter the mark string.
    item.click();

    // Note: Our initial markup for href might be absolute due to link mark logic.
    // Check href update on fix
    fixPill.click();

    const html = editor.getHTML();
    expect(html).toContain('found.md');
    expect(document.querySelectorAll('.audit-overlay-item').length).toBe(0);
  });

  it('displays manual fix input when no suggestions exist', () => {
    const issues: AuditIssue[] = [
      {
        type: 'link',
        message: 'Linked file not found',
        target: 'missing.md',
        pos: 1,
        nodeSize: 5,
      },
    ];

    editor.commands.setContent('<p><a href="missing.md">Text</a></p>', { emitUpdate: false });
    showAuditOverlay(editor, issues);

    const input = document.querySelector('.audit-manual-input') as HTMLInputElement;
    const fixBtn = document.querySelector('.audit-fix-button.manual-fix') as HTMLButtonElement;

    expect(input).not.toBeNull();
    expect(input.placeholder).toContain('Fix link');
    expect(fixBtn).not.toBeNull();
    expect(fixBtn.textContent).toBe('Fix');
  });

  it('applies manual fix when user enters value and clicks Fix button', () => {
    const issues: AuditIssue[] = [
      {
        type: 'link',
        message: 'Linked file not found',
        target: 'missing.md',
        pos: 1,
        nodeSize: 5,
      },
    ];

    editor.commands.setContent('<p><a href="missing.md">Text</a></p>', { emitUpdate: false });
    showAuditOverlay(editor, issues);

    const input = document.querySelector('.audit-manual-input') as HTMLInputElement;
    const fixBtn = document.querySelector('.audit-fix-button.manual-fix') as HTMLButtonElement;

    // User enters the corrected value
    input.value = 'correct.md';
    fixBtn.click();

    const html = editor.getHTML();
    expect(html).toContain('correct.md');
    expect(document.querySelectorAll('.audit-overlay-item').length).toBe(0);
  });

  it('applies auto-fix for images with updateAttributes', () => {
    const issues: AuditIssue[] = [
      {
        type: 'image',
        message: 'Image source not found',
        target: 'missing.png',
        suggestions: ['found.png'],
        pos: 1,
        nodeSize: 1,
      },
    ];

    editor.commands.setContent('<p><img src="missing.png" /></p>', { emitUpdate: false });
    showAuditOverlay(editor, issues);

    const fixPill = document.querySelector('.audit-suggestion-pill') as HTMLButtonElement;
    expect(fixPill).not.toBeNull();

    fixPill.click();

    const html = editor.getHTML();
    expect(html).toContain('found.png');
    expect(document.querySelectorAll('.audit-overlay-item').length).toBe(0);
  });

  it('removes issue from list after successful fix', () => {
    const issues: AuditIssue[] = [
      {
        type: 'link',
        message: 'Linked file not found',
        target: 'missing.md',
        suggestions: ['found.md'],
        pos: 1,
        nodeSize: 5,
      },
      {
        type: 'link',
        message: 'Another broken link',
        target: 'missing2.md',
        suggestions: ['found2.md'],
        pos: 10,
        nodeSize: 5,
      },
    ];

    editor.commands.setContent(
      '<p><a href="missing.md">Text</a><a href="missing2.md">Text2</a></p>',
      { emitUpdate: false }
    );
    showAuditOverlay(editor, issues);

    expect(document.querySelectorAll('.audit-overlay-item').length).toBe(2);

    const fixPills = document.querySelectorAll('.audit-suggestion-pill');
    (fixPills[0] as HTMLButtonElement).click();

    expect(document.querySelectorAll('.audit-overlay-item').length).toBe(1);
  });

  // ── NEW TESTS: Enhanced suggestions, Browse button, heading labels ───────────

  it('renders multiple suggestion pills when issue has multiple suggestions', () => {
    const issues: AuditIssue[] = [
      {
        type: 'image',
        message: 'Image file not found: missing.png',
        target: 'missing.png',
        suggestions: ['images/found-a.png', 'images/found-b.png', 'assets/found-c.png'],
        pos: 1,
        nodeSize: 1,
      },
    ];

    showAuditOverlay(editor, issues);

    const pills = document.querySelectorAll('.audit-suggestion-pill');
    expect(pills.length).toBe(3);
    expect(pills[0].textContent).toContain('found-a.png');
    expect(pills[1].textContent).toContain('found-b.png');
    expect(pills[2].textContent).toContain('found-c.png');
  });

  it('renders a Browse button for image issues (allows file picker)', () => {
    const issues: AuditIssue[] = [
      {
        type: 'image',
        message: 'Image file not found: missing.png',
        target: 'missing.png',
        pos: 1,
        nodeSize: 1,
      },
    ];

    showAuditOverlay(editor, issues);

    const browseBtn = document.querySelector('.audit-browse-btn') as HTMLButtonElement;
    expect(browseBtn).not.toBeNull();
    expect(browseBtn.textContent).toContain('Browse');
  });

  it('renders a Browse button for link issues (allows file picker)', () => {
    const issues: AuditIssue[] = [
      {
        type: 'link',
        message: 'Linked file not found: missing.md',
        target: 'missing.md',
        pos: 1,
        nodeSize: 5,
      },
    ];

    showAuditOverlay(editor, issues);

    const browseBtn = document.querySelector('.audit-browse-btn') as HTMLButtonElement;
    expect(browseBtn).not.toBeNull();
    expect(browseBtn.textContent).toContain('Browse');
  });

  it('sends auditPickFile message with correct type when Browse button clicked for image', () => {
    const issues: AuditIssue[] = [
      {
        type: 'image',
        message: 'Image file not found: missing.png',
        target: 'missing.png',
        pos: 1,
        nodeSize: 1,
      },
    ];

    showAuditOverlay(editor, issues);

    const browseBtn = document.querySelector('.audit-browse-btn') as HTMLButtonElement;
    browseBtn.click();

    expect(mockVscodeApi.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'auditPickFile',
        fileType: 'image',
      })
    );
  });

  it('sends auditPickFile message with correct type when Browse button clicked for link', () => {
    const issues: AuditIssue[] = [
      {
        type: 'link',
        message: 'Linked file not found: missing.md',
        target: 'missing.md',
        pos: 1,
        nodeSize: 5,
      },
    ];

    showAuditOverlay(editor, issues);

    const browseBtn = document.querySelector('.audit-browse-btn') as HTMLButtonElement;
    browseBtn.click();

    expect(mockVscodeApi.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'auditPickFile',
        fileType: 'any',
      })
    );
  });

  it('renders heading suggestions with a descriptive label (not just the raw slug)', () => {
    const issues: AuditIssue[] = [
      {
        type: 'heading',
        message: 'Heading anchor not found: #old-title',
        target: 'old-title',
        suggestions: ['new-title', 'revised-title'],
        pos: 1,
        nodeSize: 5,
      },
    ];

    showAuditOverlay(editor, issues);

    // Should show a friendly hint label above the suggestion pills
    const hintEl = document.querySelector('.audit-heading-hint');
    expect(hintEl).not.toBeNull();
    expect(hintEl!.textContent).toMatch(/revised|changed|updated|renamed/i);

    const pills = document.querySelectorAll('.audit-suggestion-pill');
    expect(pills.length).toBe(2);
    expect(pills[0].textContent).toContain('new-title');
  });

  it('clicking a suggestion pill applies the fix and removes the issue', () => {
    const issues: AuditIssue[] = [
      {
        type: 'link',
        message: 'Linked file not found: missing.md',
        target: 'missing.md',
        suggestions: ['found-a.md', 'found-b.md'],
        pos: 1,
        nodeSize: 5,
      },
    ];

    editor.commands.setContent('<p><a href="missing.md">Text</a></p>', { emitUpdate: false });
    showAuditOverlay(editor, issues);

    const firstPill = document.querySelector('.audit-suggestion-pill') as HTMLButtonElement;
    expect(firstPill).not.toBeNull();
    firstPill.click();

    const html = editor.getHTML();
    expect(html).toContain('found-a.md');
    expect(document.querySelectorAll('.audit-overlay-item').length).toBe(0);
  });

  it('does NOT render a Browse button for URL issues (heading type)', () => {
    const issues: AuditIssue[] = [
      {
        type: 'heading',
        message: 'Heading anchor not found: #missing',
        target: 'missing',
        pos: 1,
        nodeSize: 5,
      },
    ];

    showAuditOverlay(editor, issues);

    // heading issues are anchor-only – no file picker needed
    const browseBtn = document.querySelector('.audit-browse-btn');
    expect(browseBtn).toBeNull();
  });
});

describe('Toast Notifications', () => {
  afterEach(() => {
    clearToasts();
    jest.useRealTimers();
  });

  it('shows a success toast with correct styling', () => {
    const toastId = showToast('Test success message', 'success');

    const toast = document.getElementById(toastId);
    expect(toast).not.toBeNull();
    expect(toast?.classList.contains('toast-success')).toBe(true);
    expect(toast?.textContent).toContain('Test success message');
  });

  it('shows a loading toast with hourglass icon', done => {
    const toastId = showToast('Auditing document...', 'loading');

    const toast = document.getElementById(toastId);
    expect(toast).not.toBeNull();
    expect(toast?.classList.contains('toast-loading')).toBe(true);
    expect(toast?.textContent).toContain('Auditing document...');

    // Wait for requestAnimationFrame animation
    setTimeout(() => {
      expect(toast?.classList.contains('visible')).toBe(true);
      done();
    }, 50);
  });

  it('dismissToast removes the loading toast', done => {
    const toastId = showToast('Loading...', 'loading');

    const toast = document.getElementById(toastId);
    expect(toast).not.toBeNull();

    // Wait for animation to apply visible class
    setTimeout(() => {
      dismissToast(toastId);

      // After dismissal and animation, should be gone
      setTimeout(() => {
        const removedToast = document.getElementById(toastId);
        expect(removedToast).toBeNull();
        done();
      }, 250);
    }, 50);
  });

  it('shows an info toast', () => {
    const toastId = showToast('Info message', 'info');

    const toast = document.getElementById(toastId);
    expect(toast).not.toBeNull();
    expect(toast?.classList.contains('toast-info')).toBe(true);
    expect(toast?.textContent).toContain('Info message');
  });

  it('success toast auto-dismisses', done => {
    const toastId = showToast('Success message', 'success');

    const toast = document.getElementById(toastId);
    expect(toast).not.toBeNull();

    // Should be gone after auto-dismiss timeout
    setTimeout(() => {
      const dismissedToast = document.getElementById(toastId);
      expect(dismissedToast).toBeNull();
      done();
    }, 3500);
  });

  it('loading toast does NOT auto-dismiss', done => {
    const toastId = showToast('Loading...', 'loading');

    const toast = document.getElementById(toastId);
    expect(toast).not.toBeNull();

    // Even after a long time, should still exist
    setTimeout(() => {
      const stillHere = document.getElementById(toastId);
      expect(stillHere).not.toBeNull();
      done();
    }, 3500);
  });

  it('clears pending toast animation and dismissal timers', () => {
    jest.useFakeTimers();

    showToast('Success message', 'success');
    expect(jest.getTimerCount()).toBeGreaterThan(0);

    clearToasts();

    expect(jest.getTimerCount()).toBe(0);
  });
});
