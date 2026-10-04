/** @jest-environment node */

/**
 * Regression coverage for large-document sync serialization.
 *
 * ProseMirror preserves the identity of unchanged nodes across transactions.
 * Reusing serialization by node identity keeps a one-paragraph edit from
 * re-running every top-level Markdown renderer in a 10,000-line document.
 */

import type { JSONContent } from '@tiptap/core';
import { Schema } from '@tiptap/pm/model';
import { EditorState } from '@tiptap/pm/state';
import { getEditorMarkdownForSync } from '../../webview/utils/markdownSerialization';

interface StableTestNode {
  readonly type: { readonly name: string };
  toJSON(): JSONContent;
}

function paragraphNode(text: string, onToJson: () => void = () => undefined): StableTestNode {
  return {
    type: { name: 'paragraph' },
    toJSON: () => {
      onToJson();
      return {
        type: 'paragraph',
        content: [{ type: 'text', text }],
      };
    },
  };
}

describe('large-document Markdown serialization', () => {
  it('serializes only the changed top-level block after the initial 10,000-line snapshot', () => {
    let toJsonCalls = 0;
    const countToJson = () => {
      toJsonCalls++;
    };
    const nodes = Array.from({ length: 10_000 }, (_, index) =>
      paragraphNode(`Line ${index}`, countToJson)
    );
    const serialize = jest.fn((json: JSONContent) => {
      const paragraph = json.content?.[0];
      return paragraph?.content?.[0]?.text ?? '';
    });
    const getJSON = jest.fn(() => ({
      type: 'doc',
      content: nodes.map(node => node.toJSON()),
    }));
    const editor = {
      state: {
        doc: {
          get childCount() {
            return nodes.length;
          },
          child(index: number) {
            return nodes[index];
          },
        },
      },
      getJSON,
      markdown: { serialize },
      getMarkdown: jest.fn(() => 'fallback'),
    } as unknown as import('@tiptap/core').Editor;

    const initial = getEditorMarkdownForSync(editor);
    expect(initial).toContain('Line 0\n\nLine 1');
    expect(initial).toContain('Line 9999');
    expect(serialize).toHaveBeenCalledTimes(10_000);
    expect(toJsonCalls).toBe(10_000);

    serialize.mockClear();
    getJSON.mockClear();
    toJsonCalls = 0;
    nodes[5_000] = paragraphNode('Changed line', countToJson);

    const updated = getEditorMarkdownForSync(editor);
    expect(updated).toContain('Line 4999\n\nChanged line\n\nLine 5001');
    expect(serialize).toHaveBeenCalledTimes(1);
    expect(toJsonCalls).toBe(1);
    expect(getJSON).not.toHaveBeenCalled();
  });

  it('reuses the immutable sibling nodes retained by a real ProseMirror transaction', () => {
    const schema = new Schema({
      nodes: {
        doc: { content: 'paragraph+' },
        paragraph: { content: 'text*' },
        text: { inline: true },
      },
    });
    const paragraphs = Array.from({ length: 1_000 }, (_, index) =>
      schema.node('paragraph', undefined, schema.text(`Paragraph ${index}`))
    );
    let state = EditorState.create({ doc: schema.node('doc', undefined, paragraphs) });
    const serialize = jest.fn((json: JSONContent) => json.content?.[0]?.content?.[0]?.text ?? '');
    const editor = {
      get state() {
        return state;
      },
      getJSON: jest.fn(),
      markdown: { serialize },
      getMarkdown: jest.fn(() => 'fallback'),
    } as unknown as import('@tiptap/core').Editor;

    getEditorMarkdownForSync(editor);
    expect(serialize).toHaveBeenCalledTimes(1_000);

    const changedIndex = 500;
    let changedFrom = 1;
    for (let index = 0; index < changedIndex; index++) {
      changedFrom += state.doc.child(index).nodeSize;
    }
    const oldTextLength = state.doc.child(changedIndex).textContent.length;
    state = state.apply(
      state.tr.insertText('Changed paragraph', changedFrom, changedFrom + oldTextLength)
    );
    serialize.mockClear();

    const updated = getEditorMarkdownForSync(editor);
    expect(updated).toContain('Paragraph 499\n\nChanged paragraph\n\nParagraph 501');
    expect(serialize).toHaveBeenCalledTimes(1);
  });

  it('retries a stable heading node after a transient serializer failure', () => {
    const heading = {
      type: { name: 'heading' },
      toJSON: jest.fn(() => ({
        type: 'heading',
        attrs: { level: 1 },
        content: [{ type: 'text', text: 'Heading' }],
      })),
    };
    const serialize = jest
      .fn((_json: JSONContent): string => '# Heading')
      .mockImplementationOnce(() => {
        throw new Error('transient serializer failure');
      });
    const editor = {
      state: {
        doc: {
          childCount: 1,
          child: () => heading,
        },
      },
      getJSON: jest.fn(),
      markdown: { serialize },
      getMarkdown: jest.fn(() => '# fallback'),
    } as unknown as import('@tiptap/core').Editor;

    expect(getEditorMarkdownForSync(editor)).toBe('#');
    expect(getEditorMarkdownForSync(editor)).toBe('# Heading');
    expect(serialize).toHaveBeenCalledTimes(2);
    expect(heading.toJSON).toHaveBeenCalledTimes(2);
  });
});
