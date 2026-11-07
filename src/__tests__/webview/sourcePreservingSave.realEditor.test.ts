/** @jest-environment jsdom */

/**
 * Untouched blocks must save with their authored Markdown source.
 *
 * The serializer rebuilds Markdown from the document tree, so any authored form
 * outside TipTap's canonical output (soft breaks, compact tables, `*` lists,
 * setext headings) was rewritten on the first sync, even when the user edited a
 * different block. setMarkdownContentPreservingSource seeds the per-block cache with
 * each top-level block's raw source, so only edited blocks re-serialize.
 */

import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from '@tiptap/markdown';
import { ListKit } from '@tiptap/extension-list';
import { TableCell, TableHeader, TableRow } from '@tiptap/extension-table';
import { closeHistory } from '@tiptap/pm/history';
import { MarkdownParagraph } from '../../webview/extensions/markdownParagraph';
import { OrderedListMarkdownFix } from '../../webview/extensions/orderedListMarkdownFix';
import { MarkdownListItem } from '../../webview/extensions/markdownListItem';
import { CustomImage } from '../../webview/extensions/customImage';
import { PreservedMarkdownLiteral } from '../../webview/extensions/preservedMarkdownLiteral';
import { MarkdownLink, MarkdownCode } from '../../webview/extensions/markdownCompatibilityMarks';
import { HtmlPreservingTable } from '../../webview/extensions/htmlPreservingTable';
import { CodeBlockWithCopy } from '../../webview/extensions/codeBlockWithCopy';
import {
  getEditorMarkdownForSync,
  setMarkdownContentPreservingSource,
} from '../../webview/utils/markdownSerialization';
import { installBlankLineLexerNormalizer } from '../../webview/utils/markedLexerNormalizer';

