/** @jest-environment jsdom */

import { Editor, Node as TiptapNode } from '@tiptap/core';
import { Table, TableCell, TableHeader, TableRow } from '@tiptap/extension-table';
import { NodeSelection } from '@tiptap/pm/state';
import StarterKit from '@tiptap/starter-kit';
import { createCodeBlockCopyNodeView } from '../../webview/extensions/codeBlockCopyNodeView';
import {
  blockRelativeRangeFromPositions,
  boundedNodeText,
  codePointLength,
  codePointPrefix,
  feedbackFocusForBlockRange,
  feedbackFocusForMappedBlock,
  getFeedbackTargetFromDomRange,
  getFeedbackTargetFromProseMirrorSelection,
  resolveFeedbackRenderedRange,
} from '../../webview/features/feedbackRenderedRange';
import { getFeedbackSelectionTarget } from '../../webview/features/feedbackReview';

const OpaqueDiagram = TiptapNode.create({
  name: 'opaqueDiagram',
  group: 'block',
  atom: true,
  selectable: true,

  addAttributes() {
    return { label: { default: 'Rendered diagram' } };
  },

  parseHTML() {
    return [{ tag: 'div[data-opaque-diagram]' }];
  },

  renderHTML({ node }) {
    return [
      'div',
      {
        'data-opaque-diagram': '',
        contenteditable: 'false',
      },
      node.attrs.label as string,
    ];
  },
});

const CopyCodeBlock = TiptapNode.create({
  name: 'codeBlock',
  content: 'text*',
  marks: '',
  group: 'block',
  code: true,
  defining: true,

  addAttributes() {
    return {
      language: { default: null },
      'indent-prefix': { default: null },
    };
  },

  parseHTML() {
    return [{ tag: 'pre' }];
  },

  renderHTML() {
    return ['pre', ['code', 0]];
  },

  addNodeView() {
    return ({ node }) => createCodeBlockCopyNodeView(node, { class: 'code-block-highlighted' });
  },
});

const InlineOpaque = TiptapNode.create({
  name: 'inlineOpaque',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    return { label: { default: 'chip' } };
  },

  parseHTML() {
    return [{ tag: 'span[data-inline-opaque]' }];
  },

  renderHTML({ node }) {
    return ['span', { 'data-inline-opaque': '' }, node.attrs.label as string];
  },

  addNodeView() {
    return ({ node }) => {
      const dom = document.createElement('span');
      dom.dataset.inlineOpaque = '';
      dom.textContent = node.attrs.label as string;
      return { dom };
    };
  },
});

const OpaqueImage = TiptapNode.create({
  name: 'image',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      src: { default: '' },
      alt: { default: '' },
    };
  },

  renderHTML({ node }) {
    return ['img', { src: node.attrs.src as string, alt: node.attrs.alt as string }];
  },
});

const MermaidLikeOpaque = TiptapNode.create({
  name: 'mermaid',
  group: 'block',
  content: 'text*',
  marks: '',
  isolating: true,

  renderHTML() {
    return ['pre', { 'data-mermaid-like': '' }, ['code', 0]];
  },

  addNodeView() {
    return ({ node }) => {
      const dom = document.createElement('div');
      dom.dataset.mermaidLike = '';
      dom.textContent = `Rendered diagram: ${node.textContent}`;
      return { dom };
    };
  },
});

const MathLikeOpaque = TiptapNode.create({
  name: 'mathBlock',
  group: 'block',
  atom: true,
  selectable: true,

  addAttributes() {
    return { latex: { default: '' } };
  },

  renderHTML({ node }) {
    return ['div', { 'data-math-like': '', contenteditable: 'false' }, node.attrs.latex as string];
  },
});

function createEditor(content: string | Record<string, unknown>): Editor {
  const element = document.createElement('div');
  document.body.appendChild(element);
  return new Editor({
    element,
    extensions: [
      StarterKit,
      Table,
      TableRow,
      TableHeader,
      TableCell,
      OpaqueDiagram,
      InlineOpaque,
      OpaqueImage,
      MermaidLikeOpaque,
      MathLikeOpaque,
    ],
    content,
  });
}

function selectDomText(
  startNode: Text,
  startOffset: number,
  endNode: Text,
  endOffset: number
): Range {
  const range = document.createRange();
  range.setStart(startNode, startOffset);
  range.setEnd(endNode, endOffset);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  return range;
}

function textNode(element: Element | null): Text {
  const node = element?.firstChild;
  if (!(node instanceof Text)) throw new Error('Expected a text node');
  return node;
}

interface ExactRenderedRangeCase {
  name: string;
  content: string | Record<string, unknown>;
  startSelector: string;
  startOffset: number;
  endSelector?: string;
  endOffset: number;
  expected: {
    focus: string;
    from: number;
    to: number;
    startOrdinal: number;
    startOffset: number;
    endOrdinal: number;
    endOffset: number;
  };
}

