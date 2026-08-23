/** @jest-environment jsdom */

import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import {
  buildFeedbackAnnotationSegments,
  createFeedbackAnnotationController,
  feedbackAnnotationsPluginKey,
  getFeedbackAnnotationState,
  PENDING_FEEDBACK_ANNOTATION_ID,
} from '../../webview/features/feedbackAnnotations';
import { createFeedbackReviewController } from '../../webview/features/feedbackReview';

function createEditor(
  content: string | Record<string, unknown> = '<p>abcdefghij</p><p>second block</p>'
): Editor {
  const element = document.createElement('div');
  document.body.appendChild(element);
  return new Editor({ element, extensions: [StarterKit], content });
}

function createReviewEditor(content = '<p>abcdefghij</p>'): Editor {
  document.body.innerHTML =
    '<div class="formatting-toolbar"></div><main><div id="editor"></div></main>';
  const editor = new Editor({
    element: document.querySelector('#editor') as HTMLElement,
    extensions: [StarterKit],
    content,
  });
  editor.view.dom.getBoundingClientRect = () =>
    ({
      top: 0,
      bottom: 400,
      left: 0,
      right: 800,
      width: 800,
      height: 400,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }) as DOMRect;
  Array.from(editor.view.dom.children).forEach((element, ordinal) => {
    (element as HTMLElement).getBoundingClientRect = () => {
      const top = 24 + ordinal * 48;
      return {
        top,
        bottom: top + 28,
        left: 24,
        right: 700,
        width: 676,
        height: 28,
        x: 24,
        y: top,
        toJSON: () => ({}),
      } as DOMRect;
    };
  });
  return editor;
}