function createEditor(): Editor {
  const element = document.createElement('div');
  document.body.appendChild(element);
  const editor = new Editor({
    element,
    extensions: [
      StarterKit.configure({
        paragraph: false,
        codeBlock: false,
        bulletList: false,
        orderedList: false,
        listItem: false,
        listKeymap: false,
        link: false,
        code: false,
      }),
      MarkdownParagraph,
      PreservedMarkdownLiteral,
      CodeBlockWithCopy.configure({ workerUri: '', defaultLanguage: 'plaintext' }),
      CustomImage,
      MarkdownLink,
      MarkdownCode,
      Markdown.configure({ markedOptions: { gfm: true, breaks: true } }),
      HtmlPreservingTable.configure({ resizable: false }),
      TableRow,
      TableHeader,
      TableCell,
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
  return editor;
}

/** Mirror editor.ts: load Markdown, then remember each block's authored source. */
function load(editor: Editor, markdown: string): void {
  setMarkdownContentPreservingSource(editor, markdown);
  // Keep later test edits out of the load's history group, so undo reverts only them.
  editor.view.dispatch(closeHistory(editor.state.tr));
}

function withEditor(markdown: string, run: (editor: Editor) => void): void {
  const editor = createEditor();
  try {
    load(editor, markdown);
    run(editor);
  } finally {
    editor.destroy();
  }
}

/** Document position just inside the end of the first text block containing `needle`. */
function endOfTextBlock(editor: Editor, needle: string): number {
  let found = -1;
  editor.state.doc.descendants((node, pos) => {
    if (found !== -1) return false;
    if (node.isTextblock && node.textContent.includes(needle)) {
      found = pos + node.nodeSize - 1;
      return false;
    }
    return true;
  });
  if (found === -1) throw new Error(`No text block containing ${needle}`);
  return found;
}

function setTaskChecked(editor: Editor, label: string, checked: boolean): void {
  let target = -1;
  editor.state.doc.descendants((node, pos) => {
    if (target !== -1) return false;
    if (node.type.name === 'taskItem' && node.textContent.includes(label)) {
      target = pos;
      return false;
    }
    return true;
  });
  if (target === -1) throw new Error(`No task item ${label}`);
  const node = editor.state.doc.nodeAt(target);
  editor.view.dispatch(
    editor.state.tr.setNodeMarkup(target, undefined, { ...node?.attrs, checked })
  );
}

const authoredForms: Record<string, string> = {
  'soft line breaks': 'one\ntwo\nthree',
  'backslash break': 'one\\\ntwo',
  'blockquote soft break': '> a line\n> spanning two',
  'compact table': '| A | B |\n| --- | --- |\n| x | yy |',
  'aligned table': '| A | B |\n|:--|--:|\n| x | y |',
  'star list': '* a\n* b',
  'setext heading': 'Title\n=====',
};

const releaseFixture = [
  '# Release smoke fixture',
  '',
  'Intro paragraph with **bold**, *italic*, `inline code`, and a [link](https://example.com).',
  'A soft line break follows this sentence.',
  'Final line of the paragraph.',
  '',
  '- [x] Done task',
  '- [ ] Open task',
  '',
  '| Name | Role | Notes |',
  '| --- | --- | --- |',
  '| Ada | Eng | first |',
  '| Lin | PM | second |',
  '',
  '```typescript',
  'const greeting: string = "hello";',
  '```',
  '',
  '> A blockquote with a line',
  '> spanning two lines.',
].join('\n');

describe('source-preserving save', () => {
  describe('with no edits', () => {
    it.each(Object.entries(authoredForms))('keeps %s byte-identical', (_name, markdown) => {
      withEditor(markdown, editor => {
        expect(getEditorMarkdownForSync(editor)).toBe(markdown);
      });
    });

    it('keeps the release fixture byte-identical', () => {
      withEditor(releaseFixture, editor => {
        expect(getEditorMarkdownForSync(editor)).toBe(releaseFixture);
      });
    });
  });

  it('keeps untouched blocks when another block is edited', () => {
    const markdown = 'First paragraph.\n\nsoft\nbreak here\n\n| A | B |\n| --- | --- |\n| x | yy |';
    withEditor(markdown, editor => {
      editor.commands.insertContentAt(endOfTextBlock(editor, 'First paragraph'), ' Edited.');
      expect(getEditorMarkdownForSync(editor)).toBe(
        'First paragraph. Edited.\n\nsoft\nbreak here\n\n| A | B |\n| --- | --- |\n| x | yy |'
      );
    });
  });

  it('re-serializes only the edited block', () => {
    withEditor('* a\n* b\n\nsoft\nbreak', editor => {
      editor.commands.insertContentAt(endOfTextBlock(editor, 'a'), 'x');
      // The edited list takes the canonical form; the paragraph keeps its source.
      expect(getEditorMarkdownForSync(editor)).toBe('- ax\n- b\n\nsoft\nbreak');
    });
  });

  it('restores the authored source when a task checkbox is toggled on and off', () => {
    withEditor(releaseFixture, editor => {
      setTaskChecked(editor, 'Open task', true);
      expect(getEditorMarkdownForSync(editor)).toContain('- [x] Open task');
      setTaskChecked(editor, 'Open task', false);
      expect(getEditorMarkdownForSync(editor)).toBe(releaseFixture);
    });
  });

  it('restores the authored source after undo', () => {
    withEditor('* a\n* b\n\nTail.', editor => {
      editor.commands.insertContentAt(endOfTextBlock(editor, 'a'), 'x');
      editor.commands.undo();
      expect(getEditorMarkdownForSync(editor)).toBe('* a\n* b\n\nTail.');
    });
  });

  it('uses the new source after a host content replacement', () => {
    withEditor('* a', editor => {
      load(editor, 'Title\n=====\n\n* b');
      expect(getEditorMarkdownForSync(editor)).toBe('Title\n=====\n\n* b');
    });
  });

  it('falls back to canonical output when content is set without remembering source', () => {
    withEditor('* a', editor => {
      editor.commands.setContent('* b', { contentType: 'markdown' });
      expect(getEditorMarkdownForSync(editor)).toBe('- b');
    });
  });

  it('does not leave the lexer capture installed after loading', () => {
    withEditor('* a', editor => {
      const manager = (editor as unknown as { markdown?: object }).markdown;
      expect(manager).toBeDefined();
      expect(Object.prototype.hasOwnProperty.call(manager, 'createLexer')).toBe(false);
    });
  });

  it('normalizes CRLF source to LF', () => {
    withEditor('one\r\ntwo\r\n\r\n* a', editor => {
      expect(getEditorMarkdownForSync(editor)).toBe('one\ntwo\n\n* a');
    });
  });
});
