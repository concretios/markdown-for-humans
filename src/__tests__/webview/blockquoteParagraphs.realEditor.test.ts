/** @jest-environment jsdom */

/**
 * Editing a blockquote or GitHub alert must keep its paragraphs apart.
 *
 * GitHubAlerts joined a quote's child blocks with a single newline, so after
 * any edit `> a\n>\n> b` saved as `> a\n> b`, which renders as one paragraph.
 * Unedited quotes keep their source, so these tests edit the quote first.
 */

import { Editor, type JSONContent } from '@tiptap/core';
import { Markdown } from '@tiptap/markdown';
import StarterKit from '@tiptap/starter-kit';
import { GitHubAlerts } from '../../webview/extensions/githubAlerts';
import { MarkdownParagraph } from '../../webview/extensions/markdownParagraph';
import {
  getEditorMarkdownForSync,
  setMarkdownContentPreservingSource,
} from '../../webview/utils/markdownSerialization';
import { installBlankLineLexerNormalizer } from '../../webview/utils/markedLexerNormalizer';

function createEditor(markdown: string): Editor {
  const element = document.createElement('div');
  document.body.appendChild(element);
  const editor = new Editor({
    element,
    extensions: [
      GitHubAlerts,
      StarterKit.configure({ paragraph: false }),
      MarkdownParagraph,
      Markdown.configure({ markedOptions: { gfm: true, breaks: true } }),
    ],
    content: '',
  });
  const storage = editor as unknown as {
    markdown?: { instance?: unknown };
    storage?: { markdown?: { instance?: unknown } };
  };
  const marked = storage.markdown?.instance ?? storage.storage?.markdown?.instance;
  if (marked) installBlankLineLexerNormalizer(marked);
  setMarkdownContentPreservingSource(editor, markdown);
  return editor;
}

/** Append `!` to the first text block containing `needle`, forcing its quote to re-serialize. */
function appendTo(editor: Editor, needle: string): void {
  let end = -1;
  editor.state.doc.descendants((node, pos) => {
    if (end !== -1) return false;
    if (node.isTextblock && node.textContent.includes(needle)) {
      end = pos + node.nodeSize - 1;
      return false;
    }
    return true;
  });
  if (end === -1) throw new Error(`No text block containing ${needle}`);
  editor.commands.insertContentAt(end, '!');
}

function structure(json: JSONContent): unknown {
  return {
    type: json.type,
    ...(json.attrs?.alertType ? { alertType: json.attrs.alertType } : {}),
    ...(json.content ? { content: json.content.map(structure) } : {}),
  };
}

afterEach(() => document.body.replaceChildren());

describe('blockquote paragraphs after an edit', () => {
  it.each([
    ['a plain quote', '> first para\n>\n> second para', '> first para!\n>\n> second para'],
    [
      'a GitHub alert',
      '> [!NOTE]\n> first para\n>\n> second para',
      '> [!NOTE]\n> first para!\n>\n> second para',
    ],
    ['a nested quote', '> first para\n>\n> > inner para', '> first para!\n>\n> > inner para'],
    ['a list inside a quote', '> first para\n>\n> - a\n> - b', '> first para!\n>\n> - a\n> - b'],
  ])('keeps the paragraphs of %s separate', (_name, markdown, expected) => {
    const editor = createEditor(markdown);
    try {
      appendTo(editor, 'first para');
      const saved = getEditorMarkdownForSync(editor);
      expect(saved).toBe(expected);

      // The saved Markdown must parse back to the same structure.
      const edited = structure(editor.getJSON());
      const reopened = createEditor(saved);
      try {
        expect(structure(reopened.getJSON())).toEqual(edited);
      } finally {
        reopened.destroy();
      }
    } finally {
      editor.destroy();
    }
  });

  it('keeps a single-paragraph quote on its own lines', () => {
    const editor = createEditor('> only para');
    try {
      appendTo(editor, 'only para');
      expect(getEditorMarkdownForSync(editor)).toBe('> only para!');
    } finally {
      editor.destroy();
    }
  });
});