describe('feedback annotation decorations with a real editor', () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it('splits overlapping inline targets into stable non-overlapping segments', () => {
    expect(
      buildFeedbackAnnotationSegments([
        { id: 'F2', kind: 'inline', from: 4, to: 10 },
        { id: 'F1', kind: 'inline', from: 1, to: 7 },
      ])
    ).toEqual([
      { from: 1, to: 4, ids: ['F1'] },
      { from: 4, to: 7, ids: ['F1', 'F2'] },
      { from: 7, to: 10, ids: ['F2'] },
    ]);
  });

  it('keeps disjoint segments for one feedback ID', () => {
    expect(
      buildFeedbackAnnotationSegments([
        { id: 'F1', kind: 'inline', from: 1, to: 3 },
        { id: 'F1', kind: 'inline', from: 7, to: 9 },
      ])
    ).toEqual([
      { from: 1, to: 3, ids: ['F1'] },
      { from: 7, to: 9, ids: ['F1'] },
    ]);
  });

  it('does no plugin registration, dispatch, or DOM work outside Feedback mode', () => {
    const editor = createEditor();
    const controller = createFeedbackAnnotationController(editor);
    const dispatch = jest.spyOn(editor.view, 'dispatch');

    controller.setItems([{ id: 'F1', kind: 'inline', from: 1, to: 4 }]);

    expect(feedbackAnnotationsPluginKey.get(editor.state)).toBeUndefined();
    expect(dispatch).not.toHaveBeenCalled();
    expect(editor.view.dom.querySelector('[data-feedback-ids]')).toBeNull();
    editor.destroy();
  });

  it('registers dynamically and renders overlap segments with unique feedback attributes', () => {
    const editor = createEditor();
    const controller = createFeedbackAnnotationController(editor);
    controller.register();
    controller.setItems([
      { id: 'F2', kind: 'inline', from: 4, to: 10 },
      { id: 'F1', kind: 'inline', from: 1, to: 7 },
    ]);

    const segments = Array.from(
      editor.view.dom.querySelectorAll<HTMLElement>('.md4h-feedback-annotation-inline')
    );
    expect(segments.map(segment => segment.textContent)).toEqual(['abc', 'def', 'ghi']);
    expect(segments.map(segment => segment.dataset.feedbackIds)).toEqual(['F1', 'F1,F2', 'F2']);
    expect(editor.state.doc.textContent).toBe('abcdefghijsecond block');
    editor.destroy();
  });

  it('supports one feedback-only pending exact selection decoration', () => {
    const editor = createEditor();
    const controller = createFeedbackAnnotationController(editor);
    controller.register();

    controller.setItems([{ id: PENDING_FEEDBACK_ANNOTATION_ID, kind: 'inline', from: 1, to: 4 }]);

    const pending = editor.view.dom.querySelector<HTMLElement>(
      `[data-feedback-ids="${PENDING_FEEDBACK_ANNOTATION_ID}"]`
    );
    expect(pending?.textContent).toBe('abc');
    editor.destroy();
  });

  it('uses only the exact decoration for an active rendered-range comment', () => {
    const editor = createReviewEditor();
    const review = createFeedbackReviewController({ editor, host: { postMessage: jest.fn() } });
    review.activate({
      sessionId: 'session-1',
      source: 'docs/guide.md',
      sourceSha256: 'c'.repeat(64),
      round: 'round-1',
      items: [
        {
          id: 'F1',
          kind: 'text',
          startOrdinal: 0,
          endOrdinal: 0,
          startLine: 1,
          endLine: 1,
          focus: 'abc',
          feedback: 'Clarify this selection.',
          renderedRange: {
            version: 1,
            startOrdinal: 0,
            startOffset: 0,
            endOrdinal: 0,
            endOffset: 3,
            startBlockSha256: 'a'.repeat(64),
            endBlockSha256: 'a'.repeat(64),
          },
        },
      ],
    });

    (document.querySelector('[data-feedback-marker]') as HTMLButtonElement).click();

    expect(editor.view.dom.querySelector('.md4h-feedback-annotation-inline')?.classList).toContain(
      'is-feedback-active'
    );
    expect(editor.view.dom.firstElementChild?.classList).not.toContain('feedback-active-target');
    review.deactivate();
    editor.destroy();
  });

  it('does not add a fallback bracket for an exact cross-block rendered range', () => {
    const editor = createReviewEditor('<p>abc</p><p>xyz</p>');
    const review = createFeedbackReviewController({ editor, host: { postMessage: jest.fn() } });
    review.activate({
      sessionId: 'session-1',
      source: 'docs/guide.md',
      sourceSha256: 'c'.repeat(64),
      round: 'round-1',
      items: [
        {
          id: 'F1',
          kind: 'text',
          startOrdinal: 0,
          endOrdinal: 1,
          startLine: 1,
          endLine: 2,
          focus: 'abcxyz',
          feedback: 'Clarify this selection.',
          renderedRange: {
            version: 1,
            startOrdinal: 0,
            startOffset: 0,
            endOrdinal: 1,
            endOffset: 3,
            startBlockSha256: 'a'.repeat(64),
            endBlockSha256: 'b'.repeat(64),
          },
        },
      ],
    });

    expect(editor.view.dom.querySelectorAll('.md4h-feedback-annotation-inline')).toHaveLength(2);
    expect(document.querySelector('[data-feedback-target-bracket="F1"]')).toBeNull();
    expect(document.querySelector('[data-feedback-anchor-alert]')).toBeNull();
    review.deactivate();
    editor.destroy();
  });

  it('shows a safe anchor diagnostic and clears it when Retry resolves the exact range', () => {
    const editor = createReviewEditor('<p>abc</p><p>xyz</p>');
    const originalDomAtPos = editor.view.domAtPos.bind(editor.view);
    let rangeUnavailable = true;
    const domAtPos = jest.spyOn(editor.view, 'domAtPos').mockImplementation(position => {
      if (rangeUnavailable) throw new Error('temporary DOM mapping failure');
      return originalDomAtPos(position);
    });
    const review = createFeedbackReviewController({ editor, host: { postMessage: jest.fn() } });
    review.activate({
      sessionId: 'session-1',
      source: 'docs/guide.md',
      sourceSha256: 'c'.repeat(64),
      round: 'round-1',
      items: [
        {
          id: 'F1',
          kind: 'text',
          startOrdinal: 0,
          endOrdinal: 1,
          startLine: 1,
          endLine: 2,
          focus: 'abcxyz',
          feedback: 'Clarify this selection.',
          renderedRange: {
            version: 1,
            startOrdinal: 0,
            startOffset: 0,
            endOrdinal: 1,
            endOffset: 3,
            startBlockSha256: 'a'.repeat(64),
            endBlockSha256: 'b'.repeat(64),
          },
        },
      ],
    });

    const alert = document.querySelector('[data-feedback-anchor-alert]') as HTMLElement;
    expect(alert.getAttribute('role')).toBe('alert');
    expect(alert.textContent).toContain('MD4H-FB-ANCHOR-001');
    expect(alert.textContent).toContain('F1');
    expect(alert.textContent).not.toContain('abc');
    expect(alert.textContent).not.toContain('xyz');
    expect(document.querySelector('[data-feedback-target-bracket="F1"]')).not.toBeNull();

    rangeUnavailable = false;
    (alert.querySelector('[data-feedback-anchor-retry]') as HTMLButtonElement).click();

    expect(document.querySelector('[data-feedback-anchor-alert]')).toBeNull();
    expect(document.querySelector('[data-feedback-target-bracket="F1"]')).toBeNull();
    expect(editor.view.dom.querySelectorAll('.md4h-feedback-annotation-inline')).toHaveLength(2);
    domAtPos.mockRestore();
    review.deactivate();
    editor.destroy();
  });

  it('clears a runtime anchor diagnostic when its feedback item disappears', () => {
    const editor = createReviewEditor('<p>abc</p>');
    const review = createFeedbackReviewController({ editor, host: { postMessage: jest.fn() } });
    review.activate({
      sessionId: 'session-1',
      source: 'docs/guide.md',
      sourceSha256: 'c'.repeat(64),
      round: 'round-1',
      items: [
        {
          id: 'F1',
          kind: 'text',
          startOrdinal: 0,
          endOrdinal: 0,
          startLine: 1,
          endLine: 1,
          focus: 'does not match',
          feedback: 'Clarify this selection.',
          renderedRange: {
            version: 1,
            startOrdinal: 0,
            startOffset: 0,
            endOrdinal: 0,
            endOffset: 3,
            startBlockSha256: 'a'.repeat(64),
            endBlockSha256: 'a'.repeat(64),
          },
        },
      ],
    });
    expect(document.querySelector('[data-feedback-anchor-alert]')).not.toBeNull();

    review.updateItems([]);

    expect(document.querySelector('[data-feedback-anchor-alert]')).toBeNull();
    review.deactivate();
    editor.destroy();
  });

  it('keeps a pending exact selection inline without a whole-block wash', () => {
    const editor = createReviewEditor();
    const review = createFeedbackReviewController({ editor, host: { postMessage: jest.fn() } });
    review.activate({
      sessionId: 'session-1',
      source: 'docs/guide.md',
      sourceSha256: 'c'.repeat(64),
      round: 'round-1',
      items: [],
    });

    review.openTextComposer({
      startOrdinal: 0,
      endOrdinal: 0,
      startLine: 1,
      endLine: 1,
      focus: 'abc',
      renderedRange: {
        version: 1,
        startOrdinal: 0,
        startOffset: 0,
        endOrdinal: 0,
        endOffset: 3,
      },
    });

    expect(
      editor.view.dom.querySelector(`[data-feedback-ids="${PENDING_FEEDBACK_ANNOTATION_ID}"]`)
        ?.textContent
    ).toBe('abc');
    expect(editor.view.dom.firstElementChild?.classList).not.toContain('feedback-pending-target');
    review.deactivate();
    editor.destroy();
  });

  it('lets ProseMirror split one exact cross-block decoration without changing the document', () => {
    const editor = createEditor('<p>abc</p><p>xyz</p>');
    const controller = createFeedbackAnnotationController(editor);
    const before = editor.state.doc.toJSON();
    controller.register();
    controller.setItems([{ id: 'F1', kind: 'inline', from: 2, to: 8 }]);

    const decorated = Array.from(
      editor.view.dom.querySelectorAll<HTMLElement>('.md4h-feedback-annotation-inline')
    );
    expect(decorated.map(element => element.textContent)).toEqual(['bc', 'xy']);
    expect(editor.state.doc.toJSON()).toEqual(before);
    editor.destroy();
  });

  it('validates many targets without traversing every document block per item', () => {
    const editor = createEditor(
      Array.from({ length: 100 }, (_, index) => `<p>block ${index}</p>`).join('')
    );
    const items: Array<{ id: string; kind: 'inline'; from: number; to: number }> = [];
    editor.state.doc.forEach((_node, offset, ordinal) => {
      items.push({ id: `F${ordinal + 1}`, kind: 'inline', from: offset + 1, to: offset + 2 });
    });
    const controller = createFeedbackAnnotationController(editor);
    controller.register();
    const fullTraversal = jest.spyOn(editor.state.doc, 'forEach');

    controller.setItems(items);

    // DecorationSet construction may traverse the document once. Validation
    // must not multiply that by the number of comments.
    expect(fullTraversal.mock.calls.length).toBeLessThanOrEqual(2);
    expect(getFeedbackAnnotationState(editor)?.items).toHaveLength(100);
    editor.destroy();
  });

  it('marks every segment belonging to an active ID without stacking backgrounds', () => {
    const editor = createEditor();
    const controller = createFeedbackAnnotationController(editor);
    controller.register();
    controller.setItems([
      { id: 'F1', kind: 'inline', from: 1, to: 7 },
      { id: 'F2', kind: 'inline', from: 4, to: 10 },
    ]);
    controller.setActiveIds(['F2']);

    const segments = Array.from(
      editor.view.dom.querySelectorAll<HTMLElement>('.md4h-feedback-annotation-inline')
    );
    expect(segments.map(segment => segment.classList.contains('is-feedback-active'))).toEqual([
      false,
      true,
      true,
    ]);
    expect(segments[1].dataset.feedbackActiveIds).toBe('F2');
    editor.destroy();
  });

  it('groups node targets on the same boundary into one node decoration', () => {
    const editor = createEditor();
    const controller = createFeedbackAnnotationController(editor);
    const firstNode = editor.state.doc.child(0);
    controller.register();
    controller.setItems([
      { id: 'F2', kind: 'node', from: 0, to: firstNode.nodeSize },
      { id: 'F1', kind: 'node', from: 0, to: firstNode.nodeSize },
    ]);

    const decorated = editor.view.dom.querySelector<HTMLElement>('.md4h-feedback-annotation-node');
    expect(decorated?.tagName).toBe('P');
    expect(decorated?.dataset.feedbackIds).toBe('F1,F2');
    expect(editor.view.dom.querySelectorAll('.md4h-feedback-annotation-node')).toHaveLength(1);
    editor.destroy();
  });

  it('allows one block feedback item to decorate several containing nodes', () => {
    const editor = createEditor();
    const controller = createFeedbackAnnotationController(editor);
    const firstNode = editor.state.doc.child(0);
    const secondFrom = firstNode.nodeSize;
    const secondNode = editor.state.doc.child(1);
    controller.register();
    controller.setItems([
      { id: 'F1', kind: 'node', from: 0, to: firstNode.nodeSize },
      {
        id: 'F1',
        kind: 'node',
        from: secondFrom,
        to: secondFrom + secondNode.nodeSize,
      },
    ]);

    expect(editor.view.dom.querySelectorAll('.md4h-feedback-annotation-node')).toHaveLength(2);
    editor.destroy();
  });

  it('rejects nested node boundaries while accepting the containing top-level block', () => {
    const editor = createEditor({
      type: 'doc',
      content: [
        {
          type: 'bulletList',
          content: [
            {
              type: 'listItem',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'nested' }] }],
            },
          ],
        },
        { type: 'paragraph', content: [{ type: 'text', text: 'after' }] },
      ],
    });
    const topLevelBlock = editor.state.doc.child(0);
    let paragraphFrom = -1;
    let paragraphSize = 0;
    editor.state.doc.descendants((node, position) => {
      if (node.type.name === 'paragraph' && paragraphFrom < 0) {
        paragraphFrom = position;
        paragraphSize = node.nodeSize;
        return false;
      }
      return true;
    });
    const controller = createFeedbackAnnotationController(editor);
    controller.register();
    controller.setItems([
      {
        id: 'F1',
        kind: 'node',
        from: paragraphFrom,
        to: paragraphFrom + paragraphSize,
      },
      { id: 'F2', kind: 'node', from: 0, to: topLevelBlock.nodeSize },
    ]);

    expect(getFeedbackAnnotationState(editor)?.items).toEqual([
      { id: 'F2', kind: 'node', from: 0, to: topLevelBlock.nodeSize },
    ]);
    expect(
      editor.view.dom.querySelector<HTMLElement>('[data-feedback-ids]')?.dataset.feedbackIds
    ).toBe('F2');
    editor.destroy();
  });

  it('updates only plugin metadata and preserves plugin state across selection transactions', () => {
    const editor = createEditor();
    const controller = createFeedbackAnnotationController(editor);
    controller.register();
    const beforeDoc = editor.state.doc;
    const dispatch = jest.spyOn(editor.view, 'dispatch');
    controller.setItems([{ id: 'F1', kind: 'inline', from: 1, to: 4 }]);
    const annotationState = getFeedbackAnnotationState(editor);

    const annotationTransaction = dispatch.mock.calls[0]?.[0];
    expect(annotationTransaction?.docChanged).toBe(false);
    expect(annotationTransaction?.steps).toHaveLength(0);

    editor.commands.setTextSelection(2);

    expect(editor.state.doc.eq(beforeDoc)).toBe(true);
    expect(getFeedbackAnnotationState(editor)).toBe(annotationState);
    expect(getFeedbackAnnotationState(editor)?.items).toEqual([
      { id: 'F1', kind: 'inline', from: 1, to: 4 },
    ]);
    editor.destroy();
  });

  it('clears exact annotations instead of mapping them through a document change', () => {
    const editor = createEditor();
    const controller = createFeedbackAnnotationController(editor);
    controller.register();
    controller.setItems([{ id: 'F1', kind: 'inline', from: 1, to: 4 }]);

    editor.commands.insertContentAt(1, 'X');

    expect(getFeedbackAnnotationState(editor)).toMatchObject({ items: [], activeIds: [] });
    expect(editor.view.dom.querySelector('[data-feedback-ids]')).toBeNull();
    editor.destroy();
  });

  it('suspends and restores decorations without losing items or active IDs', () => {
    const editor = createEditor();
    const controller = createFeedbackAnnotationController(editor);
    controller.register();
    controller.setItems([{ id: 'F1', kind: 'inline', from: 1, to: 4 }]);
    controller.setActiveIds(['F1']);

    controller.suspend();
    expect(editor.view.dom.querySelector('[data-feedback-ids]')).toBeNull();
    expect(getFeedbackAnnotationState(editor)).toMatchObject({
      suspended: true,
      activeIds: ['F1'],
      items: [{ id: 'F1', kind: 'inline', from: 1, to: 4 }],
    });

    controller.restore();
    expect(editor.view.dom.querySelector('[data-feedback-ids]')?.textContent).toBe('abc');
    expect(getFeedbackAnnotationState(editor)?.suspended).toBe(false);
    editor.destroy();
  });

  it('reuses validated targets and skips idempotent metadata dispatches', () => {
    const editor = createEditor(
      Array.from({ length: 100 }, (_, index) => `<p>block ${index}</p>`).join('')
    );
    const items: Array<{ id: string; kind: 'inline'; from: number; to: number }> = [];
    editor.state.doc.forEach((_node, offset, ordinal) => {
      items.push({ id: `F${ordinal + 1}`, kind: 'inline', from: offset + 1, to: offset + 2 });
    });
    const controller = createFeedbackAnnotationController(editor);
    controller.register();
    controller.setItems(items);
    const fullTraversal = jest.spyOn(editor.state.doc, 'forEach');
    const dispatch = jest.spyOn(editor.view, 'dispatch');

    controller.setActiveIds(['F100']);
    expect(fullTraversal.mock.calls.length).toBeLessThanOrEqual(1);
    controller.setActiveIds(['F100']);
    controller.restore();

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(getFeedbackAnnotationState(editor)?.activeIds).toEqual(['F100']);
    editor.destroy();
  });

  it('clears state, then unregisters the plugin and all decoration DOM', () => {
    const editor = createEditor();
    const controller = createFeedbackAnnotationController(editor);
    controller.register();
    controller.setItems([{ id: 'F1', kind: 'inline', from: 1, to: 4 }]);

    controller.clear();
    expect(getFeedbackAnnotationState(editor)).toMatchObject({
      items: [],
      activeIds: [],
      suspended: false,
    });
    expect(editor.view.dom.querySelector('[data-feedback-ids]')).toBeNull();

    controller.unregister();
    expect(feedbackAnnotationsPluginKey.get(editor.state)).toBeUndefined();
    expect(editor.view.dom.querySelector('[data-feedback-ids]')).toBeNull();
    editor.destroy();
  });

  it('ignores malformed ranges and duplicate IDs rather than throwing', () => {
    const editor = createEditor();
    const controller = createFeedbackAnnotationController(editor);
    controller.register();

    expect(() =>
      controller.setItems([
        { id: 'F0', kind: 'inline', from: 1, to: 2 },
        { id: 'F5', kind: 'inline', from: 0, to: 3 },
        { id: 'F1', kind: 'inline', from: 4, to: 4 },
        { id: 'F2', kind: 'inline', from: -1, to: 2 },
        { id: 'F3', kind: 'node', from: 1, to: 3 },
        { id: 'F4', kind: 'inline', from: 1, to: 4 },
        { id: 'F4', kind: 'inline', from: 1, to: 4 },
      ])
    ).not.toThrow();

    expect(editor.view.dom.querySelectorAll('[data-feedback-ids]')).toHaveLength(1);
    expect(
      editor.view.dom.querySelector<HTMLElement>('[data-feedback-ids]')?.dataset.feedbackIds
    ).toBe('F4');
    editor.destroy();
  });
});
