/** @jest-environment jsdom */

import { Editor } from '@tiptap/core';
import { ListKit } from '@tiptap/extension-list';
import { Markdown } from '@tiptap/markdown';
import StarterKit from '@tiptap/starter-kit';
import { buildFeedbackAnchorMap } from '../../editor/feedbackAnchors';
import { MarkdownParagraph } from '../../webview/extensions/markdownParagraph';
import { OrderedListMarkdownFix } from '../../webview/extensions/orderedListMarkdownFix';
import { enumerateCanonicalFeedbackBlocks } from '../../webview/features/feedbackReview';

const MIXED_LIST_MARKDOWN = [
  '1. Ordered parent item',
  '  - Nested unordered child item one',
  '  - Nested unordered child item two',
  '    - Deeper unordered grandchild item',
  '',
  '- Unordered parent item',
  '  1. Nested ordered child one',
  '  2. Nested ordered child two',
  '    1. Deep nested ordered grandchild',
].join('\n');

function createListEditor(markdown: string): Editor {
  const element = document.createElement('div');
  document.body.appendChild(element);
  return new Editor({
    element,
    extensions: [
      StarterKit.configure({
        paragraph: false,
        codeBlock: false,
        bulletList: false,
        orderedList: false,
        listItem: false,
        listKeymap: false,
      }),
      MarkdownParagraph,
      Markdown.configure({ markedOptions: { gfm: true, breaks: true } }),
      ListKit.configure({ orderedList: false, taskItem: { nested: true } }),
      OrderedListMarkdownFix,
    ],
    content: markdown,
    contentType: 'markdown',
  });
}

describe('Feedback anchors with the production list parser', () => {
  afterEach(() => document.body.replaceChildren());

  it('maps the same two mixed-list blocks that TipTap rendered from the saved source', () => {
    const editor = createListEditor(MIXED_LIST_MARKDOWN);
    try {
      const canonicalBlocks = enumerateCanonicalFeedbackBlocks(editor);
      expect(canonicalBlocks).toHaveLength(2);

      const result = buildFeedbackAnchorMap(MIXED_LIST_MARKDOWN, canonicalBlocks);
      expect(result).toEqual({
        ok: true,
        map: {
          blocks: [
            { ordinal: 0, kind: 'list', startLine: 1, endLine: 4 },
            { ordinal: 1, kind: 'list', startLine: 6, endLine: 9 },
          ],
        },
      });
    } finally {
      editor.destroy();
    }
  });

  it.each([1, 2])(
    'does not absorb a mixed-list child beneath a %s-space ordered-list root',
    indent => {
      const markdown = [
        `${' '.repeat(indent)}1. parent`,
        `${' '.repeat(indent + 1)}- child`,
        '',
        '- sibling',
      ].join('\n');
      const editor = createListEditor(markdown);
      try {
        const canonicalBlocks = enumerateCanonicalFeedbackBlocks(editor);
        expect(canonicalBlocks).toHaveLength(2);
        expect(buildFeedbackAnchorMap(markdown, canonicalBlocks)).toEqual({
          ok: true,
          map: {
            blocks: [
              { ordinal: 0, kind: 'list', startLine: 1, endLine: 1 },
              { ordinal: 1, kind: 'list', startLine: 2, endLine: 4 },
            ],
          },
        });
      } finally {
        editor.destroy();
      }
    }
  );

  it('fails closed when a three-space root cannot be represented as one canonical block', () => {
    const markdown = ['   1. parent', '    - child', '', '- sibling'].join('\n');
    const editor = createListEditor(markdown);
    try {
      const result = buildFeedbackAnchorMap(markdown, enumerateCanonicalFeedbackBlocks(editor));
      expect(result).toEqual({
        ok: false,
        error: expect.objectContaining({
          code: 'MD4H-FB-ANCHOR-002',
          reason: 'invalid-canonical-block',
        }),
      });
    } finally {
      editor.destroy();
    }
  });
});