const EXACT_RENDERED_RANGE_CASES: readonly ExactRenderedRangeCase[] = [
  {
    name: 'a UTF-16 surrogate pair without splitting or counting code points',
    content: '<p>A😀B end</p>',
    startSelector: 'p',
    startOffset: 1,
    endOffset: 4,
    expected: {
      focus: '😀B',
      from: 2,
      to: 5,
      startOrdinal: 0,
      startOffset: 1,
      endOrdinal: 0,
      endOffset: 4,
    },
  },
  {
    name: 'a selection crossing bold text and a link',
    content: '<p><strong>bold</strong> and <a href="https://example.com">linked</a> tail</p>',
    startSelector: 'strong',
    startOffset: 1,
    endSelector: 'a',
    endOffset: 4,
    expected: {
      focus: 'old and link',
      from: 2,
      to: 14,
      startOrdinal: 0,
      startOffset: 1,
      endOrdinal: 0,
      endOffset: 13,
    },
  },
  {
    name: 'repeated text in a nested list item',
    content: '<ul><li><p>parent</p><ul><li><p>nested repeat</p></li></ul></li></ul>',
    startSelector: 'li li p',
    startOffset: 7,
    endOffset: 13,
    expected: {
      focus: 'repeat',
      from: 20,
      to: 26,
      startOrdinal: 0,
      startOffset: 19,
      endOrdinal: 0,
      endOffset: 25,
    },
  },
  {
    name: 'text nested in a blockquote',
    content: '<blockquote><p>quoted exact phrase</p></blockquote>',
    startSelector: 'blockquote p',
    startOffset: 7,
    endOffset: 12,
    expected: {
      focus: 'exact',
      from: 9,
      to: 14,
      startOrdinal: 0,
      startOffset: 8,
      endOrdinal: 0,
      endOffset: 13,
    },
  },
  {
    name: 'text nested in a table header cell',
    content: '<table><tbody><tr><th><p>Name</p></th><th><p>Role</p></th></tr></tbody></table>',
    startSelector: 'th:nth-of-type(2) p',
    startOffset: 0,
    endOffset: 4,
    expected: {
      focus: 'Role',
      from: 12,
      to: 16,
      startOrdinal: 0,
      startOffset: 11,
      endOrdinal: 0,
      endOffset: 15,
    },
  },
];

