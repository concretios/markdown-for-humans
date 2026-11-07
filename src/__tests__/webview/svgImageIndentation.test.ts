/** @jest-environment jsdom */

import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from '@tiptap/markdown';
import { CustomImage } from '../../webview/extensions/customImage';
import { IndentedImageCodeBlock } from '../../webview/extensions/indentedImageCodeBlock';
import { MarkdownParagraph } from '../../webview/extensions/markdownParagraph';

function editorFor(source: string): Editor {
  return new Editor({
    extensions: [
      IndentedImageCodeBlock,
      StarterKit.configure({ paragraph: false }),
      MarkdownParagraph,
      Markdown,
      CustomImage,
    ],
    content: source,
    contentType: 'markdown',
  });
}

function imagePosition(editor: Editor): number {
  let result = -1;
  editor.state.doc.descendants((node, pos) => {
    if (result < 0 && node.type.name === 'image') result = pos;
  });
  expect(result).toBeGreaterThanOrEqual(0);
  return result;
}

describe('SVG display size and image indentation', () => {
  it('persists a new indentation instead of replaying stale authored HTML', () => {
    const editor = editorFor('<img width="480" src="diagram.svg" alt="Diagram" />');
    try {
      const pos = imagePosition(editor);
      editor.view.dispatch(
        editor.state.tr.setNodeMarkup(pos, undefined, {
          ...editor.state.doc.nodeAt(pos)!.attrs,
          'indent-prefix': '    ',
        })
      );
      const serialized = editor.getMarkdown();
      expect(serialized).toMatch(/^ {4}<img /);
      editor.commands.setContent(serialized, { contentType: 'markdown' });
      const image = editor.state.doc.nodeAt(imagePosition(editor))!;
      expect(image.attrs['indent-prefix']).toBe('    ');
      expect(image.attrs.width).toBe(480);
      expect(editor.getMarkdown()).toBe(serialized);
    } finally {
      editor.destroy();
    }
  });

  it.each(['    ', '\t', '\t    '])(
    'keeps a resized Markdown image visible after reopening with indentation %j',
    prefix => {
      const editor = editorFor(`${prefix}![Diagram](diagram.svg)`);
      try {
        const pos = imagePosition(editor);
        editor.view.dispatch(
          editor.state.tr.setNodeMarkup(pos, undefined, {
            ...editor.state.doc.nodeAt(pos)!.attrs,
            width: 480,
          })
        );
        const serialized = editor.getMarkdown();
        expect(serialized.startsWith(`${prefix}<img `)).toBe(true);
        for (let iteration = 0; iteration < 3; iteration++) {
          editor.commands.setContent(serialized, { contentType: 'markdown' });
          const image = editor.state.doc.nodeAt(imagePosition(editor))!;
          expect(image.attrs.width).toBe(480);
          expect(image.attrs['indent-prefix']).toBe(prefix);
          expect(editor.getMarkdown()).toBe(serialized);
          expect(editor.getJSON().content?.some(node => node.type === 'codeBlock')).toBe(false);
        }
      } finally {
        editor.destroy();
      }
    }
  );

  it('preserves mixed indented Markdown and HTML image lines', () => {
    const source = '    ![First](first.svg)\n    <img src="second.svg" alt="Second" width="320" />';
    const editor = editorFor(source);
    try {
      const images: string[] = [];
      editor.state.doc.descendants(node => {
        if (node.type.name === 'image') images.push(node.attrs.src);
      });
      expect(images).toEqual(['first.svg', 'second.svg']);
      expect(
        editor
          .getMarkdown()
          .split('\n')
          .map(line => line.trimEnd())
          .join('\n')
      ).toBe(source);
    } finally {
      editor.destroy();
    }
  });

  it.each([
    '```html\n    <img src="diagram.svg" width="480" />\n```',
    '    <img src="diagram.svg" width="480" />\n    const value = 1',
    '    <div><img src="diagram.svg" width="480" /></div>',
  ])('keeps fenced or mixed HTML code as code: %s', source => {
    const editor = editorFor(source);
    try {
      expect(editor.getJSON().content?.[0].type).toBe('codeBlock');
    } finally {
      editor.destroy();
    }
  });
});
