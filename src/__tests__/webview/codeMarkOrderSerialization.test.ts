/** @jest-environment jsdom */

/**
 * Copyright (c) 2025-2026 Concret.io
 *
 * Licensed under the MIT License. See LICENSE file in the project root for details.
 *
 * Regression tests for inline `code` combined with another mark (link, bold,
 * italic, strike) on the same text run.
 *
 * Root cause: ProseMirror's `Mark.setFrom` (used when the parsed markdown JSON
 * is loaded into the live document) sorts a text node's `marks` array by
 * schema rank, not by how the marks were nested in the source. `code` is the
 * only mark here whose markdown syntax is literal/opaque — anything nested
 * inside a code span is not parsed as markdown. So whenever `code` isn't
 * first (innermost) in the marks array, the markdown serializer emits it as
 * outermost, and everything nested inside (a link's `[text](url)`, `**bold**`
 * markers, etc.) gets swallowed as literal text instead of being parsed.
 *
 * `reorderMarksForSerialization` (markdownSerialization.ts) fixes this by
 * moving `code` to the front of the marks array right before serialization.
 */

import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Link from '@tiptap/extension-link';
import { Markdown } from '@tiptap/markdown';
import type { JSONContent } from '@tiptap/core';
import {
  reorderMarksForSerialization,
  getEditorMarkdownForSync,
} from '../../webview/utils/markdownSerialization';
import { getSelectionAsMarkdown } from '../../webview/utils/copyMarkdown';

function createEditor(): Editor {
  const element = document.createElement('div');
  document.body.appendChild(element);
  return new Editor({
    element,
    extensions: [
      StarterKit.configure({ link: false, undoRedo: { depth: 100 } }),
      Markdown.configure({ markedOptions: { gfm: true, breaks: true } }),
      Link.configure({ openOnClick: false }),
    ],
  });
}

describe('reorderMarksForSerialization (unit)', () => {
  it('leaves a text node with no marks unchanged', () => {
    const node: JSONContent = { type: 'text', text: 'hello' };
    expect(reorderMarksForSerialization(node)).toEqual(node);
  });

  it('leaves a text node with a single mark unchanged', () => {
    const node: JSONContent = { type: 'text', text: 'hello', marks: [{ type: 'bold' }] };
    expect(reorderMarksForSerialization(node)).toEqual(node);
  });

  it('leaves marks unchanged when code is already first', () => {
    const node: JSONContent = {
      type: 'text',
      text: 'foo()',
      marks: [{ type: 'code' }, { type: 'italic' }],
    };
    expect(reorderMarksForSerialization(node)).toEqual(node);
  });

  it('moves code from the end to the front', () => {
    const node: JSONContent = {
      type: 'text',
      text: 'foo()',
      marks: [{ type: 'link', attrs: { href: './bar.ts' } }, { type: 'code' }],
    };
    expect(reorderMarksForSerialization(node).marks).toEqual([
      { type: 'code' },
      { type: 'link', attrs: { href: './bar.ts' } },
    ]);
  });

  it('moves code from the middle to the front, preserving relative order of the rest', () => {
    const node: JSONContent = {
      type: 'text',
      text: 'foo()',
      marks: [{ type: 'link', attrs: { href: 'x' } }, { type: 'code' }, { type: 'bold' }],
    };
    expect(reorderMarksForSerialization(node).marks).toEqual([
      { type: 'code' },
      { type: 'link', attrs: { href: 'x' } },
      { type: 'bold' },
    ]);
  });

  it('leaves marks unchanged when no code mark is present', () => {
    const node: JSONContent = {
      type: 'text',
      text: 'x',
      marks: [{ type: 'link', attrs: { href: 'x' } }, { type: 'bold' }, { type: 'italic' }],
    };
    expect(reorderMarksForSerialization(node)).toEqual(node);
  });

  it('recurses into nested content (doc > paragraph > text)', () => {
    const doc: JSONContent = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            {
              type: 'text',
              text: 'foo()',
              marks: [{ type: 'link', attrs: { href: './bar.ts' } }, { type: 'code' }],
            },
          ],
        },
      ],
    };
    const result = reorderMarksForSerialization(doc);
    expect(result.content?.[0]?.content?.[0]?.marks).toEqual([
      { type: 'code' },
      { type: 'link', attrs: { href: './bar.ts' } },
    ]);
  });
});

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
