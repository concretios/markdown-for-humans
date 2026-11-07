/** @jest-environment jsdom */

import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from '@tiptap/markdown';
import { TableCell, TableHeader, TableRow } from '@tiptap/extension-table';
import MarkdownIt from 'markdown-it';
import { CodeBlockWithCopy } from '../../webview/extensions/codeBlockWithCopy';
import { HtmlPreservingTable } from '../../webview/extensions/htmlPreservingTable';
import { MarkdownCode, MarkdownLink } from '../../webview/extensions/markdownCompatibilityMarks';
import { MarkdownParagraph } from '../../webview/extensions/markdownParagraph';
import { PreservedMarkdownLiteral } from '../../webview/extensions/preservedMarkdownLiteral';
import { getEditorMarkdownForSync } from '../../webview/utils/markdownSerialization';
import { installBlankLineLexerNormalizer } from '../../webview/utils/markedLexerNormalizer';

const renderedMarkdown = new MarkdownIt({ html: true });

function createEditor(source: string): Editor {
  const element = document.createElement('div');
  document.body.appendChild(element);
  const editor = new Editor({
    element,
    extensions: [
      StarterKit.configure({ paragraph: false, codeBlock: false, code: false, link: false }),
      MarkdownParagraph,
      MarkdownCode,
      MarkdownLink,
      PreservedMarkdownLiteral,
      // Highlighting is orthogonal to the production code node's parse/render contract.
      CodeBlockWithCopy.extend({ addProseMirrorPlugins: () => [] }),
      HtmlPreservingTable,
      TableRow,
      TableHeader,
      TableCell,
      Markdown.configure({ markedOptions: { gfm: true, breaks: true } }),
    ],
    content: '',
    contentType: 'markdown',
  });
  installBlankLineLexerNormalizer(editor.markdown?.instance);
  editor.commands.setContent(source, { contentType: 'markdown' });
  return editor;
}

function editUnrelatedParagraphAndSave(editor: Editor): string {
  editor.commands.insertContentAt(editor.state.doc.content.size, '<p>Unrelated edit.</p>');
  return getEditorMarkdownForSync(editor);
}