describe('feedback rendered ranges', () => {
  afterEach(() => {
    window.getSelection()?.removeAllRanges();
    document.body.replaceChildren();
  });

  it.each(EXACT_RENDERED_RANGE_CASES)('round-trips $name exactly', testCase => {
    const editor = createEditor(testCase.content);
    const start = textNode(editor.view.dom.querySelector(testCase.startSelector));
    const end = textNode(
      editor.view.dom.querySelector(testCase.endSelector ?? testCase.startSelector)
    );
    const nativeRange = selectDomText(start, testCase.startOffset, end, testCase.endOffset);

    const target = getFeedbackTargetFromDomRange(editor, nativeRange);

    expect(target).toEqual({
      kind: 'inline',
      focus: testCase.expected.focus,
      from: testCase.expected.from,
      to: testCase.expected.to,
      range: {
        version: 1,
        startOrdinal: testCase.expected.startOrdinal,
        startOffset: testCase.expected.startOffset,
        endOrdinal: testCase.expected.endOrdinal,
        endOffset: testCase.expected.endOffset,
      },
    });
    if (target?.kind === 'inline') {
      expect(resolveFeedbackRenderedRange(editor, target.range, testCase.expected.focus)).toEqual({
        focus: target.focus,
        from: target.from,
        to: target.to,
        range: target.range,
      });
    }
    editor.destroy();
  });

  it('normalizes CRLF only for visible Focus while retaining UTF-16 document offsets', () => {
    const editor = createEditor({
      type: 'doc',
      content: [
        {
          type: 'codeBlock',
          content: [{ type: 'text', text: 'alpha\r\nbeta' }],
        },
      ],
    });
    const codeText = textNode(editor.view.dom.querySelector('code'));
    const nativeRange = selectDomText(codeText, 0, codeText, codeText.length);

    const target = getFeedbackTargetFromDomRange(editor, nativeRange);

    expect(target).toEqual({
      kind: 'inline',
      focus: 'alpha\nbeta',
      from: 1,
      to: 12,
      range: {
        version: 1,
        startOrdinal: 0,
        startOffset: 0,
        endOrdinal: 0,
        endOffset: 11,
      },
    });
    if (target?.kind === 'inline') {
      expect(resolveFeedbackRenderedRange(editor, target.range, 'alpha\r\nbeta')).toEqual({
        focus: target.focus,
        from: target.from,
        to: target.to,
        range: target.range,
      });
    }
    editor.destroy();
  });

  it('falls back honestly for a native selection that crosses an image atom', () => {
    const editor = createEditor({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'before ' },
            { type: 'image', attrs: { src: 'fixture.png', alt: 'Architecture diagram' } },
            { type: 'text', text: ' after' },
          ],
        },
      ],
    });
    const paragraph = editor.view.dom.querySelector('p') as HTMLElement;
    const before = paragraph.firstChild as Text;
    const after = paragraph.lastChild as Text;
    const nativeRange = selectDomText(before, 0, after, after.length);

    expect(getFeedbackTargetFromDomRange(editor, nativeRange)).toEqual({
      kind: 'block',
      startOrdinal: 0,
      endOrdinal: 0,
      focus: nativeRange.toString(),
      reason: 'opaque-node',
    });
    editor.destroy();
  });

  it.each([
    {
      name: 'Mermaid-like rendered NodeView',
      content: {
        type: 'doc',
        content: [
          {
            type: 'mermaid',
            content: [{ type: 'text', text: 'graph TD; A-->B' }],
          },
        ],
      },
      selector: '[data-mermaid-like]',
      endOffset: 8,
      focus: 'Rendered',
    },
    {
      name: 'math-like atomic NodeView',
      content: {
        type: 'doc',
        content: [{ type: 'mathBlock', attrs: { latex: '∫ x dx' } }],
      },
      selector: '[data-math-like]',
      endOffset: 1,
      focus: '∫',
    },
  ])('uses a block bracket for an opaque $name', testCase => {
    const editor = createEditor(testCase.content);
    const renderedText = textNode(editor.view.dom.querySelector(testCase.selector));
    const nativeRange = selectDomText(renderedText, 0, renderedText, testCase.endOffset);

    expect(getFeedbackTargetFromDomRange(editor, nativeRange)).toEqual({
      kind: 'block',
      startOrdinal: 0,
      endOrdinal: 0,
      focus: testCase.focus,
      reason: 'opaque-node',
    });
    editor.destroy();
  });

  it('keeps an opaque Mermaid selection mapped when a retained GapCursor widget precedes it', () => {
    const editor = createEditor({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'before' }] },
        {
          type: 'mermaid',
          content: [{ type: 'text', text: 'graph TD; A-->B' }],
        },
      ],
    });
    const mermaid = editor.view.dom.querySelector('[data-mermaid-like]') as HTMLElement;
    const widget = document.createElement('div');
    widget.className = 'ProseMirror-gapcursor ProseMirror-widget';
    editor.view.dom.insertBefore(widget, mermaid);
    const renderedText = textNode(mermaid);
    const nativeRange = selectDomText(renderedText, 0, renderedText, 8);

    expect(getFeedbackTargetFromDomRange(editor, nativeRange)).toEqual({
      kind: 'block',
      startOrdinal: 1,
      endOrdinal: 1,
      focus: 'Rendered',
      reason: 'opaque-node',
    });
    editor.destroy();
  });

  it('keeps an unmappable table selection mapped when a retained widget precedes it', () => {
    const editor = createEditor({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'before' }] },
        {
          type: 'table',
          content: [
            {
              type: 'tableRow',
              content: [
                {
                  type: 'tableCell',
                  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Role' }] }],
                },
              ],
            },
          ],
        },
      ],
    });
    const table = editor.view.dom.querySelector('table') as HTMLTableElement;
    const tableBlock = table.parentElement as HTMLElement;
    const widget = document.createElement('span');
    widget.className = 'ProseMirror-widget';
    editor.view.dom.insertBefore(widget, tableBlock);
    const renderedText = textNode(table.querySelector('p'));
    const nativeRange = selectDomText(renderedText, 0, renderedText, renderedText.length);
    const positionSpy = jest.spyOn(editor.view, 'posAtDOM').mockImplementation(() => {
      throw new DOMException('Unmappable table NodeView');
    });

    try {
      expect(getFeedbackTargetFromDomRange(editor, nativeRange)).toEqual({
        kind: 'block',
        startOrdinal: 1,
        endOrdinal: 1,
        focus: 'Role',
        reason: 'unmappable-dom',
      });
    } finally {
      positionSpy.mockRestore();
      editor.destroy();
    }
  });

  it('uses the canonical opaque block for DOM-only Focus when nodeDOM is unavailable', () => {
    document.body.innerHTML = `
      <div class="tiptap">
        <p>before</p>
        <div class="ProseMirror-gapcursor ProseMirror-widget">Gap cursor chrome</div>
        <div data-dom-only-opaque>Rendered fallback</div>
        <p>after</p>
      </div>
    `;
    const nodes = [
      {
        type: { name: 'paragraph' },
        attrs: {},
        content: { size: 6 },
        nodeSize: 8,
        isAtom: false,
        isLeaf: false,
        isText: false,
        textBetween: () => 'before',
      },
      {
        type: { name: 'domOnlyOpaque' },
        attrs: {},
        content: { size: 0 },
        nodeSize: 1,
        isAtom: true,
        isLeaf: true,
        isText: false,
        textBetween: () => '',
      },
      {
        type: { name: 'paragraph' },
        attrs: {},
        content: { size: 5 },
        nodeSize: 7,
        isAtom: false,
        isLeaf: false,
        isText: false,
        textBetween: () => 'after',
      },
    ];
    const doc = {
      childCount: nodes.length,
      maybeChild: (ordinal: number) => nodes[ordinal] ?? null,
      forEach: (
        callback: (node: (typeof nodes)[number], offset: number, ordinal: number) => void
      ) => {
        let offset = 0;
        nodes.forEach((node, ordinal) => {
          callback(node, offset, ordinal);
          offset += node.nodeSize;
        });
      },
    };
    const editor = {
      state: { doc },
      view: { dom: document.querySelector('.tiptap') as HTMLElement },
    } as unknown as Editor;

    expect(feedbackFocusForBlockRange(editor, 1, 1)).toBe('Rendered fallback');
  });

  it('fails closed when ambiguous direct DOM cannot be resolved through nodeDOM', () => {
    const editor = createEditor({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'before' }] },
        {
          type: 'mermaid',
          content: [{ type: 'text', text: 'graph TD; A-->B' }],
        },
      ],
    });
    const mermaid = editor.view.dom.querySelector('[data-mermaid-like]') as HTMLElement;
    const foreign = document.createElement('div');
    foreign.dataset.foreign = '';
    editor.view.dom.insertBefore(foreign, mermaid);
    const renderedText = textNode(mermaid);
    const nativeRange = selectDomText(renderedText, 0, renderedText, 8);
    const positionSpy = jest.spyOn(editor.view, 'nodeDOM').mockImplementation(() => {
      throw new DOMException('Ambiguous custom DOM');
    });

    try {
      expect(getFeedbackTargetFromDomRange(editor, nativeRange)).toBeNull();
    } finally {
      positionSpy.mockRestore();
      editor.destroy();
    }
  });

  it('canonicalizes an end endpoint at the next block start back to visible content', () => {
    const editor = createEditor('<p>first</p><p>second</p>');
    const paragraphs = editor.view.dom.querySelectorAll('p');
    const first = textNode(paragraphs.item(0));
    const second = textNode(paragraphs.item(1));
    const nativeRange = selectDomText(first, 0, second, 0);

    expect(getFeedbackTargetFromDomRange(editor, nativeRange)).toEqual({
      kind: 'inline',
      focus: 'first',
      from: 1,
      to: 6,
      range: {
        version: 1,
        startOrdinal: 0,
        startOffset: 0,
        endOrdinal: 0,
        endOffset: 5,
      },
    });
    editor.destroy();
  });

  it('maps the selected repeated occurrence through DOM positions, never text search', () => {
    const editor = createEditor('<p>repeat repeat repeat</p>');
    const paragraphText = textNode(editor.view.dom.querySelector('p'));
    const range = selectDomText(paragraphText, 7, paragraphText, 13);

    const target = getFeedbackTargetFromDomRange(editor, range);

    expect(target).toEqual({
      kind: 'inline',
      focus: 'repeat',
      from: 8,
      to: 14,
      range: {
        version: 1,
        startOrdinal: 0,
        startOffset: 7,
        endOrdinal: 0,
        endOffset: 13,
      },
    });
    editor.destroy();
  });

  it('derives native block ordinals from endpoints without scanning a large document', () => {
    const editor = createEditor(
      Array.from({ length: 500 }, (_, index) => `<p>paragraph ${index}</p>`).join('')
    );
    const paragraphs = editor.view.dom.querySelectorAll('p');
    const finalText = textNode(paragraphs.item(paragraphs.length - 1));
    const range = selectDomText(finalText, 0, finalText, finalText.length);
    const intersectsNode = jest.spyOn(range, 'intersectsNode');
    const fullTraversal = jest.spyOn(editor.state.doc, 'forEach');

    expect(getFeedbackTargetFromDomRange(editor, range)).toMatchObject({
      kind: 'inline',
      range: { startOrdinal: 499, endOrdinal: 499 },
    });
    expect(intersectsNode).not.toHaveBeenCalled();
    expect(fullTraversal.mock.calls.length).toBeLessThanOrEqual(1);
    editor.destroy();
  });

  it('maps a ProseMirror text selection to the same exact occurrence', () => {
    const editor = createEditor('<p>repeat repeat repeat</p>');
    editor.commands.setTextSelection({ from: 8, to: 14 });

    expect(getFeedbackTargetFromProseMirrorSelection(editor)).toEqual({
      kind: 'inline',
      focus: 'repeat',
      from: 8,
      to: 14,
      range: {
        version: 1,
        startOrdinal: 0,
        startOffset: 7,
        endOrdinal: 0,
        endOffset: 13,
      },
    });
    editor.destroy();
  });

  it('keeps Focus identical to the resolved DOM range across block separators', () => {
    const editor = createEditor('<p>alpha</p><p>beta</p>');
    window.getSelection()?.removeAllRanges();
    editor.commands.setTextSelection({ from: 2, to: 10 });

    const target = getFeedbackSelectionTarget(editor, [
      { ordinal: 0, startLine: 1, endLine: 1 },
      { ordinal: 1, startLine: 3, endLine: 3 },
    ]);

    expect(target?.renderedRange).toBeDefined();
    expect(
      target?.renderedRange
        ? resolveFeedbackRenderedRange(editor, target.renderedRange)?.focus
        : undefined
    ).toBe(target?.focus);
    editor.destroy();
  });

  it('uses semantic whole-block Focus when a native selection cannot expose a DOM Range', () => {
    const editor = createEditor('<p>alpha beta</p>');
    const text = textNode(editor.view.dom.querySelector('p'));
    const selectionSpy = jest.spyOn(window, 'getSelection').mockReturnValue({
      anchorNode: text,
      focusNode: text,
      anchorOffset: 0,
      focusOffset: 5,
      isCollapsed: false,
      rangeCount: 1,
      getRangeAt: () => {
        throw new DOMException('Range unavailable');
      },
      toString: () => 'alpha',
    } as unknown as Selection);

    try {
      expect(
        getFeedbackSelectionTarget(editor, [{ ordinal: 0, startLine: 1, endLine: 1 }])
      ).toEqual({
        startOrdinal: 0,
        endOrdinal: 0,
        focus: 'alpha beta',
        startLine: 1,
        endLine: 1,
        presentationReason: 'unmappable-dom',
      });
    } finally {
      selectionSpy.mockRestore();
      editor.destroy();
    }
  });

  it('ignores a retained direct-child widget in the native no-Range fallback', () => {
    const editor = createEditor({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'before' }] },
        {
          type: 'mermaid',
          content: [{ type: 'text', text: 'graph TD; A-->B' }],
        },
      ],
    });
    const mermaid = editor.view.dom.querySelector('[data-mermaid-like]') as HTMLElement;
    const widget = document.createElement('div');
    widget.className = 'ProseMirror-gapcursor ProseMirror-widget';
    editor.view.dom.insertBefore(widget, mermaid);
    const renderedText = textNode(mermaid);
    const selectionSpy = jest.spyOn(window, 'getSelection').mockReturnValue({
      anchorNode: renderedText,
      focusNode: renderedText,
      anchorOffset: 0,
      focusOffset: 8,
      isCollapsed: false,
      rangeCount: 0,
      toString: () => 'Rendered',
    } as unknown as Selection);

    try {
      expect(
        getFeedbackSelectionTarget(editor, [
          { ordinal: 0, startLine: 1, endLine: 1 },
          { ordinal: 1, startLine: 3, endLine: 5 },
        ])
      ).toEqual({
        startOrdinal: 1,
        endOrdinal: 1,
        focus: 'graph TD; A-->B',
        startLine: 3,
        endLine: 5,
        presentationReason: 'unmappable-dom',
      });
    } finally {
      selectionSpy.mockRestore();
      editor.destroy();
    }
  });

  it('normalizes endpoints on block boundaries to blocks containing visible text', () => {
    const editor = createEditor('<p>first</p><p>second</p>');
    const paragraphs = editor.view.dom.querySelectorAll('p');
    const first = textNode(paragraphs.item(0));
    const second = textNode(paragraphs.item(1));
    const range = selectDomText(first, first.length, second, 6);

    expect(getFeedbackTargetFromDomRange(editor, range)).toEqual({
      kind: 'inline',
      focus: 'second',
      from: 8,
      to: 14,
      range: {
        version: 1,
        startOrdinal: 1,
        startOffset: 0,
        endOrdinal: 1,
        endOffset: 6,
      },
    });
    editor.destroy();
  });

  it('uses mapped ordinals for a native range whose endpoints are the editor root', () => {
    const editor = createEditor('<p>alpha</p><p>beta</p>');
    const range = document.createRange();
    range.setStart(editor.view.dom, 0);
    range.setEnd(editor.view.dom, 2);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    const target = getFeedbackSelectionTarget(editor, [
      { ordinal: 0, startLine: 1, endLine: 1 },
      { ordinal: 1, startLine: 3, endLine: 3 },
    ]);

    expect(target).toMatchObject({
      startOrdinal: 0,
      endOrdinal: 1,
      renderedRange: { startOrdinal: 0, endOrdinal: 1 },
    });
    editor.destroy();
  });

  it('keeps marked text exact even though its DOM is nested', () => {
    const editor = createEditor('<p>before <strong>repeat</strong> after</p>');
    const strongText = textNode(editor.view.dom.querySelector('strong'));
    const range = selectDomText(strongText, 0, strongText, strongText.length);

    const target = getFeedbackTargetFromDomRange(editor, range);

    expect(target?.kind).toBe('inline');
    expect(target?.focus).toBe('repeat');
    if (target?.kind === 'inline') {
      expect(target.range.startOffset).toBe(7);
      expect(target.range.endOffset).toBe(13);
    }
    editor.destroy();
  });

  it('supports exact selection inside a code block contentDOM', () => {
    const editor = createEditor('<pre><code>alpha\nbeta</code></pre>');
    const codeText = textNode(editor.view.dom.querySelector('code'));
    const range = selectDomText(codeText, 6, codeText, 10);

    const target = getFeedbackTargetFromDomRange(editor, range);

    expect(target?.kind).toBe('inline');
    expect(target?.focus).toBe('beta');
    if (target?.kind === 'inline') {
      expect(target.range).toMatchObject({
        startOrdinal: 0,
        startOffset: 6,
        endOrdinal: 0,
        endOffset: 10,
      });
    }
    editor.destroy();
  });

  it('falls back to the containing block when text selection crosses an inline atom', () => {
    const editor = createEditor({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'before ' },
            { type: 'inlineOpaque', attrs: { label: 'chip' } },
            { type: 'text', text: ' after' },
          ],
        },
      ],
    });
    const paragraph = editor.view.dom.querySelector('p') as HTMLElement;
    const before = paragraph.firstChild as Text;
    const after = paragraph.lastChild as Text;
    const range = selectDomText(before, 0, after, after.length);

    expect(getFeedbackTargetFromDomRange(editor, range)).toMatchObject({
      kind: 'block',
      startOrdinal: 0,
      endOrdinal: 0,
      reason: 'opaque-node',
    });
    editor.destroy();
  });

  it('keeps a text selection spanning a hard break exact', () => {
    const editor = createEditor('<p>alpha<br>beta</p>');
    const paragraph = editor.view.dom.querySelector('p') as HTMLElement;
    const before = paragraph.firstChild as Text;
    const after = paragraph.lastChild as Text;
    const range = selectDomText(before, 2, after, 2);

    expect(getFeedbackTargetFromDomRange(editor, range)?.kind).toBe('inline');
    editor.destroy();
  });

  it('does not mistake production code-block copy chrome for opaque content', () => {
    const element = document.createElement('div');
    document.body.appendChild(element);
    const editor = new Editor({
      element,
      extensions: [StarterKit.configure({ codeBlock: false }), CopyCodeBlock],
      content: '<pre><code>alpha\nbeta</code></pre>',
    });
    const codeText = textNode(editor.view.dom.querySelector('code'));
    const range = selectDomText(codeText, 6, codeText, 10);

    expect(getFeedbackTargetFromDomRange(editor, range)).toMatchObject({
      kind: 'inline',
      focus: 'beta',
    });
    editor.destroy();
  });

  it('maps repeated text inside nested list content without choosing the first occurrence', () => {
    const editor = createEditor('<ul><li><p>one repeat</p></li><li><p>two repeat</p></li></ul>');
    const listParagraphs = editor.view.dom.querySelectorAll('li p');
    const secondItem = textNode(listParagraphs.item(1));
    const range = selectDomText(secondItem, 4, secondItem, 10);

    const target = getFeedbackTargetFromDomRange(editor, range);

    expect(target?.kind).toBe('inline');
    expect(target?.focus).toBe('repeat');
    if (target?.kind === 'inline') {
      expect(target.range.startOrdinal).toBe(0);
      expect(target.from).toBeGreaterThan(editor.state.doc.textContent.indexOf('repeat') + 1);
      expect(resolveFeedbackRenderedRange(editor, target.range, 'repeat')).toMatchObject({
        from: target.from,
        to: target.to,
      });
    }
    editor.destroy();
  });

  it('round-trips a native range spanning two text blocks', () => {
    const editor = createEditor('<p>alpha</p><blockquote><p>beta</p></blockquote>');
    const first = textNode(editor.view.dom.querySelector('p'));
    const second = textNode(editor.view.dom.querySelector('blockquote p'));
    const range = selectDomText(first, 2, second, 2);

    const target = getFeedbackTargetFromDomRange(editor, range);

    expect(target?.kind).toBe('inline');
    if (target?.kind === 'inline') {
      expect(target.range).toMatchObject({ startOrdinal: 0, endOrdinal: 1 });
      expect(resolveFeedbackRenderedRange(editor, target.range, target.focus)).toMatchObject({
        from: target.from,
        to: target.to,
      });
    }
    editor.destroy();
  });

  it('returns an honest block fallback for an opaque atomic NodeView', () => {
    const editor = createEditor({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'before' }] },
        { type: 'opaqueDiagram', attrs: { label: 'Rendered diagram' } },
        { type: 'paragraph', content: [{ type: 'text', text: 'after' }] },
      ],
    });
    const opaqueText = textNode(editor.view.dom.querySelector('[data-opaque-diagram]'));
    const range = selectDomText(opaqueText, 0, opaqueText, 8);

    expect(getFeedbackTargetFromDomRange(editor, range)).toEqual({
      kind: 'block',
      startOrdinal: 1,
      endOrdinal: 1,
      focus: 'Rendered',
      reason: 'opaque-node',
    });
    editor.destroy();
  });

  it('returns a block fallback for a ProseMirror node selection', () => {
    const editor = createEditor({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'before' }] },
        { type: 'opaqueDiagram', attrs: { label: 'Rendered diagram' } },
      ],
    });
    const opaquePos = editor.state.doc.child(0).nodeSize;
    editor.view.dispatch(
      editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, opaquePos))
    );

    expect(getFeedbackTargetFromProseMirrorSelection(editor)).toEqual({
      kind: 'block',
      startOrdinal: 1,
      endOrdinal: 1,
      focus: 'Rendered diagram',
      reason: 'opaque-node',
    });
    editor.destroy();
  });

  it('labels a non-opaque node selection as a block selection and excludes NodeView chrome', () => {
    const element = document.createElement('div');
    document.body.appendChild(element);
    const editor = new Editor({
      element,
      extensions: [StarterKit.configure({ codeBlock: false }), CopyCodeBlock],
      content: '<pre><code>alpha\nbeta</code></pre>',
    });
    editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, 0)));

    expect(getFeedbackTargetFromProseMirrorSelection(editor)).toEqual({
      kind: 'block',
      startOrdinal: 0,
      endOrdinal: 0,
      focus: 'alpha\nbeta',
      reason: 'block-selection',
    });
    editor.destroy();
  });

  it('keeps transient NodeView control text out of block-selection Focus', () => {
    const element = document.createElement('div');
    document.body.appendChild(element);
    const editor = new Editor({
      element,
      extensions: [StarterKit.configure({ codeBlock: false }), CopyCodeBlock],
      content: '<pre><code>  alpha\n    beta</code></pre>',
    });
    const tooltip = editor.view.dom.querySelector('.code-block-copy-tooltip');
    const button = editor.view.dom.querySelector('.code-block-copy-button');
    if (tooltip) tooltip.textContent = 'Copied!';
    if (button) button.append('Copy');
    editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, 0)));

    expect(getFeedbackTargetFromProseMirrorSelection(editor)).toEqual({
      kind: 'block',
      startOrdinal: 0,
      endOrdinal: 0,
      focus: '  alpha\n    beta',
      reason: 'block-selection',
    });
    editor.destroy();
  });

  it('bounds whole-block Focus before traversing a block larger than one MiB', () => {
    const source = 'x'.repeat(1024 * 1024 + 1);
    const editor = createEditor({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: source }] }],
    });
    const block = editor.state.doc.child(0);
    const textBetweenSpy = jest.spyOn(block, 'textBetween');
    const nodesBetweenSpy = jest.spyOn(block, 'nodesBetween');
    editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, 0)));

    try {
      const hoverFocus = feedbackFocusForMappedBlock(
        editor,
        0,
        editor.view.dom.firstElementChild as HTMLElement
      );
      const target = getFeedbackTargetFromProseMirrorSelection(editor);

      expect(hoverFocus).toHaveLength(64 * 1024);
      expect(hoverFocus.endsWith('\n[Focus truncated]')).toBe(true);
      expect(target).toMatchObject({
        kind: 'block',
        startOrdinal: 0,
        endOrdinal: 0,
        reason: 'block-selection',
      });
      expect(target?.focus).toHaveLength(64 * 1024);
      expect(target?.focus.endsWith('\n[Focus truncated]')).toBe(true);
      // Focus comes from a bounded walk that stops past the 64 Ki-character
      // limit, never from textBetween over the whole multi-megabyte node.
      expect(nodesBetweenSpy).toHaveBeenCalled();
      expect(
        textBetweenSpy.mock.calls.every(([, to]) => typeof to === 'number' && to <= 64 * 1024 + 1)
      ).toBe(true);
    } finally {
      textBetweenSpy.mockRestore();
      nodesBetweenSpy.mockRestore();
      editor.destroy();
    }
  });

  it('measures whole-block Focus in characters, not ProseMirror positions', () => {
    // Each item costs 14 positions but only 11 characters, so the list spans
    // more than 64 Ki positions while its text stays well below 64 Ki characters.
    const items = Array.from(
      { length: 5_000 },
      (_, index) => `item${String(index).padStart(6, '0')}`
    );
    const editor = createEditor({
      type: 'doc',
      content: [
        {
          type: 'bulletList',
          content: items.map(text => ({
            type: 'listItem',
            content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
          })),
        },
      ],
    });

    try {
      expect(editor.state.doc.child(0).content.size).toBeGreaterThan(64 * 1024);
      const focus = feedbackFocusForBlockRange(editor, 0, 0);
      expect(focus).not.toContain('[Focus truncated]');
      expect(focus).toBe(items.join('\n'));
    } finally {
      editor.destroy();
    }
  });

  it('cuts truncated whole-block Focus on a code point boundary', () => {
    const sentinel = '\n[Focus truncated]';
    const prefix = 'x'.repeat(64 * 1024 - sentinel.length - 1);
    const editor = createEditor({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: `${prefix}\u{1F600}${'y'.repeat(100)}` }],
        },
      ],
    });

    try {
      const focus = feedbackFocusForBlockRange(editor, 0, 0);
      expect(focus).toBe(`${prefix}\u{1F600}${sentinel}`);
      expect(focus).not.toMatch(
        /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/
      );
    } finally {
      editor.destroy();
    }
  });

  it('reads a structure-heavy block once and stops at the character limit', () => {
    // Each item is 5 positions but 2 characters ("a" plus a block separator),
    // the shape of sparse tables and short lists.
    const editor = createEditor({
      type: 'doc',
      content: [
        {
          type: 'bulletList',
          content: Array.from({ length: 2_000 }, () => ({
            type: 'listItem',
            content: [{ type: 'paragraph', content: [{ type: 'text', text: 'a' }] }],
          })),
        },
      ],
    });
    const list = editor.state.doc.child(0);
    const itemReads = Array.from({ length: list.childCount }, (_, index) =>
      jest.spyOn(list.child(index), 'nodesBetween')
    );

    try {
      const bounded = boundedNodeText(list, 1_000);

      expect(bounded).toEqual({ text: 'a\n'.repeat(500), truncated: true });
      // Item 500 holds the first character past the limit, so 501 items is the
      // least any reader can enter. Re-reading from position 0 with a growing
      // window entered 1,403.
      const enteredItems = itemReads.reduce((total, spy) => total + spy.mock.calls.length, 0);
      expect(enteredItems).toBeLessThanOrEqual(501);
    } finally {
      itemReads.forEach(spy => spy.mockRestore());
      editor.destroy();
    }
  });

  it('matches textBetween block and leaf separators at every limit', () => {
    const editor = createEditor(
      [
        '<blockquote><p>one<br>two</p><p></p><ul><li><p>\u{1F600}x</p><ul><li><p>deep</p></li></ul></li></ul><hr><pre><code>a\nb</code></pre></blockquote>',
        '<table><tbody><tr><th><p>H</p></th><th><p></p></th></tr><tr><td><p></p></td><td><p>c\u{1F600}</p></td></tr></tbody></table>',
      ].join('')
    );

    try {
      for (let index = 0; index < editor.state.doc.childCount; index += 1) {
        const block = editor.state.doc.child(index);
        const full = block.textBetween(0, block.content.size, '\n', '\n');
        expect(boundedNodeText(block, 1_000)).toEqual({ text: full, truncated: false });
        for (let limit = 0; limit <= codePointLength(full); limit += 1) {
          expect(boundedNodeText(block, limit)).toEqual({
            text: codePointPrefix(full, limit),
            truncated: codePointLength(full) > limit,
          });
        }
      }
    } finally {
      editor.destroy();
    }
  });

  it('never exceeds the limit for a block whose rules yield more characters than positions', () => {
    // A horizontal rule takes one position but yields two characters, a block
    // separator and its leaf newline, so this block's text outgrows its size.
    const editor = createEditor(`<blockquote>${'<hr>'.repeat(10)}</blockquote>`);

    try {
      const block = editor.state.doc.child(0);
      const full = block.textBetween(0, block.content.size, '\n', '\n');
      expect(block.content.size).toBe(10);
      expect(codePointLength(full)).toBe(19);
      for (let limit = 0; limit <= codePointLength(full); limit += 1) {
        expect(boundedNodeText(block, limit)).toEqual({
          text: codePointPrefix(full, limit),
          truncated: codePointLength(full) > limit,
        });
      }
    } finally {
      editor.destroy();
    }
  });

  it('counts code points, not UTF-16 units, when it cuts a block read whole', () => {
    // Both blocks fit the limit in positions, so each is read whole and then
    // cut. An emoji is one code point but two UTF-16 units.
    const emoji = '\u{1F600}';
    const editor = createEditor(
      `<blockquote><p>${emoji}</p><hr><hr><hr></blockquote>` +
        `<blockquote>${'<hr>'.repeat(5)}<p>${emoji}${emoji}</p></blockquote>`
    );

    try {
      // 7 positions, 7 code points, 8 UTF-16 units: nothing is omitted.
      const fits = editor.state.doc.child(0);
      expect(fits.content.size).toBe(7);
      expect(boundedNodeText(fits, 7)).toEqual({
        text: `${emoji}${'\n'.repeat(6)}`,
        truncated: false,
      });

      // 11 positions, 12 code points: the cut keeps 11 whole code points.
      const cut = editor.state.doc.child(1);
      expect(cut.content.size).toBe(11);
      expect(boundedNodeText(cut, 11)).toEqual({
        text: `${'\n'.repeat(10)}${emoji}`,
        truncated: true,
      });
    } finally {
      editor.destroy();
    }
  });

  it('resolves valid block-relative positions and validates exact visible Focus', () => {
    const editor = createEditor('<p>repeat repeat repeat</p>');
    const renderedRange = {
      version: 1 as const,
      startOrdinal: 0,
      startOffset: 7,
      endOrdinal: 0,
      endOffset: 13,
    };

    const resolved = resolveFeedbackRenderedRange(editor, renderedRange, 'repeat');

    expect(resolved).toMatchObject({ from: 8, to: 14, focus: 'repeat' });
    expect(resolveFeedbackRenderedRange(editor, renderedRange, 'wrong')).toBeNull();
    editor.destroy();
  });

  it('rejects malformed or out-of-bounds ranges without clamping', () => {
    const editor = createEditor('<p>short</p><p>other</p>');

    expect(
      resolveFeedbackRenderedRange(editor, {
        version: 1,
        startOrdinal: 0,
        startOffset: 2,
        endOrdinal: 0,
        endOffset: 99,
      })
    ).toBeNull();
    expect(
      resolveFeedbackRenderedRange(editor, {
        version: 1,
        startOrdinal: 1,
        startOffset: 2,
        endOrdinal: 0,
        endOffset: 4,
      })
    ).toBeNull();
    expect(
      resolveFeedbackRenderedRange(editor, {
        version: 1,
        startOrdinal: 0,
        startOffset: 5,
        endOrdinal: 1,
        endOffset: 0,
      })
    ).toBeNull();
    editor.destroy();
  });

  it('returns null when a DOM range is collapsed or outside the editor', () => {
    const editor = createEditor('<p>inside</p>');
    const outside = document.createTextNode('outside');
    document.body.appendChild(outside);
    const outsideRange = selectDomText(outside, 0, outside, 3);
    const inside = textNode(editor.view.dom.querySelector('p'));
    const collapsed = selectDomText(inside, 2, inside, 2);

    expect(getFeedbackTargetFromDomRange(editor, outsideRange)).toBeNull();
    expect(getFeedbackTargetFromDomRange(editor, collapsed)).toBeNull();
    editor.destroy();
  });

  it('converts absolute positions using UTF-16 block content offsets', () => {
    const editor = createEditor('<p>A😀B</p>');

    expect(blockRelativeRangeFromPositions(editor.state.doc, 2, 4)).toEqual({
      version: 1,
      startOrdinal: 0,
      startOffset: 1,
      endOrdinal: 0,
      endOffset: 3,
    });
    editor.destroy();
  });
});
