/** @jest-environment jsdom */

import type { JSONContent } from '@tiptap/core';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from '@tiptap/markdown';
import { ListKit } from '@tiptap/extension-list';
import { MarkdownParagraph } from '../../webview/extensions/markdownParagraph';
import { OrderedListMarkdownFix } from '../../webview/extensions/orderedListMarkdownFix';
import { MarkdownListItem } from '../../webview/extensions/markdownListItem';

function createTestEditor(): Editor {
  const element = document.createElement('div');
  document.body.appendChild(element);

  return new Editor({
    element,
    extensions: [
      StarterKit.configure({
        heading: {
          levels: [1, 2, 3, 4, 5, 6],
        },
        paragraph: false,
        codeBlock: false,
        bulletList: false,
        orderedList: false,
        listItem: false,
        listKeymap: false,
        undoRedo: {
          depth: 100,
        },
      }),
      MarkdownParagraph,
      Markdown.configure({
        markedOptions: {
          gfm: true,
          breaks: true,
        },
      }),
      // Match the real editor which registers ListKit alongside StarterKit.
      ListKit.configure({
        listItem: false,
        orderedList: false,
        taskItem: {
          nested: true,
        },
      }),
      MarkdownListItem,
      OrderedListMarkdownFix,
    ],
    editorProps: {
      attributes: {
        class: 'markdown-editor',
        spellcheck: 'true',
      },
    },
  });
}

function hasTextWithMark(doc: JSONContent, text: string, markType: string): boolean {
  const walk = (node: JSONContent): boolean => {
    if (node.type === 'text' && node.text === text) {
      const marks = Array.isArray(node.marks) ? node.marks : [];
      return marks.some(mark => mark.type === markType);
    }

    if (!Array.isArray(node.content)) {
      return false;
    }

    return node.content.some(child => walk(child));
  };

  return walk(doc);
}

describe('Bold markdown rendering', () => {
  it.each([
    { name: 'paragraph', markdown: 'Hello **bold** world' },
    { name: 'heading', markdown: '## Hello **bold** world' },
    { name: 'blockquote', markdown: '> Hello **bold** world' },
    { name: 'list item', markdown: '- Hello **bold** world' },
    { name: 'ordered list item (dot)', markdown: '1. Hello **bold** world' },
    { name: 'ordered list item (paren)', markdown: '1) Hello **bold** world' },
  ])('parses **bold** inside a $name', ({ markdown }) => {
    const editor = createTestEditor();

    try {
      editor.commands.setContent(markdown, { contentType: 'markdown' });

      expect(editor.getHTML()).toContain('<strong>bold</strong>');
      expect(editor.getHTML()).not.toContain('**bold**');

      const json = editor.getJSON();
      expect(hasTextWithMark(json, 'bold', 'bold')).toBe(true);
    } finally {
      editor.destroy();
    }
  });

  it('parses **bold** on first render when file starts with frontmatter', () => {
    const editor = createTestEditor();

    const content = [
      '```yaml',
      '---',
      'name: Example',
      '---',
      '```',
      '',
      '## Decisions (Confirmed)',
      '',
      '1) **Default resize behavior:** resize the original file in-place **after** creating a backup.',
    ].join('\n');

    try {
      editor.commands.setContent(content, { contentType: 'markdown' });

      const html = editor.getHTML();
      expect(html).toContain('<strong>Default resize behavior:</strong>');
      expect(html).toContain('<strong>after</strong>');
      expect(html).not.toContain('**Default resize behavior:**');
    } finally {
      editor.destroy();
    }
  });

  it('round-trips bold marks back to markdown', () => {
    const editor = createTestEditor();

    try {
      editor.commands.setContent('Hello **bold** world', { contentType: 'markdown' });

      const markdown = editor.getMarkdown();
      expect(markdown).toContain('**bold**');
    } finally {
      editor.destroy();
    }
  });
});