describe('entity context safety through the real editor', () => {
  it.each([
    ['&amp;copy;', '&copy;'],
    ['&amp;#x41;', '&#x41;'],
    ['&amp;#X41;', '&#X41;'],
    ['&amp;amp;', '&amp;'],
    ['&copy;', '©'],
    ['&#x41;', 'A'],
    ['&#0;', '\uFFFD'],
    ['&#xD800;', '\uFFFD'],
    ['&#x110000;', '\uFFFD'],
    ['&notreal;', '&notreal;'],
    ['&copycat;', '&copycat;'],
  ])(
    'renders %s as actual text and preserves its meaning after another edit',
    (source, visible) => {
      const editor = createEditor(`Literal ${source} here.`);
      try {
        expect(editor.state.doc.textContent).toBe(`Literal ${visible} here.`);
        expect(editor.view.dom.textContent).toBe(`Literal ${visible} here.`);
        const saved = editUnrelatedParagraphAndSave(editor);
        expect(renderedMarkdown.render(saved)).toBe(
          renderedMarkdown.render(`Literal ${source} here.\n\nUnrelated edit.`)
        );
        const reopened = createEditor(saved);
        try {
          expect(reopened.state.doc.textContent).toBe(`Literal ${visible} here.Unrelated edit.`);
        } finally {
          reopened.destroy();
        }
      } finally {
        editor.destroy();
      }
    }
  );

  it.each([
    'Use `&amp;copy;` literally.',
    '```html\n&amp;copy;\n```',
    '[link](https://example.com/?q=&amp;copy;)',
    '[link](https://example.com "&amp;copy;")',
  ])('keeps verbatim source and link attributes intact: %s', source => {
    const editor = createEditor(source);
    try {
      expect(JSON.stringify(editor.getJSON())).not.toMatch(/[\uE000-\uE002]/);
      expect(editor.view.dom.textContent).not.toMatch(/[\uE000-\uE002]/);
      const saved = editUnrelatedParagraphAndSave(editor);
      expect(saved).toContain(source);
      expect(saved).not.toMatch(/[\uE000-\uE002]/);
    } finally {
      editor.destroy();
    }
  });

  it('keeps actual text in HTML table cells before and after save', () => {
    const editor = createEditor('<table><tr><td>&amp;copy;</td></tr></table>');
    try {
      expect(editor.view.dom.querySelector('td')?.textContent).toBe('&copy;');
      const saved = editUnrelatedParagraphAndSave(editor);
      expect(saved).toContain('<td>&amp;copy;</td>');
      expect(saved).not.toMatch(/[\uE000-\uE002]/);
    } finally {
      editor.destroy();
    }
  });

  it('keeps entity-derived Markdown delimiters literal', () => {
    const source = '&ast;literal&ast; and &#35; heading and &gt; quote';
    const editor = createEditor(source);
    try {
      expect(editor.state.doc.textContent).toBe('*literal* and # heading and > quote');
      expect(renderedMarkdown.render(getEditorMarkdownForSync(editor))).toBe(
        renderedMarkdown.render(source)
      );
    } finally {
      editor.destroy();
    }
  });

  it('serializes edits to decoded entity text instead of resurrecting old text', () => {
    const editor = createEditor('Before &amp;copy; after.');
    try {
      expect(editor.state.doc.textContent).toBe('Before &copy; after.');
      editor.commands.insertContentAt({ from: 9, to: 13 }, 'trade');
      const saved = getEditorMarkdownForSync(editor);
      expect(renderedMarkdown.render(saved)).toBe('<p>Before &amp;trade; after.</p>\n');
      const reopened = createEditor(saved);
      try {
        expect(reopened.state.doc.textContent).toBe('Before &trade; after.');
      } finally {
        reopened.destroy();
      }
    } finally {
      editor.destroy();
    }
  });

  it('preserves user-authored private-use characters without interpreting them as entity markers', () => {
    const source = 'Literal \uE000amp\uE001copy\uE002 stays literal.';
    const editor = createEditor(source);
    try {
      expect(editor.state.doc.textContent).toBe(source);
      expect(editUnrelatedParagraphAndSave(editor)).toContain(source);
    } finally {
      editor.destroy();
    }
  });

  it('keeps both characters when formatting splits a multi-codepoint entity', () => {
    const editor = createEditor('Before &NotEqualTilde; after.');
    try {
      expect(editor.state.doc.textContent).toBe('Before \u2242\u0338 after.');
      editor.chain().setTextSelection({ from: 8, to: 9 }).toggleBold().run();
      const saved = getEditorMarkdownForSync(editor);
      expect(renderedMarkdown.render(saved)).toBe(
        '<p>Before <strong>\u2242</strong>\u0338 after.</p>\n'
      );
      const reopened = createEditor(saved);
      try {
        expect(reopened.state.doc.textContent).toBe('Before \u2242\u0338 after.');
        expect(reopened.view.dom.querySelector('strong')?.textContent).toBe('\u2242');
      } finally {
        reopened.destroy();
      }
    } finally {
      editor.destroy();
    }
  });

  it('keeps edits to either character of a multi-codepoint entity', () => {
    const editor = createEditor('Before &NotEqualTilde; after.');
    try {
      editor.commands.insertContentAt({ from: 9, to: 10 }, '*');
      const saved = getEditorMarkdownForSync(editor);
      expect(renderedMarkdown.render(saved)).toBe('<p>Before \u2242* after.</p>\n');
      const reopened = createEditor(saved);
      try {
        expect(reopened.state.doc.textContent).toBe('Before \u2242* after.');
      } finally {
        reopened.destroy();
      }
    } finally {
      editor.destroy();
    }
  });

  it('uses visible entity text when toggling inline code', () => {
    const editor = createEditor('Before &amp;copy; after.');
    try {
      editor.chain().setTextSelection({ from: 8, to: 14 }).toggleCode().run();
      const saved = getEditorMarkdownForSync(editor);
      expect(saved).toBe('Before `&copy;` after.');
      const reopened = createEditor(saved);
      try {
        expect(reopened.view.dom.querySelector('code')?.textContent).toBe('&copy;');
      } finally {
        reopened.destroy();
      }
    } finally {
      editor.destroy();
    }
  });

  it('preserves literal entity text pasted from HTML without source attributes', () => {
    const editor = createEditor('Before.');
    try {
      editor.commands.insertContentAt(
        editor.state.doc.content.size,
        '<p>&amp;copy; and &copy;</p>'
      );
      expect(editor.state.doc.lastChild?.textContent).toBe('&copy; and ©');
      const saved = getEditorMarkdownForSync(editor);
      expect(renderedMarkdown.render(saved)).toBe('<p>Before.</p>\n<p>&amp;copy; and ©</p>\n');
      const reopened = createEditor(saved);
      try {
        expect(reopened.state.doc.lastChild?.textContent).toBe('&copy; and ©');
      } finally {
        reopened.destroy();
      }
    } finally {
      editor.destroy();
    }
  });
});
