/** @jest-environment jsdom */

/**
 * Blocks written with no blank line between them must save with the same layout.
 *
 * Hand-written and LLM-written Markdown often puts a list, a code fence or text
 * directly under a heading or a label line. The rendered result is the same
 * either way, but the first save used to insert a blank line at every such
 * boundary, so one edit rewrote hundreds of untouched lines. An unedited block
 * now keeps the join it had to the unedited block that followed it.
 */

import { Editor } from '@tiptap/core';
import { Markdown } from '@tiptap/markdown';
import StarterKit from '@tiptap/starter-kit';
import { ListKit } from '@tiptap/extension-list';
import { TableCell, TableHeader, TableRow } from '@tiptap/extension-table';
import { BlankLinePreservation } from '../../webview/extensions/blankLinePreservation';
import { CustomImage } from '../../webview/extensions/customImage';
import { GitHubAlerts } from '../../webview/extensions/githubAlerts';
import { HtmlComment, HtmlCommentInline } from '../../webview/extensions/htmlComment';
import { HtmlPreservingTable } from '../../webview/extensions/htmlPreservingTable';
import { MarkdownListItem } from '../../webview/extensions/markdownListItem';
import { MarkdownParagraph } from '../../webview/extensions/markdownParagraph';
import { MarkdownTaskList } from '../../webview/extensions/markdownTaskList';
import { OrderedListMarkdownFix } from '../../webview/extensions/orderedListMarkdownFix';
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
      GitHubAlerts,
      StarterKit.configure({
        paragraph: false,
        bulletList: false,
        orderedList: false,
        listItem: false,
        listKeymap: false,
      }),
      MarkdownParagraph,
      CustomImage,
      HtmlComment,
      HtmlCommentInline,
      BlankLinePreservation,
      Markdown.configure({ markedOptions: { gfm: true, breaks: true } }),
      HtmlPreservingTable.configure({ resizable: false }),
      TableRow,
      TableHeader,
      TableCell,
      ListKit.configure({ listItem: false, orderedList: false, taskList: false }),
      MarkdownTaskList,
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

/** Append text to the end of the first block (of the given node type) containing `needle`. */
function appendTo(editor: Editor, nodeType: string, needle: string, text = ' EDITED'): void {
  let end = -1;
  editor.state.doc.descendants((node, pos) => {
    if (end !== -1) return false;
    if (node.type.name === nodeType && node.textContent.includes(needle)) {
      end = pos + node.nodeSize - 1;
      return false;
    }
    return true;
  });
  if (end === -1) throw new Error(`No ${nodeType} containing "${needle}"`);
  editor.commands.insertContentAt(end, text);
}

function withEditor(markdown: string, run: (editor: Editor) => void): void {
  const editor = createEditor();
  try {
    setMarkdownContentPreservingSource(editor, markdown);
    run(editor);
  } finally {
    editor.destroy();
  }
}

const TIGHT_DOCS: Array<[string, string]> = [
  ['a label directly above a bullet list', 'Label:\n- one\n- two\n\nTail paragraph.'],
  ['a label directly above an ordered list', 'One round:\n1. first\n2. second\n\nTail paragraph.'],
  ['a heading directly above text', '## Role\nYou are a QA engineer.\n\nTail paragraph.'],
  [
    'a heading directly above a list',
    '## Rules\n- Read the file.\n- Run the tests.\n\nTail paragraph.',
  ],
  ['a label directly above a code fence', '**Commands:**\n```\nnpm test\n```\n\nTail paragraph.'],
  ['a code fence directly above text', '```\ncode\n```\nafter the fence\n\nTail paragraph.'],
  ['two headings back to back', '# A\n## B\n\nTail paragraph.'],
  ['a chain of tight blocks', '# A\n## B\ntext\n- item\n\nTail paragraph.'],
];

describe('tight block layout', () => {
  afterEach(() => document.body.replaceChildren());

  it.each(TIGHT_DOCS)('saves %s unchanged when nothing is edited', (_name, markdown) => {
    withEditor(markdown, editor => {
      expect(getEditorMarkdownForSync(editor)).toBe(markdown);
    });
  });

  it.each(TIGHT_DOCS)('keeps %s after an edit to a later block', (_name, markdown) => {
    withEditor(markdown, editor => {
      appendTo(editor, 'paragraph', 'Tail paragraph');
      expect(getEditorMarkdownForSync(editor)).toBe(
        markdown.replace('Tail paragraph.', 'Tail paragraph. EDITED')
      );
    });
  });

  it('adds a blank line when the block that followed was edited, never merging the two', () => {
    withEditor('Label:\n- one\n- two\n\nTail', editor => {
      appendTo(editor, 'paragraph', 'two', ' EDITED');
      const saved = getEditorMarkdownForSync(editor);
      expect(saved).toBe('Label:\n\n- one\n- two EDITED\n\nTail');
    });
  });

  it('adds a blank line when the block that followed is turned into a paragraph', () => {
    withEditor('Label:\n- item\n\nTail', editor => {
      editor.commands.setTextSelection(editor.state.doc.content.size - 8);
      let listPos = -1;
      editor.state.doc.descendants((node, pos) => {
        if (listPos === -1 && node.type.name === 'bulletList') listPos = pos;
      });
      editor.commands.setTextSelection(listPos + 3);
      editor.commands.toggleBulletList();
      const saved = getEditorMarkdownForSync(editor);
      expect(saved).toContain('Label:\n\nitem');
    });
  });

  it('keeps blank-line separated blocks separated', () => {
    const markdown = '# Title\n\nParagraph.\n\n- one\n- two\n\nTail paragraph.';
    withEditor(markdown, editor => {
      appendTo(editor, 'paragraph', 'Tail paragraph');
      expect(getEditorMarkdownForSync(editor)).toBe(
        markdown.replace('Tail paragraph.', 'Tail paragraph. EDITED')
      );
    });
  });
});
