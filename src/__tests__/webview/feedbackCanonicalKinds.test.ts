/** @jest-environment jsdom */

import type { Editor } from '@tiptap/core';
import { enumerateCanonicalFeedbackBlocks } from '../../webview/features/feedbackReview';
import { fingerprintFeedbackTable } from '../../webview/features/feedbackSelectionMapping';

function editorWithKinds(kinds: readonly string[]): Editor {
  const children = kinds.map((name, ordinal) => ({
    type: { name },
    content: { size: ordinal + 1 },
    nodeSize: ordinal + 3,
    toJSON: () => ({ type: name, attrs: { fixtureOrdinal: ordinal } }),
  }));
  let serialized = 0;
  const serialize = jest.fn((_json: unknown): string => {
    serialized += 1;
    return `block-${serialized}`;
  });
  return {
    state: {
      doc: {
        childCount: children.length,
        child: (ordinal: number) => children[ordinal],
      },
    },
    storage: { markdown: { serializer: { serialize } } },
  } as unknown as Editor;
}

describe('Feedback canonical rich block kinds', () => {
  it('retains evidence-specific kinds while anchor mapping remains independently normalized', () => {
    const editor = editorWithKinds([
      'mermaid',
      'mathBlock',
      'githubAlert',
      'horizontalRule',
      'image',
      'codeBlock',
      'blockquote',
    ]);

    expect(enumerateCanonicalFeedbackBlocks(editor).map(block => block.kind)).toEqual([
      'mermaid',
      'math',
      'alert',
      'horizontal-rule',
      'image',
      'code',
      'blockquote',
    ]);
  });

  it('binds a canonical table block to the existing frozen table JSON fingerprint', () => {
    const editor = editorWithKinds(['paragraph', 'table']);
    const table = editor.state.doc.child(1);
    const expected = fingerprintFeedbackTable({ version: 1, tableOrdinal: 1, table }).fingerprint;

    expect(enumerateCanonicalFeedbackBlocks(editor)).toEqual([
      { ordinal: 0, kind: 'paragraph', markdown: 'block-1', contentSize: 1 },
      {
        ordinal: 1,
        kind: 'table',
        markdown: 'block-2',
        contentSize: 2,
        tableFingerprint: expected,
      },
    ]);
  });
});
