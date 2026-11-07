/**
 * @jest-environment jsdom
 */

import type { Editor } from '@tiptap/core';
import { createTocOverlay, showTocOverlay } from '../../webview/features/tocOverlay';
import * as l10n from '../../webview/l10n';

interface MockHeading {
  level: number;
  text: string;
}

/** Just enough editor for buildOutlineFromEditor and the overlay open/close paths. */
function createMockEditor(headings: MockHeading[]): Editor {
  const nodes = headings.map((heading, index) => ({
    node: {
      type: { name: 'heading' },
      attrs: { level: heading.level },
      textContent: heading.text,
      nodeSize: heading.text.length + 2,
    },
    pos: index * 10,
  }));
  return {
    state: {
      selection: { from: 0, to: 0 },
      doc: {
        content: { size: 100 },
        descendants: (visit: (node: unknown, pos: number) => boolean) => {
          nodes.forEach(entry => visit(entry.node, entry.pos));
        },
      },
    },
    commands: { focus: jest.fn(), setTextSelection: jest.fn() },
  } as unknown as Editor;
}

const sampleBundle: Record<string, string> = {
  'Document outline': '文档大纲',
  'Document Outline': '文档大纲',
  'Close outline': '关闭大纲',
  'Close (Esc)': '关闭 (Esc)',
  'No headings yet.': '还没有标题。',
  'Add {0} to see your document outline.': '添加 {0} 即可查看文档大纲。',
  '(Untitled)': '（无标题）',
};

describe('TOC overlay localization', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  afterEach(() => {
    document.body.innerHTML = '';
    l10n.resetL10n();
  });

  it('shows English when no bundle is loaded', () => {
    const overlay = createTocOverlay(createMockEditor([]));

    expect(overlay.getAttribute('aria-label')).toBe('Document outline');
    expect(overlay.querySelector('.toc-overlay-title')?.textContent).toBe('Document Outline');
    expect(overlay.querySelector('.toc-overlay-close')?.getAttribute('aria-label')).toBe(
      'Close outline'
    );
  });

  it('shows the translated title, close button and tooltip', () => {
    l10n.configureL10n(sampleBundle);

    const overlay = createTocOverlay(createMockEditor([]));

    const close = overlay.querySelector('.toc-overlay-close') as HTMLElement;
    expect(overlay.getAttribute('aria-label')).toBe('文档大纲');
    expect(overlay.querySelector('.toc-overlay-title')?.textContent).toBe('文档大纲');
    expect(close.getAttribute('aria-label')).toBe('关闭大纲');
    expect(close.title).toBe('关闭 (Esc)');
  });

  it('translates the empty state and keeps the code sample in the hint', () => {
    l10n.configureL10n(sampleBundle);
    const editor = createMockEditor([]);
    createTocOverlay(editor);

    showTocOverlay(editor);

    const empty = document.querySelector('.toc-overlay-empty') as HTMLElement;
    expect(empty.querySelector('p')?.textContent).toBe('还没有标题。');
    const hint = empty.querySelector('.toc-overlay-empty-hint') as HTMLElement;
    expect(hint.textContent).toBe('添加 # Heading 即可查看文档大纲。');
    expect(hint.querySelector('code')?.textContent).toBe('# Heading');
  });

  it('translates the label of a heading without text', () => {
    l10n.configureL10n(sampleBundle);
    const editor = createMockEditor([{ level: 2, text: '' }]);
    createTocOverlay(editor);

    showTocOverlay(editor);

    expect(document.querySelector('.toc-overlay-item-text')?.textContent).toBe('（无标题）');
  });
});
