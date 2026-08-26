/** @jest-environment jsdom */

/**
 * Copyright (c) 2025-2026 Concret.io
 *
 * Licensed under the MIT License. See LICENSE file in the project root for details.
 *
 * Regression tests for inline `code` combined with another mark (link, bold,
 * italic, strike) on the same text run.
 *
 * TipTap 3.30 serializes marks by extension priority. MarkdownCode and
 * MarkdownLink set explicit priorities so formatting stays outside links and
 * inline code remains innermost, where its literal syntax cannot swallow any
 * surrounding Markdown marks.
 */

import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from '@tiptap/markdown';
import { MarkdownCode, MarkdownLink } from '../../webview/extensions/markdownCompatibilityMarks';
import { getEditorMarkdownForSync } from '../../webview/utils/markdownSerialization';
import { getSelectionAsMarkdown } from '../../webview/utils/copyMarkdown';

function createEditor(): Editor {
  const element = document.createElement('div');
  document.body.appendChild(element);
  return new Editor({
    element,
    extensions: [
      StarterKit.configure({ code: false, link: false, undoRedo: { depth: 100 } }),
      Markdown.configure({ markedOptions: { gfm: true, breaks: true } }),
      MarkdownCode,
      MarkdownLink.configure({ openOnClick: false }),
    ],
  });
}

describe('code + another mark round-trips through the real editor (save path)', () => {
  let editor: Editor;

  afterEach(() => {
    editor?.destroy();
  });

  it.each([
    ['code + link', '[`foo()`](./bar.ts:10)'],
    ['code + bold', '**`foo()`**'],
    ['code + italic', '*`foo()`*'],
    ['code + strike', '~~`foo()`~~'],
  ])('%s: %s round-trips unchanged', (_label, markdown) => {
    editor = createEditor();
    editor.commands.setContent(markdown, { contentType: 'markdown' });

    const out = getEditorMarkdownForSync(editor);

    expect(out).toBe(markdown);
  });

  it('link stays clickable (link mark present) after save-path serialization', () => {
    editor = createEditor();
    editor.commands.setContent('[`foo()`](./bar.ts:10)', { contentType: 'markdown' });

    const out = getEditorMarkdownForSync(editor);

    // The bug produced a single opaque code span (`[foo()](./bar.ts:10)`)
    // with no separate link syntax at all - assert the link survives as
    // real markdown link syntax, not swallowed literal text.
    expect(out).toBe('[`foo()`](./bar.ts:10)');
    expect(out).not.toBe('`[foo()](./bar.ts:10)`');
  });

  it('four-way combo (bold+italic+link+code) keeps code innermost and the link real', () => {
    editor = createEditor();
    editor.commands.setContent('[***`foo()`***](./bar.ts:10)', { contentType: 'markdown' });

    const out = getEditorMarkdownForSync(editor);

    // bold/italic are transparent and @tiptap/markdown may place them outside
    // the link (still valid, equivalent markdown) - the invariant that matters
    // is that `code` wraps only "foo()" and the link syntax is real, not that
    // bold/italic land on one specific side of the brackets.
    expect(out).toBe('***[`foo()`](./bar.ts:10)***');
    expect(out).toContain('`foo()`');
    expect(out).toContain('[`foo()`](./bar.ts:10)');
  });

  it('bold+italic+link without code is unaffected by the reordering', () => {
    editor = createEditor();
    editor.commands.setContent('[***text***](./bar.ts:10)', { contentType: 'markdown' });

    const out = getEditorMarkdownForSync(editor);

    expect(out).toBe('***[text](./bar.ts:10)***');
  });
});

describe('code + link survives the copy-as-markdown path', () => {
  let editor: Editor;

  afterEach(() => {
    editor?.destroy();
  });

  it('getSelectionAsMarkdown preserves the link around inline code', () => {
    editor = createEditor();
    editor.commands.setContent('[`foo()`](./bar.ts:10)', { contentType: 'markdown' });
    editor.commands.selectAll();

    const result = getSelectionAsMarkdown(editor);

    expect(result).toBe('[`foo()`](./bar.ts:10)');
  });
});
