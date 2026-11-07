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
import * as l10n from '../../webview/l10n';

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
      content: '<p><a href="broken.md">Test content</a></p>',
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
    // The popover deliberately enters on the next animation frame. Waiting on
    // a zero-delay timer races requestAnimationFrame in jsdom and made the full
    // suite intermittently assert before the visible class was applied.
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));

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

  describe('list reflow after fixing issues', () => {
    /**
     * Build N manual-fix link issues anchored to real positions in the doc so
     * applyFix can dispatch a transaction for each one.
     */
    function buildLinkIssues(count: number): AuditIssue[] {
      return Array.from({ length: count }, (_, index) => ({
        type: 'link' as const,
        message: `Broken link ${index + 1}`,
        target: `missing-${index + 1}.md`,
        suggestions: [],
        pos: 1,
        nodeSize: 1,
      }));
    }

    it('renders no standalone separator nodes between issues', () => {
      showAuditOverlay(editor, buildLinkIssues(3));

      const overlay = document.getElementById('audit-overlay') as HTMLElement;
      expect(overlay.querySelectorAll('.audit-overlay-item')).toHaveLength(3);
      expect(overlay.querySelectorAll('.audit-issue-separator')).toHaveLength(0);
      expect(overlay.querySelectorAll('hr')).toHaveLength(0);
    });

    it('leaves no empty placeholder rows after fixing several issues', () => {
      showAuditOverlay(editor, buildLinkIssues(4));

      const overlay = document.getElementById('audit-overlay') as HTMLElement;
      const list = overlay.querySelector('.audit-overlay-list') as HTMLElement;

      // Fix the first two issues via their manual Fix buttons.
      for (let i = 0; i < 2; i++) {
        const fixBtn = list.querySelector('.audit-fix-button.manual-fix') as HTMLButtonElement;
        expect(fixBtn).not.toBeNull();
        fixBtn.click();
      }

      // Every remaining child must be a real issue row, not a leftover divider.
      const children = Array.from(list.children);
      expect(children).toHaveLength(2);
      children.forEach(child => {
        expect(child.classList.contains('audit-overlay-item')).toBe(true);
      });
    });

    it('keeps the header count in sync with the remaining rows', () => {
      showAuditOverlay(editor, buildLinkIssues(3));

      const overlay = document.getElementById('audit-overlay') as HTMLElement;
      const title = overlay.querySelector('.audit-overlay-title') as HTMLElement;
      expect(title.textContent).toContain('3 issues');

      (overlay.querySelector('.audit-fix-button.manual-fix') as HTMLButtonElement).click();
      expect(title.textContent).toContain('2 issues');

      (overlay.querySelector('.audit-fix-button.manual-fix') as HTMLButtonElement).click();
      expect(title.textContent).toContain('1 issue');
    });
  });

  describe('localization', () => {
    // Leaves out "Fix" on purpose, to exercise the fallback to English.
    const sampleBundle: Record<string, string> = {
      'Document Audit ({0} issue)': '文档审核（{0} 项问题）',
      'Document Audit ({0} issues)': '文档审核（共 {0} 项问题）',
      Close: '关闭',
      'Navigate to issue': '转到问题',
      'Jump to issue': '跳转到问题',
      'Fix link...': '修复链接...',
      'Browse…': '浏览…',
      'Open file picker to select the correct file': '打开文件选择器以选择正确的文件',
      'Waiting…': '等待中…',
      'Heading name changed slightly. Pick the updated one:':
        '标题名称略有变化，请选择更新后的标题：',
      'Update the link to the anchor GitHub uses:': '请将链接更新为 GitHub 使用的锚点：',
      'Your document is healthy: no issues found!': '文档状态良好，未发现问题！',
      'All fixed! 🎉': '全部修复！🎉',
      Preview: '预览',
      'File preview': '文件预览',
      'Preview unavailable': '无法预览',
      'Image preview is not available for this path.': '此路径无法预览图片。',
    };

    const linkIssue = (index: number): AuditIssue => ({
      type: 'link',
      message: `Broken link ${index}`,
      target: `missing-${index}.md`,
      pos: 1,
      nodeSize: 1,
    });

    afterEach(() => {
      l10n.resetL10n();
      document.querySelector('.audit-preview-popover')?.remove();
    });

    it('shows English when no bundle is loaded', () => {
      showAuditOverlay(editor, [linkIssue(1), linkIssue(2)]);

      expect(document.querySelector('.audit-overlay-title')?.textContent).toBe(
        'Document Audit (2 issues)'
      );
      expect(document.querySelector('.audit-overlay-close')?.getAttribute('aria-label')).toBe(
        'Close'
      );
    });

    it('translates the title with its count, for one issue and for several', () => {
      l10n.configureL10n(sampleBundle);

      showAuditOverlay(editor, [linkIssue(1), linkIssue(2)]);
      const title = document.querySelector('.audit-overlay-title') as HTMLElement;
      expect(title.textContent).toBe('文档审核（共 2 项问题）');

      (document.querySelector('.audit-fix-button.manual-fix') as HTMLButtonElement).click();
      expect(title.textContent).toBe('文档审核（1 项问题）');
    });

    it('translates the single issue title on first render', () => {
      l10n.configureL10n(sampleBundle);

      showAuditOverlay(editor, [linkIssue(1)]);

      expect(document.querySelector('.audit-overlay-title')?.textContent).toBe(
        '文档审核（1 项问题）'
      );
    });

    it('translates labels written inside the HTML template and escapes them', () => {
      l10n.configureL10n({ ...sampleBundle, Close: '关闭 "x" <b>' });

      showAuditOverlay(editor, [linkIssue(1)]);

      const closeBtn = document.querySelector('.audit-overlay-close') as HTMLElement;
      expect(closeBtn.getAttribute('aria-label')).toBe('关闭 "x" <b>');
      expect(closeBtn.querySelector('b')).toBeNull();
    });

    it('translates the row buttons, input placeholder and Browse button', () => {
      l10n.configureL10n(sampleBundle);

      showAuditOverlay(editor, [linkIssue(1)]);

      const nav = document.querySelector('.audit-issue-nav-btn') as HTMLButtonElement;
      expect(nav.getAttribute('aria-label')).toBe('转到问题');
      expect(nav.title).toBe('跳转到问题');
      expect((document.querySelector('.audit-manual-input') as HTMLInputElement).placeholder).toBe(
        '修复链接...'
      );
      expect(document.querySelector('.audit-fix-button')?.textContent).toBe('Fix');
      const browse = document.querySelector('.audit-browse-btn') as HTMLButtonElement;
      expect(browse.textContent?.trim()).toBe('浏览…');
      expect(browse.title).toBe('打开文件选择器以选择正确的文件');
      expect(browse.querySelector('.codicon-folder')).not.toBeNull();
    });

    it('translates the Browse button while waiting for the picker', () => {
      l10n.configureL10n(sampleBundle);
      showAuditOverlay(editor, [linkIssue(1)]);

      const browse = document.querySelector('.audit-browse-btn') as HTMLButtonElement;
      browse.click();

      expect(browse.textContent?.trim()).toBe('等待中…');
      expect(browse.querySelector('.codicon-clock')).not.toBeNull();
    });

    it('translates the heading hint', () => {
      l10n.configureL10n(sampleBundle);

      showAuditOverlay(editor, [
        {
          type: 'heading',
          message: 'Heading anchor not found: #introduction',
          target: 'introduction',
          suggestions: ['introductin'],
          pos: 1,
          nodeSize: 1,
        },
      ]);

      expect(document.querySelector('.audit-heading-hint')?.textContent).toBe(
        '标题名称略有变化，请选择更新后的标题：'
      );
    });

    it('translates the hint on an older-form link', () => {
      l10n.configureL10n(sampleBundle);
      showAuditOverlay(editor, [
        {
          type: 'heading',
          message: 'Link works in this editor but not on GitHub: #ber-uns',
          target: 'ber-uns',
          suggestions: ['über-uns'],
          olderFormAnchor: true,
          pos: 1,
          nodeSize: 1,
        },
      ]);

      expect(document.querySelector('.audit-heading-hint')?.textContent).toBe(
        '请将链接更新为 GitHub 使用的锚点：'
      );
    });

    it('translates the healthy toast and the all fixed message', () => {
      l10n.configureL10n(sampleBundle);

      showAuditOverlay(editor, []);
      expect(document.querySelector('.toast-message')?.textContent).toBe(
        '文档状态良好，未发现问题！'
      );

      showAuditOverlay(editor, [linkIssue(1)]);
      (document.querySelector('.audit-fix-button.manual-fix') as HTMLButtonElement).click();
      expect(document.querySelector('.audit-overlay-list')?.textContent).toBe('全部修复！🎉');
    });

    it('translates the suggestion preview headers and texts', () => {
      l10n.configureL10n(sampleBundle);
      showAuditOverlay(editor, [
        {
          type: 'link',
          message: 'Linked file not found: missing.md',
          target: 'missing.md',
          suggestions: ['docs/guide.md'],
          pos: 1,
          nodeSize: 1,
        },
        {
          type: 'image',
          message: 'Image file not found: missing.png',
          target: 'missing.png',
          suggestions: ['images/found.png'],
          pos: 2,
          nodeSize: 1,
        },
      ]);
      const [filePill, imagePill] = Array.from(
        document.querySelectorAll<HTMLElement>('.audit-suggestion-pill')
      );

      filePill.dispatchEvent(new Event('mouseover', { bubbles: true }));
      expect(document.querySelector('.audit-preview-header')?.textContent).toBe('文件预览');

      imagePill.dispatchEvent(new Event('mouseover', { bubbles: true }));
      return Promise.resolve().then(() => {
        expect(document.querySelector('.audit-preview-header')?.textContent).toBe('无法预览');
        expect(document.querySelector('.audit-preview-empty')?.textContent).toBe(
          '此路径无法预览图片。'
        );
      });
    });
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

  it('renders host error text literally instead of parsing it as markup (#93)', () => {
    const payload = '<img src=https://x/y>';
    const toastId = showToast(payload, 'info');

    const toast = document.getElementById(toastId);
    expect(toast?.querySelector('img')).toBeNull();
    expect(toast?.querySelector('.toast-message')?.textContent).toBe(payload);
  });

  it('renders a first keyed Feedback error literally as well', () => {
    const payload = 'Draft failed: <b id="injected">bad</b>';
    const toastId = showToast(payload, 'info', { dedupeKey: 'feedback-local-error' });

    const toast = document.getElementById(toastId);
    expect(toast?.querySelector('#injected')).toBeNull();
    expect(toast?.querySelector('.toast-message')?.textContent).toBe(payload);
    expect(toast?.querySelector('.toast-icon.codicon-info')).not.toBeNull();
  });

  it('shows an info toast', () => {
    const toastId = showToast('Info message', 'info');

    const toast = document.getElementById(toastId);
    expect(toast).not.toBeNull();
    expect(toast?.classList.contains('toast-info')).toBe(true);
    expect(toast?.textContent).toContain('Info message');
  });

  it('coalesces one keyed Feedback error and refreshes its dismissal lifetime', () => {
    jest.useFakeTimers();

    const firstId = showToast('Could not start Feedback.', 'info', {
      dedupeKey: 'feedback-local-error',
    });
    jest.advanceTimersByTime(2_000);
    const secondId = showToast('Could not start Feedback.', 'info', {
      dedupeKey: 'feedback-local-error',
    });

    expect(secondId).toBe(firstId);
    expect(document.querySelectorAll('.toast-info')).toHaveLength(1);

    jest.advanceTimersByTime(2_999);
    expect(document.getElementById(firstId)).not.toBeNull();
    jest.advanceTimersByTime(201);
    expect(document.getElementById(firstId)).toBeNull();
  });

  it('replaces the message in an existing keyed Feedback error toast', () => {
    const firstId = showToast('First Feedback error.', 'info', {
      dedupeKey: 'feedback-local-error',
    });
    const secondId = showToast('Newest Feedback error.', 'info', {
      dedupeKey: 'feedback-local-error',
    });

    expect(secondId).toBe(firstId);
    expect(document.querySelectorAll('.toast-info')).toHaveLength(1);
    expect(document.getElementById(firstId)?.textContent).toContain('Newest Feedback error.');
    expect(document.getElementById(firstId)?.textContent).not.toContain('First Feedback error.');
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
