/** @jest-environment jsdom */

/**
 * Regression: @tiptap/markdown@3.30.5 HTML-entity-encodes `&`, `<`, and `>` in
 * plain-text nodes (MarkdownManager#encodeTextForMarkdown → encodeHtmlEntities),
 * even though Markdown never requires escaping these in prose. The webview
 * neutralises that over-encoding in `patchEntityOverEncoding`. This test
 * pins the FULL round-trip through the real production serialization path
 * (`getEditorMarkdownForSync`) so all three characters survive outside code and
 * are left untouched inside inline code / code blocks.
 */

import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from '@tiptap/markdown';
import { ListKit } from '@tiptap/extension-list';
import { MarkdownParagraph } from '../../webview/extensions/markdownParagraph';
import { OrderedListMarkdownFix } from '../../webview/extensions/orderedListMarkdownFix';
import { MarkdownListItem } from '../../webview/extensions/markdownListItem';
import { CustomImage } from '../../webview/extensions/customImage';
import { PreservedMarkdownLiteral } from '../../webview/extensions/preservedMarkdownLiteral';
import { getEditorMarkdownForSync } from '../../webview/utils/markdownSerialization';
import { installBlankLineLexerNormalizer } from '../../webview/utils/markedLexerNormalizer';

function createRealEditor(initialMarkdown: string, opts: { codeBlock?: boolean } = {}): Editor {
  const element = document.createElement('div');
  document.body.appendChild(element);
  const editor = new Editor({
    element,
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3, 4, 5, 6] },
        paragraph: false,
        ...(opts.codeBlock ? {} : { codeBlock: false }),
        bulletList: false,
        orderedList: false,
        listItem: false,
        listKeymap: false,
        undoRedo: { depth: 100 },
      }),
      MarkdownParagraph,
      PreservedMarkdownLiteral,
      CustomImage,
      Markdown.configure({ markedOptions: { gfm: true, breaks: true } }),
      ListKit.configure({ listItem: false, orderedList: false, taskItem: { nested: true } }),
      MarkdownListItem,
      OrderedListMarkdownFix,
    ],
    content: '',
    contentType: 'markdown',
  });
  const storage = editor as unknown as {
    markdown?: { instance?: unknown };
    storage?: { markdown?: { instance?: unknown } };
  };
  const marked = storage.markdown?.instance ?? storage.storage?.markdown?.instance;
  if (marked) installBlankLineLexerNormalizer(marked);
  if (initialMarkdown) editor.commands.setContent(initialMarkdown, { contentType: 'markdown' });
  return editor;
}

function roundTrip(markdown: string, opts?: { codeBlock?: boolean }): string {
  const editor = createRealEditor(markdown, opts);
  try {
    return getEditorMarkdownForSync(editor).trim();
  } finally {
    editor.destroy();
  }
}

describe('entity over-encoding is neutralised on save (real editor)', () => {
  it('preserves < and > in prose comparisons', () => {
    expect(roundTrip('if x < 5 and y > 3 then done')).toBe('if x < 5 and y > 3 then done');
  });

  it('preserves angle brackets in generics and arrows', () => {
    expect(roundTrip('Use List<String> and Map<K,V> with x -> y')).toBe(
      'Use List<String> and Map<K,V> with x -> y'
    );
  });

  it('preserves a bare ampersand in prose', () => {
    expect(roundTrip('Q&A and R&D')).toBe('Q&A and R&D');
  });

  it('preserves a mix of &, <, > together', () => {
    expect(roundTrip('a & b < c > d')).toBe('a & b < c > d');
  });

  it('leaves inline code content untouched', () => {
    expect(roundTrip('Call `foo<bar>()` and `a && b`')).toBe('Call `foo<bar>()` and `a && b`');
  });

  it('leaves fenced code block content untouched', () => {
    const md = ['```', 'if (a < b && c > d) {}', '```'].join('\n');
    expect(roundTrip(md, { codeBlock: true })).toBe(md);
  });
});
