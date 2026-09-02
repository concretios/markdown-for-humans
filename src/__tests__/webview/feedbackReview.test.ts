/**
 * @jest-environment jsdom
 */

import type { Editor } from '@tiptap/core';
import { Schema, type Node as ProseMirrorNode } from '@tiptap/pm/model';
import { CellSelection } from '@tiptap/pm/tables';
import {
  createFeedbackDraftSurfaceGate,
  createFeedbackReviewController,
  enumerateCanonicalFeedbackBlocks,
  feedbackReadOnlyPluginKey,
  getFeedbackSelectionTarget,
  type FeedbackReviewHost,
} from '../../webview/features/feedbackReview';
import {
  captureSelectedFeedbackBlocks,
  startFeedbackAreaCapture,
} from '../../webview/features/feedbackCaptureWorkflow';
import {
  FEEDBACK_MAX_EXACT_CELL_COUNT,
  fingerprintFeedbackTable,
} from '../../webview/features/feedbackSelectionMapping';
import type {
  FeedbackHostMessage,
  FeedbackItemSummary,
  FeedbackWebviewMessage,
} from '../../shared/feedbackProtocol';
import {
  FEEDBACK_ERROR_CODES,
  FEEDBACK_MAX_EXACT_CELL_COUNT_PER_SESSION,
} from '../../shared/feedbackProtocol';

const feedbackTableSchema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    text: { group: 'inline' },
    paragraph: { content: 'inline*', group: 'block' },
    table: {
      content: 'tableRow+',
      group: 'block',
      tableRole: 'table',
      isolating: true,
    },
    tableRow: { content: '(tableHeader | tableCell)+', tableRole: 'row' },
    tableHeader: {
      content: 'paragraph+',
      tableRole: 'header_cell',
      isolating: true,
      attrs: {
        colspan: { default: 1 },
        rowspan: { default: 1 },
        colwidth: { default: null },
      },
    },
    tableCell: {
      content: 'paragraph+',
      tableRole: 'cell',
      isolating: true,
      attrs: {
        colspan: { default: 1 },
        rowspan: { default: 1 },
        colwidth: { default: null },
      },
    },
  },
});

function omitTransferSession<T extends { session: unknown }>(message: T): Omit<T, 'session'> {
  const { session, ...identity } = message;
  void session;
  return identity;
}

function createEditorFixture(): Editor {
  document.body.innerHTML = `
    <div class="formatting-toolbar"></div>
    <main id="editor-shell">
      <div id="editor"><div class="tiptap" contenteditable="true">
        <h1>Title</h1><p>Alpha beta</p><p><br></p><blockquote><p>Quote</p></blockquote>
      </div></div>
    </main>
  `;

  const children = [
    {
      type: { name: 'heading' },
      nodeSize: 7,
      isAtom: false,
      attrs: {},
      content: { size: 5 },
      textBetween: () => 'Title',
    },
    {
      type: { name: 'paragraph' },
      nodeSize: 12,
      isAtom: false,
      attrs: {},
      content: { size: 10 },
      textBetween: () => 'Alpha beta',
    },
    {
      type: { name: 'paragraph' },
      nodeSize: 2,
      isAtom: false,
      attrs: {},
      content: { size: 0 },
      textBetween: () => '',
    },
    {
      type: { name: 'blockquote' },
      nodeSize: 9,
      isAtom: false,
      attrs: {},
      content: { size: 7 },
      textBetween: () => 'Quote',
    },
  ];
  const doc = {
    childCount: children.length,
    child: (index: number) => children[index],
    forEach: (
      callback: (node: (typeof children)[number], offset: number, ordinal: number) => void
    ) => {
      let offset = 0;
      children.forEach((node, ordinal) => {
        callback(node, offset, ordinal);
        offset += node.nodeSize;
      });
    },
    maybeChild: (index: number) => children[index] ?? null,
    textBetween: () => '',
  };

  const fixture = {
    state: { doc, selection: { from: 1, to: 1, empty: true } },
    view: { dom: document.querySelector('.tiptap') as HTMLElement },
    storage: {
      markdown: {
        serializer: {
          serialize: jest
            .fn()
            .mockReturnValueOnce('# Title')
            .mockReturnValueOnce('Alpha beta')
            .mockReturnValueOnce('')
            .mockReturnValueOnce('> Quote'),
        },
      },
    },
    isEditable: true,
    setEditable: jest.fn(),
    on: jest.fn(),
    off: jest.fn(),
  };
  fixture.setEditable.mockImplementation((editable: boolean) => {
    fixture.isEditable = editable;
  });

  const editorContainer = document.querySelector('#editor') as HTMLElement;
  editorContainer.getBoundingClientRect = () =>
    ({
      top: 0,
      bottom: 480,
      left: 0,
      right: 800,
      width: 800,
      height: 480,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }) as DOMRect;
  Array.from(fixture.view.dom.children).forEach((element, ordinal) => {
    (element as HTMLElement).getBoundingClientRect = () => {
      const top = 24 + ordinal * 64;
      return {
        top,
        bottom: top + 40,
        left: 32,
        right: 720,
        width: 688,
        height: 40,
        x: 32,
        y: top,
        toJSON: () => ({}),
      } as DOMRect;
    };
  });
  return fixture as unknown as Editor;
}

function tableFixtureCellText(rows: number, columns: number, row: number, column: number): string {
  const defaultValues = [
    ['Role', 'Primary concern'],
    ['Product lead', 'Response quality'],
  ];
  return rows === 2 && columns === 2 ? defaultValues[row][column] : `R${row + 1}C${column + 1}`;
}

function createRectangularTableEditorFixture(rows: number, columns: number): Editor {
  const editor = createEditorFixture();
  const cell = (type: 'tableHeader' | 'tableCell', text: string): ProseMirrorNode =>
    feedbackTableSchema.nodes[type].create(
      { colspan: 1, rowspan: 1, colwidth: null },
      feedbackTableSchema.nodes.paragraph.create(null, feedbackTableSchema.text(text))
    );
  const table = feedbackTableSchema.nodes.table.create(
    null,
    Array.from({ length: rows }, (_, row) =>
      feedbackTableSchema.nodes.tableRow.create(
        null,
        Array.from({ length: columns }, (_, column) =>
          cell(
            row === 0 ? 'tableHeader' : 'tableCell',
            tableFixtureCellText(rows, columns, row, column)
          )
        )
      )
    )
  );
  const doc = feedbackTableSchema.nodes.doc.create(null, table);
  (editor.state as unknown as { doc: ProseMirrorNode }).doc = doc;
  editor.view.dom.innerHTML = `<table><tbody>${Array.from({ length: rows }, (_, row) => {
    return `<tr>${Array.from({ length: columns }, (_, column) => {
      const value = tableFixtureCellText(rows, columns, row, column);
      return `<${row === 0 ? 'th' : 'td'}>${value}</${row === 0 ? 'th' : 'td'}>`;
    }).join('')}</tr>`;
  }).join('')}</tbody></table>`;
  const tableElement = editor.view.dom.firstElementChild as HTMLElement;
  tableElement.getBoundingClientRect = () =>
    ({
      top: 24,
      bottom: 184,
      left: 32,
      right: 720,
      width: 688,
      height: 160,
      x: 32,
      y: 24,
      toJSON: () => ({}),
    }) as DOMRect;
  return editor;
}

function createTableEditorFixture(): Editor {
  return createRectangularTableEditorFixture(2, 2);
}

function dispatchFeedbackBlockHover(target: Element): void {
  target.dispatchEvent(
    new MouseEvent('pointerover', {
      bubbles: true,
      clientX: 96,
      clientY: 96,
    })
  );
}

async function waitForFeedbackFrame(): Promise<void> {
  await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
}

function createSavedFeedbackItems(count: number): FeedbackItemSummary[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `F${index + 1}`,
    kind: 'text' as const,
    startOrdinal: Math.min(index, 1),
    endOrdinal: Math.min(index, 1),
    startLine: index + 1,
    endLine: index + 1,
    focus: index === 0 ? 'Title' : 'Alpha beta',
    feedback: `Feedback ${index + 1}`,
  }));
}

describe('Feedback review controller', () => {
  let host: FeedbackReviewHost;

  beforeEach(() => {
    host = { postMessage: jest.fn() };
  });

  afterEach(() => {
    window.dispatchEvent(new CustomEvent('feedbackSessionEnded'));
    document.body.classList.remove('feedback-capture-active');
    document.body.innerHTML = '';
  });

  it('uses one exclusive draft-surface gate for every text and capture phase', () => {
    const kinds = [
      'text-composer',
      'feedback-edit',
      'text-block-selector',
      'finish-checkpoint',
      'area-capture',
      'capture-block-selector',
      'capture-rasterizing',
      'capture-annotation',
    ] as const;

    for (const kind of kinds) {
      const gate = createFeedbackDraftSurfaceGate();
      const activeElement = document.createElement('button');
      document.body.append(activeElement);
      const focusActive = jest.fn(() => activeElement.focus());
      const active = gate.claim({ kind, element: activeElement, focus: focusActive });
      expect(active).not.toBeNull();

      const contender = gate.claim({
        kind: kind === 'text-composer' ? 'area-capture' : 'text-composer',
        focus: jest.fn(),
      });

      expect(contender).toBeNull();
      expect(focusActive).toHaveBeenCalledTimes(1);
      expect(document.activeElement).toBe(activeElement);
      active?.release();
      expect(gate.hasActive()).toBe(false);
      activeElement.remove();
    }
  });

  it('enumerates canonical top-level blocks in document order', () => {
    const editor = createEditorFixture();

    expect(enumerateCanonicalFeedbackBlocks(editor)).toEqual([
      { ordinal: 0, kind: 'heading', markdown: '# Title', contentSize: 5 },
      { ordinal: 1, kind: 'paragraph', markdown: 'Alpha beta', contentSize: 10 },
      { ordinal: 3, kind: 'blockquote', markdown: '> Quote', contentSize: 7 },
    ]);
  });

  it('uses the TipTap v3 Markdown manager exposed by the live editor', () => {
    const editor = createEditorFixture() as unknown as {
      markdown?: { serialize: jest.Mock<string, [unknown]> };
      storage: { markdown: { manager?: { serialize: jest.Mock<string, [unknown]> } } };
    };
    const manager = {
      serialize: jest
        .fn<string, [unknown]>()
        .mockReturnValueOnce('# Title')
        .mockReturnValueOnce('Alpha beta')
        .mockReturnValueOnce('')
        .mockReturnValueOnce('> Quote'),
    };
    editor.markdown = manager;
    editor.storage.markdown = { manager };

    expect(enumerateCanonicalFeedbackBlocks(editor as unknown as Editor)).toEqual([
      { ordinal: 0, kind: 'heading', markdown: '# Title', contentSize: 5 },
      { ordinal: 1, kind: 'paragraph', markdown: 'Alpha beta', contentSize: 10 },
      { ordinal: 3, kind: 'blockquote', markdown: '> Quote', contentSize: 7 },
    ]);
    expect(manager.serialize).toHaveBeenCalledTimes(4);
  });

  it('rejects a browser selection that crosses from the document into review chrome', () => {
    const editorDom = document.createElement('div');
    const inside = document.createTextNode('Alpha beta');
    const feedbackCard = document.createElement('aside');
    const outside = document.createTextNode('Existing feedback');
    editorDom.append(inside);
    feedbackCard.append(outside);
    document.body.append(editorDom, feedbackCard);
    const selectionSpy = jest.spyOn(window, 'getSelection').mockReturnValue({
      anchorNode: inside,
      focusNode: outside,
      isCollapsed: false,
      rangeCount: 1,
      toString: () => 'Alpha beta Existing feedback',
    } as unknown as Selection);
    const editor = {
      state: {
        selection: { from: 1, to: 10, empty: false },
        doc: {
          forEach: (
            callback: (node: { nodeSize: number }, offset: number, ordinal: number) => void
          ) => callback({ nodeSize: 12 }, 0, 0),
          textBetween: () => 'Alpha beta',
        },
      },
      view: { dom: editorDom },
    } as unknown as Editor;

    expect(
      getFeedbackSelectionTarget(editor, [{ ordinal: 0, startLine: 1, endLine: 1 }])
    ).toBeNull();
    selectionSpy.mockRestore();
  });

  it('maps an incomplete native read-only selection to its semantic blocks', () => {
    const editor = createEditorFixture();
    const firstText = editor.view.dom.children[0].firstChild!;
    const secondText = editor.view.dom.children[1].firstChild!;
    const selectionSpy = jest.spyOn(window, 'getSelection').mockReturnValue({
      anchorNode: firstText,
      focusNode: secondText,
      toString: () => 'Title\nAlpha',
    } as unknown as Selection);

    expect(
      getFeedbackSelectionTarget(editor, [
        { ordinal: 0, startLine: 1, endLine: 1 },
        { ordinal: 1, startLine: 3, endLine: 3 },
      ])
    ).toEqual({
      startOrdinal: 0,
      endOrdinal: 1,
      focus: 'Title\nAlpha beta',
      startLine: 1,
      endLine: 3,
      presentationReason: 'unmappable-dom',
    });
    selectionSpy.mockRestore();
  });

  it('does not turn a collapsed native caret into whole-block feedback', () => {
    const editor = createEditorFixture();
    const text = editor.view.dom.children[1].firstChild!;
    const selectionSpy = jest.spyOn(window, 'getSelection').mockReturnValue({
      anchorNode: text,
      focusNode: text,
      anchorOffset: 2,
      focusOffset: 2,
      isCollapsed: true,
      toString: () => '',
    } as unknown as Selection);

    expect(
      getFeedbackSelectionTarget(editor, [{ ordinal: 1, startLine: 3, endLine: 3 }])
    ).toBeNull();
    selectionSpy.mockRestore();
  });

  it('does not reuse stale ProseMirror state when native code endpoints lack a DOM Range', () => {
    document.body.innerHTML = `
      <div class="tiptap">
        <p>Alpha beta</p>
        <div class="code-block-wrapper"><pre><code><span>const answer = 42;</span></code></pre></div>
      </div>
    `;
    const editorDom = document.querySelector('.tiptap') as HTMLElement;
    const codeText = editorDom.querySelector('code span')!.firstChild!;
    const nodes = [{ nodeSize: 12 }, { nodeSize: 21 }];
    const editor = {
      state: {
        selection: { from: 1, to: 6, empty: false },
        doc: {
          forEach: (
            callback: (node: (typeof nodes)[number], offset: number, ordinal: number) => void
          ) => {
            callback(nodes[0], 0, 0);
            callback(nodes[1], nodes[0].nodeSize, 1);
          },
          textBetween: () => 'Alpha',
        },
      },
      view: { dom: editorDom },
    } as unknown as Editor;
    const selectionSpy = jest.spyOn(window, 'getSelection').mockReturnValue({
      anchorNode: codeText,
      focusNode: codeText,
      anchorOffset: 6,
      focusOffset: 17,
      isCollapsed: false,
      toString: () => 'answer = 42',
    } as unknown as Selection);

    expect(
      getFeedbackSelectionTarget(editor, [
        { ordinal: 0, startLine: 1, endLine: 1 },
        { ordinal: 1, startLine: 3, endLine: 5 },
      ])
    ).toEqual({
      startOrdinal: 1,
      endOrdinal: 1,
      focus: 'answer = 42',
      startLine: 3,
      endLine: 5,
      presentationReason: 'unmappable-dom',
    });
    selectionSpy.mockRestore();
  });

  it('freezes the editor and creates a labelled review rail after start succeeds', () => {
    const editor = createEditorFixture();
    const controller = createFeedbackReviewController({ editor, host });

    controller.activate({
      sessionId: 'session-1',
      source: 'docs/guide.md',
      sourceSha256: 'a'.repeat(64),
      round: '20260821T093000Z-k4p9',
      items: [],
    });

    expect(editor.view.dom.getAttribute('aria-readonly')).toBe('true');
    expect(editor.view.dom.getAttribute('contenteditable')).toBe('true');
    expect(editor.view.dom.getAttribute('tabindex')).toBe('0');
    expect(editor.setEditable).not.toHaveBeenCalled();
    expect(document.body.classList.contains('feedback-review-active')).toBe(true);
    expect(document.querySelector('[data-feedback-frame-label]')?.textContent).toContain(
      'Feedback review · snapshot saved'
    );
    expect(document.querySelector('[aria-label="Feedback comments"]')).toBeTruthy();

    controller.deactivate();
    expect(editor.setEditable).not.toHaveBeenCalled();
    expect(editor.view.dom.getAttribute('tabindex')).toBeNull();
  });

  it('acknowledges transition recovery while keeping the owner locked until peer unlock', () => {
    const editor = createEditorFixture();
    const dynamicEditor = editor as unknown as {
      registerPlugin: jest.Mock;
      unregisterPlugin: jest.Mock;
    };
    const pluginsByKey: Record<string, unknown> = {};
    const readOnlyPluginKey = (feedbackReadOnlyPluginKey as unknown as { key: string }).key;
    (editor.state as unknown as { config: { pluginsByKey: Record<string, unknown> } }).config = {
      pluginsByKey,
    };
    dynamicEditor.registerPlugin = jest.fn((plugin: unknown) => {
      pluginsByKey[readOnlyPluginKey] = plugin;
      return editor.state;
    });
    dynamicEditor.unregisterPlugin = jest.fn((key: { key: string }) => {
      delete pluginsByKey[key.key];
      return editor.state;
    });
    const onReadOnlyChange = jest.fn();
    const controller = createFeedbackReviewController({ editor, host, onReadOnlyChange });
    controller.start();
    const request = (host.postMessage as jest.Mock).mock.calls
      .map(call => call[0])
      .find(message => message.type === 'feedback.start');
    const transitionController = controller as typeof controller & {
      applyTransitionSync(
        message: {
          type: 'feedback.transition.sync';
          requestId: string;
          lockId: string;
          revision: number;
          content: string;
        },
        apply: (content: string) => boolean
      ): boolean;
      completeTransition(lockId: string): boolean;
      hasPeerReleaseLock(lockId: string): boolean;
      applyPeerRelease(lockId: string, apply: (content: string) => boolean): boolean;
    };
    const applyContent = jest.fn((content: string) => {
      expect(content).toBe('# Changed during start\n');
      expect(feedbackReadOnlyPluginKey.get(editor.state)).toBeUndefined();
      expect(editor.view.dom.getAttribute('aria-readonly')).toBe('true');
      const attemptedInput = new Event('beforeinput', { bubbles: true, cancelable: true });
      editor.view.dom.dispatchEvent(attemptedInput);
      expect(attemptedInput.defaultPrevented).toBe(true);
      return true;
    });
    const sync = {
      type: 'feedback.transition.sync' as const,
      requestId: request.requestId,
      lockId: 'transition-lock-1',
      revision: 1,
      content: '# Changed during start\n',
    };

    expect(transitionController.applyTransitionSync(sync, () => false)).toBe(false);
    expect(host.postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'feedback.transition.applied' })
    );
    const retryAfterFalse = document.querySelector<HTMLButtonElement>(
      '[data-feedback-transition-retry]'
    );
    expect(retryAfterFalse).not.toBeNull();
    retryAfterFalse?.click();
    expect(host.postMessage).toHaveBeenCalledWith({
      type: 'feedback.transition.retry',
      requestId: request.requestId,
      lockId: 'transition-lock-1',
      revision: 1,
    });
    expect(editor.view.dom.getAttribute('aria-readonly')).toBe('true');

    const uncorrelatedApply = jest.fn(() => true);
    expect(
      transitionController.applyTransitionSync(
        { ...sync, requestId: 'stale-start-request' },
        uncorrelatedApply
      )
    ).toBe(false);
    expect(
      transitionController.applyTransitionSync({ ...sync, lockId: 'stale-lock' }, uncorrelatedApply)
    ).toBe(false);
    expect(
      transitionController.applyTransitionSync({ ...sync, revision: 3 }, uncorrelatedApply)
    ).toBe(false);
    expect(uncorrelatedApply).not.toHaveBeenCalled();
    expect(editor.view.dom.getAttribute('aria-readonly')).toBe('true');

    expect(
      transitionController.applyTransitionSync(sync, () => {
        throw new Error('setContent failed');
      })
    ).toBe(false);
    expect(host.postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'feedback.transition.applied' })
    );
    const retryAfterThrow = document.querySelector<HTMLButtonElement>(
      '[data-feedback-transition-retry]'
    );
    expect(retryAfterThrow).not.toBeNull();
    retryAfterThrow?.click();
    expect(
      (host.postMessage as jest.Mock).mock.calls.filter(
        call => call[0].type === 'feedback.transition.retry'
      )
    ).toHaveLength(2);
    expect(feedbackReadOnlyPluginKey.get(editor.state)).toBeDefined();
    expect(editor.view.dom.getAttribute('aria-readonly')).toBe('true');

    expect(transitionController.applyTransitionSync(sync, applyContent)).toBe(true);

    expect(applyContent).toHaveBeenCalledTimes(1);
    expect(dynamicEditor.unregisterPlugin).toHaveBeenCalledWith(feedbackReadOnlyPluginKey);
    expect(feedbackReadOnlyPluginKey.get(editor.state)).toBeDefined();
    expect(editor.view.dom.getAttribute('aria-readonly')).toBe('true');
    expect(document.body.classList).toContain('feedback-review-starting');
    expect(controller.getSession()).toBeNull();
    expect(onReadOnlyChange).toHaveBeenLastCalledWith(true);
    expect(host.postMessage).toHaveBeenCalledWith({
      type: 'feedback.transition.applied',
      requestId: request.requestId,
      lockId: 'transition-lock-1',
      revision: 1,
    });

    expect(transitionController.applyTransitionSync(sync, applyContent)).toBe(true);
    expect(applyContent).toHaveBeenCalledTimes(1);
    expect(
      (host.postMessage as jest.Mock).mock.calls.filter(
        call => call[0].type === 'feedback.transition.applied' && call[0].revision === 1
      )
    ).toHaveLength(2);

    controller.handleHostMessage({
      type: 'feedback.error',
      requestId: request.requestId,
      code: 'MD4H-FB-SNAPSHOT-001',
      message: 'The source changed while Feedback was starting.',
      recoverable: true,
    });
    expect(editor.view.dom.getAttribute('aria-readonly')).toBe('true');
    expect(transitionController.completeTransition('stale-lock')).toBe(false);
    expect(editor.view.dom.getAttribute('aria-readonly')).toBe('true');

    expect(transitionController.hasPeerReleaseLock('stale-lock')).toBe(false);
    expect(transitionController.hasPeerReleaseLock('transition-lock-1')).toBe(true);
    const releaseApply = jest.fn(() => true);
    expect(transitionController.applyPeerRelease('stale-lock', releaseApply)).toBe(false);
    expect(releaseApply).not.toHaveBeenCalled();
    expect(transitionController.applyPeerRelease('transition-lock-1', () => false)).toBe(false);
    expect(editor.view.dom.getAttribute('aria-readonly')).toBe('true');
    expect(transitionController.applyPeerRelease('transition-lock-1', releaseApply)).toBe(true);
    expect(releaseApply).toHaveBeenCalledTimes(1);
    expect(editor.view.dom.getAttribute('aria-readonly')).toBe('true');
    expect(document.body.classList).toContain('feedback-review-starting');
    expect(onReadOnlyChange).toHaveBeenLastCalledWith(true);
    expect(transitionController.completeTransition('transition-lock-1')).toBe(true);
    expect(editor.view.dom.getAttribute('aria-readonly')).toBeNull();
    expect(document.body.classList).not.toContain('feedback-review-starting');
    expect(onReadOnlyChange).toHaveBeenLastCalledWith(false);
  });

  it('accepts an authoritative peer release for a transition that needed no recovery sync', () => {
    const editor = createEditorFixture();
    const controller = createFeedbackReviewController({ editor, host });
    const transitionController = controller as typeof controller & {
      hasPeerReleaseLock(lockId: string): boolean;
      applyPeerRelease(lockId: string, apply: () => boolean): boolean;
      completeTransition(lockId: string): boolean;
    };

    controller.start();
    const request = (host.postMessage as jest.Mock).mock.calls
      .map(call => call[0])
      .find(message => message.type === 'feedback.start');
    controller.handleHostMessage({
      type: 'feedback.transition.locked',
      requestId: request.requestId,
      lockId: 'transition-without-recovery',
    });

    expect(transitionController.hasPeerReleaseLock('transition-without-recovery')).toBe(true);
    expect(transitionController.applyPeerRelease('stale-lock', () => true)).toBe(false);
    expect(transitionController.applyPeerRelease('transition-without-recovery', () => false)).toBe(
      false
    );
    expect(editor.view.dom.getAttribute('aria-readonly')).toBe('true');

    const apply = jest.fn(() => true);
    expect(transitionController.applyPeerRelease('transition-without-recovery', apply)).toBe(true);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(editor.view.dom.getAttribute('aria-readonly')).toBe('true');
    expect(transitionController.completeTransition('transition-without-recovery')).toBe(true);
    expect(editor.view.dom.getAttribute('aria-readonly')).toBeNull();
    expect(document.body.classList).not.toContain('feedback-review-starting');
  });

  it('applies and commits an authoritative retirement for an active review session', () => {
    const editor = createEditorFixture();
    const controller = createFeedbackReviewController({ editor, host });
    const releaseController = controller as typeof controller & {
      hasPeerReleaseLock(lockId: string): boolean;
      applyPeerRelease(lockId: string, apply: () => boolean): boolean;
      completeSessionRelease(lockId: string): boolean;
    };
    controller.activate({
      sessionId: 'active-retirement-session',
      source: 'docs/guide.md',
      sourceSha256: 'a'.repeat(64),
      round: '20260821T093000Z-ar01',
      items: [],
    });

    expect(releaseController.hasPeerReleaseLock('stale-session')).toBe(false);
    expect(releaseController.hasPeerReleaseLock('active-retirement-session')).toBe(true);
    expect(releaseController.applyPeerRelease('active-retirement-session', () => false)).toBe(
      false
    );
    expect(controller.getSession()?.sessionId).toBe('active-retirement-session');
    expect(editor.view.dom.getAttribute('aria-readonly')).toBe('true');

    const apply = jest.fn(() => true);
    expect(releaseController.applyPeerRelease('active-retirement-session', apply)).toBe(true);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(releaseController.completeSessionRelease('stale-session')).toBe(false);
    expect(controller.getSession()?.sessionId).toBe('active-retirement-session');
    expect(releaseController.completeSessionRelease('active-retirement-session')).toBe(true);
    expect(controller.getSession()).toBeNull();
    expect(editor.view.dom.getAttribute('aria-readonly')).toBeNull();
  });

  it('ignores an uncorrelated started response from a stale host transition', () => {
    const editor = createEditorFixture();
    const controller = createFeedbackReviewController({ editor, host });

    controller.handleHostMessage({
      type: 'feedback.started',
      requestId: 'stale-start',
      sessionId: 'stale-session',
      source: 'docs/guide.md',
      sourceSha256: 'a'.repeat(64),
      round: '20260821T093000Z-k4p9',
      feedbackFile: '.md4h/feedback/stale/feedback.md',
      anchors: [],
      items: [],
    });

    expect(controller.getSession()).toBeNull();
    expect(editor.view.dom.getAttribute('aria-readonly')).toBeNull();
  });

  it('ignores every active-session response from a stale runtime token', () => {
    const editor = createEditorFixture();
    const controller = createFeedbackReviewController({ editor, host });
    controller.activate({
      sessionId: 'current-session',
      source: 'docs/guide.md',
      sourceSha256: 'a'.repeat(64),
      round: '20260821T093000Z-k4p9',
      items: [
        {
          id: 'F1',
          kind: 'text',
          startOrdinal: 1,
          endOrdinal: 1,
          startLine: 3,
          endLine: 3,
          focus: 'Alpha beta',
          feedback: 'Keep this current item.',
        },
      ],
    });

    const staleMessages = [
      {
        type: 'feedback.updated',
        requestId: 'stale-update',
        sessionId: 'stale-session',
        items: [],
      },
      {
        type: 'feedback.invalidated',
        sessionId: 'stale-session',
        code: 'MD4H-FB-SNAPSHOT-001',
        message: 'Stale invalidation.',
      },
      {
        type: 'feedback.error',
        requestId: 'stale-error',
        sessionId: 'stale-session',
        message: 'Stale failure.',
        recoverable: true,
      },
      {
        type: 'feedback.diagnosticsCopied',
        requestId: 'stale-diagnostics',
        sessionId: 'stale-session',
      },
      {
        type: 'feedback.finished',
        requestId: 'stale-finish',
        sessionId: 'stale-session',
        feedbackFile: '.md4h/feedback/stale/feedback.md',
        itemCount: 1,
        prompt: 'Implement the sealed feedback bundle.',
        promptCopied: true,
      },
      {
        type: 'feedback.discarded',
        requestId: 'stale-discard',
        sessionId: 'stale-session',
      },
    ] as FeedbackHostMessage[];

    for (const message of staleMessages) controller.handleHostMessage(message);

    expect(controller.getSession()).toEqual(
      expect.objectContaining({
        sessionId: 'current-session',
        items: [expect.objectContaining({ id: 'F1' })],
      })
    );
    expect(controller.isInvalidated()).toBe(false);
  });

  it('applies a matching invalidation and never lets an inactive-draft response end it', () => {
    const editor = createEditorFixture();
    const controller = createFeedbackReviewController({ editor, host });
    controller.activate({
      sessionId: 'current-session',
      source: 'docs/guide.md',
      sourceSha256: 'a'.repeat(64),
      round: '20260821T093000Z-k4p9',
      items: [],
    });

    controller.handleHostMessage({
      type: 'feedback.draft.discarded',
      requestId: 'inactive-draft-discard',
      round: '20260820T093000Z-old1',
    });
    expect(controller.getSession()?.sessionId).toBe('current-session');

    controller.handleHostMessage({
      type: 'feedback.invalidated',
      sessionId: 'current-session',
      code: 'MD4H-FB-SNAPSHOT-001',
      message: 'The source changed.',
    });
    expect(controller.isInvalidated()).toBe(true);
    expect(controller.getSession()?.sessionId).toBe('current-session');

    controller.discard();
    expect(host.postMessage).toHaveBeenCalledWith({
      type: 'feedback.discard',
      requestId: expect.any(String),
      sessionId: 'current-session',
    });
  });

  it.each([
    {
      outcome: 'discard',
      message: {
        type: 'feedback.discarded' as const,
        requestId: 'close-current',
        sessionId: 'current-session',
      },
    },
  ])('keeps a $outcome read-only until its correlated session lock unlocks', ({ message }) => {
    const editor = createEditorFixture();
    const onReadOnlyChange = jest.fn();
    const controller = createFeedbackReviewController({ editor, host, onReadOnlyChange });
    controller.activate({
      sessionId: 'current-session',
      source: 'docs/guide.md',
      sourceSha256: 'a'.repeat(64),
      round: '20260821T093000Z-k4p9',
      items: [],
    });
    const closingControl = document.createElement('button');
    closingControl.setAttribute('data-feedback-action', '');
    document.body.append(closingControl);
    closingControl.focus();

    controller.handleHostMessage(message);
    // The real toolbar rerenders its actions as disabled while close sync is
    // pending, removing the originally focused control.
    closingControl.remove();

    expect(controller.getSession()?.sessionId).toBe('current-session');
    expect(editor.view.dom.getAttribute('aria-readonly')).toBe('true');
    expect(host.postMessage).toHaveBeenCalledWith({
      type: 'feedback.close.ready',
      requestId: 'close-current',
      sessionId: 'current-session',
    });

    const applyContent = jest.fn((_content: string) => {
      expect(editor.view.dom.getAttribute('aria-readonly')).toBe('true');
      expect(onReadOnlyChange).toHaveBeenLastCalledWith(true);
      const attemptedInput = new Event('beforeinput', { bubbles: true, cancelable: true });
      editor.view.dom.dispatchEvent(attemptedInput);
      expect(attemptedInput.defaultPrevented).toBe(true);
      return true;
    });
    const applied = (
      controller as typeof controller & {
        applyCloseSync(
          sync: {
            type: 'feedback.close.sync';
            requestId: string;
            sessionId: string;
            revision: number;
            content: string;
          },
          apply: (content: string) => boolean
        ): boolean;
      }
    ).applyCloseSync(
      {
        type: 'feedback.close.sync',
        requestId: 'close-current',
        sessionId: 'current-session',
        revision: 1,
        content: '# Authoritative source\n',
      },
      applyContent
    );

    expect(applied).toBe(true);
    expect(applyContent).toHaveBeenCalledWith('# Authoritative source\n');
    expect(controller.getSession()?.sessionId).toBe('current-session');
    expect(editor.view.dom.getAttribute('aria-readonly')).toBe('true');
    expect(onReadOnlyChange).toHaveBeenLastCalledWith(true);
    expect(host.postMessage).toHaveBeenCalledWith({
      type: 'feedback.close.applied',
      requestId: 'close-current',
      sessionId: 'current-session',
      revision: 1,
    });

    const closeController = controller as typeof controller & {
      completeClose(lockId: string): boolean;
      hasPeerReleaseLock(lockId: string): boolean;
      applyPeerRelease(lockId: string, apply: (content: string) => boolean): boolean;
    };
    expect(closeController.completeClose('current-session')).toBe(false);
    expect(controller.getSession()?.sessionId).toBe('current-session');

    controller.handleHostMessage({
      type: 'feedback.close.release',
      requestId: 'close-current',
      sessionId: 'current-session',
      revision: 1,
    });

    expect(host.postMessage).toHaveBeenCalledWith({
      type: 'feedback.close.released',
      requestId: 'close-current',
      sessionId: 'current-session',
      revision: 1,
    });
    expect(controller.getSession()?.sessionId).toBe('current-session');
    expect(editor.view.dom.getAttribute('aria-readonly')).toBe('true');
    expect(onReadOnlyChange).toHaveBeenLastCalledWith(true);
    expect(closeController.completeClose('stale-session')).toBe(false);
    expect(controller.getSession()?.sessionId).toBe('current-session');

    expect(closeController.hasPeerReleaseLock('stale-session')).toBe(false);
    expect(closeController.hasPeerReleaseLock('current-session')).toBe(true);
    const releaseApply = jest.fn(() => true);
    expect(closeController.applyPeerRelease('stale-session', releaseApply)).toBe(false);
    expect(releaseApply).not.toHaveBeenCalled();
    expect(closeController.applyPeerRelease('current-session', () => false)).toBe(false);
    expect(editor.view.dom.getAttribute('aria-readonly')).toBe('true');
    expect(closeController.applyPeerRelease('current-session', releaseApply)).toBe(true);
    expect(releaseApply).toHaveBeenCalledTimes(1);
    expect(controller.getSession()?.sessionId).toBe('current-session');
    expect(editor.view.dom.getAttribute('aria-readonly')).toBe('true');
    expect(onReadOnlyChange).toHaveBeenLastCalledWith(true);
    expect(closeController.completeClose('current-session')).toBe(true);
    expect(controller.getSession()).toBeNull();
    expect(editor.view.dom.getAttribute('aria-readonly')).toBeNull();
    expect(onReadOnlyChange).toHaveBeenLastCalledWith(false);
    expect(document.activeElement).toBe(editor.view.dom);
  });

  it('rejects an uncorrelated close sync without applying content or unlocking', () => {
    const editor = createEditorFixture();
    const controller = createFeedbackReviewController({ editor, host });
    controller.activate({
      sessionId: 'current-session',
      source: 'docs/guide.md',
      sourceSha256: 'a'.repeat(64),
      round: '20260821T093000Z-k4p9',
      items: [],
    });
    controller.handleHostMessage({
      type: 'feedback.discarded',
      requestId: 'finish-current',
      sessionId: 'current-session',
    });
    const applyContent = jest.fn(() => true);
    const closeController = controller as typeof controller & {
      applyCloseSync(
        sync: {
          type: 'feedback.close.sync';
          requestId: string;
          sessionId: string;
          revision: number;
          content: string;
        },
        apply: (content: string) => boolean
      ): boolean;
    };

    expect(
      closeController.applyCloseSync(
        {
          type: 'feedback.close.sync',
          requestId: 'stale-finish',
          sessionId: 'current-session',
          revision: 1,
          content: '# Must not apply\n',
        },
        applyContent
      )
    ).toBe(false);
    expect(
      closeController.applyCloseSync(
        {
          type: 'feedback.close.sync',
          requestId: 'finish-current',
          sessionId: 'stale-session',
          revision: 1,
          content: '# Must not apply\n',
        },
        applyContent
      )
    ).toBe(false);

    expect(applyContent).not.toHaveBeenCalled();
    expect(controller.getSession()?.sessionId).toBe('current-session');
    expect(editor.view.dom.getAttribute('aria-readonly')).toBe('true');
    expect(host.postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'feedback.close.applied' })
    );

    controller.handleHostMessage({
      type: 'feedback.close.release',
      requestId: 'finish-current',
      sessionId: 'current-session',
      revision: 1,
    });
    expect(controller.getSession()?.sessionId).toBe('current-session');
    expect(editor.view.dom.getAttribute('aria-readonly')).toBe('true');
    expect(host.postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'feedback.close.released' })
    );
  });

  it('fails closed when authoritative close sync returns false or throws', () => {
    const editor = createEditorFixture();
    const controller = createFeedbackReviewController({ editor, host });
    controller.activate({
      sessionId: 'current-session',
      source: 'docs/guide.md',
      sourceSha256: 'a'.repeat(64),
      round: '20260821T093000Z-k4p9',
      items: [],
    });
    controller.handleHostMessage({
      type: 'feedback.discarded',
      requestId: 'discard-current',
      sessionId: 'current-session',
    });
    const closeController = controller as typeof controller & {
      applyCloseSync(
        sync: {
          type: 'feedback.close.sync';
          requestId: string;
          sessionId: string;
          revision: number;
          content: string;
        },
        apply: (content: string) => boolean
      ): boolean;
    };
    const sync = {
      type: 'feedback.close.sync' as const,
      requestId: 'discard-current',
      sessionId: 'current-session',
      revision: 1,
      content: '# Authoritative source\n',
    };

    expect(closeController.applyCloseSync(sync, () => false)).toBe(false);
    expect(
      closeController.applyCloseSync(sync, () => {
        throw new Error('setContent failed');
      })
    ).toBe(false);

    expect(controller.getSession()?.sessionId).toBe('current-session');
    expect(editor.view.dom.getAttribute('aria-readonly')).toBe('true');
    expect(host.postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'feedback.close.applied' })
    );
  });

  it('surfaces a start failure visibly and restores the editable document', () => {
    const editor = createEditorFixture();
    const controller = createFeedbackReviewController({ editor, host });
    const onLocalError = jest.fn();
    window.addEventListener('feedbackLocalError', onLocalError);

    controller.start();
    const request = (host.postMessage as jest.Mock).mock.calls
      .map(call => call[0])
      .find(message => message.type === 'feedback.start');

    expect(document.body.classList).toContain('feedback-review-starting');
    controller.handleHostMessage({
      type: 'feedback.error',
      requestId: request.requestId,
      code: 'MD4H-FB-STORE-001',
      message: 'Open this saved Markdown file inside a workspace before starting feedback.',
      recoverable: true,
    });

    expect(onLocalError).toHaveBeenCalledTimes(1);
    expect((onLocalError.mock.calls[0][0] as CustomEvent).detail).toEqual({
      message: 'Open this saved Markdown file inside a workspace before starting feedback.',
    });
    expect(document.body.classList).not.toContain('feedback-review-starting');
    expect(editor.view.dom.getAttribute('contenteditable')).toBe('true');
    expect(editor.setEditable).not.toHaveBeenCalled();

    window.removeEventListener('feedbackLocalError', onLocalError);
  });

  it('posts only one start request while the first transition is pending', () => {
    const editor = createEditorFixture();
    const controller = createFeedbackReviewController({ editor, host });

    controller.start();
    controller.start();

    const starts = (host.postMessage as jest.Mock).mock.calls
      .map(call => call[0])
      .filter(message => message.type === 'feedback.start');
    expect(starts).toHaveLength(1);
  });

  it('opens an exact text composer and posts no feedback until submitted', () => {
    const editor = createEditorFixture();
    const controller = createFeedbackReviewController({ editor, host });
    controller.activate({
      sessionId: 'session-1',
      source: 'docs/guide.md',
      sourceSha256: 'b'.repeat(64),
      round: 'round-1',
      items: [],
    });

    controller.openTextComposer({
      startOrdinal: 1,
      endOrdinal: 1,
      focus: 'Alpha beta',
      startLine: 3,
      endLine: 3,
    });

    expect(host.postMessage).not.toHaveBeenCalled();
    expect(document.querySelector('[data-feedback-focus]')?.textContent).toBe('Alpha beta');
    expect(document.querySelector('[data-feedback-lines]')?.textContent).toContain('3');

    const field = document.querySelector('[data-feedback-input]') as HTMLTextAreaElement;
    field.value = 'Make this more specific.';
    field.dispatchEvent(new Event('input', { bubbles: true }));
    (document.querySelector('[data-feedback-submit]') as HTMLButtonElement).click();

    expect(host.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'feedback.text.add',
        sessionId: 'session-1',
        startOrdinal: 1,
        endOrdinal: 1,
        focus: 'Alpha beta',
        feedback: 'Make this more specific.',
      })
    );
  });

  it('renders exact text as literal target context and labels containing source lines', () => {
    const editor = createEditorFixture();
    const controller = createFeedbackReviewController({ editor, host });
    controller.activate({
      sessionId: 'session-1',
      source: 'docs/guide.md',
      sourceSha256: 'b'.repeat(64),
      round: 'round-1',
      items: [],
    });
    const focus = '<img src=x onerror=alert(1)> **literal Markdown**';

    controller.openTextComposer({
      startOrdinal: 1,
      endOrdinal: 1,
      focus,
      startLine: 3,
      endLine: 3,
      renderedRange: {
        version: 1,
        startOrdinal: 1,
        startOffset: 0,
        endOrdinal: 1,
        endOffset: 10,
      },
    });

    expect(document.querySelector('[data-feedback-target-label]')?.textContent).toBe(
      'Selected text'
    );
    expect(document.querySelector('[data-feedback-target-preview]')?.textContent).toContain(focus);
    expect(document.querySelector('[data-feedback-target-preview] img')).toBeNull();
    expect(document.querySelector('[data-feedback-lines]')?.textContent).toBe(
      'Containing source line 3'
    );
    expect(document.querySelector('.feedback-composer-focus')).toBeNull();
  });

  it('uses a stable compact or wide composer preset with an accessible user override', async () => {
    const editor = createEditorFixture();
    const editorContainer = document.querySelector<HTMLElement>('#editor')!;
    let containerWidth = 1_200;
    editorContainer.getBoundingClientRect = () =>
      ({
        top: 0,
        bottom: 720,
        left: 0,
        right: containerWidth,
        width: containerWidth,
        height: 720,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect;
    const controller = createFeedbackReviewController({ editor, host });
    controller.activate({
      sessionId: 'session-1',
      source: 'docs/guide.md',
      sourceSha256: 'b'.repeat(64),
      round: 'round-1',
      items: [],
    });

    controller.openTextComposer({
      startOrdinal: 1,
      endOrdinal: 1,
      focus: 'Alpha',
      startLine: 3,
      endLine: 3,
      renderedRange: {
        version: 1,
        startOrdinal: 1,
        startOffset: 0,
        endOrdinal: 1,
        endOffset: 5,
      },
    });

    const compactComposer = document.querySelector<HTMLElement>('.feedback-composer')!;
    compactComposer.getBoundingClientRect = () =>
      ({
        top: 24,
        bottom: 284,
        left: 0,
        right: 320,
        width: 320,
        height: 260,
        x: 0,
        y: 24,
        toJSON: () => ({}),
      }) as DOMRect;
    const sizeToggle = compactComposer.querySelector<HTMLButtonElement>(
      '[data-feedback-composer-size-toggle]'
    )!;
    Object.defineProperty(compactComposer.querySelector('[data-feedback-input]'), 'scrollHeight', {
      configurable: true,
      get: () => (compactComposer.dataset.feedbackComposerSize === 'wide' ? 140 : 220),
    });
    await waitForFeedbackFrame();
    expect(compactComposer.dataset.feedbackComposerSize).toBe('compact');
    expect(compactComposer.style.width).toBe('320px');
    expect(sizeToggle.textContent).toBe('Expand');
    expect(sizeToggle.getAttribute('aria-label')).toBe('Expand feedback composer');
    expect(sizeToggle.hasAttribute('aria-pressed')).toBe(false);

    sizeToggle.click();
    await waitForFeedbackFrame();
    expect(compactComposer.dataset.feedbackComposerSize).toBe('wide');
    expect(compactComposer.style.width).toBe('480px');
    expect(sizeToggle.textContent).toBe('Compact');
    expect(sizeToggle.getAttribute('aria-label')).toBe('Use compact feedback composer');
    expect(sizeToggle.hasAttribute('aria-pressed')).toBe(false);
    expect(
      compactComposer.querySelector<HTMLTextAreaElement>('[data-feedback-input]')?.style.height
    ).toBe('140px');

    sizeToggle.click();
    await waitForFeedbackFrame();
    expect(compactComposer.dataset.feedbackComposerSize).toBe('compact');
    expect(compactComposer.style.width).toBe('320px');
    expect(
      compactComposer.querySelector<HTMLTextAreaElement>('[data-feedback-input]')?.style.height
    ).toBe('220px');
    compactComposer
      .querySelector<HTMLButtonElement>('.feedback-composer-actions .feedback-secondary-button')
      ?.click();

    controller.openTextComposer({
      startOrdinal: 0,
      endOrdinal: 1,
      focus: 'Title\nAlpha beta',
      startLine: 1,
      endLine: 3,
      presentationReason: 'manual-block-range',
    });
    const complexComposer = document.querySelector<HTMLElement>('.feedback-composer')!;
    complexComposer.getBoundingClientRect = compactComposer.getBoundingClientRect;
    await waitForFeedbackFrame();
    expect(complexComposer.dataset.feedbackComposerSize).toBe('wide');
    expect(complexComposer.style.width).toBe('480px');
    expect(complexComposer.querySelector('[data-feedback-composer-size-toggle]')?.textContent).toBe(
      'Compact'
    );
    const targetBottom = Math.max(
      editor.view.dom.children[0].getBoundingClientRect().bottom,
      editor.view.dom.children[1].getBoundingClientRect().bottom
    );
    expect(Number.parseFloat(complexComposer.style.top)).toBeGreaterThanOrEqual(targetBottom + 12);

    containerWidth = 800;
    window.dispatchEvent(new Event('resize'));
    await waitForFeedbackFrame();
    expect(complexComposer.style.width).toBe('744px');
    complexComposer
      .querySelector<HTMLButtonElement>('[data-feedback-composer-size-toggle]')
      ?.click();
    await waitForFeedbackFrame();
    expect(complexComposer.style.width).toBe('320px');
  });

  it('keeps a wide composer in view when a tall target intersects the current viewport', async () => {
    const originalInnerHeight = window.innerHeight;
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 600 });
    const editor = createEditorFixture();
    const editorContainer = document.querySelector<HTMLElement>('#editor')!;
    document.querySelector<HTMLElement>('.formatting-toolbar')!.getBoundingClientRect = () =>
      ({
        top: 0,
        bottom: 64,
        left: 0,
        right: 1_200,
        width: 1_200,
        height: 64,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect;
    editorContainer.getBoundingClientRect = () =>
      ({
        top: -1_000,
        bottom: 2_000,
        left: 0,
        right: 1_200,
        width: 1_200,
        height: 3_000,
        x: 0,
        y: -1_000,
        toJSON: () => ({}),
      }) as DOMRect;
    (editor.view.dom.children[0] as HTMLElement).getBoundingClientRect = () =>
      ({
        top: -500,
        bottom: -460,
        left: 32,
        right: 1_120,
        width: 1_088,
        height: 40,
        x: 32,
        y: -500,
        toJSON: () => ({}),
      }) as DOMRect;
    (editor.view.dom.children[1] as HTMLElement).getBoundingClientRect = () =>
      ({
        top: 460,
        bottom: 500,
        left: 32,
        right: 1_120,
        width: 1_088,
        height: 40,
        x: 32,
        y: 460,
        toJSON: () => ({}),
      }) as DOMRect;
    const controller = createFeedbackReviewController({ editor, host });
    controller.activate({
      sessionId: 'session-1',
      source: 'docs/guide.md',
      sourceSha256: 'b'.repeat(64),
      round: 'round-1',
      items: [],
    });

    try {
      controller.openTextComposer({
        startOrdinal: 0,
        endOrdinal: 1,
        focus: 'Title\nAlpha beta',
        startLine: 1,
        endLine: 3,
        presentationReason: 'manual-block-range',
      });
      const composer = document.querySelector<HTMLElement>('.feedback-composer')!;
      composer.getBoundingClientRect = () =>
        ({
          top: 0,
          bottom: 260,
          left: 0,
          right: 480,
          width: 480,
          height: 260,
          x: 0,
          y: 0,
          toJSON: () => ({}),
        }) as DOMRect;
      await waitForFeedbackFrame();

      const viewportTop = 1_000;
      const viewportBottom = viewportTop + 600;
      const composerTop = Number.parseFloat(composer.style.top);
      expect(composer.dataset.feedbackComposerSize).toBe('wide');
      expect(composerTop).toBeGreaterThanOrEqual(viewportTop + 64 + 12);
      expect(composerTop + 260).toBeLessThanOrEqual(viewportBottom - 12);
    } finally {
      Object.defineProperty(window, 'innerHeight', {
        configurable: true,
        value: originalInnerHeight,
      });
    }
  });

  it('keeps a compact composer reachable near the bottom of the visible viewport', async () => {
    const originalInnerHeight = window.innerHeight;
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 600 });
    const editor = createEditorFixture();
    const editorContainer = document.querySelector<HTMLElement>('#editor')!;
    editorContainer.getBoundingClientRect = () =>
      ({
        top: 0,
        bottom: 1_200,
        left: 0,
        right: 1_200,
        width: 1_200,
        height: 1_200,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect;
    (editor.view.dom.children[1] as HTMLElement).getBoundingClientRect = () =>
      ({
        top: 520,
        bottom: 560,
        left: 32,
        right: 1_120,
        width: 1_088,
        height: 40,
        x: 32,
        y: 520,
        toJSON: () => ({}),
      }) as DOMRect;
    const controller = createFeedbackReviewController({ editor, host });
    controller.activate({
      sessionId: 'session-1',
      source: 'docs/guide.md',
      sourceSha256: 'b'.repeat(64),
      round: 'round-1',
      items: [],
    });

    try {
      controller.openTextComposer({
        startOrdinal: 1,
        endOrdinal: 1,
        focus: 'Alpha beta',
        startLine: 3,
        endLine: 3,
      });
      const composer = document.querySelector<HTMLElement>('.feedback-composer')!;
      composer.getBoundingClientRect = () =>
        ({
          top: 0,
          bottom: 260,
          left: 0,
          right: 320,
          width: 320,
          height: 260,
          x: 0,
          y: 0,
          toJSON: () => ({}),
        }) as DOMRect;
      await waitForFeedbackFrame();

      const composerTop = Number.parseFloat(composer.style.top);
      expect(composer.dataset.feedbackComposerSize).toBe('compact');
      expect(composerTop).toBeGreaterThanOrEqual(12);
      expect(composerTop + 260).toBeLessThanOrEqual(600 - 12);
    } finally {
      Object.defineProperty(window, 'innerHeight', {
        configurable: true,
        value: originalInnerHeight,
      });
    }
  });

  it('remeasures wrapped feedback after a responsive composer width change', async () => {
    const editor = createEditorFixture();
    const editorContainer = document.querySelector<HTMLElement>('#editor')!;
    let containerWidth = 800;
    editorContainer.getBoundingClientRect = () =>
      ({
        top: 0,
        bottom: 720,
        left: 0,
        right: containerWidth,
        width: containerWidth,
        height: 720,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect;
    const controller = createFeedbackReviewController({ editor, host });
    controller.activate({
      sessionId: 'session-1',
      source: 'docs/guide.md',
      sourceSha256: 'b'.repeat(64),
      round: 'round-1',
      items: [],
    });
    controller.openTextComposer({
      startOrdinal: 0,
      endOrdinal: 1,
      focus: 'Title\nAlpha beta',
      startLine: 1,
      endLine: 3,
      presentationReason: 'manual-block-range',
    });
    const composer = document.querySelector<HTMLElement>('.feedback-composer')!;
    const field = composer.querySelector<HTMLTextAreaElement>('[data-feedback-input]')!;
    composer.getBoundingClientRect = () =>
      ({
        top: 24,
        bottom: 284,
        left: 0,
        right: 480,
        width: 480,
        height: 260,
        x: 0,
        y: 24,
        toJSON: () => ({}),
      }) as DOMRect;
    Object.defineProperty(field, 'scrollHeight', {
      configurable: true,
      get: () => (composer.style.width === '480px' ? 260 : 140),
    });
    await waitForFeedbackFrame();
    field.value = 'Feedback that wraps more after the composer becomes narrower.';
    field.dispatchEvent(new Event('input', { bubbles: true }));
    expect(composer.style.width).toBe('744px');
    expect(field.style.height).toBe('140px');

    containerWidth = 1_200;
    window.dispatchEvent(new Event('resize'));
    await waitForFeedbackFrame();
    expect(composer.style.width).toBe('480px');
    expect(field.style.height).toBe('260px');
  });

  it('grows the feedback input to a viewport cap and then uses its own overflow', () => {
    const editor = createEditorFixture();
    const controller = createFeedbackReviewController({ editor, host });
    controller.activate({
      sessionId: 'session-1',
      source: 'docs/guide.md',
      sourceSha256: 'b'.repeat(64),
      round: 'round-1',
      items: [],
    });
    controller.openTextComposer({
      startOrdinal: 1,
      endOrdinal: 1,
      focus: 'Alpha beta',
      startLine: 3,
      endLine: 3,
    });
    const field = document.querySelector<HTMLTextAreaElement>('[data-feedback-input]')!;
    const originalInnerHeight = window.innerHeight;
    let contentHeight = 1_000;
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 600 });
    Object.defineProperty(field, 'scrollHeight', {
      configurable: true,
      get: () => contentHeight,
    });

    try {
      field.value = 'A long feedback draft';
      field.dispatchEvent(new Event('input', { bubbles: true }));
      expect(field.style.height).toBe('240px');
      expect(field.style.overflowY).toBe('auto');

      contentHeight = 140;
      field.dispatchEvent(new Event('input', { bubbles: true }));
      expect(field.style.height).toBe('140px');
      expect(field.style.overflowY).toBe('hidden');
    } finally {
      Object.defineProperty(window, 'innerHeight', {
        configurable: true,
        value: originalInnerHeight,
      });
    }
  });

  it('does not schedule annotation layout when textarea geometry is unchanged', () => {
    const queuedFrames: FrameRequestCallback[] = [];
    const requestFrame = jest
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation(callback => {
        queuedFrames.push(callback);
        return queuedFrames.length;
      });
    const flushFrames = (): void => {
      while (queuedFrames.length > 0) queuedFrames.shift()?.(0);
    };
    try {
      const editor = createEditorFixture();
      const controller = createFeedbackReviewController({ editor, host });
      controller.activate({
        sessionId: 'session-1',
        source: 'docs/guide.md',
        sourceSha256: 'b'.repeat(64),
        round: 'round-1',
        items: [],
      });
      controller.openTextComposer({
        startOrdinal: 1,
        endOrdinal: 1,
        focus: 'Alpha beta',
        startLine: 3,
        endLine: 3,
      });
      flushFrames();
      const field = document.querySelector<HTMLTextAreaElement>('[data-feedback-input]')!;
      Object.defineProperty(field, 'scrollHeight', { configurable: true, value: 140 });

      field.value = 'First draft';
      field.dispatchEvent(new Event('input', { bubbles: true }));
      expect(field.style.height).toBe('140px');
      flushFrames();
      const callsAfterGeometryChange = requestFrame.mock.calls.length;

      field.value = 'Different text with the same measured height';
      field.dispatchEvent(new Event('input', { bubbles: true }));

      expect(requestFrame).toHaveBeenCalledTimes(callsAfterGeometryChange);
      controller.deactivate();
    } finally {
      requestFrame.mockRestore();
    }
  });

  it('keeps presentation provenance renderer-local when feedback is submitted', () => {
    const editor = createEditorFixture();
    const controller = createFeedbackReviewController({ editor, host });
    controller.activate({
      sessionId: 'session-1',
      source: 'docs/guide.md',
      sourceSha256: 'b'.repeat(64),
      round: 'round-1',
      items: [],
    });
    controller.openTextComposer({
      startOrdinal: 3,
      endOrdinal: 3,
      focus: 'Quote',
      startLine: 7,
      endLine: 9,
      presentationReason: 'opaque-node',
    });
    const field = document.querySelector('[data-feedback-input]') as HTMLTextAreaElement;
    field.value = 'Change the complete rendered block.';
    field.dispatchEvent(new Event('input', { bubbles: true }));
    field.form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

    const message = (host.postMessage as jest.Mock).mock.calls.at(-1)?.[0] as Record<
      string,
      unknown
    >;
    expect(message).toMatchObject({
      type: 'feedback.text.add',
      focus: 'Quote',
      startOrdinal: 3,
      endOrdinal: 3,
    });
    expect(message).not.toHaveProperty('presentationReason');
  });

  it('preserves deep document scroll while focusing a composer opened from a code selection', () => {
    const editor = createEditorFixture();
    const codeBlock = document.createElement('div');
    codeBlock.className = 'code-block-wrapper';
    codeBlock.innerHTML = `<pre><code><span>"docs.reading-mode": {
  key: "docs.reading-mode",
  owner: "docs-core",
  enabled: false,
},</span></code></pre>`;
    editor.view.dom.replaceChild(codeBlock, editor.view.dom.children[3]);

    const controller = createFeedbackReviewController({ editor, host });
    controller.activate({
      sessionId: 'session-1',
      source: 'marketplace-assets/ref.md',
      sourceSha256: 'b'.repeat(64),
      round: 'round-1',
      anchors: [{ ordinal: 3, startLine: 242, endLine: 276 }],
      items: [],
    });

    const codeText = codeBlock.querySelector('code span')!.firstChild!;
    const selectionSpy = jest.spyOn(window, 'getSelection').mockReturnValue({
      anchorNode: codeText,
      focusNode: codeText,
      anchorOffset: 0,
      focusOffset: codeText.textContent?.length ?? 0,
      isCollapsed: false,
      rangeCount: 0,
      toString: () => codeText.textContent ?? '',
    } as unknown as Selection);
    const initialScrollTop = 4_800;
    document.documentElement.scrollTop = initialScrollTop;
    const nativeFocus = HTMLTextAreaElement.prototype.focus;
    const focusSpy = jest
      .spyOn(HTMLTextAreaElement.prototype, 'focus')
      .mockImplementation(function (this: HTMLTextAreaElement, options?: FocusOptions) {
        nativeFocus.call(this, options);
        // Model the browser's default focus scrolling. `preventScroll` is what
        // keeps a composer mounted near a deep target from jumping the page.
        if (!options?.preventScroll) document.documentElement.scrollTop = 0;
      });

    try {
      expect(controller.commentOnSelection()).toBe(true);

      const field = document.querySelector('[data-feedback-input]') as HTMLTextAreaElement;
      expect(document.activeElement).toBe(field);
      expect(document.documentElement.scrollTop).toBe(initialScrollTop);
      expect(focusSpy).toHaveBeenLastCalledWith({ preventScroll: true });
      expect(document.querySelector('[data-feedback-lines]')?.textContent).toContain('242-276');
    } finally {
      focusSpy.mockRestore();
      selectionSpy.mockRestore();
    }
  });

  it('preserves deep document scroll when cancelling a composer back to the editor', () => {
    const editor = createEditorFixture();
    const controller = createFeedbackReviewController({ editor, host });
    controller.activate({
      sessionId: 'session-1',
      source: 'marketplace-assets/ref.md',
      sourceSha256: 'b'.repeat(64),
      round: 'round-1',
      items: [],
    });

    const initialScrollTop = 4_800;
    document.documentElement.scrollTop = initialScrollTop;
    const nativeEditorFocus = editor.view.dom.focus.bind(editor.view.dom);
    const editorFocusSpy = jest
      .spyOn(editor.view.dom, 'focus')
      .mockImplementation((options?: FocusOptions) => {
        nativeEditorFocus(options);
        if (!options?.preventScroll) document.documentElement.scrollTop = 0;
      });

    try {
      editor.view.dom.focus({ preventScroll: true });
      controller.openTextComposer({
        startOrdinal: 3,
        endOrdinal: 3,
        focus: '"docs.reading-mode"',
        startLine: 242,
        endLine: 276,
      });

      document.querySelector<HTMLButtonElement>('.feedback-composer-actions button')?.click();

      expect(document.querySelector('.feedback-composer')).toBeNull();
      expect(document.activeElement).toBe(editor.view.dom);
      expect(document.documentElement.scrollTop).toBe(initialScrollTop);
      expect(editorFocusSpy).toHaveBeenLastCalledWith({ preventScroll: true });
    } finally {
      editorFocusSpy.mockRestore();
    }
  });

  it('sends the exact block-relative rendered range with text feedback', () => {
    const editor = createEditorFixture();
    const controller = createFeedbackReviewController({ editor, host });
    controller.activate({
      sessionId: 'session-1',
      source: 'docs/guide.md',
      sourceSha256: 'b'.repeat(64),
      round: 'round-1',
      items: [],
    });
    controller.openTextComposer({
      startOrdinal: 1,
      endOrdinal: 1,
      focus: 'Alpha',
      startLine: 3,
      endLine: 3,
      renderedRange: {
        version: 1,
        startOrdinal: 1,
        startOffset: 0,
        endOrdinal: 1,
        endOffset: 5,
      },
    });
    const field = document.querySelector('[data-feedback-input]') as HTMLTextAreaElement;
    field.value = 'Make this more specific.';
    field.dispatchEvent(new Event('input', { bubbles: true }));
    field.form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

    expect(host.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'feedback.text.add',
        renderedRange: {
          version: 1,
          startOrdinal: 1,
          startOffset: 0,
          endOrdinal: 1,
          endOffset: 5,
        },
      })
    );
  });

  it('keeps the existing typed composer focused when a second target asks to open', () => {
    const editor = createEditorFixture();
    const controller = createFeedbackReviewController({ editor, host });
    controller.activate({
      sessionId: 'session-1',
      source: 'docs/guide.md',
      sourceSha256: 'b'.repeat(64),
      round: 'round-1',
      items: [],
    });
    controller.openTextComposer({
      startOrdinal: 1,
      endOrdinal: 1,
      focus: 'Alpha beta',
      startLine: 3,
      endLine: 3,
    });
    const composer = document.querySelector('.feedback-composer') as HTMLFormElement;
    const field = composer.querySelector('[data-feedback-input]') as HTMLTextAreaElement;
    field.value = 'Keep this draft on the first target.';
    field.dispatchEvent(new Event('input', { bubbles: true }));
    field.focus();

    controller.openTextComposer({
      startOrdinal: 0,
      endOrdinal: 0,
      focus: 'Title',
      startLine: 1,
      endLine: 1,
    });

    expect(document.querySelector('.feedback-composer') === composer).toBe(true);
    expect(document.querySelector('[data-feedback-input]') === field).toBe(true);
    expect(field.value).toBe('Keep this draft on the first target.');
    expect(document.querySelector('[data-feedback-focus]')?.textContent).toBe('Alpha beta');
    expect(editor.view.dom.children[0].classList).not.toContain('feedback-pending-target');
    expect(editor.view.dom.children[1].classList).toContain('feedback-pending-target');
    expect(document.activeElement).toBe(field);
  });

  it('refuses to finish while a text composer is open and preserves its draft', () => {
    const confirmFinish = jest.spyOn(window, 'confirm').mockReturnValue(true);
    try {
      const editor = createEditorFixture();
      const controller = createFeedbackReviewController({ editor, host });
      controller.activate({
        sessionId: 'session-1',
        source: 'docs/guide.md',
        sourceSha256: 'b'.repeat(64),
        round: 'round-1',
        items: [],
      });
      controller.openTextComposer({
        startOrdinal: 1,
        endOrdinal: 1,
        focus: 'Alpha beta',
        startLine: 3,
        endLine: 3,
      });
      const composer = document.querySelector('.feedback-composer') as HTMLFormElement;
      const field = composer.querySelector('[data-feedback-input]') as HTMLTextAreaElement;
      field.value = 'Do not lose this unfinished feedback.';
      field.dispatchEvent(new Event('input', { bubbles: true }));
      field.focus();

      controller.finish();

      expect(confirmFinish).not.toHaveBeenCalled();
      expect(
        (host.postMessage as jest.Mock).mock.calls.some(call => call[0].type === 'feedback.finish')
      ).toBe(false);
      expect(document.querySelector('[data-feedback-completion-dialog]')).toBeNull();
      expect(document.querySelector('.feedback-composer') === composer).toBe(true);
      expect(field.value).toBe('Do not lose this unfinished feedback.');
      expect(document.activeElement).toBe(field);
    } finally {
      confirmFinish.mockRestore();
    }
  });

  it.each([
    { count: 1, expected: '1 feedback item ready to lock' },
    { count: 2, expected: '2 feedback items ready to lock' },
  ])('opens a safe finish checkpoint for $count saved item(s)', ({ count, expected }) => {
    const legacyConfirm = jest.spyOn(window, 'confirm').mockReturnValue(false);
    let controller: ReturnType<typeof createFeedbackReviewController> | undefined;
    try {
      const editor = createEditorFixture();
      const finishInvoker = document.createElement('button');
      finishInvoker.setAttribute('data-feedback-finish', '');
      document.body.append(finishInvoker);
      controller = createFeedbackReviewController({ editor, host });
      controller.activate({
        sessionId: 'session-1',
        source: 'docs/guide.md',
        sourceSha256: 'b'.repeat(64),
        round: 'round-1',
        feedbackFile: '.md4h/feedback/docs/guide.md--round-1/feedback.md',
        items: createSavedFeedbackItems(count),
      });
      finishInvoker.focus();

      controller.finish();

      const dialog = document.querySelector<HTMLElement>('[data-feedback-completion-dialog]');
      const resume = dialog?.querySelector<HTMLButtonElement>('[data-feedback-completion-resume]');
      expect(legacyConfirm).not.toHaveBeenCalled();
      expect(dialog?.getAttribute('role')).toBe('dialog');
      expect(dialog?.getAttribute('aria-modal')).toBe('true');
      expect(dialog?.hasAttribute('data-md4h-modal')).toBe(true);
      expect(dialog?.getAttribute('aria-describedby')).toBe(
        'feedback-completion-description feedback-completion-count feedback-completion-path feedback-completion-status'
      );
      const countElement = dialog?.querySelector<HTMLElement>('[data-feedback-completion-count]');
      const pathElement = dialog?.querySelector<HTMLElement>('[data-feedback-completion-path]');
      expect(countElement?.id).toBe('feedback-completion-count');
      expect(countElement?.textContent).toBe(expected);
      expect(pathElement?.id).toBe('feedback-completion-path');
      expect(pathElement?.tabIndex).toBe(0);
      expect(pathElement?.getAttribute('aria-labelledby')).toBe('feedback-completion-path-label');
      expect(pathElement?.textContent).toBe('.md4h/feedback/docs/guide.md--round-1/feedback.md');
      expect(document.activeElement).toBe(resume);
      expect(controller.isWritable()).toBe(true);
      expect(editor.view.dom.getAttribute('aria-readonly')).toBe('true');
      expect(
        (host.postMessage as jest.Mock).mock.calls.some(call => call[0].type === 'feedback.finish')
      ).toBe(false);
    } finally {
      controller?.deactivate();
      legacyConfirm.mockRestore();
    }
  });

  it('resumes safely by button or Escape and reveals without sealing', () => {
    const legacyConfirm = jest.spyOn(window, 'confirm').mockReturnValue(false);
    let controller: ReturnType<typeof createFeedbackReviewController> | undefined;
    try {
      const editor = createEditorFixture();
      const finishInvoker = document.createElement('button');
      finishInvoker.setAttribute('data-feedback-finish', '');
      document.body.append(finishInvoker);
      controller = createFeedbackReviewController({ editor, host });
      controller.activate({
        sessionId: 'session-1',
        source: 'docs/guide.md',
        sourceSha256: 'b'.repeat(64),
        round: 'round-1',
        feedbackFile: '.md4h/feedback/docs/guide.md--round-1/feedback.md',
        items: createSavedFeedbackItems(1),
      });
      finishInvoker.focus();
      controller.finish();

      let dialog = document.querySelector<HTMLElement>('[data-feedback-completion-dialog]');
      dialog?.querySelector<HTMLButtonElement>('[data-feedback-completion-reveal]')?.click();
      expect(host.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'feedback.reveal', sessionId: 'session-1' })
      );
      expect(document.querySelector('[data-feedback-completion-dialog]')).toBe(dialog);
      expect(
        (host.postMessage as jest.Mock).mock.calls.some(call => call[0].type === 'feedback.finish')
      ).toBe(false);

      dialog?.querySelector<HTMLButtonElement>('[data-feedback-completion-resume]')?.click();
      expect(document.querySelector('[data-feedback-completion-dialog]')).toBeNull();
      expect(controller.isWritable()).toBe(true);
      expect(document.activeElement).toBe(finishInvoker);

      controller.finish();
      dialog = document.querySelector<HTMLElement>('[data-feedback-completion-dialog]');
      const escape = new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true,
      });
      dialog?.dispatchEvent(escape);

      expect(escape.defaultPrevented).toBe(true);
      expect(document.querySelector('[data-feedback-completion-dialog]')).toBeNull();
      expect(controller.isWritable()).toBe(true);
      expect(document.activeElement).toBe(finishInvoker);
      expect(
        (host.postMessage as jest.Mock).mock.calls.some(call => call[0].type === 'feedback.finish')
      ).toBe(false);
      expect(legacyConfirm).not.toHaveBeenCalled();
    } finally {
      controller?.deactivate();
      legacyConfirm.mockRestore();
    }
  });

  it('confirms once and rejects a stale finished response for the current session', () => {
    const legacyConfirm = jest.spyOn(window, 'confirm').mockReturnValue(false);
    let controller: ReturnType<typeof createFeedbackReviewController> | undefined;
    try {
      const editor = createEditorFixture();
      controller = createFeedbackReviewController({ editor, host });
      controller.activate({
        sessionId: 'session-1',
        source: 'docs/guide.md',
        sourceSha256: 'b'.repeat(64),
        round: 'round-1',
        feedbackFile: '.md4h/feedback/docs/guide.md--round-1/feedback.md',
        items: createSavedFeedbackItems(2),
      });
      controller.finish();
      const dialog = document.querySelector<HTMLElement>('[data-feedback-completion-dialog]');
      const confirm = dialog?.querySelector<HTMLButtonElement>(
        '[data-feedback-completion-confirm]'
      );

      confirm?.click();
      confirm?.click();
      controller.finish();

      const finishMessages = (host.postMessage as jest.Mock).mock.calls
        .map(call => call[0] as FeedbackWebviewMessage)
        .filter(message => message.type === 'feedback.finish') as Array<{
        type: 'feedback.finish';
        requestId: string;
        sessionId: string;
      }>;
      expect(finishMessages).toHaveLength(1);
      expect(finishMessages[0]).toEqual(
        expect.objectContaining({ type: 'feedback.finish', sessionId: 'session-1' })
      );
      expect(controller.isWritable()).toBe(false);
      expect(dialog?.getAttribute('data-feedback-completion-state')).toBe('finishing');
      expect(dialog?.querySelector('[data-feedback-completion-resume]')).toBeNull();

      const finishRequest = finishMessages[0];
      controller.handleHostMessage({
        type: 'feedback.finished',
        requestId: `${finishRequest.requestId}-stale`,
        sessionId: 'session-1',
        feedbackFile: '.md4h/feedback/docs/guide.md--round-1/feedback.md',
        itemCount: 2,
        prompt: 'Implement the sealed feedback bundle.',
        promptCopied: true,
      } as unknown as FeedbackHostMessage);

      expect(
        (host.postMessage as jest.Mock).mock.calls.some(
          call => call[0].type === 'feedback.close.ready'
        )
      ).toBe(false);
      expect(controller.getSession()?.sessionId).toBe('session-1');
      expect(dialog?.getAttribute('data-feedback-completion-state')).toBe('finishing');
      expect(legacyConfirm).not.toHaveBeenCalled();
    } finally {
      controller?.deactivate();
      legacyConfirm.mockRestore();
    }
  });

  it('disables finishing when no feedback has been logged', () => {
    const legacyConfirm = jest.spyOn(window, 'confirm').mockReturnValue(false);
    let controller: ReturnType<typeof createFeedbackReviewController> | undefined;
    try {
      const editor = createEditorFixture();
      controller = createFeedbackReviewController({ editor, host });
      controller.activate({
        sessionId: 'session-1',
        source: 'docs/guide.md',
        sourceSha256: 'b'.repeat(64),
        round: 'round-1',
        feedbackFile: '.md4h/feedback/docs/guide.md--round-1/feedback.md',
        items: [],
      });

      controller.finish();

      const dialog = document.querySelector<HTMLElement>('[data-feedback-completion-dialog]');
      const confirm = dialog?.querySelector<HTMLButtonElement>(
        '[data-feedback-completion-confirm]'
      );
      expect(dialog?.querySelector('[data-feedback-completion-count]')?.textContent).toBe(
        'No feedback logged yet'
      );
      expect(confirm?.disabled).toBe(true);
      confirm?.click();
      expect(
        (host.postMessage as jest.Mock).mock.calls.some(call => call[0].type === 'feedback.finish')
      ).toBe(false);
      expect(controller.isWritable()).toBe(true);
      expect(legacyConfirm).not.toHaveBeenCalled();
    } finally {
      controller?.deactivate();
      legacyConfirm.mockRestore();
    }
  });

  it('traps forward and reverse focus inside the finish checkpoint', () => {
    const legacyConfirm = jest.spyOn(window, 'confirm').mockReturnValue(false);
    let controller: ReturnType<typeof createFeedbackReviewController> | undefined;
    try {
      const editor = createEditorFixture();
      controller = createFeedbackReviewController({ editor, host });
      controller.activate({
        sessionId: 'session-1',
        source: 'docs/guide.md',
        sourceSha256: 'b'.repeat(64),
        round: 'round-1',
        feedbackFile: '.md4h/feedback/docs/guide.md--round-1/feedback.md',
        items: createSavedFeedbackItems(1),
      });
      controller.finish();

      const dialog = document.querySelector<HTMLElement>('[data-feedback-completion-dialog]');
      const path = dialog?.querySelector<HTMLElement>('[data-feedback-completion-path]');
      const resume = dialog?.querySelector<HTMLButtonElement>('[data-feedback-completion-resume]');
      const confirm = dialog?.querySelector<HTMLButtonElement>(
        '[data-feedback-completion-confirm]'
      );
      path?.focus();
      dialog?.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Tab',
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        })
      );
      expect(document.activeElement).toBe(confirm);

      dialog?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
      );
      expect(document.activeElement).toBe(path);
      expect(resume).not.toBeNull();
      expect(legacyConfirm).not.toHaveBeenCalled();
    } finally {
      controller?.deactivate();
      legacyConfirm.mockRestore();
    }
  });

  it('contains wheel and page scrolling inside the finish checkpoint', () => {
    const editor = createEditorFixture();
    const controller = createFeedbackReviewController({ editor, host });
    controller.activate({
      sessionId: 'session-1',
      source: 'docs/guide.md',
      sourceSha256: 'b'.repeat(64),
      round: 'round-1',
      feedbackFile: '.md4h/feedback/docs/guide.md--round-1/feedback.md',
      items: createSavedFeedbackItems(1),
    });
    controller.finish();

    const dialog = document.querySelector<HTMLElement>('[data-feedback-completion-dialog]')!;
    const wheel = new WheelEvent('wheel', { deltaY: 240, bubbles: true, cancelable: true });
    dialog.dispatchEvent(wheel);
    const pageDown = new KeyboardEvent('keydown', {
      key: 'PageDown',
      bubbles: true,
      cancelable: true,
    });
    dialog.dispatchEvent(pageDown);

    expect(wheel.defaultPrevented).toBe(true);
    expect(pageDown.defaultPrevented).toBe(true);
  });

  it('owns the draft-surface gate while the finish checkpoint is open', () => {
    const editor = createEditorFixture();
    const controller = createFeedbackReviewController({ editor, host });
    controller.activate({
      sessionId: 'session-1',
      source: 'docs/guide.md',
      sourceSha256: 'b'.repeat(64),
      round: 'round-1',
      feedbackFile: '.md4h/feedback/docs/guide.md--round-1/feedback.md',
      items: createSavedFeedbackItems(1),
    });
    controller.finish();
    const dialog = document.querySelector<HTMLElement>('[data-feedback-completion-dialog]');
    const resume = dialog?.querySelector<HTMLButtonElement>('[data-feedback-completion-resume]');

    controller.openTextComposer({
      startOrdinal: 1,
      endOrdinal: 1,
      focus: 'Alpha beta',
      startLine: 3,
      endLine: 3,
    });
    startFeedbackAreaCapture({ editor, review: controller, rasterize: jest.fn() });

    expect(document.querySelector('.feedback-composer')).toBeNull();
    expect(document.querySelector('.feedback-area-capture')).toBeNull();
    expect(document.activeElement).toBe(resume);
    expect(controller.draftSurfaceGate.activeKind()).toBe('finish-checkpoint');
  });

  it('keeps invalidation inside an open checkpoint and disables finishing immediately', () => {
    const editor = createEditorFixture();
    const finishInvoker = document.createElement('button');
    finishInvoker.setAttribute('data-feedback-finish', '');
    document.body.append(finishInvoker);
    const controller = createFeedbackReviewController({ editor, host });
    controller.activate({
      sessionId: 'session-1',
      source: 'docs/guide.md',
      sourceSha256: 'b'.repeat(64),
      round: 'round-1',
      feedbackFile: '.md4h/feedback/docs/guide.md--round-1/feedback.md',
      items: createSavedFeedbackItems(1),
    });
    finishInvoker.focus();
    controller.finish();

    controller.invalidate('MD4H-FB-SNAPSHOT-001');
    finishInvoker.disabled = true;

    const dialog = document.querySelector<HTMLElement>('[data-feedback-completion-dialog]');
    const resume = dialog?.querySelector<HTMLButtonElement>('[data-feedback-completion-resume]');
    const confirm = dialog?.querySelector<HTMLButtonElement>('[data-feedback-completion-confirm]');
    expect(confirm?.disabled).toBe(true);
    expect(dialog?.querySelector('[data-feedback-completion-status]')?.textContent).toContain(
      'source changed outside this snapshot'
    );
    expect(dialog?.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).toBe(resume);

    dialog?.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true,
      })
    );
    expect(document.querySelector('[data-feedback-completion-dialog]')).toBeNull();
    expect(controller.isInvalidated()).toBe(true);
    expect(document.activeElement).toBe(editor.view.dom);
  });

  it('falls back to the editor when an invalidated checkpoint return target is aria-disabled', () => {
    const editor = createEditorFixture();
    const finishInvoker = document.createElement('div');
    finishInvoker.tabIndex = 0;
    finishInvoker.setAttribute('role', 'button');
    finishInvoker.setAttribute('data-feedback-finish', '');
    document.body.append(finishInvoker);
    const controller = createFeedbackReviewController({ editor, host });
    controller.activate({
      sessionId: 'session-1',
      source: 'docs/guide.md',
      sourceSha256: 'b'.repeat(64),
      round: 'round-1',
      feedbackFile: '.md4h/feedback/docs/guide.md--round-1/feedback.md',
      items: createSavedFeedbackItems(1),
    });
    finishInvoker.focus();
    controller.finish();

    controller.invalidate('MD4H-FB-SNAPSHOT-001');
    finishInvoker.setAttribute('aria-disabled', 'true');
    document.querySelector<HTMLElement>('[data-feedback-completion-dialog]')?.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true,
      })
    );

    expect(document.querySelector('[data-feedback-completion-dialog]')).toBeNull();
    expect(document.activeElement).toBe(editor.view.dom);
  });

  it('updates the checkpoint count and restores the logical Finish control', () => {
    const editor = createEditorFixture();
    const finishInvoker = document.createElement('button');
    finishInvoker.setAttribute('data-feedback-finish', '');
    document.body.append(finishInvoker);
    const controller = createFeedbackReviewController({ editor, host });
    controller.activate({
      sessionId: 'session-1',
      source: 'docs/guide.md',
      sourceSha256: 'b'.repeat(64),
      round: 'round-1',
      feedbackFile: '.md4h/feedback/docs/guide.md--round-1/feedback.md',
      items: createSavedFeedbackItems(1),
    });
    finishInvoker.focus();
    controller.finish();

    controller.updateItems(createSavedFeedbackItems(2));
    finishInvoker.remove();
    const replacementFinish = document.createElement('button');
    replacementFinish.setAttribute('data-feedback-finish', '');
    document.body.append(replacementFinish);
    const dialog = document.querySelector<HTMLElement>('[data-feedback-completion-dialog]');
    expect(dialog?.querySelector('[data-feedback-completion-count]')?.textContent).toBe(
      '2 feedback items ready to lock'
    );

    dialog?.querySelector<HTMLButtonElement>('[data-feedback-completion-resume]')?.click();
    expect(document.activeElement).toBe(replacementFinish);
  });

  it('reopens a retryable checkpoint after a matching finish error', () => {
    const legacyConfirm = jest.spyOn(window, 'confirm').mockReturnValue(false);
    let controller: ReturnType<typeof createFeedbackReviewController> | undefined;
    try {
      const editor = createEditorFixture();
      controller = createFeedbackReviewController({ editor, host });
      controller.activate({
        sessionId: 'session-1',
        source: 'docs/guide.md',
        sourceSha256: 'b'.repeat(64),
        round: 'round-1',
        feedbackFile: '.md4h/feedback/docs/guide.md--round-1/feedback.md',
        items: createSavedFeedbackItems(1),
      });
      controller.finish();
      const dialog = document.querySelector<HTMLElement>('[data-feedback-completion-dialog]');
      dialog?.querySelector<HTMLButtonElement>('[data-feedback-completion-confirm]')?.click();
      const finish = (host.postMessage as jest.Mock).mock.calls
        .map(call => call[0] as FeedbackWebviewMessage)
        .find(message => message.type === 'feedback.finish') as {
        type: 'feedback.finish';
        requestId: string;
        sessionId: string;
      };

      controller.handleHostMessage({
        type: 'feedback.error',
        requestId: finish.requestId,
        sessionId: 'session-1',
        code: 'MD4H-FB-STORE-002',
        message: 'Could not seal the feedback bundle. Try again.',
        recoverable: true,
      });

      const retry = document.querySelector<HTMLButtonElement>('[data-feedback-completion-confirm]');
      expect(dialog?.getAttribute('data-feedback-completion-state')).toBe('confirm');
      expect(dialog?.querySelector('[data-feedback-completion-status]')?.textContent).toBe(
        'Could not seal the feedback bundle. Try again.'
      );
      expect(retry?.disabled).toBe(false);
      expect(controller.isWritable()).toBe(true);
      controller.handleHostMessage({
        type: 'feedback.finished',
        requestId: finish.requestId,
        sessionId: 'session-1',
        feedbackFile: '.md4h/feedback/docs/guide.md--round-1/feedback.md',
        itemCount: 1,
        prompt: 'Implement the sealed feedback bundle.',
        promptCopied: true,
      });
      expect(
        (host.postMessage as jest.Mock).mock.calls.some(
          call => call[0].type === 'feedback.close.ready'
        )
      ).toBe(false);
      retry?.click();
      expect(
        (host.postMessage as jest.Mock).mock.calls.filter(
          call => call[0].type === 'feedback.finish'
        )
      ).toHaveLength(2);
      expect(legacyConfirm).not.toHaveBeenCalled();
    } finally {
      controller?.deactivate();
      legacyConfirm.mockRestore();
    }
  });

  it('keeps the authoritative sealed result visible after the editor unlocks', () => {
    const legacyConfirm = jest.spyOn(window, 'confirm').mockReturnValue(false);
    let controller: ReturnType<typeof createFeedbackReviewController> | undefined;
    try {
      const editor = createEditorFixture();
      controller = createFeedbackReviewController({ editor, host });
      controller.activate({
        sessionId: 'session-1',
        source: 'docs/guide.md',
        sourceSha256: 'b'.repeat(64),
        round: 'round-1',
        feedbackFile: '.md4h/feedback/docs/guide.md--round-1/feedback.md',
        items: createSavedFeedbackItems(2),
      });
      controller.finish();
      document.querySelector<HTMLButtonElement>('[data-feedback-completion-confirm]')?.click();
      const finish = (host.postMessage as jest.Mock).mock.calls
        .map(call => call[0] as FeedbackWebviewMessage)
        .find(message => message.type === 'feedback.finish') as {
        type: 'feedback.finish';
        requestId: string;
        sessionId: string;
      };
      const feedbackFile = '.md4h/feedback/docs/guide.md--round-1/feedback.md';
      controller.handleHostMessage({
        type: 'feedback.finished',
        requestId: finish.requestId,
        sessionId: 'session-1',
        feedbackFile,
        itemCount: 3,
        prompt: 'Implement the sealed feedback bundle.',
        promptCopied: true,
      });
      expect(document.querySelector('[data-feedback-completion-status]')?.textContent).toBe(
        'Feedback locked. Restoring the latest source…'
      );
      const retainedCheckpoint = document.querySelector<HTMLElement>(
        '[data-feedback-completion-dialog]'
      );
      const escapeAfterSeal = new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true,
      });
      retainedCheckpoint?.dispatchEvent(escapeAfterSeal);
      expect(escapeAfterSeal.defaultPrevented).toBe(true);
      expect(document.querySelector('[data-feedback-completion-dialog]')).toBe(retainedCheckpoint);
      expect(editor.view.dom.getAttribute('aria-readonly')).toBe('true');

      controller.invalidate('MD4H-FB-SNAPSHOT-001');
      expect(retainedCheckpoint?.getAttribute('data-feedback-completion-state')).toBe('finishing');
      expect(retainedCheckpoint?.getAttribute('aria-busy')).toBe('true');
      expect(retainedCheckpoint?.querySelector('[data-feedback-completion-resume]')).toBeNull();
      expect(
        retainedCheckpoint?.querySelector<HTMLButtonElement>('[data-feedback-completion-confirm]')
          ?.disabled
      ).toBe(true);
      expect(host.postMessage).toHaveBeenCalledWith({
        type: 'feedback.close.ready',
        requestId: finish.requestId,
        sessionId: 'session-1',
      });
      expect(
        controller.applyCloseSync(
          {
            type: 'feedback.close.sync',
            requestId: finish.requestId,
            sessionId: 'session-1',
            revision: 1,
            content: '# Current source\n',
          },
          () => true
        )
      ).toBe(true);
      controller.handleHostMessage({
        type: 'feedback.close.release',
        requestId: finish.requestId,
        sessionId: 'session-1',
        revision: 1,
      });
      expect(controller.completeClose('session-1')).toBe(true);

      const result = document.querySelector<HTMLElement>('[data-feedback-completion-dialog]');
      expect(controller.getSession()).toBeNull();
      expect(editor.view.dom.getAttribute('aria-readonly')).toBeNull();
      expect(result?.getAttribute('data-feedback-completion-state')).toBe('sealed');
      expect(result?.querySelector('[data-feedback-completion-count]')?.textContent).toBe(
        '3 feedback items locked'
      );
      expect(result?.querySelector('[data-feedback-completion-path]')?.textContent).toBe(
        feedbackFile
      );
      expect(result?.querySelector('[data-feedback-completion-status]')?.textContent).toBe(
        'Agent handoff copied'
      );
      const done = result?.querySelector<HTMLButtonElement>('[data-feedback-completion-done]');
      controller.start();
      expect(
        (host.postMessage as jest.Mock).mock.calls.some(call => call[0].type === 'feedback.start')
      ).toBe(false);
      expect(document.querySelector('[data-feedback-completion-dialog]')).toBe(result);
      expect(document.activeElement).toBe(done);

      done?.click();
      expect(document.querySelector('[data-feedback-completion-dialog]')).toBeNull();
      expect(document.activeElement).toBe(editor.view.dom);
      expect(legacyConfirm).not.toHaveBeenCalled();
    } finally {
      controller?.deactivate();
      legacyConfirm.mockRestore();
    }
  });

  it('retains the exact customized multiline prompt for Copy again', async () => {
    const legacyConfirm = jest.spyOn(window, 'confirm').mockReturnValue(false);
    const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    const writeText = jest.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    let controller: ReturnType<typeof createFeedbackReviewController> | undefined;
    try {
      const editor = createEditorFixture();
      controller = createFeedbackReviewController({ editor, host });
      controller.activate({
        sessionId: 'session-1',
        source: 'docs/guide.md',
        sourceSha256: 'b'.repeat(64),
        round: 'round-1',
        feedbackFile: '.md4h/feedback/docs/guide.md--round-1/feedback.md',
        items: createSavedFeedbackItems(1),
      });
      controller.finish();
      document.querySelector<HTMLButtonElement>('[data-feedback-completion-confirm]')?.click();
      const finish = (host.postMessage as jest.Mock).mock.calls
        .map(call => call[0] as FeedbackWebviewMessage)
        .find(message => message.type === 'feedback.finish') as {
        type: 'feedback.finish';
        requestId: string;
        sessionId: string;
      };
      const prompt =
        'Review `.md4h/feedback/docs/guide.md--round-1/feedback.md`.\n' +
        'Use our team workflow, keep {{round}} literal, and report every ID.';
      controller.handleHostMessage({
        type: 'feedback.finished',
        requestId: finish.requestId,
        sessionId: 'session-1',
        feedbackFile: '.md4h/feedback/docs/guide.md--round-1/feedback.md',
        itemCount: 1,
        prompt,
        promptCopied: false,
      });
      controller.applyCloseSync(
        {
          type: 'feedback.close.sync',
          requestId: finish.requestId,
          sessionId: 'session-1',
          revision: 1,
          content: '# Current source\n',
        },
        () => true
      );
      controller.handleHostMessage({
        type: 'feedback.close.release',
        requestId: finish.requestId,
        sessionId: 'session-1',
        revision: 1,
      });
      expect(controller.completeClose('session-1')).toBe(true);

      const copyAgain = document.querySelector<HTMLButtonElement>(
        '[data-feedback-completion-copy-again]'
      );
      expect(copyAgain).not.toBeNull();
      copyAgain?.click();
      await Promise.resolve();

      expect(writeText).toHaveBeenCalledWith(prompt);
      expect(document.querySelector('[data-feedback-completion-status]')?.textContent).toBe(
        'Agent handoff copied'
      );
      expect(legacyConfirm).not.toHaveBeenCalled();
    } finally {
      controller?.deactivate();
      legacyConfirm.mockRestore();
      if (originalClipboard) {
        Object.defineProperty(navigator, 'clipboard', originalClipboard);
      } else {
        Reflect.deleteProperty(navigator, 'clipboard');
      }
    }
  });

  it('hands focus to reachable close recovery when source restoration fails', () => {
    const editor = createEditorFixture();
    const controller = createFeedbackReviewController({ editor, host });
    controller.activate({
      sessionId: 'session-1',
      source: 'docs/guide.md',
      sourceSha256: 'b'.repeat(64),
      round: 'round-1',
      feedbackFile: '.md4h/feedback/docs/guide.md--round-1/feedback.md',
      items: createSavedFeedbackItems(1),
    });
    controller.finish();
    document.querySelector<HTMLButtonElement>('[data-feedback-completion-confirm]')?.click();
    const finish = (host.postMessage as jest.Mock).mock.calls
      .map(call => call[0] as FeedbackWebviewMessage)
      .find(message => message.type === 'feedback.finish') as {
      type: 'feedback.finish';
      requestId: string;
      sessionId: string;
    };
    controller.handleHostMessage({
      type: 'feedback.finished',
      requestId: finish.requestId,
      sessionId: 'session-1',
      feedbackFile: '.md4h/feedback/docs/guide.md--round-1/feedback.md',
      itemCount: 1,
      prompt: 'Implement the sealed feedback bundle.',
      promptCopied: true,
    });

    expect(
      controller.applyCloseSync(
        {
          type: 'feedback.close.sync',
          requestId: finish.requestId,
          sessionId: 'session-1',
          revision: 1,
          content: '# Current source\n',
        },
        () => false
      )
    ).toBe(false);

    const retry = document.querySelector<HTMLButtonElement>('[data-feedback-close-retry]');
    expect(document.querySelector('[data-feedback-completion-dialog]')).toBeNull();
    expect(retry).not.toBeNull();
    expect(document.activeElement).toBe(retry);
    expect(controller.getSession()?.sessionId).toBe('session-1');
    expect(editor.view.dom.getAttribute('aria-readonly')).toBe('true');

    retry?.click();
    expect(
      controller.applyCloseSync(
        {
          type: 'feedback.close.sync',
          requestId: finish.requestId,
          sessionId: 'session-1',
          revision: 2,
          content: '# Latest source\n',
        },
        () => true
      )
    ).toBe(true);
    controller.handleHostMessage({
      type: 'feedback.close.release',
      requestId: finish.requestId,
      sessionId: 'session-1',
      revision: 2,
    });
    expect(controller.completeClose('session-1')).toBe(true);
    expect(
      document
        .querySelector('[data-feedback-completion-dialog]')
        ?.getAttribute('data-feedback-completion-state')
    ).toBe('sealed');
  });

  it('keeps a text draft focused instead of opening an overlapping area capture', () => {
    const editor = createEditorFixture();
    const controller = createFeedbackReviewController({ editor, host });
    controller.activate({
      sessionId: 'session-1',
      source: 'docs/guide.md',
      sourceSha256: 'b'.repeat(64),
      round: 'round-1',
      anchors: [{ ordinal: 1, startLine: 3, endLine: 3 }],
      items: [],
    });
    controller.openTextComposer({
      startOrdinal: 1,
      endOrdinal: 1,
      focus: 'Alpha beta',
      startLine: 3,
      endLine: 3,
    });
    const field = document.querySelector('[data-feedback-input]') as HTMLTextAreaElement;
    field.value = 'Keep this draft.';
    const editorDom = editor.view.dom as HTMLElement;
    editorDom.getBoundingClientRect = () =>
      ({ left: 0, top: 0, right: 800, bottom: 480, width: 800, height: 480 }) as DOMRect;

    startFeedbackAreaCapture({ editor, review: controller, rasterize: jest.fn() });

    expect(document.querySelector('.feedback-area-capture')).toBeNull();
    expect(document.querySelector('[data-feedback-input]')).toBe(field);
    expect(field.value).toBe('Keep this draft.');
    expect(document.activeElement).toBe(field);
    controller.deactivate();
  });

  it('blocks text composition, Finish, and Discard while an area capture owns the session', () => {
    const confirmFinish = jest.spyOn(window, 'confirm').mockReturnValue(true);
    try {
      const editor = createEditorFixture();
      const controller = createFeedbackReviewController({ editor, host });
      controller.activate({
        sessionId: 'session-1',
        source: 'docs/guide.md',
        sourceSha256: 'b'.repeat(64),
        round: 'round-1',
        anchors: [{ ordinal: 1, startLine: 3, endLine: 3 }],
        items: [],
      });
      const editorDom = editor.view.dom as HTMLElement;
      editorDom.getBoundingClientRect = () =>
        ({ left: 0, top: 0, right: 800, bottom: 480, width: 800, height: 480 }) as DOMRect;
      startFeedbackAreaCapture({ editor, review: controller, rasterize: jest.fn() });
      const capture = document.querySelector('.feedback-area-capture') as HTMLElement;
      expect(capture).not.toBeNull();

      controller.openTextComposer({
        startOrdinal: 1,
        endOrdinal: 1,
        focus: 'Alpha beta',
        startLine: 3,
        endLine: 3,
      });
      controller.finish();
      controller.discard();

      expect(document.querySelector('.feedback-composer')).toBeNull();
      expect(confirmFinish).not.toHaveBeenCalled();
      expect(
        (host.postMessage as jest.Mock).mock.calls.some(call =>
          ['feedback.finish', 'feedback.discard'].includes(call[0].type)
        )
      ).toBe(false);
      expect(document.querySelector('[data-feedback-completion-dialog]')).toBeNull();
      expect(document.activeElement).toBe(capture);
      controller.deactivate();
    } finally {
      confirmFinish.mockRestore();
    }
  });

  it('shows only the new composer while saved comments remain on the rail', () => {
    const editor = createEditorFixture();
    const controller = createFeedbackReviewController({ editor, host });
    controller.activate({
      sessionId: 'session-1',
      source: 'docs/guide.md',
      sourceSha256: 'b'.repeat(64),
      round: 'round-1',
      items: [
        {
          id: 'F1',
          kind: 'text',
          startOrdinal: 0,
          endOrdinal: 0,
          startLine: 1,
          endLine: 1,
          focus: 'Title',
          feedback: 'Old note',
        },
      ],
    });
    const marker = document.querySelector('[data-feedback-marker]') as HTMLButtonElement;
    marker.click();
    expect(document.querySelector('[data-feedback-card="F1"]')).not.toBeNull();

    controller.openTextComposer({
      startOrdinal: 1,
      endOrdinal: 1,
      focus: 'Alpha beta',
      startLine: 3,
      endLine: 3,
    });

    expect(document.querySelector('.feedback-composer')).not.toBeNull();
    expect(document.querySelector('[data-feedback-card="F1"]')).toBeNull();
    expect(document.querySelector('.feedback-comments-panel')?.textContent).not.toContain(
      'Old note'
    );
    expect(marker.classList).not.toContain('active');

    const cancel = Array.from(
      document.querySelectorAll<HTMLButtonElement>('.feedback-composer button')
    ).find(button => button.textContent === 'Cancel');
    cancel?.click();
    expect(document.querySelector('.feedback-comment-rail')?.classList).not.toContain('expanded');
    const savedMarker = document.querySelector('[data-feedback-marker]') as HTMLButtonElement;
    expect(savedMarker).not.toBeNull();
    savedMarker.click();
    expect(document.querySelector('[data-feedback-card="F1"]')).not.toBeNull();
  });

  it('keeps saved comment cards out of the composer after a host refresh', () => {
    const editor = createEditorFixture();
    const controller = createFeedbackReviewController({ editor, host });
    const savedItem = {
      id: 'F1',
      kind: 'text' as const,
      startOrdinal: 0,
      endOrdinal: 0,
      startLine: 1,
      endLine: 1,
      focus: 'Title',
      feedback: 'Old note',
    };
    controller.activate({
      sessionId: 'session-1',
      source: 'docs/guide.md',
      sourceSha256: 'b'.repeat(64),
      round: 'round-1',
      items: [savedItem],
    });
    controller.openTextComposer({
      startOrdinal: 1,
      endOrdinal: 1,
      focus: 'Alpha beta',
      startLine: 3,
      endLine: 3,
    });

    controller.handleHostMessage({
      type: 'feedback.updated',
      requestId: 'external-refresh',
      sessionId: controller.getSession()!.sessionId,
      items: [savedItem],
    });

    expect(document.querySelector('.feedback-composer')).not.toBeNull();
    expect(document.querySelector('[data-feedback-card]')).toBeNull();
  });

  it('preserves textarea focus when a host refresh arrives during composition', () => {
    const editor = createEditorFixture();
    const controller = createFeedbackReviewController({ editor, host });
    controller.activate({
      sessionId: 'session-1',
      source: 'docs/guide.md',
      sourceSha256: 'b'.repeat(64),
      round: 'round-1',
      items: [],
    });
    controller.openTextComposer({
      startOrdinal: 1,
      endOrdinal: 1,
      focus: 'Alpha beta',
      startLine: 3,
      endLine: 3,
    });
    const composer = document.querySelector('.feedback-composer') as HTMLFormElement;
    const field = composer.querySelector('textarea') as HTMLTextAreaElement;
    field.value = 'Keep my focus and this draft.';
    field.focus();

    controller.handleHostMessage({
      type: 'feedback.updated',
      requestId: 'external-refresh',
      sessionId: controller.getSession()!.sessionId,
      items: [],
    });

    expect(document.querySelector('.feedback-composer')).toBe(composer);
    expect(field.value).toBe('Keep my focus and this draft.');
    expect(document.activeElement).toBe(field);
  });

  it('keeps the chosen rendered blocks visibly targeted until the composer closes', () => {
    const editor = createEditorFixture();
    const controller = createFeedbackReviewController({ editor, host });
    controller.activate({
      sessionId: 'session-1',
      source: 'docs/guide.md',
      sourceSha256: 'b'.repeat(64),
      round: 'round-1',
      items: [],
    });

    controller.openTextComposer({
      startOrdinal: 0,
      endOrdinal: 1,
      focus: 'Title\nAlpha beta',
      startLine: 1,
      endLine: 3,
    });

    expect(editor.view.dom.children[0].classList).toContain('feedback-pending-target');
    expect(editor.view.dom.children[1].classList).toContain('feedback-pending-target');
    expect(editor.view.dom.children[2].classList).not.toContain('feedback-pending-target');

    const cancel = Array.from(
      document.querySelectorAll<HTMLButtonElement>('.feedback-composer button')
    ).find(button => button.textContent === 'Cancel');
    cancel?.click();

    expect(editor.view.dom.querySelector('.feedback-pending-target')).toBeNull();
  });

  it('returns an empty cancelled composer to the slim comment rail', () => {
    const editor = createEditorFixture();
    const controller = createFeedbackReviewController({ editor, host });
    controller.activate({
      sessionId: 'session-1',
      source: 'docs/guide.md',
      sourceSha256: 'b'.repeat(64),
      round: 'round-1',
      items: [],
    });
    controller.openTextComposer({
      startOrdinal: 1,
      endOrdinal: 1,
      focus: 'Alpha beta',
      startLine: 3,
      endLine: 3,
    });

    const rail = document.querySelector('.feedback-comment-rail') as HTMLElement;
    expect(rail.classList).toContain('expanded');
    const cancel = Array.from(
      document.querySelectorAll<HTMLButtonElement>('.feedback-composer button')
    ).find(button => button.textContent === 'Cancel');
    cancel?.click();

    expect(rail.hidden).toBe(false);
    expect(rail.classList).not.toContain('expanded');
    expect(document.querySelector('.feedback-composer')).toBeNull();
  });

  it('keeps a dirty composer until its in-webview Discard is confirmed', async () => {
    const editor = createEditorFixture();
    const controller = createFeedbackReviewController({ editor, host });
    controller.activate({
      sessionId: 'session-1',
      source: 'docs/guide.md',
      sourceSha256: 'c'.repeat(64),
      round: 'round-1',
      items: [],
    });
    controller.openTextComposer({
      startOrdinal: 1,
      endOrdinal: 1,
      focus: 'Alpha beta',
      startLine: 3,
      endLine: 3,
    });
    const composer = document.querySelector<HTMLFormElement>('.feedback-composer')!;
    const field = composer.querySelector<HTMLTextAreaElement>('[data-feedback-input]')!;
    const cancel = composer.querySelector<HTMLButtonElement>(
      '.feedback-composer-actions .feedback-secondary-button'
    )!;
    field.value = 'Keep this unfinished note';
    field.dispatchEvent(new Event('input', { bubbles: true }));

    expect(cancel.textContent).toBe('Discard');
    cancel.click();

    const checkpoint = document.querySelector<HTMLElement>('[data-feedback-discard-dialog]');
    expect(checkpoint?.textContent).toContain(
      'Your unfinished comment will be lost. Saved comments and the Feedback session will remain.'
    );
    expect(document.querySelector('.feedback-composer')).toBe(composer);
    expect(field.value).toBe('Keep this unfinished note');
    expect(composer.inert).toBe(true);
    expect(controller.draftSurfaceGate.activeKind()).toBe('text-composer');
    document.body.tabIndex = -1;
    document.body.focus();
    expect(controller.draftSurfaceGate.focusActive()).toBe(true);
    expect(document.activeElement).toBe(
      checkpoint?.querySelector<HTMLElement>('[data-feedback-discard-keep]')
    );
    expect(
      (host.postMessage as jest.Mock).mock.calls.some(call => call[0].type === 'feedback.text.add')
    ).toBe(false);

    checkpoint?.querySelector<HTMLButtonElement>('[data-feedback-discard-keep]')?.click();
    await Promise.resolve();
    expect(document.querySelector('.feedback-composer')).toBe(composer);
    expect(composer.inert).toBe(false);
    expect(controller.draftSurfaceGate.activeKind()).toBe('text-composer');
    expect(document.activeElement).toBe(field);

    cancel.click();
    document
      .querySelector<HTMLElement>('[data-feedback-discard-dialog]')
      ?.querySelector<HTMLButtonElement>('[data-feedback-discard-confirm]')
      ?.click();
    await Promise.resolve();
    expect(document.querySelector('.feedback-composer')).toBeNull();
    expect(controller.draftSurfaceGate.activeKind()).toBeNull();
    expect(editor.view.dom.querySelector('.feedback-pending-target')).toBeNull();
  });

  it('uses the same dirty-discard checkpoint when Escape closes a composer', async () => {
    const editor = createEditorFixture();
    const controller = createFeedbackReviewController({ editor, host });
    controller.activate({
      sessionId: 'session-1',
      source: 'docs/guide.md',
      sourceSha256: 'c'.repeat(64),
      round: 'round-1',
      items: [],
    });
    controller.openTextComposer({
      startOrdinal: 1,
      endOrdinal: 1,
      focus: 'Alpha beta',
      startLine: 3,
      endLine: 3,
    });
    const composer = document.querySelector<HTMLFormElement>('.feedback-composer')!;
    const field = composer.querySelector<HTMLTextAreaElement>('[data-feedback-input]')!;
    field.value = 'Do not lose this draft';
    field.dispatchEvent(new Event('input', { bubbles: true }));

    composer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(document.querySelector('.feedback-composer')).toBe(composer);
    let checkpoint = document.querySelector<HTMLElement>('[data-feedback-discard-dialog]')!;
    checkpoint.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await Promise.resolve();
    expect(document.querySelector('.feedback-composer')).toBe(composer);
    expect(document.activeElement).toBe(field);

    composer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    checkpoint = document.querySelector<HTMLElement>('[data-feedback-discard-dialog]')!;
    checkpoint.querySelector<HTMLButtonElement>('[data-feedback-discard-confirm]')?.click();
    await Promise.resolve();
    expect(document.querySelector('.feedback-composer')).toBeNull();
  });

  it('activates with a collapsed, labelled comments rail and stable relationships', () => {
    const editor = createEditorFixture();
    const controller = createFeedbackReviewController({ editor, host });
    controller.activate({
      sessionId: 'session-1',
      source: 'docs/guide.md',
      sourceSha256: 'c'.repeat(64),
      round: 'round-1',
      items: [
        {
          id: 'F1',
          kind: 'text',
          startOrdinal: 1,
          endOrdinal: 1,
          startLine: 3,
          endLine: 3,
          focus: 'Alpha beta',
          feedback: 'Clarify this.',
        },
      ],
    });

    const rail = document.querySelector('.feedback-comment-rail') as HTMLElement;
    const panel = document.querySelector('.feedback-comments-panel') as HTMLElement;
    const marker = document.querySelector('[data-feedback-marker]') as HTMLButtonElement;

    expect(rail.id).not.toBe('');
    expect(panel.id).not.toBe('');
    expect(rail.hidden).toBe(false);
    expect(rail.getAttribute('aria-hidden')).toBe('false');
    expect(rail.getAttribute('aria-expanded')).toBeNull();
    expect(marker.getAttribute('aria-controls')).toBe(panel.id);
    expect(marker.getAttribute('aria-expanded')).toBe('false');
    expect(document.body.getAttribute('data-feedback-comments-state')).toBe('collapsed');
  });

  it('moves the collapsed rail to an expanded drawer when a marker is opened', () => {
    const editor = createEditorFixture();
    const controller = createFeedbackReviewController({ editor, host });
    controller.activate({
      sessionId: 'session-1',
      source: 'docs/guide.md',
      sourceSha256: 'c'.repeat(64),
      round: 'round-1',
      items: [
        {
          id: 'F1',
          kind: 'text',
          startOrdinal: 1,
          endOrdinal: 1,
          startLine: 3,
          endLine: 3,
          focus: 'Alpha beta',
          feedback: 'Clarify this.',
        },
      ],
    });

    const rail = document.querySelector('.feedback-comment-rail') as HTMLElement;
    const railId = rail.id;
    const marker = document.querySelector('[data-feedback-marker]') as HTMLButtonElement;
    marker.click();

    expect(rail.id).toBe(railId);
    expect(rail.hidden).toBe(false);
    expect(rail.classList).toContain('expanded');
    expect(rail.getAttribute('aria-hidden')).toBe('false');
    expect(rail.getAttribute('aria-expanded')).toBeNull();
    expect(marker.getAttribute('aria-expanded')).toBe('true');
    expect(document.body.getAttribute('data-feedback-comments-state')).toBe('expanded');
  });

  it('returns an expanded comment drawer to the same collapsed rail when closed', () => {
    const editor = createEditorFixture();
    const controller = createFeedbackReviewController({ editor, host });
    controller.activate({
      sessionId: 'session-1',
      source: 'docs/guide.md',
      sourceSha256: 'c'.repeat(64),
      round: 'round-1',
      items: [
        {
          id: 'F1',
          kind: 'text',
          startOrdinal: 1,
          endOrdinal: 1,
          startLine: 3,
          endLine: 3,
          focus: 'Alpha beta',
          feedback: 'Clarify this.',
        },
      ],
    });

    const rail = document.querySelector('.feedback-comment-rail') as HTMLElement;
    const railId = rail.id;
    (document.querySelector('[data-feedback-marker]') as HTMLButtonElement).click();
    (document.querySelector('[data-feedback-panel-collapse]') as HTMLButtonElement).click();

    const marker = document.querySelector('[data-feedback-marker]') as HTMLButtonElement;
    expect(rail.id).toBe(railId);
    expect(rail.hidden).toBe(false);
    expect(rail.classList).not.toContain('expanded');
    expect(rail.getAttribute('aria-hidden')).toBe('false');
    expect(rail.getAttribute('aria-expanded')).toBeNull();
    expect(marker.getAttribute('aria-expanded')).toBe('false');
    expect(document.body.getAttribute('data-feedback-comments-state')).toBe('collapsed');
  });

  it('treats the active marker as a disclosure toggle for the expanded drawer', () => {
    const editor = createEditorFixture();
    const controller = createFeedbackReviewController({ editor, host });
    controller.activate({
      sessionId: 'session-1',
      source: 'docs/guide.md',
      sourceSha256: 'c'.repeat(64),
      round: 'round-1',
      items: [
        {
          id: 'F1',
          kind: 'text',
          startOrdinal: 1,
          endOrdinal: 1,
          startLine: 3,
          endLine: 3,
          focus: 'Alpha beta',
          feedback: 'Clarify this.',
        },
      ],
    });

    const marker = document.querySelector('[data-feedback-marker]') as HTMLButtonElement;
    marker.click();
    expect(marker.getAttribute('aria-expanded')).toBe('true');

    marker.click();

    expect(document.querySelector('.feedback-comment-rail')?.classList).not.toContain('expanded');
    expect(marker.getAttribute('aria-expanded')).toBe('false');
    expect(marker.classList).not.toContain('active');
    expect(document.body.getAttribute('data-feedback-comments-state')).toBe('collapsed');
    expect(document.activeElement).toBe(marker);
  });

  it('uses the toolbar visibility toggle only for hidden and collapsed rail states', () => {
    const editor = createEditorFixture();
    const controller = createFeedbackReviewController({ editor, host });
    controller.activate({
      sessionId: 'session-1',
      source: 'docs/guide.md',
      sourceSha256: 'c'.repeat(64),
      round: 'round-1',
      items: [],
    });

    const rail = document.querySelector('.feedback-comment-rail') as HTMLElement;
    const railId = rail.id;
    controller.toggleComments(false);

    expect(rail.id).toBe(railId);
    expect(rail.hidden).toBe(true);
    expect(rail.getAttribute('aria-hidden')).toBe('true');
    expect(rail.getAttribute('aria-expanded')).toBeNull();
    expect(document.body.getAttribute('data-feedback-comments-state')).toBe('hidden');

    controller.toggleComments(true);

    expect(rail.id).toBe(railId);
    expect(rail.hidden).toBe(false);
    expect(rail.classList).not.toContain('expanded');
    expect(rail.getAttribute('aria-hidden')).toBe('false');
    expect(rail.getAttribute('aria-expanded')).toBeNull();
    expect(document.body.getAttribute('data-feedback-comments-state')).toBe('collapsed');
  });

  it('keeps an active composer expanded and preserves typed feedback when hide is requested', () => {
    const editor = createEditorFixture();
    const controller = createFeedbackReviewController({ editor, host });
    controller.activate({
      sessionId: 'session-1',
      source: 'docs/guide.md',
      sourceSha256: 'c'.repeat(64),
      round: 'round-1',
      items: [],
    });
    controller.openTextComposer({
      startOrdinal: 1,
      endOrdinal: 1,
      focus: 'Alpha beta',
      startLine: 3,
      endLine: 3,
    });
    const rail = document.querySelector('.feedback-comment-rail') as HTMLElement;
    const composer = document.querySelector('.feedback-composer') as HTMLFormElement;
    const field = document.querySelector('[data-feedback-input]') as HTMLTextAreaElement;
    field.value = 'Keep this draft visible.';
    field.dispatchEvent(new Event('input', { bubbles: true }));

    controller.toggleComments(false);

    expect(rail.hidden).toBe(false);
    expect(rail.classList).toContain('expanded');
    expect(rail.getAttribute('aria-hidden')).toBe('false');
    expect(document.body.getAttribute('data-feedback-comments-state')).toBe('expanded');
    expect(document.querySelector('.feedback-composer')).toBe(composer);
    expect((document.querySelector('[data-feedback-input]') as HTMLTextAreaElement).value).toBe(
      'Keep this draft visible.'
    );
    expect(document.activeElement).toBe(field);
  });

  it('schedules marker repositioning when a hidden rail is shown again', () => {
    const queuedFrames: FrameRequestCallback[] = [];
    const requestFrame = jest
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation(callback => {
        queuedFrames.push(callback);
        return queuedFrames.length;
      });
    const flushFrames = (): void => {
      while (queuedFrames.length > 0) queuedFrames.shift()?.(0);
    };
    try {
      const editor = createEditorFixture();
      const controller = createFeedbackReviewController({ editor, host });
      controller.activate({
        sessionId: 'session-1',
        source: 'docs/guide.md',
        sourceSha256: 'c'.repeat(64),
        round: 'round-1',
        items: [
          {
            id: 'F1',
            kind: 'text',
            startOrdinal: 1,
            endOrdinal: 1,
            startLine: 3,
            endLine: 3,
            focus: 'Alpha beta',
            feedback: 'Clarify this.',
          },
        ],
      });
      flushFrames();
      controller.toggleComments(false);
      flushFrames();
      const callsBeforeShow = requestFrame.mock.calls.length;

      controller.toggleComments(true);

      expect(requestFrame.mock.calls.length).toBeGreaterThan(callsBeforeShow);
    } finally {
      requestFrame.mockRestore();
    }
  });

  it('does not schedule annotation work when a narrow anchored card collapses', () => {
    const queuedFrames: FrameRequestCallback[] = [];
    const requestFrame = jest
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation(callback => {
        queuedFrames.push(callback);
        return queuedFrames.length;
      });
    const originalInnerWidth = window.innerWidth;
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 700 });
    const flushFrames = (): void => {
      while (queuedFrames.length > 0) queuedFrames.shift()?.(0);
    };
    try {
      const editor = createEditorFixture();
      const controller = createFeedbackReviewController({ editor, host });
      controller.activate({
        sessionId: 'session-1',
        source: 'docs/guide.md',
        sourceSha256: 'c'.repeat(64),
        round: 'round-1',
        items: [
          {
            id: 'F1',
            kind: 'text',
            startOrdinal: 1,
            endOrdinal: 1,
            startLine: 3,
            endLine: 3,
            focus: 'Alpha beta',
            feedback: 'Clarify this.',
          },
        ],
      });
      flushFrames();
      (document.querySelector('[data-feedback-marker]') as HTMLButtonElement).click();
      flushFrames();
      const callsBeforeCollapse = requestFrame.mock.calls.length;

      (document.querySelector('[data-feedback-panel-collapse]') as HTMLButtonElement).click();

      expect(requestFrame.mock.calls.length).toBe(callsBeforeCollapse);
    } finally {
      Object.defineProperty(window, 'innerWidth', {
        configurable: true,
        value: originalInnerWidth,
      });
      requestFrame.mockRestore();
    }
  });

  it('places the active narrow card below its target instead of covering the annotation', () => {
    const cardRect = jest
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockImplementation(function (this: HTMLElement) {
        const height = this.hasAttribute('data-feedback-card') ? 120 : 0;
        return {
          top: 0,
          bottom: height,
          left: 0,
          right: 0,
          width: 0,
          height,
          x: 0,
          y: 0,
          toJSON: () => ({}),
        } as DOMRect;
      });
    try {
      const editor = createEditorFixture();
      const controller = createFeedbackReviewController({ editor, host });
      controller.activate({
        sessionId: 'session-1',
        source: 'docs/guide.md',
        sourceSha256: 'c'.repeat(64),
        round: 'round-1',
        items: [
          {
            id: 'F1',
            kind: 'text',
            startOrdinal: 1,
            endOrdinal: 1,
            startLine: 3,
            endLine: 3,
            focus: 'Alpha beta',
            feedback: 'Clarify this.',
          },
        ],
      });

      (document.querySelector('[data-feedback-marker]') as HTMLButtonElement).click();

      const targetBottom = editor.view.dom.children[1].getBoundingClientRect().bottom;
      const card = document.querySelector('[data-feedback-card="F1"]') as HTMLElement;
      expect(Number.parseFloat(card.style.top)).toBeGreaterThanOrEqual(targetBottom + 12);
    } finally {
      cardRect.mockRestore();
    }
  });

  it('moves focus out of the rail when the toolbar command hides comments', () => {
    const editor = createEditorFixture();
    const controller = createFeedbackReviewController({ editor, host });
    controller.activate({
      sessionId: 'session-1',
      source: 'docs/guide.md',
      sourceSha256: 'c'.repeat(64),
      round: 'round-1',
      items: [
        {
          id: 'F1',
          kind: 'text',
          startOrdinal: 1,
          endOrdinal: 1,
          startLine: 3,
          endLine: 3,
          focus: 'Alpha beta',
          feedback: 'Clarify this.',
        },
      ],
    });
    (document.querySelector('[data-feedback-marker]') as HTMLButtonElement).click();
    const card = document.querySelector('[data-feedback-card="F1"]') as HTMLElement;
    card.focus();
    expect(document.activeElement).toBe(card);

    controller.handleHostMessage({
      type: 'feedback.command',
      command: 'toggleComments',
    });

    expect((document.querySelector('.feedback-comment-rail') as HTMLElement).hidden).toBe(true);
    expect(document.activeElement).toBe(editor.view.dom);
  });

  it('removes comments body state and restores editor focus when deactivated from the rail', () => {
    const editor = createEditorFixture();
    const controller = createFeedbackReviewController({ editor, host });
    controller.activate({
      sessionId: 'session-1',
      source: 'docs/guide.md',
      sourceSha256: 'c'.repeat(64),
      round: 'round-1',
      items: [
        {
          id: 'F1',
          kind: 'text',
          startOrdinal: 1,
          endOrdinal: 1,
          startLine: 3,
          endLine: 3,
          focus: 'Alpha beta',
          feedback: 'Clarify this.',
        },
      ],
    });
    (document.querySelector('[data-feedback-marker]') as HTMLButtonElement).click();
    const card = document.querySelector('[data-feedback-card="F1"]') as HTMLElement;
    card.focus();
    expect(document.body.getAttribute('data-feedback-comments-state')).toBe('expanded');
    expect(document.activeElement).toBe(card);

    controller.deactivate();

    expect(document.body.getAttribute('data-feedback-comments-state')).toBeNull();
    expect(document.querySelector('.feedback-comment-rail')).toBeNull();
    expect(document.activeElement).toBe(editor.view.dom);
  });

  it('provides a control that collapses comment cards back to the rail', () => {
    const editor = createEditorFixture();
    const controller = createFeedbackReviewController({ editor, host });
    controller.activate({
      sessionId: 'session-1',
      source: 'docs/guide.md',
      sourceSha256: 'c'.repeat(64),
      round: 'round-1',
      items: [
        {
          id: 'F1',
          kind: 'text',
          startOrdinal: 1,
          endOrdinal: 1,
          startLine: 3,
          endLine: 3,
          focus: 'Alpha beta',
          feedback: 'Clarify this.',
        },
      ],
    });

    const rail = document.querySelector('.feedback-comment-rail') as HTMLElement;
    (document.querySelector('[data-feedback-marker]') as HTMLButtonElement).click();
    expect(rail.classList).toContain('expanded');

    const collapse = document.querySelector('[data-feedback-panel-collapse]') as HTMLButtonElement;
    expect(collapse).toBeTruthy();
    collapse.click();

    expect(rail.classList).not.toContain('expanded');
  });

  it('retains and re-enables a text composer when the host write fails', () => {
    const editor = createEditorFixture();
    const controller = createFeedbackReviewController({ editor, host });
    controller.activate({
      sessionId: 'session-1',
      source: 'docs/guide.md',
      sourceSha256: 'b'.repeat(64),
      round: 'round-1',
      items: [],
    });
    controller.openTextComposer({
      startOrdinal: 1,
      endOrdinal: 1,
      focus: 'Alpha beta',
      startLine: 3,
      endLine: 3,
    });

    const field = document.querySelector('[data-feedback-input]') as HTMLTextAreaElement;
    const submit = document.querySelector('[data-feedback-submit]') as HTMLButtonElement;
    field.value = 'Keep this feedback for Retry.';
    field.dispatchEvent(new Event('input', { bubbles: true }));
    submit.click();
    const request = (host.postMessage as jest.Mock).mock.calls
      .map(call => call[0])
      .find(message => message.type === 'feedback.text.add');

    expect(submit.disabled).toBe(true);
    controller.handleHostMessage({
      type: 'feedback.error',
      requestId: request.requestId,
      sessionId: controller.getSession()!.sessionId,
      message: 'Draft write failed.',
      recoverable: true,
    });

    expect(document.querySelector('[data-feedback-input]')).toBe(field);
    expect(field.value).toBe('Keep this feedback for Retry.');
    expect(submit.disabled).toBe(false);
  });

  it('keeps a comment visible and re-enables Delete when deletion fails', () => {
    const editor = createEditorFixture();
    const controller = createFeedbackReviewController({ editor, host });
    controller.activate({
      sessionId: 'session-1',
      source: 'docs/guide.md',
      sourceSha256: 'c'.repeat(64),
      round: 'round-1',
      items: [
        {
          id: 'F1',
          kind: 'text',
          startOrdinal: 1,
          endOrdinal: 1,
          startLine: 3,
          endLine: 3,
          focus: 'Alpha beta',
          feedback: 'Clarify this.',
        },
      ],
    });

    (document.querySelector('[data-feedback-marker]') as HTMLButtonElement).click();
    const card = document.querySelector('[data-feedback-card="F1"]') as HTMLElement;
    const remove = Array.from(card.querySelectorAll('button')).find(
      button => button.textContent === 'Delete'
    ) as HTMLButtonElement;
    remove.click();
    const request = (host.postMessage as jest.Mock).mock.calls
      .map(call => call[0])
      .find(message => message.type === 'feedback.item.delete');

    expect(document.querySelector('[data-feedback-card="F1"]')).toBe(card);
    expect(remove.disabled).toBe(true);
    expect(controller.getSession()?.items.map(item => item.id)).toEqual(['F1']);

    controller.handleHostMessage({
      type: 'feedback.error',
      requestId: request.requestId,
      sessionId: controller.getSession()!.sessionId,
      message: 'Delete failed.',
      recoverable: true,
    });

    expect(document.querySelector('[data-feedback-card="F1"]')).toBe(card);
    expect(remove.disabled).toBe(false);
    expect(document.querySelector('.feedback-undo-delete')).toBeNull();
  });

  it('keeps final-deletion Undo visibly reachable and focused until the next session', () => {
    const editor = createEditorFixture();
    const controller = createFeedbackReviewController({ editor, host });
    const firstItem = {
      id: 'F1',
      kind: 'text' as const,
      startOrdinal: 1,
      endOrdinal: 1,
      startLine: 3,
      endLine: 3,
      focus: 'Alpha beta',
      feedback: 'Clarify this.',
    };
    controller.activate({
      sessionId: 'session-1',
      source: 'docs/guide.md',
      sourceSha256: 'c'.repeat(64),
      round: 'round-1',
      items: [firstItem],
    });
    const rail = document.querySelector('.feedback-comment-rail') as HTMLElement;
    (document.querySelector('[data-feedback-marker]') as HTMLButtonElement).click();
    expect(rail.classList).toContain('expanded');
    const remove = Array.from(
      document.querySelector('[data-feedback-card="F1"]')!.querySelectorAll('button')
    ).find(button => button.textContent === 'Delete') as HTMLButtonElement;
    remove.click();
    const request = (host.postMessage as jest.Mock).mock.calls
      .map(call => call[0])
      .find(message => message.type === 'feedback.item.delete');
    controller.handleHostMessage({
      type: 'feedback.updated',
      requestId: request.requestId,
      sessionId: controller.getSession()!.sessionId,
      items: [],
    });
    const undo = document.querySelector('.feedback-undo-delete') as HTMLButtonElement;
    expect(undo.textContent).toContain('F1');
    expect(rail.hidden).toBe(false);
    expect(rail.classList).toContain('expanded');
    expect(document.body.getAttribute('data-feedback-comments-state')).toBe('expanded');
    expect(document.activeElement).toBe(undo);

    controller.deactivate();
    controller.activate({
      sessionId: 'session-2',
      source: 'docs/other.md',
      sourceSha256: 'd'.repeat(64),
      round: 'round-2',
      items: [],
    });

    expect(document.querySelector('.feedback-undo-delete')).toBeNull();
  });

  it('reopens a collapsed final-deletion Undo with one Comments activation', () => {
    const editor = createEditorFixture();
    const controller = createFeedbackReviewController({ editor, host });
    controller.activate({
      sessionId: 'session-1',
      source: 'docs/guide.md',
      sourceSha256: 'c'.repeat(64),
      round: 'round-1',
      items: [
        {
          id: 'F1',
          kind: 'text',
          startOrdinal: 1,
          endOrdinal: 1,
          startLine: 3,
          endLine: 3,
          focus: 'Alpha beta',
          feedback: 'Clarify this.',
        },
      ],
    });
    (document.querySelector('[data-feedback-marker]') as HTMLButtonElement).click();
    const remove = Array.from(
      document.querySelector('[data-feedback-card="F1"]')!.querySelectorAll('button')
    ).find(button => button.textContent === 'Delete') as HTMLButtonElement;
    remove.click();
    const request = (host.postMessage as jest.Mock).mock.calls
      .map(call => call[0])
      .find(message => message.type === 'feedback.item.delete');
    controller.handleHostMessage({
      type: 'feedback.updated',
      requestId: request.requestId,
      sessionId: controller.getSession()!.sessionId,
      items: [],
    });

    (document.querySelector('[data-feedback-panel-collapse]') as HTMLButtonElement).click();
    const rail = document.querySelector('.feedback-comment-rail') as HTMLElement;
    expect(rail.hidden).toBe(true);
    expect(document.body.getAttribute('data-feedback-comments-state')).toBe('hidden');

    controller.toggleComments();

    expect(rail.hidden).toBe(false);
    expect(rail.classList).toContain('expanded');
    expect(document.querySelector('[data-feedback-undo-id="F1"]')).not.toBeNull();
  });

  it('keeps Undo available for Retry when restoring a deletion fails', () => {
    const editor = createEditorFixture();
    const controller = createFeedbackReviewController({ editor, host });
    controller.activate({
      sessionId: 'session-1',
      source: 'docs/guide.md',
      sourceSha256: 'c'.repeat(64),
      round: 'round-1',
      items: [
        {
          id: 'F1',
          kind: 'text',
          startOrdinal: 1,
          endOrdinal: 1,
          startLine: 3,
          endLine: 3,
          focus: 'Alpha beta',
          feedback: 'Clarify this.',
        },
      ],
    });
    (document.querySelector('[data-feedback-marker]') as HTMLButtonElement).click();
    const remove = Array.from(
      document.querySelector('[data-feedback-card="F1"]')!.querySelectorAll('button')
    ).find(button => button.textContent === 'Delete') as HTMLButtonElement;
    remove.click();
    const deleteRequest = (host.postMessage as jest.Mock).mock.calls
      .map(call => call[0])
      .find(message => message.type === 'feedback.item.delete');
    controller.handleHostMessage({
      type: 'feedback.updated',
      requestId: deleteRequest.requestId,
      sessionId: controller.getSession()!.sessionId,
      items: [],
    });

    const undo = document.querySelector('.feedback-undo-delete') as HTMLButtonElement;
    undo.click();
    const restoreRequest = (host.postMessage as jest.Mock).mock.calls
      .map(call => call[0])
      .find(message => message.type === 'feedback.item.restore');
    controller.handleHostMessage({
      type: 'feedback.error',
      requestId: restoreRequest.requestId,
      sessionId: controller.getSession()!.sessionId,
      message: 'Restore failed.',
      recoverable: true,
    });

    expect(document.querySelector('.feedback-undo-delete')).toBe(undo);
    expect(undo.disabled).toBe(false);
  });

  it('returns a successfully restored comment to an active and focused stable target', () => {
    const editor = createEditorFixture();
    const controller = createFeedbackReviewController({ editor, host });
    const item = {
      id: 'F1',
      kind: 'text' as const,
      startOrdinal: 1,
      endOrdinal: 1,
      startLine: 3,
      endLine: 3,
      focus: 'Alpha beta',
      feedback: 'Clarify this.',
    };
    controller.activate({
      sessionId: 'session-1',
      source: 'docs/guide.md',
      sourceSha256: 'c'.repeat(64),
      round: 'round-1',
      items: [item],
    });
    (document.querySelector('[data-feedback-marker]') as HTMLButtonElement).click();
    const remove = Array.from(
      document.querySelector('[data-feedback-card="F1"]')!.querySelectorAll('button')
    ).find(button => button.textContent === 'Delete') as HTMLButtonElement;
    remove.click();
    const deleteRequest = (host.postMessage as jest.Mock).mock.calls
      .map(call => call[0])
      .find(message => message.type === 'feedback.item.delete');
    controller.handleHostMessage({
      type: 'feedback.updated',
      requestId: deleteRequest.requestId,
      sessionId: controller.getSession()!.sessionId,
      items: [],
    });
    (document.querySelector('.feedback-undo-delete') as HTMLButtonElement).click();
    const restoreRequest = (host.postMessage as jest.Mock).mock.calls
      .map(call => call[0])
      .find(message => message.type === 'feedback.item.restore');

    controller.handleHostMessage({
      type: 'feedback.updated',
      requestId: restoreRequest.requestId,
      sessionId: controller.getSession()!.sessionId,
      items: [item],
    });

    const marker = document.querySelector('[data-feedback-marker]') as HTMLButtonElement;
    const restoredCard = document.querySelector('[data-feedback-card="F1"]') as HTMLElement;
    expect(marker.classList).toContain('active');
    expect(marker.getAttribute('aria-expanded')).toBe('true');
    expect(restoredCard).not.toBeNull();
    expect(document.querySelector('.feedback-undo-delete')).toBeNull();
    expect(document.querySelector('.feedback-comment-rail')?.classList).toContain('expanded');
    expect(document.activeElement === restoredCard || document.activeElement === marker).toBe(true);
  });

  it('focuses the matching Undo when the newest deletion leaves multiple Undo choices', () => {
    const editor = createEditorFixture();
    const controller = createFeedbackReviewController({ editor, host });
    const first = {
      id: 'F1',
      kind: 'text' as const,
      startOrdinal: 0,
      endOrdinal: 0,
      startLine: 1,
      endLine: 1,
      focus: 'Title',
      feedback: 'First note.',
    };
    const second = {
      id: 'F2',
      kind: 'text' as const,
      startOrdinal: 3,
      endOrdinal: 3,
      startLine: 8,
      endLine: 9,
      focus: 'Quote',
      feedback: 'Second note.',
    };
    controller.activate({
      sessionId: 'session-1',
      source: 'docs/guide.md',
      sourceSha256: 'c'.repeat(64),
      round: 'round-1',
      items: [first, second],
    });
    const firstMarker = Array.from(
      document.querySelectorAll<HTMLButtonElement>('[data-feedback-marker]')
    ).find(marker => marker.dataset.feedbackIds === 'F1')!;
    firstMarker.click();
    const firstDelete = Array.from(
      document.querySelector('[data-feedback-card="F1"]')!.querySelectorAll('button')
    ).find(button => button.textContent === 'Delete') as HTMLButtonElement;
    firstDelete.click();
    const firstRequest = (host.postMessage as jest.Mock).mock.calls
      .map(call => call[0])
      .find(message => message.type === 'feedback.item.delete' && message.id === 'F1');
    controller.handleHostMessage({
      type: 'feedback.updated',
      requestId: firstRequest.requestId,
      sessionId: controller.getSession()!.sessionId,
      items: [second],
    });

    (document.querySelector('[data-feedback-card="F2"]') as HTMLElement).click();
    const secondDelete = Array.from(
      document.querySelector('[data-feedback-card="F2"]')!.querySelectorAll('button')
    ).find(button => button.textContent === 'Delete') as HTMLButtonElement;
    secondDelete.click();
    const secondRequest = (host.postMessage as jest.Mock).mock.calls
      .map(call => call[0])
      .find(message => message.type === 'feedback.item.delete' && message.id === 'F2');
    controller.handleHostMessage({
      type: 'feedback.updated',
      requestId: secondRequest.requestId,
      sessionId: controller.getSession()!.sessionId,
      items: [],
    });

    const undoButtons = Array.from(
      document.querySelectorAll<HTMLButtonElement>('.feedback-undo-delete')
    );
    const firstUndo = undoButtons.find(button => button.textContent?.includes('F1'))!;
    const secondUndo = undoButtons.find(button => button.textContent?.includes('F2'))!;
    expect(firstUndo).not.toBe(secondUndo);
    expect(document.querySelector('.feedback-comment-rail')?.classList).toContain('expanded');
    expect(document.activeElement).toBe(secondUndo);
  });

  it('offers a keyboard block-range picker when no text selection is available', () => {
    const editor = createEditorFixture();
    const controller = createFeedbackReviewController({ editor, host });
    controller.activate({
      sessionId: 'session-1',
      source: 'docs/guide.md',
      sourceSha256: 'b'.repeat(64),
      round: 'round-1',
      anchors: [
        { ordinal: 0, startLine: 1, endLine: 1 },
        { ordinal: 1, startLine: 3, endLine: 3 },
      ],
      items: [],
    });

    expect(controller.commentOnSelection()).toBe(true);
    const picker = document.querySelector<HTMLFormElement>('[data-feedback-text-block-selector]');
    expect(picker).not.toBeNull();
    picker?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

    expect(document.querySelector('[data-feedback-target-label]')?.textContent).toBe(
      'Selected blocks'
    );
    expect(document.querySelector('[data-feedback-target-detail]')?.textContent).toBe(
      '2 blocks · heading to paragraph'
    );
    expect(document.querySelector('[data-feedback-focus]')).toBeNull();
    expect(document.querySelector('[data-feedback-lines]')?.textContent).toContain('1-3');
  });

  it('refuses to finish while the keyboard block-range selector is open', () => {
    const confirmFinish = jest.spyOn(window, 'confirm').mockReturnValue(true);
    try {
      const editor = createEditorFixture();
      const controller = createFeedbackReviewController({ editor, host });
      controller.activate({
        sessionId: 'session-1',
        source: 'docs/guide.md',
        sourceSha256: 'b'.repeat(64),
        round: 'round-1',
        anchors: [
          { ordinal: 0, startLine: 1, endLine: 1 },
          { ordinal: 1, startLine: 3, endLine: 3 },
        ],
        items: [],
      });
      expect(controller.commentOnSelection()).toBe(true);
      const selector = document.querySelector(
        '[data-feedback-text-block-selector]'
      ) as HTMLFormElement;
      const firstBlock = selector.querySelector('select') as HTMLSelectElement;
      expect(document.activeElement).toBe(firstBlock);

      controller.finish();

      expect(confirmFinish).not.toHaveBeenCalled();
      expect(
        (host.postMessage as jest.Mock).mock.calls.some(call => call[0].type === 'feedback.finish')
      ).toBe(false);
      expect(document.querySelector('[data-feedback-completion-dialog]')).toBeNull();
      expect(document.querySelector('[data-feedback-text-block-selector]')).toBe(selector);
      expect(document.activeElement).toBe(firstBlock);
    } finally {
      confirmFinish.mockRestore();
    }
  });

  it('keeps one keyboard block selector and its original return focus when invoked twice', () => {
    const editor = createEditorFixture();
    const controller = createFeedbackReviewController({ editor, host });
    controller.activate({
      sessionId: 'session-1',
      source: 'docs/guide.md',
      sourceSha256: 'b'.repeat(64),
      round: 'round-1',
      anchors: [
        { ordinal: 0, startLine: 1, endLine: 1 },
        { ordinal: 1, startLine: 3, endLine: 3 },
      ],
      items: [],
    });
    editor.view.dom.focus();
    expect(controller.commentOnSelection()).toBe(true);
    const originalSelector = document.querySelector(
      '[data-feedback-text-block-selector]'
    ) as HTMLFormElement;

    expect(controller.commentOnSelection()).toBe(true);

    expect(document.querySelector('[data-feedback-text-block-selector]')).toBe(originalSelector);
    expect(document.querySelectorAll('[data-feedback-text-block-selector]')).toHaveLength(1);
    const cancel = Array.from(originalSelector.querySelectorAll('button')).find(
      button => button.textContent === 'Cancel'
    ) as HTMLButtonElement;
    cancel.click();
    expect(document.activeElement).toBe(editor.view.dom);
  });

  it('keeps the text block selector focused instead of opening a capture block selector', () => {
    const editor = createEditorFixture();
    const controller = createFeedbackReviewController({ editor, host });
    controller.activate({
      sessionId: 'session-1',
      source: 'docs/guide.md',
      sourceSha256: 'b'.repeat(64),
      round: 'round-1',
      anchors: [
        { ordinal: 0, startLine: 1, endLine: 1 },
        { ordinal: 1, startLine: 3, endLine: 3 },
      ],
      items: [],
    });
    expect(controller.commentOnSelection()).toBe(true);
    const textSelector = document.querySelector(
      '[data-feedback-text-block-selector]'
    ) as HTMLFormElement;
    const firstSelect = textSelector.querySelector('select') as HTMLSelectElement;

    captureSelectedFeedbackBlocks({ editor, review: controller, rasterize: jest.fn() });

    expect(document.querySelectorAll('.feedback-block-selector')).toHaveLength(1);
    expect(document.querySelector('[data-feedback-text-block-selector]')).toBe(textSelector);
    expect(document.activeElement).toBe(firstSelect);
    controller.deactivate();
  });

  it('removes the keyboard block-range selector and restores editor focus on deactivate', () => {
    const editor = createEditorFixture();
    const controller = createFeedbackReviewController({ editor, host });
    controller.activate({
      sessionId: 'session-1',
      source: 'docs/guide.md',
      sourceSha256: 'b'.repeat(64),
      round: 'round-1',
      anchors: [
        { ordinal: 0, startLine: 1, endLine: 1 },
        { ordinal: 1, startLine: 3, endLine: 3 },
      ],
      items: [],
    });
    expect(controller.commentOnSelection()).toBe(true);
    const selector = document.querySelector(
      '[data-feedback-text-block-selector]'
    ) as HTMLFormElement;
    expect(selector).not.toBeNull();
    expect(selector.contains(document.activeElement)).toBe(true);

    controller.deactivate();

    expect(document.querySelector('[data-feedback-text-block-selector]')).toBeNull();
    expect(document.activeElement).toBe(editor.view.dom);
  });

  it('renders stable markers in document order and clusters overlapping targets', () => {
    const editor = createEditorFixture();
    const controller = createFeedbackReviewController({ editor, host });
    controller.activate({
      sessionId: 'session-1',
      source: 'docs/guide.md',
      sourceSha256: 'c'.repeat(64),
      round: 'round-1',
      items: [
        {
          id: 'F3',
          kind: 'text',
          startOrdinal: 2,
          endOrdinal: 2,
          startLine: 8,
          endLine: 9,
          focus: 'Blank paragraph',
          feedback: 'Third note.',
        },
        {
          id: 'F1',
          kind: 'text',
          startOrdinal: 0,
          endOrdinal: 1,
          startLine: 1,
          endLine: 3,
          focus: 'Title and introduction',
          feedback: 'First note.',
        },
        {
          id: 'F2',
          kind: 'screenshot',
          startOrdinal: 0,
          endOrdinal: 1,
          startLine: 1,
          endLine: 3,
          feedback: 'Screenshot note.',
          imageUri: 'vscode-webview://feedback/F2.png?revision=1',
        },
      ],
    });

    const markers = Array.from(document.querySelectorAll('[data-feedback-marker]'));
    expect(markers).toHaveLength(2);
    expect(markers[0].getAttribute('data-feedback-ids')).toBe('F1,F2');
    expect(markers[0].textContent).toContain('2');
    expect(markers[0].getAttribute('aria-label')).toContain(
      'F1, lines 1-3, Title and introduction'
    );
    expect(markers[0].getAttribute('aria-label')).toContain('F2, lines 1-3, screenshot');
    expect(markers[1].getAttribute('data-feedback-ids')).toBe('F3');
  });

  it('reconciles marker clusters when exact decorations split a shared block target', () => {
    const queuedFrames: FrameRequestCallback[] = [];
    const requestFrame = jest
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation(callback => {
        queuedFrames.push(callback);
        return queuedFrames.length;
      });
    const editor = createEditorFixture();
    const controller = createFeedbackReviewController({ editor, host });
    controller.activate({
      sessionId: 'session-1',
      source: 'docs/guide.md',
      sourceSha256: 'c'.repeat(64),
      round: 'round-1',
      items: [
        {
          id: 'F1',
          kind: 'text',
          startOrdinal: 1,
          endOrdinal: 1,
          startLine: 3,
          endLine: 3,
          focus: 'Alpha beta',
          feedback: 'First note.',
        },
        {
          id: 'F2',
          kind: 'text',
          startOrdinal: 1,
          endOrdinal: 1,
          startLine: 3,
          endLine: 3,
          focus: 'Alpha beta',
          feedback: 'Second note.',
        },
      ],
    });
    expect(document.querySelectorAll('[data-feedback-marker]')).toHaveLength(1);
    const paragraph = editor.view.dom.children[1];
    const first = document.createElement('span');
    const second = document.createElement('span');
    first.className = 'md4h-feedback-annotation md4h-feedback-annotation-inline';
    second.className = 'md4h-feedback-annotation md4h-feedback-annotation-inline';
    first.dataset.feedbackIds = 'F1';
    second.dataset.feedbackIds = 'F2';
    first.getBoundingClientRect = () =>
      ({ top: 100, bottom: 112, left: 20, right: 80, width: 60, height: 12 }) as DOMRect;
    second.getBoundingClientRect = () =>
      ({ top: 200, bottom: 212, left: 20, right: 80, width: 60, height: 12 }) as DOMRect;
    paragraph.append(first, second);

    window.dispatchEvent(new Event('resize'));
    while (queuedFrames.length > 0) queuedFrames.shift()?.(0);

    expect(
      Array.from(document.querySelectorAll<HTMLElement>('[data-feedback-marker]')).map(
        marker => marker.dataset.feedbackIds
      )
    ).toEqual(['F1', 'F2']);
    requestFrame.mockRestore();
  });

  it('keeps proximity-cluster disclosure synchronized when a compact sibling activates', () => {
    const editor = createEditorFixture();
    const first = editor.view.dom.children[0] as HTMLElement;
    const second = editor.view.dom.children[1] as HTMLElement;
    jest.spyOn(first, 'getBoundingClientRect').mockReturnValue({
      top: 100,
      bottom: 112,
      left: 20,
      right: 600,
      width: 580,
      height: 12,
      x: 20,
      y: 100,
      toJSON: () => ({}),
    } as DOMRect);
    jest.spyOn(second, 'getBoundingClientRect').mockReturnValue({
      top: 116,
      bottom: 128,
      left: 20,
      right: 600,
      width: 580,
      height: 12,
      x: 20,
      y: 116,
      toJSON: () => ({}),
    } as DOMRect);
    const controller = createFeedbackReviewController({ editor, host });
    controller.activate({
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
          focus: 'Title',
          feedback: 'First note.',
        },
        {
          id: 'F2',
          kind: 'text',
          startOrdinal: 1,
          endOrdinal: 1,
          startLine: 3,
          endLine: 3,
          focus: 'Alpha beta',
          feedback: 'Second note.',
        },
      ],
    });
    const marker = document.querySelector(
      '[data-feedback-marker][data-feedback-ids="F1,F2"]'
    ) as HTMLButtonElement;
    marker.click();

    (document.querySelector('[data-feedback-card="F2"]') as HTMLElement).click();

    const refreshedMarker = document.querySelector(
      '[data-feedback-marker][data-feedback-ids="F1,F2"]'
    ) as HTMLButtonElement;
    expect(refreshedMarker.getAttribute('aria-expanded')).toBe('true');
    expect(
      document.querySelector('[data-feedback-card="F2"]')?.getAttribute('data-feedback-card-state')
    ).toBe('active');
  });

  it('repositions a cluster whose Feedback IDs are reversed from document order', () => {
    const queuedFrames: FrameRequestCallback[] = [];
    const requestFrame = jest
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation(callback => {
        queuedFrames.push(callback);
        return queuedFrames.length;
      });
    const editor = createEditorFixture();
    let upperTop = 100;
    let lowerTop = 116;
    jest.spyOn(editor.view.dom.children[0], 'getBoundingClientRect').mockImplementation(
      () =>
        ({
          top: upperTop,
          bottom: upperTop + 12,
          left: 20,
          right: 600,
          width: 580,
          height: 12,
          x: 20,
          y: upperTop,
          toJSON: () => ({}),
        }) as DOMRect
    );
    jest.spyOn(editor.view.dom.children[1], 'getBoundingClientRect').mockImplementation(
      () =>
        ({
          top: lowerTop,
          bottom: lowerTop + 12,
          left: 20,
          right: 600,
          width: 580,
          height: 12,
          x: 20,
          y: lowerTop,
          toJSON: () => ({}),
        }) as DOMRect
    );
    const controller = createFeedbackReviewController({ editor, host });
    controller.activate({
      sessionId: 'session-1',
      source: 'docs/guide.md',
      sourceSha256: 'c'.repeat(64),
      round: 'round-1',
      items: [
        {
          id: 'F1',
          kind: 'text',
          startOrdinal: 1,
          endOrdinal: 1,
          startLine: 3,
          endLine: 3,
          focus: 'Alpha beta',
          feedback: 'First note.',
        },
        {
          id: 'F2',
          kind: 'text',
          startOrdinal: 0,
          endOrdinal: 0,
          startLine: 1,
          endLine: 1,
          focus: 'Title',
          feedback: 'Second note.',
        },
      ],
    });
    const marker = document.querySelector(
      '[data-feedback-marker][data-feedback-ids="F1,F2"]'
    ) as HTMLElement;
    expect(Number.parseFloat(marker.style.top)).toBeCloseTo(114, 4);
    upperTop = 200;
    lowerTop = 216;

    window.dispatchEvent(new Event('resize'));
    while (queuedFrames.length > 0) queuedFrames.shift()?.(0);

    expect(Number.parseFloat(marker.style.top)).toBeCloseTo(214, 4);
    requestFrame.mockRestore();
  });

  it('mounts annotations beside ProseMirror in the document scroll coordinate space', () => {
    const editor = createEditorFixture();
    const editorContainer = document.querySelector('#editor') as HTMLElement;
    const containerRect = {
      top: 100,
      bottom: 900,
      left: 0,
      right: 800,
      width: 800,
      height: 800,
      x: 0,
      y: 100,
      toJSON: () => ({}),
    } as DOMRect;
    const targetRect = {
      top: 220,
      bottom: 260,
      left: 40,
      right: 700,
      width: 660,
      height: 40,
      x: 40,
      y: 220,
      toJSON: () => ({}),
    } as DOMRect;
    jest.spyOn(editorContainer, 'getBoundingClientRect').mockReturnValue(containerRect);
    jest.spyOn(editor.view.dom.children[1], 'getBoundingClientRect').mockReturnValue(targetRect);
    const controller = createFeedbackReviewController({ editor, host });

    controller.activate({
      sessionId: 'session-1',
      source: 'docs/guide.md',
      sourceSha256: 'c'.repeat(64),
      round: 'round-1',
      items: [
        {
          id: 'F1',
          kind: 'text',
          startOrdinal: 1,
          endOrdinal: 1,
          startLine: 3,
          endLine: 3,
          focus: 'Alpha beta',
          feedback: 'Clarify this.',
        },
      ],
    });

    const layer = document.querySelector('[data-feedback-annotation-layer]') as HTMLElement;
    const marker = document.querySelector('[data-feedback-marker]') as HTMLElement;
    expect(layer).not.toBeNull();
    expect(layer.parentElement).toBe(editorContainer);
    expect(editor.view.dom.contains(layer)).toBe(false);
    expect(marker.closest('[data-feedback-annotation-layer]')).toBe(layer);
    expect(Number.parseFloat(marker.style.top)).toBeCloseTo(140, 4);
  });

  it('draws one continuous sibling-layer bracket across a multi-block fallback target', () => {
    const editor = createEditorFixture();
    const editorContainer = document.querySelector('#editor') as HTMLElement;
    jest.spyOn(editorContainer, 'getBoundingClientRect').mockReturnValue({
      top: 40,
      bottom: 840,
      left: 20,
      right: 820,
      width: 800,
      height: 800,
      x: 20,
      y: 40,
      toJSON: () => ({}),
    } as DOMRect);
    jest.spyOn(editor.view.dom.children[0], 'getBoundingClientRect').mockReturnValue({
      top: 100,
      bottom: 130,
      left: 80,
      right: 700,
      width: 620,
      height: 30,
      x: 80,
      y: 100,
      toJSON: () => ({}),
    } as DOMRect);
    jest.spyOn(editor.view.dom.children[3], 'getBoundingClientRect').mockReturnValue({
      top: 330,
      bottom: 370,
      left: 64,
      right: 700,
      width: 636,
      height: 40,
      x: 64,
      y: 330,
      toJSON: () => ({}),
    } as DOMRect);
    const controller = createFeedbackReviewController({ editor, host });

    controller.activate({
      sessionId: 'session-1',
      source: 'docs/guide.md',
      sourceSha256: 'c'.repeat(64),
      round: 'round-1',
      items: [
        {
          id: 'F1',
          kind: 'screenshot',
          startOrdinal: 0,
          endOrdinal: 3,
          startLine: 1,
          endLine: 9,
          feedback: 'Clarify this section.',
          imageUri: 'vscode-webview://feedback/F1.png?revision=1',
        },
      ],
    });

    const layer = document.querySelector('[data-feedback-annotation-layer]') as HTMLElement;
    const bracket = document.querySelector('[data-feedback-target-bracket="F1"]') as HTMLElement;
    expect(bracket.parentElement?.parentElement).toBe(layer);
    expect(editor.view.dom.contains(bracket)).toBe(false);
    expect(bracket.getAttribute('aria-hidden')).toBe('true');
    expect(bracket.hasAttribute('aria-controls')).toBe(false);
    expect(Number.parseFloat(bracket.style.top)).toBeCloseTo(60, 4);
    expect(Number.parseFloat(bracket.style.height)).toBeCloseTo(270, 4);
    expect(Number.parseFloat(bracket.style.left)).toBeCloseTo(32, 4);

    (document.querySelector('[data-feedback-marker]') as HTMLButtonElement).click();

    expect(bracket.classList).toContain('active');
  });

  it('updates fallback bracket geometry on layout and retains its last valid position', () => {
    const queuedFrames: FrameRequestCallback[] = [];
    const requestFrame = jest
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation(callback => {
        queuedFrames.push(callback);
        return queuedFrames.length;
      });
    const editor = createEditorFixture();
    let measurable = true;
    let firstTop = 100;
    let lastBottom = 300;
    let proseLeft = 48;
    const rectFor = (first: boolean): DOMRect => {
      if (!measurable) {
        return {
          top: 0,
          bottom: 0,
          left: 0,
          right: 0,
          width: 0,
          height: 0,
          x: 0,
          y: 0,
          toJSON: () => ({}),
        } as DOMRect;
      }
      const top = first ? firstTop : lastBottom - 40;
      const bottom = first ? firstTop + 32 : lastBottom;
      return {
        top,
        bottom,
        left: proseLeft,
        right: 700,
        width: 700 - proseLeft,
        height: bottom - top,
        x: proseLeft,
        y: top,
        toJSON: () => ({}),
      } as DOMRect;
    };
    jest
      .spyOn(editor.view.dom.children[0], 'getBoundingClientRect')
      .mockImplementation(() => rectFor(true));
    jest
      .spyOn(editor.view.dom.children[3], 'getBoundingClientRect')
      .mockImplementation(() => rectFor(false));
    const controller = createFeedbackReviewController({ editor, host });
    controller.activate({
      sessionId: 'session-1',
      source: 'docs/guide.md',
      sourceSha256: 'c'.repeat(64),
      round: 'round-1',
      items: [
        {
          id: 'F1',
          kind: 'screenshot',
          startOrdinal: 0,
          endOrdinal: 3,
          startLine: 1,
          endLine: 9,
          feedback: 'Clarify this section.',
          imageUri: 'vscode-webview://feedback/F1.png?revision=1',
        },
      ],
    });
    const bracket = document.querySelector('[data-feedback-target-bracket="F1"]') as HTMLElement;
    firstTop = 160;
    lastBottom = 420;
    proseLeft = 72;

    window.dispatchEvent(new Event('resize'));
    while (queuedFrames.length > 0) queuedFrames.shift()?.(0);

    expect(bracket.style.top).toBe('160px');
    expect(bracket.style.height).toBe('260px');
    expect(bracket.style.left).toBe('60px');
    const lastValidStyle = {
      top: bracket.style.top,
      height: bracket.style.height,
      left: bracket.style.left,
    };
    measurable = false;

    window.dispatchEvent(new Event('resize'));
    while (queuedFrames.length > 0) queuedFrames.shift()?.(0);

    expect({
      top: bracket.style.top,
      height: bracket.style.height,
      left: bracket.style.left,
    }).toEqual(lastValidStyle);
    expect(document.querySelector('[data-feedback-layout-alert]')?.textContent).toContain(
      'last measured position'
    );
    requestFrame.mockRestore();
  });

  it('suppresses fallback brackets while hidden or capturing and does no scroll-time work', () => {
    const queuedFrames: FrameRequestCallback[] = [];
    const requestFrame = jest
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation(callback => {
        queuedFrames.push(callback);
        return queuedFrames.length;
      });
    const editor = createEditorFixture();
    const firstRect = jest.spyOn(editor.view.dom.children[0], 'getBoundingClientRect');
    const lastRect = jest.spyOn(editor.view.dom.children[3], 'getBoundingClientRect');
    const controller = createFeedbackReviewController({ editor, host });
    controller.activate({
      sessionId: 'session-1',
      source: 'docs/guide.md',
      sourceSha256: 'c'.repeat(64),
      round: 'round-1',
      items: [
        {
          id: 'F1',
          kind: 'text',
          startOrdinal: 0,
          endOrdinal: 3,
          startLine: 1,
          endLine: 9,
          focus: 'Legacy block focus',
          feedback: 'Clarify this section.',
        },
      ],
    });
    while (queuedFrames.length > 0) queuedFrames.shift()?.(0);
    requestFrame.mockClear();
    firstRect.mockClear();
    lastRect.mockClear();
    const bracketLayer = document.querySelector(
      '[data-feedback-target-bracket-layer]'
    ) as HTMLElement;

    window.dispatchEvent(new Event('scroll'));

    expect(requestFrame).not.toHaveBeenCalled();
    expect(firstRect).not.toHaveBeenCalled();
    expect(lastRect).not.toHaveBeenCalled();

    controller.toggleComments(false);
    expect(bracketLayer.hidden).toBe(true);
    controller.toggleComments(true);
    expect(bracketLayer.hidden).toBe(false);
    controller.setAnnotationsSuspended(true);
    expect(bracketLayer.hidden).toBe(true);
    controller.setAnnotationsSuspended(false);
    expect(bracketLayer.hidden).toBe(false);

    controller.deactivate();
    expect(document.querySelector('[data-feedback-target-bracket-layer]')).toBeNull();
    requestFrame.mockRestore();
  });

  it('does not fabricate positions when every target measurement is unavailable', () => {
    const editor = createEditorFixture();
    jest.spyOn(editor.view.dom.children[1], 'getBoundingClientRect').mockReturnValue({
      top: 0,
      bottom: 0,
      left: 0,
      right: 0,
      width: 0,
      height: 0,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect);
    const controller = createFeedbackReviewController({ editor, host });

    controller.activate({
      sessionId: 'session-1',
      source: 'docs/guide.md',
      sourceSha256: 'c'.repeat(64),
      round: 'round-1',
      items: [
        {
          id: 'F1',
          kind: 'text',
          startOrdinal: 1,
          endOrdinal: 1,
          startLine: 3,
          endLine: 3,
          focus: 'Alpha beta',
          feedback: 'Clarify this.',
        },
      ],
    });

    expect(document.querySelector('[data-feedback-marker]')).toBeNull();
    expect(document.querySelector('[data-feedback-card="F1"]')).not.toBeNull();
    const alert = document.querySelector('[data-feedback-layout-alert]') as HTMLElement;
    expect(alert.getAttribute('role')).toBe('alert');
    expect(alert.textContent).toContain('F1');
    expect(alert.textContent).toContain('not currently measurable');
    expect(alert.querySelector('[data-feedback-layout-retry]')).not.toBeNull();
    const open = alert.querySelector('[data-feedback-layout-open="F1"]') as HTMLButtonElement;
    expect(open.getAttribute('aria-label')).toBe('Open feedback F1 without a positioned marker');

    open.click();

    expect(document.querySelector('.feedback-comment-rail')?.classList).toContain('expanded');
    const card = document.querySelector('[data-feedback-card="F1"]') as HTMLElement;
    expect(card.dataset.feedbackCardState).toBe('active');
    expect(document.activeElement).toBe(card);
  });

  it('retains an item at its last valid target geometry when a later measurement fails', () => {
    const queuedFrames: FrameRequestCallback[] = [];
    const requestFrame = jest
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation(callback => {
        queuedFrames.push(callback);
        return queuedFrames.length;
      });
    const editor = createEditorFixture();
    let secondTargetAvailable = true;
    jest.spyOn(editor.view.dom.children[0], 'getBoundingClientRect').mockReturnValue({
      top: 100,
      bottom: 140,
      left: 32,
      right: 720,
      width: 688,
      height: 40,
      x: 32,
      y: 100,
      toJSON: () => ({}),
    } as DOMRect);
    jest.spyOn(editor.view.dom.children[1], 'getBoundingClientRect').mockImplementation(() => {
      if (!secondTargetAvailable) {
        return {
          top: 0,
          bottom: 0,
          left: 0,
          right: 0,
          width: 0,
          height: 0,
          x: 0,
          y: 0,
          toJSON: () => ({}),
        } as DOMRect;
      }
      return {
        top: 300,
        bottom: 340,
        left: 32,
        right: 720,
        width: 688,
        height: 40,
        x: 32,
        y: 300,
        toJSON: () => ({}),
      } as DOMRect;
    });
    const controller = createFeedbackReviewController({ editor, host });
    controller.activate({
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
          focus: 'Title',
          feedback: 'First note.',
        },
        {
          id: 'F2',
          kind: 'text',
          startOrdinal: 1,
          endOrdinal: 1,
          startLine: 3,
          endLine: 3,
          focus: 'Alpha beta',
          feedback: 'Second note.',
        },
      ],
    });
    const marker = document.querySelector(
      '[data-feedback-marker][data-feedback-ids="F2"]'
    ) as HTMLElement;
    const originalTop = marker.style.top;
    secondTargetAvailable = false;

    window.dispatchEvent(new Event('resize'));
    while (queuedFrames.length > 0) queuedFrames.shift()?.(0);

    expect(
      (document.querySelector('[data-feedback-marker][data-feedback-ids="F2"]') as HTMLElement)
        .style.top
    ).toBe(originalTop);
    expect(document.querySelector('[data-feedback-layout-alert]')?.textContent).toContain(
      'last measured position'
    );
    requestFrame.mockRestore();
  });

  it('retains the last measured card geometry when a visible card temporarily cannot be measured', () => {
    const queuedFrames: FrameRequestCallback[] = [];
    const requestFrame = jest
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation(callback => {
        queuedFrames.push(callback);
        return queuedFrames.length;
      });
    let cardAvailable = true;
    const cardRect = jest
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockImplementation(function (this: HTMLElement) {
        const height = this.hasAttribute('data-feedback-card') && cardAvailable ? 120 : 0;
        return {
          top: 0,
          bottom: height,
          left: 0,
          right: 0,
          width: 0,
          height,
          x: 0,
          y: 0,
          toJSON: () => ({}),
        } as DOMRect;
      });
    try {
      const editor = createEditorFixture();
      const controller = createFeedbackReviewController({ editor, host });
      controller.activate({
        sessionId: 'session-1',
        source: 'docs/guide.md',
        sourceSha256: 'c'.repeat(64),
        round: 'round-1',
        items: [
          {
            id: 'F1',
            kind: 'text',
            startOrdinal: 1,
            endOrdinal: 1,
            startLine: 3,
            endLine: 3,
            focus: 'Alpha beta',
            feedback: 'Clarify this.',
          },
        ],
      });
      (document.querySelector('[data-feedback-marker]') as HTMLButtonElement).click();
      const originalTop = (document.querySelector('[data-feedback-card="F1"]') as HTMLElement).style
        .top;
      cardAvailable = false;

      window.dispatchEvent(new Event('resize'));
      while (queuedFrames.length > 0) queuedFrames.shift()?.(0);

      expect((document.querySelector('[data-feedback-card="F1"]') as HTMLElement).style.top).toBe(
        originalTop
      );
      expect(document.querySelector('[data-feedback-layout-alert]')?.textContent).toContain(
        'last measured position'
      );
    } finally {
      cardRect.mockRestore();
      requestFrame.mockRestore();
    }
  });

  it('retries failed geometry and restores markers when the target becomes measurable', () => {
    const editor = createEditorFixture();
    let targetAvailable = false;
    jest.spyOn(editor.view.dom.children[1], 'getBoundingClientRect').mockImplementation(() => {
      if (!targetAvailable) {
        return {
          top: 0,
          bottom: 0,
          left: 0,
          right: 0,
          width: 0,
          height: 0,
          x: 0,
          y: 0,
          toJSON: () => ({}),
        } as DOMRect;
      }
      return {
        top: 240,
        bottom: 280,
        left: 32,
        right: 720,
        width: 688,
        height: 40,
        x: 32,
        y: 240,
        toJSON: () => ({}),
      } as DOMRect;
    });
    const controller = createFeedbackReviewController({ editor, host });
    controller.activate({
      sessionId: 'session-1',
      source: 'docs/guide.md',
      sourceSha256: 'c'.repeat(64),
      round: 'round-1',
      items: [
        {
          id: 'F1',
          kind: 'text',
          startOrdinal: 1,
          endOrdinal: 1,
          startLine: 3,
          endLine: 3,
          focus: 'Alpha beta',
          feedback: 'First note.',
        },
      ],
    });
    targetAvailable = true;

    (document.querySelector('[data-feedback-layout-retry]') as HTMLButtonElement).click();

    const marker = document.querySelector('[data-feedback-marker]') as HTMLElement;
    expect(Number.parseFloat(marker.style.top)).toBeCloseTo(260, 4);
    expect(document.querySelector('[data-feedback-layout-alert]')).toBeNull();
    expect(document.activeElement).toBe(marker);
  });

  it('performs no annotation measurement or animation scheduling during document scroll', () => {
    const originalRequestAnimationFrame = window.requestAnimationFrame;
    const queuedFrames: FrameRequestCallback[] = [];
    const requestFrame = jest.fn((callback: FrameRequestCallback) => {
      queuedFrames.push(callback);
      return queuedFrames.length;
    });
    Object.defineProperty(window, 'requestAnimationFrame', {
      configurable: true,
      writable: true,
      value: requestFrame,
    });
    const editor = createEditorFixture();
    const targetRect = jest
      .spyOn(editor.view.dom.children[1], 'getBoundingClientRect')
      .mockReturnValue({
        top: 220,
        bottom: 260,
        left: 40,
        right: 700,
        width: 660,
        height: 40,
        x: 40,
        y: 220,
        toJSON: () => ({}),
      } as DOMRect);
    const controller = createFeedbackReviewController({ editor, host });
    controller.activate({
      sessionId: 'session-1',
      source: 'docs/guide.md',
      sourceSha256: 'c'.repeat(64),
      round: 'round-1',
      items: [
        {
          id: 'F1',
          kind: 'text',
          startOrdinal: 1,
          endOrdinal: 1,
          startLine: 3,
          endLine: 3,
          focus: 'Alpha beta',
          feedback: 'Clarify this.',
        },
      ],
    });
    while (queuedFrames.length > 0) {
      queuedFrames.shift()?.(0);
    }
    requestFrame.mockClear();
    targetRect.mockClear();

    window.dispatchEvent(new Event('scroll'));

    expect(requestFrame).not.toHaveBeenCalled();
    expect(targetRect).not.toHaveBeenCalled();
    controller.deactivate();
    Object.defineProperty(window, 'requestAnimationFrame', {
      configurable: true,
      writable: true,
      value: originalRequestAnimationFrame,
    });
  });

  it('schedules one fresh layout when document fonts finish loading', async () => {
    const originalRequestAnimationFrame = window.requestAnimationFrame;
    const originalFonts = Object.getOwnPropertyDescriptor(document, 'fonts');
    const queuedFrames: FrameRequestCallback[] = [];
    const requestFrame = jest.fn((callback: FrameRequestCallback) => {
      queuedFrames.push(callback);
      return queuedFrames.length;
    });
    let resolveFonts!: () => void;
    Object.defineProperty(window, 'requestAnimationFrame', {
      configurable: true,
      writable: true,
      value: requestFrame,
    });
    Object.defineProperty(document, 'fonts', {
      configurable: true,
      value: { ready: new Promise<void>(resolve => (resolveFonts = resolve)) },
    });
    const editor = createEditorFixture();
    const controller = createFeedbackReviewController({ editor, host });
    controller.activate({
      sessionId: 'session-1',
      source: 'docs/guide.md',
      sourceSha256: 'c'.repeat(64),
      round: 'round-1',
      items: [],
    });
    while (queuedFrames.length > 0) queuedFrames.shift()?.(0);
    requestFrame.mockClear();

    resolveFonts();
    await Promise.resolve();

    expect(requestFrame).toHaveBeenCalledTimes(1);
    controller.deactivate();
    Object.defineProperty(window, 'requestAnimationFrame', {
      configurable: true,
      writable: true,
      value: originalRequestAnimationFrame,
    });
    if (originalFonts) Object.defineProperty(document, 'fonts', originalFonts);
    else Reflect.deleteProperty(document, 'fonts');
  });

  it('indexes only exact decoration elements once instead of scanning document blocks', () => {
    const editor = createEditorFixture();
    const query = jest.spyOn(editor.view.dom, 'querySelectorAll');
    const classLookup = jest.spyOn(editor.view.dom, 'getElementsByClassName');
    const controller = createFeedbackReviewController({ editor, host });
    controller.activate({
      sessionId: 'session-1',
      source: 'docs/guide.md',
      sourceSha256: 'c'.repeat(64),
      round: 'round-1',
      items: Array.from({ length: 200 }, (_, index) => ({
        id: `F${index + 1}`,
        kind: 'text' as const,
        startOrdinal: index % 2,
        endOrdinal: index % 2,
        startLine: index + 1,
        endLine: index + 1,
        focus: index % 2 === 0 ? 'Title' : 'Alpha beta',
        feedback: `Comment ${index + 1}`,
      })),
    });

    expect(query.mock.calls.filter(call => call[0] === '[data-feedback-ids]')).toHaveLength(0);
    expect(
      classLookup.mock.calls.filter(call => call[0] === 'md4h-feedback-annotation')
    ).toHaveLength(1);
  });

  it('indexes rendered cards once per layout instead of querying one card per comment', () => {
    const editor = createEditorFixture();
    const query = jest.spyOn(Element.prototype, 'querySelector');
    const controller = createFeedbackReviewController({ editor, host });

    controller.activate({
      sessionId: 'session-1',
      source: 'docs/guide.md',
      sourceSha256: 'c'.repeat(64),
      round: 'round-1',
      items: Array.from({ length: 200 }, (_, index) => ({
        id: `F${index + 1}`,
        kind: 'text' as const,
        startOrdinal: index % 2,
        endOrdinal: index % 2,
        startLine: index + 1,
        endLine: index + 1,
        focus: index % 2 === 0 ? 'Title' : 'Alpha beta',
        feedback: `Comment ${index + 1}`,
      })),
    });

    const perCardLookups = query.mock.calls.filter(
      call => typeof call[0] === 'string' && call[0].startsWith('[data-feedback-card="F')
    );
    expect(perCardLookups).toHaveLength(0);
  });

  it('keeps 10,000-line geometry reads bounded to 200 annotated targets and does no scroll work', () => {
    const originalRequestAnimationFrame = window.requestAnimationFrame;
    const queuedFrames: FrameRequestCallback[] = [];
    const requestFrame = jest.fn((callback: FrameRequestCallback) => {
      queuedFrames.push(callback);
      return queuedFrames.length;
    });
    Object.defineProperty(window, 'requestAnimationFrame', {
      configurable: true,
      writable: true,
      value: requestFrame,
    });
    const lineCount = 10_000;
    document.body.innerHTML = `
      <div class="formatting-toolbar"></div>
      <div id="editor"><div class="tiptap markdown-editor">${Array.from(
        { length: lineCount },
        (_, index) => `<p class="stress-block" data-stress-index="${index}">Line ${index + 1}</p>`
      ).join('')}</div></div>
    `;
    const editorDom = document.querySelector('.tiptap') as HTMLElement;
    const nodes = Array.from({ length: lineCount }, () => ({
      type: { name: 'paragraph' },
      nodeSize: 12,
    }));
    const editor = {
      state: {
        doc: {
          forEach: (
            callback: (node: (typeof nodes)[number], offset: number, ordinal: number) => void
          ) => nodes.forEach((node, ordinal) => callback(node, ordinal * node.nodeSize, ordinal)),
        },
        selection: { from: 1, to: 1, empty: true },
      },
      view: { dom: editorDom },
      storage: {},
      isEditable: true,
      setEditable: jest.fn(),
      on: jest.fn(),
      off: jest.fn(),
    } as unknown as Editor;
    const annotatedOrdinals = new Set(Array.from({ length: 200 }, (_, index) => index * 50));
    let annotatedBlockReads = 0;
    let unannotatedBlockReads = 0;
    const rect = jest
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockImplementation(function (this: HTMLElement) {
        if (this.classList.contains('stress-block')) {
          const ordinal = Number(this.dataset.stressIndex);
          if (annotatedOrdinals.has(ordinal)) annotatedBlockReads += 1;
          else unannotatedBlockReads += 1;
          const top = ordinal * 24;
          return {
            top,
            bottom: top + 24,
            left: 40,
            right: 820,
            width: 780,
            height: 24,
            x: 40,
            y: top,
            toJSON: () => ({}),
          } as DOMRect;
        }
        if (this.id === 'editor') {
          return {
            top: 0,
            bottom: lineCount * 24,
            left: 0,
            right: 1200,
            width: 1200,
            height: lineCount * 24,
            x: 0,
            y: 0,
            toJSON: () => ({}),
          } as DOMRect;
        }
        if (this === editorDom) {
          return {
            top: 0,
            bottom: lineCount * 24,
            left: 40,
            right: 820,
            width: 780,
            height: lineCount * 24,
            x: 40,
            y: 0,
            toJSON: () => ({}),
          } as DOMRect;
        }
        const height = this.hasAttribute('data-feedback-card') ? 52 : 0;
        return {
          top: 0,
          bottom: height,
          left: 0,
          right: 0,
          width: 0,
          height,
          x: 0,
          y: 0,
          toJSON: () => ({}),
        } as DOMRect;
      });
    const controller = createFeedbackReviewController({ editor, host });
    controller.activate({
      sessionId: 'session-1',
      source: 'docs/guide.md',
      sourceSha256: 'c'.repeat(64),
      round: 'round-1',
      items: Array.from({ length: 200 }, (_, index) => ({
        id: `F${index + 1}`,
        kind: 'text' as const,
        startOrdinal: index * 50,
        endOrdinal: index * 50,
        startLine: index * 50 + 1,
        endLine: index * 50 + 1,
        focus: `Line ${index * 50 + 1}`,
        feedback: `Comment ${index + 1}`,
      })),
    });
    while (queuedFrames.length > 0) queuedFrames.shift()?.(0);
    requestFrame.mockClear();
    const readsBeforeScroll = annotatedBlockReads;

    window.dispatchEvent(new Event('scroll'));

    expect(unannotatedBlockReads).toBe(0);
    expect(annotatedBlockReads).toBe(200);
    expect(annotatedBlockReads).toBe(readsBeforeScroll);
    expect(requestFrame).not.toHaveBeenCalled();
    expect(
      Number.parseFloat(
        (document.querySelector('[data-feedback-marker][data-feedback-ids="F200"]') as HTMLElement)
          .style.top
      )
    ).toBeGreaterThan(200_000);
    controller.deactivate();
    rect.mockRestore();
    Object.defineProperty(window, 'requestAnimationFrame', {
      configurable: true,
      writable: true,
      value: originalRequestAnimationFrame,
    });
  }, 10_000);

  it('keeps repeated whole-block hover bounded in a 10,000-block document', () => {
    const originalRequestAnimationFrame = window.requestAnimationFrame;
    const queuedFrames: FrameRequestCallback[] = [];
    const requestFrame = jest.fn((callback: FrameRequestCallback) => {
      queuedFrames.push(callback);
      return queuedFrames.length;
    });
    Object.defineProperty(window, 'requestAnimationFrame', {
      configurable: true,
      writable: true,
      value: requestFrame,
    });
    const blockCount = 10_000;
    const targetOrdinal = 7_654;
    document.body.innerHTML = `
      <div class="formatting-toolbar"></div>
      <div id="editor"><div class="tiptap markdown-editor">${Array.from(
        { length: blockCount },
        (_, index) =>
          `<p class="hover-stress-block" data-hover-index="${index}"><span>Line ${index + 1}</span></p>`
      ).join('')}</div></div>
    `;
    const editorDom = document.querySelector('.tiptap') as HTMLElement;
    let targetFocusReads = 0;
    const nodes = Array.from({ length: blockCount }, (_, index) => ({
      type: { name: 'paragraph' },
      nodeSize: 12,
      isAtom: false,
      content: { size: 10 },
      textBetween: () => {
        if (index === targetOrdinal) targetFocusReads += 1;
        return `Line ${index + 1}`;
      },
    }));
    const forEachBlock = jest.fn(
      (callback: (node: (typeof nodes)[number], offset: number, ordinal: number) => void): void =>
        nodes.forEach((node, ordinal) => callback(node, ordinal * node.nodeSize, ordinal))
    );
    const nodeDOM = jest.fn(() => null);
    const editor = {
      state: {
        doc: {
          childCount: nodes.length,
          maybeChild: (ordinal: number) => nodes[ordinal] ?? null,
          forEach: forEachBlock,
        },
        selection: { from: 1, to: 1, empty: true },
      },
      view: { dom: editorDom, nodeDOM },
      storage: {},
      isEditable: true,
      setEditable: jest.fn(),
      on: jest.fn(),
      off: jest.fn(),
    } as unknown as Editor;
    const target = editorDom.children[targetOrdinal] as HTMLElement;
    const nestedTarget = target.firstElementChild as HTMLElement;
    const selectionSpy = jest.spyOn(window, 'getSelection').mockReturnValue({
      anchorNode: null,
      focusNode: null,
      anchorOffset: 0,
      focusOffset: 0,
      isCollapsed: true,
      rangeCount: 0,
      toString: () => '',
    } as unknown as Selection);
    let targetReads = 0;
    let otherBlockReads = 0;
    const rect = jest
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockImplementation(function (this: HTMLElement) {
        if (this.classList.contains('hover-stress-block')) {
          const ordinal = Number(this.dataset.hoverIndex);
          if (ordinal === targetOrdinal) targetReads += 1;
          else otherBlockReads += 1;
          const top = ordinal === targetOrdinal ? 120 : ordinal * 24;
          return {
            top,
            bottom: top + 24,
            left: 40,
            right: 820,
            width: 780,
            height: 24,
            x: 40,
            y: top,
            toJSON: () => ({}),
          } as DOMRect;
        }
        if (this.id === 'editor') {
          return {
            top: 0,
            bottom: blockCount * 24,
            left: 0,
            right: 1200,
            width: 1200,
            height: blockCount * 24,
            x: 0,
            y: 0,
            toJSON: () => ({}),
          } as DOMRect;
        }
        return {
          top: 0,
          bottom: 0,
          left: 0,
          right: 0,
          width: 0,
          height: 0,
          x: 0,
          y: 0,
          toJSON: () => ({}),
        } as DOMRect;
      });
    const controller = createFeedbackReviewController({ editor, host });

    try {
      controller.activate({
        sessionId: 'session-1',
        source: 'docs/large.md',
        sourceSha256: 'c'.repeat(64),
        round: 'round-1',
        anchors: [
          {
            ordinal: targetOrdinal,
            startLine: targetOrdinal + 1,
            endLine: targetOrdinal + 1,
          },
        ],
        items: [],
      });
      while (queuedFrames.length > 0) queuedFrames.shift()?.(0);
      expect(nodeDOM).not.toHaveBeenCalled();
      forEachBlock.mockClear();
      requestFrame.mockClear();
      targetReads = 0;
      otherBlockReads = 0;
      targetFocusReads = 0;

      for (let index = 0; index < 25; index += 1) {
        dispatchFeedbackBlockHover(nestedTarget);
        while (queuedFrames.length > 0) queuedFrames.shift()?.(index);
      }
      expect(nodeDOM).not.toHaveBeenCalled();

      const action = document.querySelector<HTMLButtonElement>('[data-feedback-block-action]');
      expect(action).not.toBeNull();
      expect(action?.hidden).toBe(false);
      expect(document.querySelectorAll('[data-feedback-block-action]')).toHaveLength(1);
      expect(targetReads).toBeLessThanOrEqual(1);
      expect(otherBlockReads).toBe(0);
      expect(targetFocusReads).toBeLessThanOrEqual(1);
      expect(forEachBlock).not.toHaveBeenCalled();

      const readsBeforeScroll = targetReads;
      requestFrame.mockClear();
      window.dispatchEvent(new Event('scroll'));
      expect(targetReads).toBe(readsBeforeScroll);
      expect(requestFrame).not.toHaveBeenCalled();
    } finally {
      controller.deactivate();
      selectionSpy.mockRestore();
      rect.mockRestore();
      Object.defineProperty(window, 'requestAnimationFrame', {
        configurable: true,
        writable: true,
        value: originalRequestAnimationFrame,
      });
    }
  }, 10_000);

  it('renders source-ordered compact cards and expands only the active comment', () => {
    const editor = createEditorFixture();
    const controller = createFeedbackReviewController({ editor, host });
    controller.activate({
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
          focus: 'Title',
          feedback: 'Clarify the title.',
        },
        {
          id: 'F2',
          kind: 'text',
          startOrdinal: 3,
          endOrdinal: 3,
          startLine: 8,
          endLine: 9,
          focus: 'Quote',
          feedback: 'Use a concrete quotation.',
        },
      ],
    });

    const firstMarker = document.querySelector('[data-feedback-ids="F1"]') as HTMLButtonElement;
    firstMarker.click();

    const cards = Array.from(document.querySelectorAll<HTMLElement>('[data-feedback-card]'));
    expect(cards.map(card => card.dataset.feedbackCard)).toEqual(['F1', 'F2']);
    expect(cards[0].dataset.feedbackCardState).toBe('active');
    expect(cards[0].querySelector('[data-feedback-card-focus]')?.textContent).toBe('Title');
    expect(cards[1].dataset.feedbackCardState).toBe('compact');
    expect(cards[1].querySelector('[data-feedback-card-focus]')).toBeNull();
    expect(cards[1].textContent).toContain('Use a concrete quotation.');
    expect(cards[1].closest('[data-feedback-card-layer]')).not.toBeNull();
  });

  it('reopens a whole-block card with frozen rich text instead of its saved Markdown evidence', () => {
    const editor = createEditorFixture();
    const controller = createFeedbackReviewController({ editor, host });
    controller.activate({
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
          focus: '# **Title**',
          feedback: 'Make the heading more specific.',
        },
      ],
    });

    (document.querySelector('[data-feedback-marker]') as HTMLButtonElement).click();

    expect(document.querySelector('[data-feedback-target-label]')?.textContent).toBe(
      'Whole heading'
    );
    expect(document.querySelector('[data-feedback-card-focus]')?.textContent).toBe('Title');
    expect(document.querySelector('[data-feedback-card-focus]')?.textContent).not.toContain('**');
    expect(document.querySelector('[data-feedback-card-focus]')?.textContent).not.toContain('](');
    expect(document.querySelector('[data-feedback-card-focus]')?.textContent).not.toContain('`');
  });

  it('uses roving focus for document-ordered feedback markers', () => {
    const editor = createEditorFixture();
    const controller = createFeedbackReviewController({ editor, host });
    controller.activate({
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
          focus: 'Title',
          feedback: 'First note.',
        },
        {
          id: 'F2',
          kind: 'text',
          startOrdinal: 1,
          endOrdinal: 1,
          startLine: 3,
          endLine: 3,
          focus: 'Alpha beta',
          feedback: 'Second note.',
        },
        {
          id: 'F3',
          kind: 'text',
          startOrdinal: 3,
          endOrdinal: 3,
          startLine: 8,
          endLine: 9,
          focus: 'Quote',
          feedback: 'Third note.',
        },
      ],
    });
    const markers = Array.from(
      document.querySelectorAll<HTMLButtonElement>('[data-feedback-marker]')
    );
    expect(markers.map(marker => marker.tabIndex)).toEqual([0, -1, -1]);

    markers[0].focus();
    markers[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(document.activeElement).toBe(markers[1]);
    expect(markers.map(marker => marker.tabIndex)).toEqual([-1, 0, -1]);

    markers[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    expect(document.activeElement).toBe(markers[2]);
    markers[2].dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    expect(document.activeElement).toBe(markers[0]);
  });

  it('navigates feedback in document order through unbound host commands', () => {
    const editor = createEditorFixture();
    const firstTarget = editor.view.dom.children[0] as HTMLElement & {
      scrollIntoView: jest.Mock;
    };
    const secondTarget = editor.view.dom.children[1] as HTMLElement & {
      scrollIntoView: jest.Mock;
    };
    firstTarget.scrollIntoView = jest.fn();
    secondTarget.scrollIntoView = jest.fn();
    const controller = createFeedbackReviewController({ editor, host });
    controller.activate({
      sessionId: 'session-1',
      source: 'docs/guide.md',
      sourceSha256: 'c'.repeat(64),
      round: 'round-1',
      items: [
        {
          id: 'F2',
          kind: 'text',
          startOrdinal: 1,
          endOrdinal: 1,
          startLine: 3,
          endLine: 3,
          focus: 'Alpha beta',
          feedback: 'Second note.',
        },
        {
          id: 'F1',
          kind: 'text',
          startOrdinal: 0,
          endOrdinal: 0,
          startLine: 1,
          endLine: 1,
          focus: 'Title',
          feedback: 'First note.',
        },
      ],
    });

    controller.handleHostMessage({ type: 'feedback.command', command: 'nextFeedback' });
    expect(
      document.querySelector('[data-feedback-card="F1"]')?.getAttribute('data-feedback-card-state')
    ).toBe('active');
    expect(firstTarget.scrollIntoView).toHaveBeenLastCalledWith({
      behavior: 'auto',
      block: 'center',
    });

    controller.handleHostMessage({ type: 'feedback.command', command: 'nextFeedback' });
    expect(
      document.querySelector('[data-feedback-card="F2"]')?.getAttribute('data-feedback-card-state')
    ).toBe('active');
    expect(secondTarget.scrollIntoView).toHaveBeenCalled();

    controller.handleHostMessage({ type: 'feedback.command', command: 'previousFeedback' });
    expect(
      document.querySelector('[data-feedback-card="F1"]')?.getAttribute('data-feedback-card-state')
    ).toBe('active');
  });

  it('keeps navigation and comment disclosure inside the active completion surface', async () => {
    const editor = createEditorFixture();
    const target = editor.view.dom.children[0] as HTMLElement & { scrollIntoView: jest.Mock };
    target.scrollIntoView = jest.fn();
    const controller = createFeedbackReviewController({ editor, host });
    controller.activate({
      sessionId: 'session-1',
      source: 'docs/guide.md',
      sourceSha256: 'c'.repeat(64),
      round: 'round-1',
      feedbackFile: '.md4h/feedback/docs/guide.md--round-1/feedback.md',
      items: createSavedFeedbackItems(1),
    });
    const commentsState = document.body.getAttribute('data-feedback-comments-state');
    controller.finish();
    const resume = document.querySelector<HTMLButtonElement>('[data-feedback-completion-resume]');

    controller.handleHostMessage({ type: 'feedback.command', command: 'nextFeedback' });
    controller.toggleComments(false);
    await new Promise(resolve => window.setTimeout(resolve, 0));

    expect(target.scrollIntoView).not.toHaveBeenCalled();
    expect(document.body.getAttribute('data-feedback-comments-state')).toBe(commentsState);
    expect(document.activeElement).toBe(resume);
    expect(document.querySelector('.feedback-live-region')?.textContent).toContain(
      'Resume feedback or finish the current completion step'
    );
  });

  it('does not navigate feedback behind another active modal', async () => {
    const editor = createEditorFixture();
    const target = editor.view.dom.children[0] as HTMLElement & { scrollIntoView: jest.Mock };
    target.scrollIntoView = jest.fn();
    const controller = createFeedbackReviewController({ editor, host });
    controller.activate({
      sessionId: 'session-1',
      source: 'docs/guide.md',
      sourceSha256: 'c'.repeat(64),
      round: 'round-1',
      items: createSavedFeedbackItems(1),
    });
    const modal = document.createElement('section');
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('data-md4h-modal', '');
    const modalAction = document.createElement('button');
    modalAction.textContent = 'Keep editing dialog';
    modal.append(modalAction);
    document.body.append(modal);
    modalAction.focus();

    controller.navigateFeedback('next');
    await new Promise(resolve => window.setTimeout(resolve, 0));

    expect(target.scrollIntoView).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(modalAction);
    expect(document.querySelector('.feedback-live-region')?.textContent).toContain(
      'Complete or close the active dialog before navigating comments'
    );
  });

  it('closes active details with Escape and restores focus to the matching marker', () => {
    const editor = createEditorFixture();
    const controller = createFeedbackReviewController({ editor, host });
    controller.activate({
      sessionId: 'session-1',
      source: 'docs/guide.md',
      sourceSha256: 'c'.repeat(64),
      round: 'round-1',
      items: [
        {
          id: 'F1',
          kind: 'text',
          startOrdinal: 1,
          endOrdinal: 1,
          startLine: 3,
          endLine: 3,
          focus: 'Alpha beta',
          feedback: 'Clarify this.',
        },
      ],
    });
    const marker = document.querySelector('[data-feedback-marker]') as HTMLButtonElement;
    marker.click();
    const card = document.querySelector('[data-feedback-card="F1"]') as HTMLElement;
    card.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

    expect(document.querySelector('.feedback-comment-rail')?.classList).not.toContain('expanded');
    expect(marker.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(marker);
  });

  it('edits an active comment in an in-webview form and saves one trimmed update', () => {
    const editor = createEditorFixture();
    const prompt = jest.spyOn(window, 'prompt').mockReturnValue(null);
    const controller = createFeedbackReviewController({ editor, host });
    controller.activate({
      sessionId: 'session-1',
      source: 'docs/guide.md',
      sourceSha256: 'c'.repeat(64),
      round: 'round-1',
      items: [
        {
          id: 'F1',
          kind: 'text',
          startOrdinal: 1,
          endOrdinal: 1,
          startLine: 3,
          endLine: 3,
          focus: 'Alpha beta',
          feedback: 'Clarify this.',
        },
      ],
    });
    (document.querySelector('[data-feedback-marker]') as HTMLButtonElement).click();
    const edit = Array.from(
      document.querySelectorAll<HTMLButtonElement>('[data-feedback-card="F1"] button')
    ).find(button => button.textContent === 'Edit')!;
    edit.click();

    const field = document.querySelector<HTMLTextAreaElement>('[data-feedback-edit-input="F1"]');
    const save = document.querySelector<HTMLButtonElement>('[data-feedback-edit-save="F1"]');
    expect(prompt).not.toHaveBeenCalled();
    expect(field?.value).toBe('Clarify this.');
    expect(document.activeElement).toBe(field);
    expect(save?.disabled).toBe(true);

    if (!field || !save) throw new Error('Inline feedback editor was not rendered.');
    field.value = '  Make this more specific.  ';
    field.dispatchEvent(new Event('input', { bubbles: true }));
    expect(save.disabled).toBe(false);
    save.click();
    save.click();

    const updates = (host.postMessage as jest.Mock).mock.calls
      .map(call => call[0] as FeedbackWebviewMessage)
      .filter(message => message.type === 'feedback.item.edit');
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      type: 'feedback.item.edit',
      sessionId: 'session-1',
      id: 'F1',
      feedback: 'Make this more specific.',
    });
    expect(save.disabled).toBe(true);

    const requestId = updates[0]?.requestId;
    if (!requestId) throw new Error('Edit request did not include a request ID.');
    controller.handleHostMessage({
      type: 'feedback.updated',
      requestId,
      sessionId: 'session-1',
      items: [
        {
          id: 'F1',
          kind: 'text',
          startOrdinal: 1,
          endOrdinal: 1,
          startLine: 3,
          endLine: 3,
          focus: 'Alpha beta',
          feedback: 'Make this more specific.',
        },
      ],
    });

    expect(document.querySelector('[data-feedback-edit-input="F1"]')).toBeNull();
    expect(
      document.querySelector('[data-feedback-card="F1"] .feedback-card-body')?.textContent
    ).toBe('Make this more specific.');
    expect(document.activeElement?.textContent).toBe('Edit');
    prompt.mockRestore();
  });

  it('grows a saved-comment edit field to the same viewport cap as a new comment', () => {
    const editor = createEditorFixture();
    const controller = createFeedbackReviewController({ editor, host });
    controller.activate({
      sessionId: 'session-1',
      source: 'docs/guide.md',
      sourceSha256: 'c'.repeat(64),
      round: 'round-1',
      items: [
        {
          id: 'F1',
          kind: 'text',
          startOrdinal: 1,
          endOrdinal: 1,
          startLine: 3,
          endLine: 3,
          focus: 'Alpha beta',
          feedback: 'Clarify this.',
        },
      ],
    });
    (document.querySelector('[data-feedback-marker]') as HTMLButtonElement).click();
    document.querySelector<HTMLButtonElement>('[data-feedback-edit-action="F1"]')?.click();
    const field = document.querySelector<HTMLTextAreaElement>('[data-feedback-edit-input="F1"]')!;
    const originalInnerHeight = window.innerHeight;
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 600 });
    Object.defineProperty(field, 'scrollHeight', { configurable: true, value: 1_000 });

    try {
      field.value = 'A long saved-comment revision';
      field.dispatchEvent(new Event('input', { bubbles: true }));
      expect(field.style.height).toBe('240px');
      expect(field.style.overflowY).toBe('auto');
    } finally {
      Object.defineProperty(window, 'innerHeight', {
        configurable: true,
        value: originalInnerHeight,
      });
    }
  });

  it('remeasures a saved-comment edit card after its responsive width changes', () => {
    const queuedFrames: FrameRequestCallback[] = [];
    const requestFrame = jest
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation(callback => {
        queuedFrames.push(callback);
        return queuedFrames.length;
      });
    const flushFrames = (): void => {
      while (queuedFrames.length > 0) queuedFrames.shift()?.(0);
    };
    let containerWidth = 800;
    const editor = createEditorFixture();
    const editorContainer = document.querySelector<HTMLElement>('#editor')!;
    editorContainer.getBoundingClientRect = () =>
      ({
        top: 0,
        bottom: 720,
        left: 0,
        right: containerWidth,
        width: containerWidth,
        height: 720,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect;
    const controller = createFeedbackReviewController({ editor, host });
    controller.activate({
      sessionId: 'session-1',
      source: 'docs/guide.md',
      sourceSha256: 'c'.repeat(64),
      round: 'round-1',
      items: [
        {
          id: 'F1',
          kind: 'text',
          startOrdinal: 1,
          endOrdinal: 1,
          startLine: 3,
          endLine: 3,
          focus: 'Alpha beta',
          feedback: 'A saved comment with target context that can wrap independently.',
        },
      ],
    });

    try {
      flushFrames();
      document.querySelector<HTMLButtonElement>('[data-feedback-marker]')?.click();
      document.querySelector<HTMLButtonElement>('[data-feedback-edit-action="F1"]')?.click();
      const card = document.querySelector<HTMLElement>('[data-feedback-card="F1"]')!;
      const field = document.querySelector<HTMLTextAreaElement>('[data-feedback-edit-input="F1"]')!;
      Object.defineProperty(field, 'scrollHeight', { configurable: true, value: 96 });
      const measuredWidths: string[] = [];
      card.getBoundingClientRect = () => {
        measuredWidths.push(card.style.width);
        const height = card.style.width === '320px' ? 300 : 180;
        return {
          top: 0,
          bottom: height,
          left: 0,
          right: Number.parseFloat(card.style.width) || 744,
          width: Number.parseFloat(card.style.width) || 744,
          height,
          x: 0,
          y: 0,
          toJSON: () => ({}),
        } as DOMRect;
      };
      flushFrames();
      expect(card.style.width).toBe('744px');
      measuredWidths.length = 0;

      containerWidth = 1_200;
      window.dispatchEvent(new Event('resize'));
      const firstPassFrames = queuedFrames.splice(0);
      expect(firstPassFrames.length).toBeGreaterThan(0);
      firstPassFrames.forEach(callback => callback(0));

      expect(card.style.width).toBe('320px');
      const followUpFrames = queuedFrames.splice(0);
      expect(followUpFrames.length).toBeGreaterThan(0);
      followUpFrames.forEach(callback => callback(0));
      expect(measuredWidths).toContain('320px');
    } finally {
      controller.deactivate();
      requestFrame.mockRestore();
    }
  });

  it('keeps a tall saved-comment edit form below the sticky toolbar after deep scrolling', async () => {
    const originalInnerHeight = window.innerHeight;
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 600 });
    const editor = createEditorFixture();
    const editorContainer = document.querySelector<HTMLElement>('#editor')!;
    editorContainer.getBoundingClientRect = () =>
      ({
        top: -1_000,
        bottom: 1_000,
        left: 0,
        right: 1_200,
        width: 1_200,
        height: 2_000,
        x: 0,
        y: -1_000,
        toJSON: () => ({}),
      }) as DOMRect;
    document.querySelector<HTMLElement>('.formatting-toolbar')!.getBoundingClientRect = () =>
      ({
        top: 0,
        bottom: 64,
        left: 0,
        right: 1_200,
        width: 1_200,
        height: 64,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect;
    (editor.view.dom.children[1] as HTMLElement).getBoundingClientRect = () =>
      ({
        top: -900,
        bottom: -860,
        left: 32,
        right: 1_120,
        width: 1_088,
        height: 40,
        x: 32,
        y: -900,
        toJSON: () => ({}),
      }) as DOMRect;
    const controller = createFeedbackReviewController({ editor, host });
    controller.activate({
      sessionId: 'session-1',
      source: 'docs/guide.md',
      sourceSha256: 'c'.repeat(64),
      round: 'round-1',
      items: [
        {
          id: 'F1',
          kind: 'text',
          startOrdinal: 1,
          endOrdinal: 1,
          startLine: 3,
          endLine: 3,
          focus: 'Alpha beta',
          feedback: 'Clarify this.',
        },
      ],
    });

    try {
      document.querySelector<HTMLButtonElement>('[data-feedback-marker]')?.click();
      document.querySelector<HTMLButtonElement>('[data-feedback-edit-action="F1"]')?.click();
      const card = document.querySelector<HTMLElement>('[data-feedback-card="F1"]')!;
      card.getBoundingClientRect = () =>
        ({
          top: 0,
          bottom: 300,
          left: 0,
          right: 320,
          width: 320,
          height: 300,
          x: 0,
          y: 0,
          toJSON: () => ({}),
        }) as DOMRect;
      await waitForFeedbackFrame();

      const cardTop = Number.parseFloat(card.style.top);
      expect(cardTop).toBeGreaterThanOrEqual(1_000 + 64 + 12);
      expect(cardTop + 300).toBeLessThanOrEqual(1_000 + 600 - 12);
    } finally {
      controller.deactivate();
      Object.defineProperty(window, 'innerHeight', {
        configurable: true,
        value: originalInnerHeight,
      });
    }
  });

  it('pins a tall saved-comment edit form inside the viewport when earlier cards are crowded', async () => {
    const originalInnerHeight = window.innerHeight;
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 600 });
    const editor = createEditorFixture();
    const editorContainer = document.querySelector<HTMLElement>('#editor')!;
    editorContainer.getBoundingClientRect = () =>
      ({
        top: -1_000,
        bottom: 1_000,
        left: 0,
        right: 1_200,
        width: 1_200,
        height: 2_000,
        x: 0,
        y: -1_000,
        toJSON: () => ({}),
      }) as DOMRect;
    document.querySelector<HTMLElement>('.formatting-toolbar')!.getBoundingClientRect = () =>
      ({
        top: 0,
        bottom: 64,
        left: 0,
        right: 1_200,
        width: 1_200,
        height: 64,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect;
    (editor.view.dom.children[1] as HTMLElement).getBoundingClientRect = () =>
      ({
        top: -900,
        bottom: -860,
        left: 32,
        right: 1_120,
        width: 1_088,
        height: 40,
        x: 32,
        y: -900,
        toJSON: () => ({}),
      }) as DOMRect;
    const controller = createFeedbackReviewController({ editor, host });
    controller.activate({
      sessionId: 'session-1',
      source: 'docs/guide.md',
      sourceSha256: 'c'.repeat(64),
      round: 'round-1',
      items: createSavedFeedbackItems(40),
    });
    const stubCardHeights = (): void => {
      document.querySelectorAll<HTMLElement>('[data-feedback-card]').forEach(card => {
        card.getBoundingClientRect = () => {
          const height = card.querySelector('[data-feedback-edit-input]') ? 300 : 60;
          return {
            top: 0,
            bottom: height,
            left: 0,
            right: 320,
            width: 320,
            height,
            x: 0,
            y: 0,
            toJSON: () => ({}),
          } as DOMRect;
        };
      });
    };

    try {
      document.querySelector<HTMLButtonElement>('[data-feedback-marker]')?.click();
      expect(document.querySelectorAll('[data-feedback-card]')).toHaveLength(40);
      stubCardHeights();
      document.querySelector<HTMLElement>('[data-feedback-card="F40"]')?.click();
      stubCardHeights();
      const edit = document.querySelector<HTMLButtonElement>('[data-feedback-edit-action="F40"]');
      expect(edit).not.toBeNull();
      edit?.click();
      expect(document.querySelector('[data-feedback-edit-input="F40"]')).not.toBeNull();
      expect(document.querySelectorAll('[data-feedback-card]')).toHaveLength(1);
      expect(document.querySelector('[data-feedback-card="F40"]')).not.toBeNull();
      stubCardHeights();
      await waitForFeedbackFrame();

      const card = document.querySelector<HTMLElement>('[data-feedback-card="F40"]')!;
      const cardTop = Number.parseFloat(card.style.top);
      expect(cardTop).toBeGreaterThanOrEqual(1_000 + 64 + 12);
      expect(cardTop + 300).toBeLessThanOrEqual(1_000 + 600 - 12);
    } finally {
      Object.defineProperty(window, 'innerHeight', {
        configurable: true,
        value: originalInnerHeight,
      });
    }
  });

  it('hides deleted-item Undo controls until the active saved-comment edit closes', () => {
    const editor = createEditorFixture();
    const items = createSavedFeedbackItems(2);
    const controller = createFeedbackReviewController({ editor, host });
    controller.activate({
      sessionId: 'session-1',
      source: 'docs/guide.md',
      sourceSha256: 'c'.repeat(64),
      round: 'round-1',
      items,
    });
    const firstMarker = Array.from(
      document.querySelectorAll<HTMLButtonElement>('[data-feedback-marker]')
    ).find(marker => marker.dataset.feedbackIds?.split(',').includes('F1'))!;
    firstMarker.click();
    const remove = Array.from(
      document.querySelectorAll<HTMLButtonElement>('[data-feedback-card="F1"] button')
    ).find(button => button.textContent === 'Delete')!;
    remove.click();
    const request = (host.postMessage as jest.Mock).mock.calls
      .map(call => call[0])
      .find(message => message.type === 'feedback.item.delete');
    controller.handleHostMessage({
      type: 'feedback.updated',
      requestId: request.requestId,
      sessionId: 'session-1',
      items: [items[1]!],
    });
    expect(document.querySelector('[data-feedback-undo-id="F1"]')).not.toBeNull();

    const secondMarker = Array.from(
      document.querySelectorAll<HTMLButtonElement>('[data-feedback-marker]')
    ).find(marker => marker.dataset.feedbackIds?.split(',').includes('F2'))!;
    secondMarker.click();
    document.querySelector<HTMLButtonElement>('[data-feedback-edit-action="F2"]')?.click();

    expect(document.querySelector('[data-feedback-edit-input="F2"]')).not.toBeNull();
    expect(document.querySelector('[data-feedback-undo-id="F1"]')).toBeNull();
    document.querySelector<HTMLButtonElement>('[data-feedback-edit-cancel="F2"]')?.click();
    expect(document.querySelector('[data-feedback-undo-id="F1"]')).not.toBeNull();
    controller.deactivate();
  });

  it('disables Edit while its sibling Delete is in flight', () => {
    const editor = createEditorFixture();
    const items = createSavedFeedbackItems(1);
    const controller = createFeedbackReviewController({ editor, host });
    controller.activate({
      sessionId: 'session-1',
      source: 'docs/guide.md',
      sourceSha256: 'c'.repeat(64),
      round: 'round-1',
      items,
    });
    document.querySelector<HTMLButtonElement>('[data-feedback-marker]')?.click();
    const card = document.querySelectorAll<HTMLButtonElement>('[data-feedback-card="F1"] button');
    const edit = Array.from(card).find(button => button.textContent === 'Edit')!;
    const remove = Array.from(card).find(button => button.textContent === 'Delete')!;
    expect(edit.disabled).toBe(false);

    remove.click();

    expect(edit.disabled).toBe(true);
    expect(remove.disabled).toBe(true);
    controller.deactivate();
  });

  it('re-enables Edit alongside Delete when the delete request fails', () => {
    const editor = createEditorFixture();
    const items = createSavedFeedbackItems(1);
    const controller = createFeedbackReviewController({ editor, host });
    controller.activate({
      sessionId: 'session-1',
      source: 'docs/guide.md',
      sourceSha256: 'c'.repeat(64),
      round: 'round-1',
      items,
    });
    document.querySelector<HTMLButtonElement>('[data-feedback-marker]')?.click();
    const card = document.querySelectorAll<HTMLButtonElement>('[data-feedback-card="F1"] button');
    const edit = Array.from(card).find(button => button.textContent === 'Edit')!;
    const remove = Array.from(card).find(button => button.textContent === 'Delete')!;
    remove.click();
    const request = (host.postMessage as jest.Mock).mock.calls
      .map(call => call[0])
      .find(message => message.type === 'feedback.item.delete');

    controller.handleHostMessage({
      type: 'feedback.error',
      requestId: request.requestId,
      sessionId: controller.getSession()!.sessionId,
      message: 'Delete failed.',
      recoverable: true,
    });

    expect(remove.disabled).toBe(false);
    expect(edit.disabled).toBe(false);
    controller.deactivate();
  });

  it('announces a specific message when an external update drops the item currently under edit', async () => {
    const editor = createEditorFixture();
    const items = createSavedFeedbackItems(2);
    const controller = createFeedbackReviewController({ editor, host });
    controller.activate({
      sessionId: 'session-1',
      source: 'docs/guide.md',
      sourceSha256: 'c'.repeat(64),
      round: 'round-1',
      items,
    });
    const firstMarker = Array.from(
      document.querySelectorAll<HTMLButtonElement>('[data-feedback-marker]')
    ).find(marker => marker.dataset.feedbackIds?.split(',').includes('F1'))!;
    firstMarker.click();
    document.querySelector<HTMLButtonElement>('[data-feedback-edit-action="F1"]')?.click();
    expect(document.querySelector('[data-feedback-edit-input="F1"]')).not.toBeNull();

    // Flush any announcements already queued by activation/edit so only
    // writes triggered by the update below are recorded below.
    await new Promise(resolve => window.setTimeout(resolve, 0));

    // Record every non-empty value written to the live region, so the
    // exclusivity assertion below cannot be fooled by an earlier
    // announcement that gets overwritten before the timers flush.
    const liveRegion = document.querySelector<HTMLElement>('.feedback-live-region')!;
    const writes: string[] = [];
    const descriptor = Object.getOwnPropertyDescriptor(Node.prototype, 'textContent')!;
    Object.defineProperty(liveRegion, 'textContent', {
      configurable: true,
      get() {
        return descriptor.get!.call(this);
      },
      set(value: string) {
        if (value) writes.push(value);
        descriptor.set!.call(this, value);
      },
    });

    // An unrelated/external update (no pending mutation on this webview
    // corresponds to this requestId) simply omits F1 from the source of
    // truth, e.g. another collaborator or a host-driven prune.
    controller.handleHostMessage({
      type: 'feedback.updated',
      requestId: 'external-update',
      sessionId: 'session-1',
      items: [items[1]!],
    });
    await new Promise(resolve => window.setTimeout(resolve, 0));

    Object.defineProperty(liveRegion, 'textContent', descriptor);

    expect(writes).toEqual([
      'The unsaved edit was discarded because that comment is no longer present.',
    ]);
    controller.deactivate();
  });

  it('keeps Edit disabled across a re-render while its sibling Delete is still pending', () => {
    const editor = createEditorFixture();
    const items = createSavedFeedbackItems(2);
    const controller = createFeedbackReviewController({ editor, host });
    controller.activate({
      sessionId: 'session-1',
      source: 'docs/guide.md',
      sourceSha256: 'c'.repeat(64),
      round: 'round-1',
      items,
    });
    const firstMarker = Array.from(
      document.querySelectorAll<HTMLButtonElement>('[data-feedback-marker]')
    ).find(marker => marker.dataset.feedbackIds?.split(',').includes('F1'))!;
    firstMarker.click();
    const remove = Array.from(
      document.querySelectorAll<HTMLButtonElement>('[data-feedback-card="F1"] button')
    ).find(button => button.textContent === 'Delete')!;
    remove.click();

    // An unrelated update for a different item forces renderCards() to rebuild
    // every card's Edit/Delete buttons from scratch while the delete for F1 is
    // still in flight.
    controller.handleHostMessage({
      type: 'feedback.updated',
      requestId: 'unrelated-request',
      sessionId: 'session-1',
      items,
    });

    const edit = Array.from(
      document.querySelectorAll<HTMLButtonElement>('[data-feedback-card="F1"] button')
    ).find(button => button.textContent === 'Edit')!;
    const rebuiltRemove = Array.from(
      document.querySelectorAll<HTMLButtonElement>('[data-feedback-card="F1"] button')
    ).find(button => button.textContent === 'Delete')!;
    expect(edit.disabled).toBe(true);
    expect(rebuiltRemove.disabled).toBe(true);
    controller.deactivate();
  });

  it('re-enables the currently mounted Edit and Delete buttons when a delete-error ack arrives after a re-render', () => {
    const editor = createEditorFixture();
    const items = createSavedFeedbackItems(2);
    const controller = createFeedbackReviewController({ editor, host });
    controller.activate({
      sessionId: 'session-1',
      source: 'docs/guide.md',
      sourceSha256: 'c'.repeat(64),
      round: 'round-1',
      items,
    });
    const firstMarker = Array.from(
      document.querySelectorAll<HTMLButtonElement>('[data-feedback-marker]')
    ).find(marker => marker.dataset.feedbackIds?.split(',').includes('F1'))!;
    firstMarker.click();
    const remove = Array.from(
      document.querySelectorAll<HTMLButtonElement>('[data-feedback-card="F1"] button')
    ).find(button => button.textContent === 'Delete')!;
    remove.click();
    const request = (host.postMessage as jest.Mock).mock.calls
      .map(call => call[0])
      .find(message => message.type === 'feedback.item.delete');

    // An unrelated update forces renderCards() to rebuild every card's
    // Edit/Delete buttons from scratch, detaching the button refs captured
    // above, before the real delete request's error ack arrives.
    controller.handleHostMessage({
      type: 'feedback.updated',
      requestId: 'unrelated-request',
      sessionId: 'session-1',
      items,
    });

    controller.handleHostMessage({
      type: 'feedback.error',
      requestId: request.requestId,
      sessionId: 'session-1',
      message: 'Delete failed.',
      recoverable: true,
    });

    const liveEdit = document.querySelector<HTMLButtonElement>('[data-feedback-edit-action="F1"]')!;
    const liveRemove = document.querySelector<HTMLButtonElement>(
      '[data-feedback-delete-action="F1"]'
    )!;
    expect(liveEdit.disabled).toBe(false);
    expect(liveRemove.disabled).toBe(false);
    controller.deactivate();
  });

  it('retains a failed inline edit for retry and lets Cancel restore the Edit control', () => {
    const editor = createEditorFixture();
    const controller = createFeedbackReviewController({ editor, host });
    controller.activate({
      sessionId: 'session-1',
      source: 'docs/guide.md',
      sourceSha256: 'c'.repeat(64),
      round: 'round-1',
      items: [
        {
          id: 'F1',
          kind: 'text',
          startOrdinal: 1,
          endOrdinal: 1,
          startLine: 3,
          endLine: 3,
          focus: 'Alpha beta',
          feedback: 'Clarify this.',
        },
      ],
    });
    (document.querySelector('[data-feedback-marker]') as HTMLButtonElement).click();
    const edit = Array.from(
      document.querySelectorAll<HTMLButtonElement>('[data-feedback-card="F1"] button')
    ).find(button => button.textContent === 'Edit')!;
    edit.click();
    const field = document.querySelector<HTMLTextAreaElement>('[data-feedback-edit-input="F1"]')!;
    const save = document.querySelector<HTMLButtonElement>('[data-feedback-edit-save="F1"]')!;
    field.value = 'Keep this draft';
    field.dispatchEvent(new Event('input', { bubbles: true }));

    (document.querySelector('[data-feedback-marker]') as HTMLButtonElement).click();
    expect(document.activeElement).toBe(field);

    controller.finish();
    expect(document.querySelector('[data-feedback-completion-dialog]')).toBeNull();
    expect(document.activeElement).toBe(field);

    save.click();
    const update = (host.postMessage as jest.Mock).mock.calls
      .map(call => call[0] as FeedbackWebviewMessage)
      .find(message => message.type === 'feedback.item.edit');
    if (!update || update.type !== 'feedback.item.edit') {
      throw new Error('Edit request was not posted.');
    }
    controller.handleHostMessage({
      type: 'feedback.error',
      requestId: update.requestId,
      sessionId: 'session-1',
      code: 'MD4H-FB-STORE-001',
      message: 'Could not save feedback.',
      recoverable: true,
    });

    expect(field.value).toBe('Keep this draft');
    expect(save.disabled).toBe(false);
    expect(document.activeElement).toBe(field);

    const cancel = document.querySelector<HTMLButtonElement>('[data-feedback-edit-cancel="F1"]')!;
    cancel.click();
    expect(document.querySelector('[data-feedback-edit-input="F1"]')).toBeNull();
    expect(document.activeElement?.textContent).toBe('Edit');
    expect(
      (host.postMessage as jest.Mock).mock.calls
        .map(call => call[0] as FeedbackWebviewMessage)
        .filter(message => message.type === 'feedback.item.edit')
    ).toHaveLength(1);
  });

  it('preserves an inline edit draft, caret, and screenshot preview across host refreshes', () => {
    const editor = createEditorFixture();
    const controller = createFeedbackReviewController({ editor, host });
    const item: FeedbackItemSummary = {
      id: 'F1',
      kind: 'screenshot',
      startOrdinal: 1,
      endOrdinal: 1,
      startLine: 3,
      endLine: 3,
      imageUri: 'vscode-webview://feedback/F1.png',
      feedback: 'Clarify this capture.',
    };
    controller.activate({
      sessionId: 'session-1',
      source: 'docs/guide.md',
      sourceSha256: 'c'.repeat(64),
      round: 'round-1',
      items: [item],
    });
    (document.querySelector('[data-feedback-marker]') as HTMLButtonElement).click();
    const edit = document.querySelector<HTMLButtonElement>('[data-feedback-edit-action="F1"]')!;
    edit.click();
    const originalField = document.querySelector<HTMLTextAreaElement>(
      '[data-feedback-edit-input="F1"]'
    )!;
    originalField.value = 'Keep this local edit';
    originalField.dispatchEvent(new Event('input', { bubbles: true }));
    originalField.setSelectionRange(5, 9);
    originalField.focus();

    controller.handleHostMessage({
      type: 'feedback.updated',
      requestId: 'unrelated-refresh',
      sessionId: 'session-1',
      items: [item],
    });

    const refreshedField = document.querySelector<HTMLTextAreaElement>(
      '[data-feedback-edit-input="F1"]'
    )!;
    expect(refreshedField).not.toBe(originalField);
    expect(refreshedField.value).toBe('Keep this local edit');
    expect(refreshedField.selectionStart).toBe(5);
    expect(refreshedField.selectionEnd).toBe(9);
    expect(document.activeElement).toBe(refreshedField);
    expect(document.querySelector<HTMLImageElement>('[data-feedback-card-image]')?.src).toContain(
      'vscode-webview://feedback/F1.png'
    );
  });

  it('omits the redundant Show target action from document-aligned active cards', () => {
    const editor = createEditorFixture();
    const controller = createFeedbackReviewController({ editor, host });
    controller.activate({
      sessionId: 'session-1',
      source: 'docs/guide.md',
      sourceSha256: 'c'.repeat(64),
      round: 'round-1',
      items: [
        {
          id: 'F1',
          kind: 'text',
          startOrdinal: 1,
          endOrdinal: 1,
          startLine: 3,
          endLine: 3,
          focus: 'Alpha beta',
          feedback: 'Clarify this.',
        },
      ],
    });
    (document.querySelector('[data-feedback-marker]') as HTMLButtonElement).click();
    const actionLabels = Array.from(
      document.querySelectorAll<HTMLButtonElement>('[data-feedback-card="F1"] button')
    ).map(button => button.textContent);

    expect(actionLabels).toEqual(['Edit', 'Delete']);
  });

  it('opens the matching comment when a saved highlight is clicked but not during text selection', () => {
    const editor = createEditorFixture();
    const paragraph = editor.view.dom.children[1] as HTMLElement;
    paragraph.innerHTML =
      '<span class="md4h-feedback-annotation md4h-feedback-annotation-inline" data-feedback-ids="F1">Alpha</span> beta';
    const controller = createFeedbackReviewController({ editor, host });
    controller.activate({
      sessionId: 'session-1',
      source: 'docs/guide.md',
      sourceSha256: 'c'.repeat(64),
      round: 'round-1',
      items: [
        {
          id: 'F1',
          kind: 'text',
          startOrdinal: 1,
          endOrdinal: 1,
          startLine: 3,
          endLine: 3,
          focus: 'Alpha',
          feedback: 'Clarify this.',
        },
      ],
    });
    const highlight = paragraph.querySelector('.md4h-feedback-annotation') as HTMLElement;
    const selectionSpy = jest.spyOn(window, 'getSelection').mockReturnValue({
      isCollapsed: false,
      toString: () => 'Alpha',
    } as unknown as Selection);
    highlight.click();
    expect(document.querySelector('.feedback-comment-rail')?.classList).not.toContain('expanded');

    selectionSpy.mockReturnValue({ isCollapsed: true, toString: () => '' } as unknown as Selection);
    highlight.click();
    expect(document.querySelector('.feedback-comment-rail')?.classList).toContain('expanded');
    expect(
      document.querySelector('[data-feedback-card="F1"]')?.getAttribute('data-feedback-card-state')
    ).toBe('active');
    selectionSpy.mockRestore();
  });

  it('opens the exact clicked feedback ID inside a clustered highlight marker', () => {
    const editor = createEditorFixture();
    const paragraph = editor.view.dom.children[1] as HTMLElement;
    paragraph.innerHTML =
      '<span class="md4h-feedback-annotation md4h-feedback-annotation-inline" data-feedback-ids="F1">Alpha</span> <span class="md4h-feedback-annotation md4h-feedback-annotation-inline" data-feedback-ids="F2">beta</span>';
    const controller = createFeedbackReviewController({ editor, host });
    controller.activate({
      sessionId: 'session-1',
      source: 'docs/guide.md',
      sourceSha256: 'c'.repeat(64),
      round: 'round-1',
      items: [
        {
          id: 'F1',
          kind: 'text',
          startOrdinal: 1,
          endOrdinal: 1,
          startLine: 3,
          endLine: 3,
          focus: 'Alpha',
          feedback: 'First.',
        },
        {
          id: 'F2',
          kind: 'text',
          startOrdinal: 1,
          endOrdinal: 1,
          startLine: 3,
          endLine: 3,
          focus: 'beta',
          feedback: 'Second.',
        },
      ],
    });
    const selectionSpy = jest.spyOn(window, 'getSelection').mockReturnValue({
      isCollapsed: true,
      toString: () => '',
    } as unknown as Selection);

    (paragraph.querySelector('[data-feedback-ids="F2"]') as HTMLElement).click();

    expect(
      document.querySelector('[data-feedback-card="F2"]')?.getAttribute('data-feedback-card-state')
    ).toBe('active');
    selectionSpy.mockRestore();
  });

  it('removes the same-scroll layer and EOF spacer when Feedback mode ends', () => {
    const editor = createEditorFixture();
    const controller = createFeedbackReviewController({ editor, host });
    controller.activate({
      sessionId: 'session-1',
      source: 'docs/guide.md',
      sourceSha256: 'c'.repeat(64),
      round: 'round-1',
      items: [],
    });
    expect(document.querySelector('[data-feedback-annotation-layer]')).not.toBeNull();

    controller.deactivate();

    expect(document.querySelector('[data-feedback-annotation-layer]')).toBeNull();
    expect(document.querySelector('[data-feedback-annotation-spacer]')).toBeNull();
    expect(document.querySelector('#editor')?.classList).not.toContain('feedback-review-surface');
  });

  it('emits one session-ended event before idempotent review teardown', () => {
    const editor = createEditorFixture();
    const ended = jest.fn();
    window.addEventListener('feedbackSessionEnded', ended);
    const controller = createFeedbackReviewController({ editor, host });
    controller.activate({
      sessionId: 'session-1',
      source: 'docs/guide.md',
      sourceSha256: 'c'.repeat(64),
      round: 'round-1',
      items: [],
    });

    controller.deactivate();
    controller.deactivate();

    expect(ended).toHaveBeenCalledTimes(1);
    window.removeEventListener('feedbackSessionEnded', ended);
  });

  it('preserves focus on the equivalent card action after a host refresh', () => {
    const editor = createEditorFixture();
    const controller = createFeedbackReviewController({ editor, host });
    const item = {
      id: 'F1',
      kind: 'text' as const,
      startOrdinal: 1,
      endOrdinal: 1,
      startLine: 3,
      endLine: 3,
      focus: 'Alpha beta',
      feedback: 'Clarify this.',
    };
    controller.activate({
      sessionId: 'session-1',
      source: 'docs/guide.md',
      sourceSha256: 'c'.repeat(64),
      round: 'round-1',
      items: [item],
    });
    (document.querySelector('[data-feedback-marker]') as HTMLButtonElement).click();
    const originalEdit = Array.from(
      document.querySelector('[data-feedback-card="F1"]')!.querySelectorAll('button')
    ).find(button => button.textContent === 'Edit') as HTMLButtonElement;
    originalEdit.focus();
    expect(document.activeElement).toBe(originalEdit);

    controller.handleHostMessage({
      type: 'feedback.updated',
      requestId: 'external-card-refresh',
      sessionId: controller.getSession()!.sessionId,
      items: [{ ...item, feedback: 'Use a concrete example.' }],
    });

    const refreshedEdit = Array.from(
      document.querySelector('[data-feedback-card="F1"]')!.querySelectorAll('button')
    ).find(button => button.textContent === 'Edit') as HTMLButtonElement;
    expect(refreshedEdit).not.toBe(originalEdit);
    expect(document.activeElement === refreshedEdit).toBe(true);
  });

  it('preserves focus on the equivalent marker after a collapsed host refresh', () => {
    const editor = createEditorFixture();
    const controller = createFeedbackReviewController({ editor, host });
    const item = {
      id: 'F1',
      kind: 'text' as const,
      startOrdinal: 1,
      endOrdinal: 1,
      startLine: 3,
      endLine: 3,
      focus: 'Alpha beta',
      feedback: 'Clarify this.',
    };
    controller.activate({
      sessionId: 'session-1',
      source: 'docs/guide.md',
      sourceSha256: 'c'.repeat(64),
      round: 'round-1',
      items: [item],
    });
    const originalMarker = document.querySelector('[data-feedback-marker]') as HTMLButtonElement;
    originalMarker.click();
    originalMarker.click();
    expect(document.activeElement).toBe(originalMarker);

    controller.handleHostMessage({
      type: 'feedback.updated',
      requestId: 'external-marker-refresh',
      sessionId: controller.getSession()!.sessionId,
      items: [{ ...item, feedback: 'Use a concrete example.' }],
    });

    const refreshedMarker = document.querySelector('[data-feedback-marker]') as HTMLButtonElement;
    expect(refreshedMarker).not.toBe(originalMarker);
    expect(document.activeElement === refreshedMarker).toBe(true);
  });

  it('preserves marker focus when a clustered marker loses its first member', () => {
    const editor = createEditorFixture();
    const controller = createFeedbackReviewController({ editor, host });
    const first = {
      id: 'F1',
      kind: 'text' as const,
      startOrdinal: 0,
      endOrdinal: 1,
      startLine: 1,
      endLine: 3,
      focus: 'Title\nAlpha beta',
      feedback: 'First note.',
    };
    const second = {
      id: 'F2',
      kind: 'text' as const,
      startOrdinal: 0,
      endOrdinal: 1,
      startLine: 1,
      endLine: 3,
      focus: 'Title\nAlpha beta',
      feedback: 'Second note.',
    };
    controller.activate({
      sessionId: 'session-1',
      source: 'docs/guide.md',
      sourceSha256: 'c'.repeat(64),
      round: 'round-1',
      items: [first, second],
    });
    const originalMarker = document.querySelector(
      '[data-feedback-ids="F1,F2"]'
    ) as HTMLButtonElement;
    originalMarker.focus();

    controller.handleHostMessage({
      type: 'feedback.updated',
      requestId: 'external-cluster-refresh',
      sessionId: controller.getSession()!.sessionId,
      items: [second],
    });

    const survivingMarker = document.querySelector('[data-feedback-ids="F2"]');
    expect(survivingMarker).not.toBeNull();
    expect(document.activeElement).toBe(survivingMarker);
  });

  it('keeps a remaining clustered comment active after its neighbour is removed', () => {
    const editor = createEditorFixture();
    const controller = createFeedbackReviewController({ editor, host });
    const remaining = {
      id: 'F2',
      kind: 'text' as const,
      startOrdinal: 0,
      endOrdinal: 1,
      startLine: 1,
      endLine: 3,
      focus: 'Title\nAlpha beta',
      feedback: 'Keep this one.',
    };
    controller.activate({
      sessionId: 'session-1',
      source: 'docs/guide.md',
      sourceSha256: 'c'.repeat(64),
      round: 'round-1',
      items: [
        {
          ...remaining,
          id: 'F1',
          feedback: 'Remove this one.',
        },
        remaining,
      ],
    });
    (document.querySelector('[data-feedback-marker]') as HTMLButtonElement).click();

    controller.updateItems([remaining]);

    const marker = document.querySelector('[data-feedback-marker]') as HTMLButtonElement;
    expect(marker.getAttribute('data-feedback-ids')).toBe('F2');
    expect(marker.classList).toContain('active');
    expect(marker.getAttribute('aria-expanded')).toBe('true');
    expect(document.querySelector('[data-feedback-card="F2"]')).not.toBeNull();
    expect(document.querySelector('.feedback-comment-rail')?.classList).toContain('expanded');
    expect(editor.view.dom.children[0].classList).toContain('feedback-active-target');
    expect(editor.view.dom.children[1].classList).toContain('feedback-active-target');
  });

  it('selects the deterministic surviving cluster when an active cluster splits', () => {
    const editor = createEditorFixture();
    const controller = createFeedbackReviewController({ editor, host });
    controller.activate({
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
          endLine: 3,
          focus: 'Title\nAlpha beta',
          feedback: 'First note.',
        },
        {
          id: 'F2',
          kind: 'text',
          startOrdinal: 0,
          endOrdinal: 1,
          startLine: 1,
          endLine: 3,
          focus: 'Title\nAlpha beta',
          feedback: 'Second note.',
        },
      ],
    });
    (document.querySelector('[data-feedback-marker]') as HTMLButtonElement).click();

    controller.updateItems([
      {
        id: 'F1',
        kind: 'text',
        startOrdinal: 0,
        endOrdinal: 0,
        startLine: 1,
        endLine: 1,
        focus: 'Title',
        feedback: 'First note.',
      },
      {
        id: 'F2',
        kind: 'text',
        startOrdinal: 3,
        endOrdinal: 3,
        startLine: 8,
        endLine: 9,
        focus: 'Quote',
        feedback: 'Second note.',
      },
    ]);

    const markers = Array.from(
      document.querySelectorAll<HTMLButtonElement>('[data-feedback-marker]')
    );
    const first = markers.find(marker => marker.dataset.feedbackIds === 'F1');
    const second = markers.find(marker => marker.dataset.feedbackIds === 'F2');
    expect(first?.classList).toContain('active');
    expect(first?.getAttribute('aria-expanded')).toBe('true');
    expect(second?.classList).not.toContain('active');
    expect(second?.getAttribute('aria-expanded')).toBe('false');
    expect(document.querySelector('[data-feedback-card="F1"]')).not.toBeNull();
    expect(
      document.querySelector('[data-feedback-card="F2"]')?.getAttribute('data-feedback-card-state')
    ).toBe('compact');
    expect(editor.view.dom.children[0].classList).toContain('feedback-active-target');
    expect(editor.view.dom.children[1].classList).not.toContain('feedback-active-target');
    expect(editor.view.dom.children[2].classList).not.toContain('feedback-active-target');
  });

  it('adopts a newly merged member into the active comment cluster', () => {
    const editor = createEditorFixture();
    const controller = createFeedbackReviewController({ editor, host });
    controller.activate({
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
          endLine: 3,
          focus: 'Title\nAlpha beta',
          feedback: 'First note.',
        },
        {
          id: 'F2',
          kind: 'text',
          startOrdinal: 3,
          endOrdinal: 3,
          startLine: 8,
          endLine: 9,
          focus: 'Quote',
          feedback: 'Second note.',
        },
      ],
    });
    const firstMarker = Array.from(
      document.querySelectorAll<HTMLButtonElement>('[data-feedback-marker]')
    ).find(marker => marker.dataset.feedbackIds === 'F1')!;
    firstMarker.click();

    controller.updateItems([
      {
        id: 'F1',
        kind: 'text',
        startOrdinal: 0,
        endOrdinal: 1,
        startLine: 1,
        endLine: 3,
        focus: 'Title\nAlpha beta',
        feedback: 'First note.',
      },
      {
        id: 'F2',
        kind: 'text',
        startOrdinal: 1,
        endOrdinal: 3,
        startLine: 3,
        endLine: 9,
        focus: 'Alpha beta\nQuote',
        feedback: 'Second note.',
      },
    ]);

    const mergedMarker = document.querySelector(
      '[data-feedback-marker][data-feedback-ids="F1,F2"]'
    ) as HTMLButtonElement;
    expect(mergedMarker).not.toBeNull();
    expect(mergedMarker.classList).toContain('active');
    expect(mergedMarker.getAttribute('aria-expanded')).toBe('true');
    expect(document.querySelector('[data-feedback-card="F1"]')).not.toBeNull();
    expect(document.querySelector('[data-feedback-card="F2"]')).not.toBeNull();
    expect(editor.view.dom.children[0].classList).toContain('feedback-active-target');
    expect(editor.view.dom.children[1].classList).toContain('feedback-active-target');
    expect(editor.view.dom.children[2].classList).not.toContain('feedback-active-target');
  });

  it('summarizes a structural saved target and activates its rendered blocks', () => {
    const editor = createEditorFixture();
    const controller = createFeedbackReviewController({ editor, host });
    controller.activate({
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
          endLine: 3,
          focus: 'Title\nAlpha beta',
          feedback: 'Clarify this.',
        },
      ],
    });

    (document.querySelector('[data-feedback-marker]') as HTMLButtonElement).click();

    expect(document.querySelector('[data-feedback-target-label]')?.textContent).toBe(
      'Selected blocks'
    );
    expect(document.querySelector('[data-feedback-target-detail]')?.textContent).toBe(
      '2 blocks · heading to paragraph'
    );
    expect(document.querySelector('[data-feedback-card-focus]')).toBeNull();
    expect(document.querySelector('[data-feedback-card="F1"]')?.textContent).toContain(
      'docs/guide.md:1-3'
    );
    expect(document.querySelector('[data-feedback-card-image]')).toBeNull();
    expect(editor.view.dom.children[0].classList).toContain('feedback-active-target');
    expect(editor.view.dom.children[1].classList).toContain('feedback-active-target');

    (document.querySelector('[data-feedback-panel-collapse]') as HTMLButtonElement).click();
    expect(editor.view.dom.querySelector('.feedback-active-target')).toBeNull();
  });

  it('shows a saved capture preview, refreshes it, and reports a load failure inline', () => {
    const editor = createEditorFixture();
    const controller = createFeedbackReviewController({ editor, host });
    const screenshot = {
      id: 'F1',
      kind: 'screenshot' as const,
      startOrdinal: 1,
      endOrdinal: 1,
      startLine: 3,
      endLine: 3,
      feedback: 'Make this section easier to scan.',
      imageUri: 'vscode-webview://feedback/F1.png?revision=1',
    };
    controller.activate({
      sessionId: 'session-1',
      source: 'docs/guide.md',
      sourceSha256: 'c'.repeat(64),
      round: 'round-1',
      items: [screenshot],
    });

    (document.querySelector('[data-feedback-marker]') as HTMLButtonElement).click();
    const preview = document.querySelector<HTMLImageElement>('[data-feedback-card-image]');
    expect(preview).not.toBeNull();
    expect(preview?.getAttribute('src')).toBe(screenshot.imageUri);
    expect(preview?.getAttribute('alt')).toContain('F1');
    expect(preview?.getAttribute('loading')).toBe('lazy');

    preview?.dispatchEvent(new Event('error'));
    expect(preview?.hidden).toBe(true);
    expect(document.querySelector('[data-feedback-card-image-error]')?.textContent).toContain(
      'Capture preview unavailable'
    );
    expect(document.querySelector('[data-feedback-card="F1"]')?.textContent).toContain(
      'Make this section easier to scan.'
    );

    controller.handleHostMessage({
      type: 'feedback.updated',
      requestId: 'replace-capture',
      sessionId: controller.getSession()!.sessionId,
      items: [{ ...screenshot, imageUri: 'vscode-webview://feedback/F1.png?revision=2' }],
    });

    const refreshed = document.querySelector<HTMLImageElement>('[data-feedback-card-image]');
    expect(refreshed?.getAttribute('src')).toContain('revision=2');
    expect(document.querySelector('[data-feedback-card="F1"]')).not.toBeNull();
    expect(document.querySelector('.feedback-comment-rail')?.classList).toContain('expanded');
  });

  it('reports runtime exact-target degradation once and includes only its ID at Finish', () => {
    const editor = createEditorFixture();
    const controller = createFeedbackReviewController({ editor, host });
    const sensitiveFocus = 'Alpha beta private quoted focus';
    const unresolvedItem = {
      id: 'F1',
      kind: 'text' as const,
      startOrdinal: 1,
      endOrdinal: 1,
      startLine: 3,
      endLine: 3,
      focus: sensitiveFocus,
      feedback: 'Clarify this.',
      renderedRange: {
        version: 1 as const,
        startOrdinal: 1,
        startOffset: 0,
        endOrdinal: 1,
        endOffset: 5,
        startBlockSha256: '1'.repeat(64),
        endBlockSha256: '1'.repeat(64),
      },
    };

    controller.activate({
      sessionId: 'session-1',
      source: 'docs/guide.md',
      sourceSha256: 'c'.repeat(64),
      round: 'round-1',
      items: [unresolvedItem],
    });
    controller.updateItems([unresolvedItem]);

    const reports = (host.postMessage as jest.Mock).mock.calls
      .map(call => call[0])
      .filter(message => message.type === 'feedback.capture.error');
    expect(reports).toHaveLength(1);
    expect(reports[0]).toEqual({
      type: 'feedback.capture.error',
      requestId: expect.any(String),
      sessionId: 'session-1',
      code: 'MD4H-FB-ANCHOR-001',
    });
    expect(JSON.stringify(reports[0])).not.toContain(sensitiveFocus);
    expect(document.querySelector('[data-feedback-anchor-alert]')).not.toBeNull();

    document.querySelector<HTMLButtonElement>('[data-feedback-marker]')?.click();
    expect(
      document
        .querySelector('[data-feedback-target-kind]')
        ?.getAttribute('data-feedback-target-kind')
    ).toBe('whole-block');
    expect(document.querySelector('[data-feedback-target-label]')?.textContent).toBe(
      'Whole paragraph'
    );
    expect(document.querySelector('[data-feedback-target-explanation]')?.textContent).toContain(
      'complete containing block'
    );
    expect(document.querySelector('[data-feedback-target-label]')?.textContent).not.toBe(
      'Selected text'
    );

    controller.finish();
    document.querySelector<HTMLButtonElement>('[data-feedback-completion-confirm]')?.click();
    const finish = (host.postMessage as jest.Mock).mock.calls
      .map(call => call[0])
      .find(message => message.type === 'feedback.finish');
    expect(finish).toEqual(
      expect.objectContaining({
        type: 'feedback.finish',
        sessionId: 'session-1',
        degradedTargetIds: ['F1'],
      })
    );
    expect(JSON.stringify(finish)).not.toContain(sensitiveFocus);
    controller.deactivate();
  });

  it('refreshes exact locator resolution when Finish is confirmed', () => {
    const editor = createTableEditorFixture();
    const table = editor.state.doc.maybeChild(0)!;
    const controller = createFeedbackReviewController({ editor, host });
    const item = {
      id: 'F1',
      kind: 'text' as const,
      startOrdinal: 0,
      endOrdinal: 0,
      startLine: 1,
      endLine: 4,
      focus: 'Role',
      feedback: 'Clarify this cell.',
      cellTarget: {
        version: 1 as const,
        tableOrdinal: 0,
        rectangle: { top: 0, left: 0, bottom: 1, right: 1 },
        tableFingerprint: fingerprintFeedbackTable({
          version: 1,
          tableOrdinal: 0,
          table,
        }).fingerprint,
        tableBlockSha256: '1'.repeat(64),
      },
    };

    controller.activate({
      sessionId: 'session-1',
      source: 'docs/table.md',
      sourceSha256: 'c'.repeat(64),
      round: 'round-1',
      items: [item],
    });
    expect(
      (host.postMessage as jest.Mock).mock.calls.some(
        call => call[0].type === 'feedback.capture.error'
      )
    ).toBe(false);

    controller.finish();
    expect(document.querySelector('[data-feedback-completion-dialog]')).not.toBeNull();

    const replacement = feedbackTableSchema.nodes.paragraph.create(
      null,
      feedbackTableSchema.text('The table is no longer resolvable.')
    );
    (editor.state as unknown as { doc: ProseMirrorNode }).doc =
      feedbackTableSchema.nodes.doc.create(null, replacement);

    document.querySelector<HTMLButtonElement>('[data-feedback-completion-confirm]')?.click();

    const finish = (host.postMessage as jest.Mock).mock.calls
      .map(call => call[0])
      .find(message => message.type === 'feedback.finish');
    expect(finish).toEqual(
      expect.objectContaining({
        type: 'feedback.finish',
        sessionId: 'session-1',
        degradedTargetIds: ['F1'],
      })
    );
    controller.deactivate();
  });

  it('caps exact cell expansion across a session and degrades later IDs deterministically', () => {
    const rows = 16;
    const columns = 16;
    const cellsPerLocator = rows * columns;
    const exactLocatorCount = FEEDBACK_MAX_EXACT_CELL_COUNT_PER_SESSION / cellsPerLocator;
    expect(exactLocatorCount).toBe(16);
    const editor = createRectangularTableEditorFixture(rows, columns);
    const table = editor.state.doc.child(0);
    const tableFingerprint = fingerprintFeedbackTable({
      version: 1,
      tableOrdinal: 0,
      table,
    }).fingerprint;
    const nodeAt = jest.spyOn(table, 'nodeAt');
    const items: FeedbackItemSummary[] = Array.from(
      { length: exactLocatorCount + 1 },
      (_, index) => ({
        id: `F${index + 1}`,
        kind: 'text' as const,
        startOrdinal: 0,
        endOrdinal: 0,
        startLine: 1,
        endLine: rows + 2,
        focus: 'Selected table cells',
        feedback: `Review rectangle ${index + 1}.`,
        cellTarget: {
          version: 1 as const,
          tableOrdinal: 0,
          rectangle: { top: 0, left: 0, bottom: rows, right: columns },
          tableFingerprint,
          tableBlockSha256: '1'.repeat(64),
        },
      })
    ).reverse();
    const controller = createFeedbackReviewController({ editor, host });

    controller.activate({
      sessionId: 'session-cell-budget',
      source: 'docs/table.md',
      sourceSha256: 'c'.repeat(64),
      round: 'round-1',
      anchors: [{ ordinal: 0, startLine: 1, endLine: rows + 2 }],
      items,
    });

    expect(nodeAt).toHaveBeenCalledTimes(FEEDBACK_MAX_EXACT_CELL_COUNT_PER_SESSION);
    controller.finish();
    const callsBeforeConfirm = nodeAt.mock.calls.length;
    document.querySelector<HTMLButtonElement>('[data-feedback-completion-confirm]')?.click();

    expect(nodeAt).toHaveBeenCalledTimes(callsBeforeConfirm);
    const finish = (host.postMessage as jest.Mock).mock.calls
      .map(call => call[0])
      .find(message => message.type === 'feedback.finish');
    expect(finish).toEqual(
      expect.objectContaining({
        sessionId: 'session-cell-budget',
        degradedTargetIds: [`F${exactLocatorCount + 1}`],
      })
    );
    controller.deactivate();
  });

  it('submits a new cell selection as whole-table feedback after the session cap is reached', () => {
    const editor = createTableEditorFixture();
    const table = editor.state.doc.child(0);
    const tableFingerprint = fingerprintFeedbackTable({
      version: 1,
      tableOrdinal: 0,
      table,
    }).fingerprint;
    const fullBudgetItems: FeedbackItemSummary[] = Array.from({ length: 16 }, (_, index) => ({
      id: `F${index + 1}`,
      kind: 'text' as const,
      startOrdinal: 0,
      endOrdinal: 0,
      startLine: 1,
      endLine: 4,
      focus: 'Previous table selection',
      feedback: `Review prior rectangle ${index + 1}.`,
      cellTarget: {
        version: 1 as const,
        tableOrdinal: 0,
        // Well-shaped metadata consumes the defensive budget even if a stale
        // renderer cannot resolve it against the current table dimensions.
        rectangle: { top: 0, left: 0, bottom: 16, right: 16 },
        tableFingerprint,
        tableBlockSha256: '1'.repeat(64),
      },
    }));
    const controller = createFeedbackReviewController({ editor, host });
    controller.activate({
      sessionId: 'session-cell-budget',
      source: 'docs/table.md',
      sourceSha256: 'c'.repeat(64),
      round: 'round-1',
      anchors: [{ ordinal: 0, startLine: 1, endLine: 4 }],
      items: fullBudgetItems,
    });

    controller.openTextComposer({
      startOrdinal: 0,
      endOrdinal: 0,
      focus: 'Role',
      startLine: 1,
      endLine: 4,
      cellTarget: {
        version: 1,
        tableOrdinal: 0,
        rectangle: { top: 0, left: 0, bottom: 1, right: 1 },
        tableFingerprint,
      },
    });

    expect(document.querySelector('[data-feedback-target-label]')?.textContent).toBe('Whole table');
    expect(document.querySelector('[data-feedback-target-explanation]')?.textContent).toContain(
      'session has reached its exact cell detail limit'
    );
    const field = document.querySelector<HTMLTextAreaElement>('[data-feedback-input]')!;
    field.value = 'Review this table as a whole.';
    field.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector<HTMLButtonElement>('[data-feedback-submit]')?.click();
    const add = (host.postMessage as jest.Mock).mock.calls
      .map(call => call[0])
      .find(message => message.type === 'feedback.text.add');
    expect(add).toEqual(
      expect.objectContaining({
        type: 'feedback.text.add',
        focus: '[table]',
        feedback: 'Review this table as a whole.',
      })
    );
    expect(add).not.toHaveProperty('cellTarget');
    controller.deactivate();
  });

  it('keeps cold oversized cell capture on the bounded whole-table path', () => {
    const rows = 17;
    const columns = 16;
    expect(rows * columns).toBeGreaterThan(FEEDBACK_MAX_EXACT_CELL_COUNT);
    const editor = createRectangularTableEditorFixture(rows, columns);
    const cells: number[] = [];
    editor.state.doc.descendants((node, position) => {
      if (node.type.spec.tableRole === 'cell' || node.type.spec.tableRole === 'header_cell') {
        cells.push(position);
      }
    });
    const selection = CellSelection.create(editor.state.doc, cells[0], cells[cells.length - 1]);
    (editor.state as unknown as { selection: CellSelection }).selection = selection;
    const table = editor.state.doc.child(0);
    const nodeAt = jest.spyOn(table, 'nodeAt');
    const toJSON = jest.spyOn(table, 'toJSON');
    const controller = createFeedbackReviewController({ editor, host });

    controller.activate({
      sessionId: 'session-1',
      source: 'docs/table.md',
      sourceSha256: 'c'.repeat(64),
      round: 'round-1',
      anchors: [{ ordinal: 0, startLine: 1, endLine: rows + 2 }],
      items: [],
    });

    expect(controller.commentOnSelection()).toBe(true);
    expect(document.querySelector('[data-feedback-target-label]')?.textContent).toBe('Whole table');
    expect(document.querySelector('[data-feedback-target-detail]')?.textContent).toBe(
      `${rows} rows × ${columns} columns`
    );
    expect(document.querySelector('[data-feedback-target-explanation]')?.textContent).toContain(
      'too large to anchor cell by cell'
    );

    const field = document.querySelector('[data-feedback-input]') as HTMLTextAreaElement;
    field.value = 'Summarize the whole table.';
    field.dispatchEvent(new Event('input', { bubbles: true }));
    (document.querySelector('[data-feedback-submit]') as HTMLButtonElement).click();

    const message = (host.postMessage as jest.Mock).mock.calls
      .map(call => call[0] as FeedbackWebviewMessage)
      .find(candidate => candidate.type === 'feedback.text.add');
    expect(message).toEqual(
      expect.objectContaining({
        type: 'feedback.text.add',
        startOrdinal: 0,
        endOrdinal: 0,
        focus: '[table]',
        feedback: 'Summarize the whole table.',
      })
    );
    expect(message).not.toHaveProperty('cellTarget');
    expect(nodeAt).not.toHaveBeenCalled();
    expect(toJSON).not.toHaveBeenCalled();
    controller.deactivate();
  });

  it('describes an unresolved saved cell target as a whole-table fallback', () => {
    const editor = createTableEditorFixture();
    const controller = createFeedbackReviewController({ editor, host });
    controller.activate({
      sessionId: 'session-1',
      source: 'docs/table.md',
      sourceSha256: 'c'.repeat(64),
      round: 'round-1',
      items: [
        {
          id: 'F1',
          kind: 'text',
          startOrdinal: 0,
          endOrdinal: 0,
          startLine: 1,
          endLine: 4,
          focus: 'Role\tPrimary concern',
          feedback: 'Clarify these cells.',
          cellTarget: {
            version: 1,
            tableOrdinal: 0,
            rectangle: { top: 0, left: 0, bottom: 1, right: 2 },
            tableFingerprint: `md4h-table/v1:${'0'.repeat(16)}`,
            tableBlockSha256: '0'.repeat(64),
          },
        },
      ],
    });

    document.querySelector<HTMLButtonElement>('[data-feedback-marker]')?.click();

    const target = document.querySelector<HTMLElement>('[data-feedback-target-kind]');
    expect(target?.dataset.feedbackTargetKind).toBe('whole-table');
    expect(target?.querySelector('[data-feedback-target-label]')?.textContent).toBe('Whole table');
    expect(target?.querySelector('[data-feedback-target-detail]')?.textContent).toBe(
      '2 rows × 2 columns'
    );
    expect(target?.querySelector('[data-feedback-target-preview]')).toBeNull();
    expect(target?.querySelector('[data-feedback-target-explanation]')?.textContent).toContain(
      'complete containing block'
    );
    expect(target?.textContent).not.toContain('Selected cells');
  });

  it('invalidates without discarding the draft and restores editing only when ended', () => {
    const editor = createEditorFixture();
    const controller = createFeedbackReviewController({ editor, host });
    controller.activate({
      sessionId: 'session-1',
      source: 'docs/guide.md',
      sourceSha256: 'd'.repeat(64),
      round: 'round-1',
      items: [],
    });

    controller.invalidate('MD4H-FB-SNAPSHOT-001');

    expect(document.querySelector('[role="alert"]')?.textContent).toContain('source changed');
    expect(editor.view.dom.getAttribute('aria-readonly')).toBe('true');

    controller.deactivate();
    expect(editor.view.dom.getAttribute('aria-readonly')).toBeNull();
    expect(editor.view.dom.getAttribute('contenteditable')).toBe('true');
    expect(document.body.classList.contains('feedback-review-active')).toBe(false);
  });

  it('preserves pending text as read-only when invalidated and exposes non-writable state', () => {
    const editor = createEditorFixture();
    const controller = createFeedbackReviewController({ editor, host });
    const invalidatedListener = jest.fn();
    window.addEventListener('feedbackInvalidated', invalidatedListener);
    try {
      controller.activate({
        sessionId: 'session-1',
        source: 'docs/guide.md',
        sourceSha256: 'd'.repeat(64),
        round: 'round-1',
        items: [],
      });
      controller.openTextComposer({
        startOrdinal: 1,
        endOrdinal: 1,
        focus: 'Alpha beta',
        startLine: 3,
        endLine: 3,
      });
      const composer = document.querySelector('.feedback-composer') as HTMLFormElement;
      const field = composer.querySelector('textarea') as HTMLTextAreaElement;
      const submit = composer.querySelector('[data-feedback-submit]') as HTMLButtonElement;
      field.value = 'Must not be posted after invalidation.';
      field.dispatchEvent(new Event('input', { bubbles: true }));

      expect(controller.isWritable()).toBe(true);
      expect(controller.isInvalidated()).toBe(false);
      controller.invalidate('MD4H-FB-SNAPSHOT-001');

      expect(controller.isWritable()).toBe(false);
      expect(controller.isInvalidated()).toBe(true);
      expect(document.querySelector('.feedback-composer') === composer).toBe(true);
      expect(document.querySelector('[data-feedback-input]') === field).toBe(true);
      expect(field.value).toBe('Must not be posted after invalidation.');
      expect(field.readOnly).toBe(true);
      expect(submit.disabled).toBe(true);
      expect(invalidatedListener).toHaveBeenCalledWith(
        expect.objectContaining({ detail: { code: 'MD4H-FB-SNAPSHOT-001' } })
      );
      composer.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      expect(
        (host.postMessage as jest.Mock).mock.calls.some(
          call => call[0].type === 'feedback.text.add'
        )
      ).toBe(false);
    } finally {
      window.removeEventListener('feedbackInvalidated', invalidatedListener);
    }
  });

  it('reuses one mapped block action and submits a plain whole-block target', async () => {
    const editor = createEditorFixture();
    const controller = createFeedbackReviewController({ editor, host });
    controller.activate({
      sessionId: 'session-1',
      source: 'docs/guide.md',
      sourceSha256: 'e'.repeat(64),
      round: 'round-1',
      anchors: [
        { ordinal: 0, startLine: 1, endLine: 1 },
        { ordinal: 1, startLine: 3, endLine: 3 },
        { ordinal: 3, startLine: 8, endLine: 9 },
      ],
      items: [],
    });
    const quote = editor.view.dom.children[3] as HTMLElement;
    const quoteParagraph = quote.querySelector('p') as HTMLParagraphElement;
    const quoteText = quoteParagraph.firstChild;
    const diagram = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    const diagramPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    diagram.append(diagramPath);
    quoteParagraph.append(diagram);
    const selectionSpy = jest.spyOn(window, 'getSelection').mockReturnValue({
      anchorNode: quoteText,
      focusNode: quoteText,
      anchorOffset: 2,
      focusOffset: 2,
      isCollapsed: true,
      rangeCount: 0,
      toString: () => '',
    } as unknown as Selection);

    try {
      dispatchFeedbackBlockHover(diagramPath);
      await waitForFeedbackFrame();

      const firstAction = document.querySelector<HTMLButtonElement>('[data-feedback-block-action]');
      expect(firstAction).not.toBeNull();
      if (!firstAction) throw new Error('Missing whole-block Feedback action');
      expect(firstAction.hidden).toBe(false);
      expect(firstAction.getAttribute('aria-label')).toBe('Add feedback to this block');

      dispatchFeedbackBlockHover(editor.view.dom.children[0]);
      await waitForFeedbackFrame();
      const headingAction = document.querySelector<HTMLButtonElement>(
        '[data-feedback-block-action]'
      );
      expect(headingAction).toBe(firstAction);
      expect(headingAction?.hidden).toBe(false);

      dispatchFeedbackBlockHover(diagramPath);
      await waitForFeedbackFrame();
      const quoteAction = document.querySelector<HTMLButtonElement>('[data-feedback-block-action]');
      expect(quoteAction).toBe(firstAction);
      quoteAction?.click();

      expect(document.querySelector('[data-feedback-focus]')?.textContent).toBe('Quote');
      const actionWhileComposing = document.querySelector<HTMLButtonElement>(
        '[data-feedback-block-action]'
      );
      expect(actionWhileComposing === null || actionWhileComposing.hidden).toBe(true);
      const field = document.querySelector('[data-feedback-input]') as HTMLTextAreaElement;
      field.value = 'Clarify this quotation.';
      field.dispatchEvent(new Event('input', { bubbles: true }));
      (document.querySelector('[data-feedback-submit]') as HTMLButtonElement).click();

      const message = (host.postMessage as jest.Mock).mock.calls
        .map(call => call[0] as FeedbackWebviewMessage)
        .find(candidate => candidate.type === 'feedback.text.add');
      expect(message).toEqual(
        expect.objectContaining({
          type: 'feedback.text.add',
          sessionId: 'session-1',
          startOrdinal: 3,
          endOrdinal: 3,
          focus: 'Quote',
          feedback: 'Clarify this quotation.',
        })
      );
      expect(message).not.toHaveProperty('renderedRange');
      expect(message).not.toHaveProperty('cellTarget');
    } finally {
      selectionSpy.mockRestore();
      controller.deactivate();
    }
  });

  it('keeps the exact-text action authoritative over a visible block action', async () => {
    const editor = createEditorFixture();
    const controller = createFeedbackReviewController({ editor, host });
    controller.activate({
      sessionId: 'session-1',
      source: 'docs/guide.md',
      sourceSha256: 'e'.repeat(64),
      round: 'round-1',
      anchors: [
        { ordinal: 0, startLine: 1, endLine: 1 },
        { ordinal: 1, startLine: 3, endLine: 3 },
      ],
      items: [],
    });
    const titleText = editor.view.dom.children[0].firstChild;
    const paragraphText = editor.view.dom.children[1].firstChild;
    const selectionRect = {
      left: 180,
      right: 300,
      top: 220,
      bottom: 242,
      width: 120,
      height: 22,
      x: 180,
      y: 220,
      toJSON: () => ({}),
    } as DOMRect;
    let currentSelection = {
      anchorNode: titleText,
      focusNode: titleText,
      anchorOffset: 2,
      focusOffset: 2,
      isCollapsed: true,
      rangeCount: 0,
      toString: () => '',
    } as unknown as Selection;
    const selectionSpy = jest
      .spyOn(window, 'getSelection')
      .mockImplementation(() => currentSelection);

    try {
      dispatchFeedbackBlockHover(editor.view.dom.children[0]);
      await waitForFeedbackFrame();
      const blockAction = document.querySelector<HTMLButtonElement>('[data-feedback-block-action]');
      expect(blockAction).not.toBeNull();
      expect(blockAction?.hidden).toBe(false);
      expect(
        document.querySelector<HTMLElement>('[data-feedback-block-target-preview]')?.hidden
      ).toBe(false);

      currentSelection = {
        anchorNode: titleText,
        focusNode: paragraphText,
        anchorOffset: 0,
        focusOffset: 5,
        isCollapsed: false,
        rangeCount: 1,
        getRangeAt: () =>
          ({
            getClientRects: () => [selectionRect],
            getBoundingClientRect: () => selectionRect,
          }) as unknown as Range,
        toString: () => 'Title\nAlpha',
      } as unknown as Selection;
      document.dispatchEvent(new Event('selectionchange'));
      await waitForFeedbackFrame();

      expect(blockAction?.hidden).toBe(true);
      expect(
        document.querySelector<HTMLElement>('[data-feedback-block-target-preview]')?.hidden
      ).toBe(true);
      const selectionAction = document.querySelector<HTMLButtonElement>(
        '[data-feedback-selection-action]'
      );
      expect(selectionAction).not.toBeNull();
      expect(selectionAction?.getAttribute('aria-label')).toBe('Add feedback to selected text');

      dispatchFeedbackBlockHover(editor.view.dom.children[1]);
      await waitForFeedbackFrame();
      expect(blockAction?.hidden).toBe(true);
      expect(document.querySelectorAll('[data-feedback-block-action]')).toHaveLength(1);
      expect(document.querySelector('[data-feedback-selection-action]')).toBe(selectionAction);
    } finally {
      selectionSpy.mockRestore();
      controller.deactivate();
    }
  });

  it('suppresses block feedback for whitespace selection and a connected outside-editor caret', async () => {
    const editor = createEditorFixture();
    const title = editor.view.dom.children[0] as HTMLElement;
    const titleText = title.firstChild;
    const whitespace = document.createTextNode('   ');
    title.append(whitespace);
    let currentSelection: Selection = {
      anchorNode: titleText,
      focusNode: titleText,
      anchorOffset: 2,
      focusOffset: 2,
      isCollapsed: true,
      rangeCount: 0,
      toString: () => '',
    } as unknown as Selection;
    const selectionSpy = jest
      .spyOn(window, 'getSelection')
      .mockImplementation(() => currentSelection);
    const controller = createFeedbackReviewController({ editor, host });

    try {
      controller.activate({
        sessionId: 'session-1',
        source: 'docs/guide.md',
        sourceSha256: 'e'.repeat(64),
        round: 'round-1',
        anchors: [{ ordinal: 0, startLine: 1, endLine: 1 }],
        items: [],
      });
      dispatchFeedbackBlockHover(title);
      await waitForFeedbackFrame();

      const action = document.querySelector<HTMLButtonElement>('[data-feedback-block-action]');
      expect(action).not.toBeNull();
      expect(action?.hidden).toBe(false);

      title.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
      expect(action?.hidden).toBe(true);

      currentSelection = {
        anchorNode: whitespace,
        focusNode: whitespace,
        anchorOffset: 0,
        focusOffset: 3,
        isCollapsed: false,
        rangeCount: 1,
        getRangeAt: () => document.createRange(),
        toString: () => '   ',
      } as unknown as Selection;
      document.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }));
      document.dispatchEvent(new Event('selectionchange'));
      await waitForFeedbackFrame();

      expect(action?.hidden).toBe(true);
      expect(document.querySelector('[data-feedback-selection-action]')).toBeNull();

      const outsideText = document.createTextNode('Feedback toolbar');
      document.querySelector('.formatting-toolbar')?.append(outsideText);
      currentSelection = {
        anchorNode: outsideText,
        focusNode: outsideText,
        anchorOffset: 2,
        focusOffset: 2,
        isCollapsed: true,
        rangeCount: 0,
        toString: () => '',
      } as unknown as Selection;
      dispatchFeedbackBlockHover(title);
      await waitForFeedbackFrame();

      expect(action?.hidden).toBe(true);
      expect(document.querySelector('[data-feedback-selection-action]')).toBeNull();
    } finally {
      controller.deactivate();
      selectionSpy.mockRestore();
    }
  });

  it('captures the pointer on the editor surface when a block drag starts', async () => {
    const editor = createEditorFixture();
    const title = editor.view.dom.children[0] as HTMLElement;
    const controller = createFeedbackReviewController({ editor, host });
    if (!('setPointerCapture' in HTMLElement.prototype)) {
      (
        HTMLElement.prototype as { setPointerCapture?: (pointerId: number) => void }
      ).setPointerCapture = () => {};
    }
    const setPointerCaptureSpy = jest
      .spyOn(HTMLElement.prototype, 'setPointerCapture')
      .mockImplementation(() => {});

    try {
      controller.activate({
        sessionId: 'session-1',
        source: 'docs/guide.md',
        sourceSha256: 'e'.repeat(64),
        round: 'round-1',
        anchors: [{ ordinal: 0, startLine: 1, endLine: 1 }],
        items: [],
      });

      const pointerDown = new MouseEvent('pointerdown', { bubbles: true });
      Object.defineProperty(pointerDown, 'pointerId', { value: 17 });
      title.dispatchEvent(pointerDown);

      expect(setPointerCaptureSpy).toHaveBeenCalledWith(17);
      expect(setPointerCaptureSpy.mock.instances[0]).toBe(editor.view.dom);
    } finally {
      controller.deactivate();
      setPointerCaptureSpy.mockRestore();
    }
  });

  it('resets the block drag state on a window blur so hover works normally afterward', async () => {
    const editor = createEditorFixture();
    const title = editor.view.dom.children[0] as HTMLElement;
    const titleText = title.firstChild;
    const controller = createFeedbackReviewController({ editor, host });
    if (!('setPointerCapture' in HTMLElement.prototype)) {
      (
        HTMLElement.prototype as { setPointerCapture?: (pointerId: number) => void }
      ).setPointerCapture = () => {};
    }
    const setPointerCaptureSpy = jest
      .spyOn(HTMLElement.prototype, 'setPointerCapture')
      .mockImplementation(() => {});
    const selectionSpy = jest.spyOn(window, 'getSelection').mockReturnValue({
      anchorNode: titleText,
      focusNode: titleText,
      anchorOffset: 2,
      focusOffset: 2,
      isCollapsed: true,
      rangeCount: 0,
      toString: () => '',
    } as unknown as Selection);

    try {
      controller.activate({
        sessionId: 'session-1',
        source: 'docs/guide.md',
        sourceSha256: 'e'.repeat(64),
        round: 'round-1',
        anchors: [{ ordinal: 0, startLine: 1, endLine: 1 }],
        items: [],
      });

      dispatchFeedbackBlockHover(title);
      await waitForFeedbackFrame();
      const action = document.querySelector<HTMLButtonElement>('[data-feedback-block-action]');
      expect(action?.hidden).toBe(false);

      const pointerDown = new MouseEvent('pointerdown', { bubbles: true });
      Object.defineProperty(pointerDown, 'pointerId', { value: 21 });
      title.dispatchEvent(pointerDown);
      expect(action?.hidden).toBe(true);

      // The pointer never reaches this document's pointerup/pointercancel
      // listeners (e.g. released outside the rendered viewport); only a
      // window blur signals that the drag ended.
      window.dispatchEvent(new Event('blur'));

      dispatchFeedbackBlockHover(title);
      await waitForFeedbackFrame();

      expect(action?.hidden).toBe(false);
    } finally {
      controller.deactivate();
      setPointerCaptureSpy.mockRestore();
      selectionSpy.mockRestore();
    }
  });

  it('hides the block action while the keyboard capture picker owns the draft gate', async () => {
    const editor = createEditorFixture();
    const title = editor.view.dom.children[0] as HTMLElement;
    const titleText = title.firstChild;
    const selectionSpy = jest.spyOn(window, 'getSelection').mockReturnValue({
      anchorNode: titleText,
      focusNode: titleText,
      anchorOffset: 2,
      focusOffset: 2,
      isCollapsed: true,
      rangeCount: 0,
      toString: () => '',
    } as unknown as Selection);
    const controller = createFeedbackReviewController({ editor, host });

    try {
      editor.view.dom.focus();
      controller.activate({
        sessionId: 'session-1',
        source: 'docs/guide.md',
        sourceSha256: 'e'.repeat(64),
        round: 'round-1',
        anchors: [
          { ordinal: 0, startLine: 1, endLine: 1 },
          { ordinal: 1, startLine: 3, endLine: 3 },
        ],
        items: [],
      });
      dispatchFeedbackBlockHover(title);
      await waitForFeedbackFrame();

      const action = document.querySelector<HTMLButtonElement>('[data-feedback-block-action]');
      if (!action) throw new Error('Missing whole-block Feedback action');
      expect(action.hidden).toBe(false);

      captureSelectedFeedbackBlocks({ editor, review: controller, rasterize: jest.fn() });
      const picker = document.querySelector<HTMLFormElement>('.feedback-block-selector');
      if (!picker) throw new Error('Missing keyboard capture block selector');
      const hiddenWhilePickerOwnsGate = action.hidden;

      action.click();
      const clickStayedInert =
        document.querySelector('.feedback-composer') === null && picker.isConnected;
      const cancel = Array.from(picker.querySelectorAll<HTMLButtonElement>('button')).find(
        button => button.textContent === 'Cancel'
      );
      if (!cancel) throw new Error('Missing keyboard capture cancel button');
      cancel.click();

      expect({
        hiddenWhilePickerOwnsGate,
        clickStayedInert,
        pickerClosed: !picker.isConnected,
        actionRestored: !action.hidden,
      }).toEqual({
        hiddenWhilePickerOwnsGate: true,
        clickStayedInert: true,
        pickerClosed: true,
        actionRestored: true,
      });
    } finally {
      controller.deactivate();
      selectionSpy.mockRestore();
    }
  });

  it('keeps focus through the block-action handoff and restores the editor after cancel', async () => {
    const editor = createEditorFixture();
    const paragraph = editor.view.dom.children[1] as HTMLElement;
    const paragraphText = paragraph.firstChild;
    const selectionSpy = jest.spyOn(window, 'getSelection').mockReturnValue({
      anchorNode: paragraphText,
      focusNode: paragraphText,
      anchorOffset: 2,
      focusOffset: 2,
      isCollapsed: true,
      rangeCount: 0,
      toString: () => '',
    } as unknown as Selection);
    const controller = createFeedbackReviewController({ editor, host });

    try {
      controller.activate({
        sessionId: 'session-1',
        source: 'docs/guide.md',
        sourceSha256: 'e'.repeat(64),
        round: 'round-1',
        anchors: [{ ordinal: 1, startLine: 3, endLine: 3 }],
        items: [],
      });
      dispatchFeedbackBlockHover(paragraph);
      await waitForFeedbackFrame();

      const action = document.querySelector<HTMLButtonElement>('[data-feedback-block-action]');
      if (!action) throw new Error('Missing whole-block Feedback action');
      expect(action.hidden).toBe(false);
      action.focus();
      expect(document.activeElement).toBe(action);

      jest.useFakeTimers();
      editor.view.dom.dispatchEvent(new MouseEvent('pointerleave', { relatedTarget: action }));
      jest.advanceTimersByTime(100);
      expect(action.hidden).toBe(false);
      expect(document.activeElement).toBe(action);

      action.click();
      const field = document.querySelector<HTMLTextAreaElement>('[data-feedback-input]');
      expect(field).not.toBeNull();
      expect(document.activeElement).toBe(field);
      expect(action.hidden).toBe(true);
      document.querySelector<HTMLButtonElement>('.feedback-composer-actions button')?.click();

      expect(document.querySelector('.feedback-composer')).toBeNull();
      expect(document.activeElement).toBe(editor.view.dom);
      expect(action.hidden).toBe(false);
    } finally {
      controller.deactivate();
      jest.useRealTimers();
      selectionSpy.mockRestore();
    }
  });

  it('clears stale gutter hover after an outside leave and after a focused action blurs', async () => {
    const editor = createEditorFixture();
    const paragraph = editor.view.dom.children[1] as HTMLElement;
    const outside = document.createElement('button');
    outside.textContent = 'Outside feedback gutter';
    document.body.append(outside);
    const selectionSpy = jest.spyOn(window, 'getSelection').mockReturnValue({
      anchorNode: null,
      focusNode: null,
      isCollapsed: true,
      rangeCount: 0,
      toString: () => '',
    } as unknown as Selection);
    const controller = createFeedbackReviewController({ editor, host });

    try {
      controller.activate({
        sessionId: 'session-1',
        source: 'docs/guide.md',
        sourceSha256: 'e'.repeat(64),
        round: 'round-1',
        anchors: [{ ordinal: 1, startLine: 3, endLine: 3 }],
        items: [],
      });
      dispatchFeedbackBlockHover(paragraph);
      await waitForFeedbackFrame();

      const action = document.querySelector<HTMLButtonElement>('[data-feedback-block-action]');
      if (!action) throw new Error('Missing whole-block Feedback action');
      expect(action.hidden).toBe(false);

      jest.useFakeTimers();
      editor.view.dom.dispatchEvent(new MouseEvent('pointerleave', { relatedTarget: outside }));
      jest.advanceTimersByTime(79);
      const stableBeforeOutsideDelay = !action.hidden;
      jest.advanceTimersByTime(1);
      const clearedAfterOutsideLeave = action.hidden;
      jest.useRealTimers();

      dispatchFeedbackBlockHover(paragraph);
      await waitForFeedbackFrame();
      action.focus();
      jest.useFakeTimers();
      editor.view.dom.dispatchEvent(new MouseEvent('pointerleave', { relatedTarget: action }));
      jest.advanceTimersByTime(100);
      const stableDuringFocusedHandoff = !action.hidden && document.activeElement === action;

      outside.focus();
      jest.advanceTimersByTime(100);

      expect({
        stableBeforeOutsideDelay,
        clearedAfterOutsideLeave,
        stableDuringFocusedHandoff,
        clearedAfterFocusout: action.hidden,
      }).toEqual({
        stableBeforeOutsideDelay: true,
        clearedAfterOutsideLeave: true,
        stableDuringFocusedHandoff: true,
        clearedAfterFocusout: true,
      });
    } finally {
      controller.deactivate();
      jest.useRealTimers();
      selectionSpy.mockRestore();
    }
  });

  it('restores editor focus when a focused block action is removed by deactivation', async () => {
    const editor = createEditorFixture();
    const paragraph = editor.view.dom.children[1] as HTMLElement;
    const paragraphText = paragraph.firstChild;
    const selectionSpy = jest.spyOn(window, 'getSelection').mockReturnValue({
      anchorNode: paragraphText,
      focusNode: paragraphText,
      anchorOffset: 2,
      focusOffset: 2,
      isCollapsed: true,
      rangeCount: 0,
      toString: () => '',
    } as unknown as Selection);
    const controller = createFeedbackReviewController({ editor, host });

    try {
      controller.activate({
        sessionId: 'session-1',
        source: 'docs/guide.md',
        sourceSha256: 'e'.repeat(64),
        round: 'round-1',
        anchors: [{ ordinal: 1, startLine: 3, endLine: 3 }],
        items: [],
      });
      dispatchFeedbackBlockHover(paragraph);
      await waitForFeedbackFrame();
      const action = document.querySelector<HTMLButtonElement>('[data-feedback-block-action]');
      if (!action) throw new Error('Missing whole-block Feedback action');
      action.focus();

      controller.deactivate();

      expect(action.isConnected).toBe(false);
      expect(document.activeElement).toBe(editor.view.dom);
    } finally {
      controller.deactivate();
      selectionSpy.mockRestore();
    }
  });

  it('hides a focused block action when discard close becomes pending and restores editor focus', async () => {
    const editor = createEditorFixture();
    const paragraph = editor.view.dom.children[1] as HTMLElement;
    const paragraphText = paragraph.firstChild;
    const selectionSpy = jest.spyOn(window, 'getSelection').mockReturnValue({
      anchorNode: paragraphText,
      focusNode: paragraphText,
      anchorOffset: 2,
      focusOffset: 2,
      isCollapsed: true,
      rangeCount: 0,
      toString: () => '',
    } as unknown as Selection);
    const controller = createFeedbackReviewController({ editor, host });

    try {
      controller.activate({
        sessionId: 'session-1',
        source: 'docs/guide.md',
        sourceSha256: 'e'.repeat(64),
        round: 'round-1',
        anchors: [{ ordinal: 1, startLine: 3, endLine: 3 }],
        items: [],
      });
      dispatchFeedbackBlockHover(paragraph);
      await waitForFeedbackFrame();
      const action = document.querySelector<HTMLButtonElement>('[data-feedback-block-action]');
      if (!action) throw new Error('Missing whole-block Feedback action');
      action.focus();

      controller.handleHostMessage({
        type: 'feedback.discarded',
        requestId: 'discard-current',
        sessionId: 'session-1',
      });
      const hiddenWhenCloseBecamePending = action.hidden;
      const applied = controller.applyCloseSync(
        {
          type: 'feedback.close.sync',
          requestId: 'discard-current',
          sessionId: 'session-1',
          revision: 1,
          content: '# Authoritative source\n',
        },
        () => true
      );
      controller.handleHostMessage({
        type: 'feedback.close.release',
        requestId: 'discard-current',
        sessionId: 'session-1',
        revision: 1,
      });
      const completed = controller.completeClose('session-1');

      expect({
        hiddenWhenCloseBecamePending,
        applied,
        completed,
        editorFocused: document.activeElement === editor.view.dom,
      }).toEqual({
        hiddenWhenCloseBecamePending: true,
        applied: true,
        completed: true,
        editorFocused: true,
      });
    } finally {
      controller.deactivate();
      selectionSpy.mockRestore();
    }
  });

  it('fails block hover closed and removes its action across invalidation and teardown', async () => {
    const editor = createEditorFixture();
    const controller = createFeedbackReviewController({ editor, host });
    controller.activate({
      sessionId: 'session-1',
      source: 'docs/guide.md',
      sourceSha256: 'e'.repeat(64),
      round: 'round-1',
      anchors: [{ ordinal: 1, startLine: 3, endLine: 3 }],
      items: [],
    });
    const paragraphText = editor.view.dom.children[1].firstChild;
    const selectionSpy = jest.spyOn(window, 'getSelection').mockReturnValue({
      anchorNode: paragraphText,
      focusNode: paragraphText,
      anchorOffset: 2,
      focusOffset: 2,
      isCollapsed: true,
      rangeCount: 0,
      toString: () => '',
    } as unknown as Selection);

    try {
      dispatchFeedbackBlockHover(editor.view.dom.children[1]);
      await waitForFeedbackFrame();
      const action = document.querySelector<HTMLButtonElement>('[data-feedback-block-action]');
      expect(action).not.toBeNull();
      expect(action?.hidden).toBe(false);

      dispatchFeedbackBlockHover(editor.view.dom.children[2]);
      await waitForFeedbackFrame();
      expect(action?.hidden).toBe(true);

      dispatchFeedbackBlockHover(editor.view.dom.children[1]);
      await waitForFeedbackFrame();
      expect(action?.hidden).toBe(false);

      controller.invalidate('MD4H-FB-SNAPSHOT-001');
      expect(action?.hidden).toBe(true);

      controller.deactivate();
      expect(action?.isConnected).toBe(false);
      expect(document.querySelector('[data-feedback-block-action]')).toBeNull();
    } finally {
      selectionSpy.mockRestore();
      controller.deactivate();
    }
  });

  it('places a selection-local Add feedback action outside the comments rail', async () => {
    const editor = createEditorFixture();
    const controller = createFeedbackReviewController({ editor, host });
    controller.activate({
      sessionId: 'session-1',
      source: 'docs/guide.md',
      sourceSha256: 'e'.repeat(64),
      round: 'round-1',
      anchors: [
        { ordinal: 0, startLine: 1, endLine: 1 },
        { ordinal: 1, startLine: 3, endLine: 3 },
      ],
      items: [],
    });
    controller.toggleComments(false);
    const selectionRect = {
      left: 180,
      right: 300,
      top: 220,
      bottom: 242,
      width: 120,
      height: 22,
      x: 180,
      y: 220,
      toJSON: () => ({}),
    } as DOMRect;
    const selectionSpy = jest.spyOn(window, 'getSelection').mockReturnValue({
      anchorNode: editor.view.dom.children[0].firstChild,
      focusNode: editor.view.dom.children[1].firstChild,
      anchorOffset: 0,
      focusOffset: 5,
      isCollapsed: false,
      rangeCount: 1,
      getRangeAt: () =>
        ({
          getClientRects: () => [selectionRect],
          getBoundingClientRect: () => selectionRect,
        }) as unknown as Range,
      toString: () => 'Title\nAlpha',
    } as unknown as Selection);

    document.dispatchEvent(new Event('selectionchange'));
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));

    const action = document.querySelector('[data-feedback-selection-action]') as HTMLButtonElement;
    expect(action).not.toBeNull();
    expect(action.getAttribute('aria-label')).toBe('Add feedback to selected text');
    expect(action.querySelector('.codicon-comment-discussion-sparkle')).not.toBeNull();
    expect(action.closest('.feedback-comment-rail')).toBeNull();
    expect(action.style.left).toBe('308px');
    expect(action.style.top).toBe('250px');
    const pointerDown = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    expect(action.dispatchEvent(pointerDown)).toBe(false);
    action.click();
    expect(document.querySelector('[data-feedback-target-label]')?.textContent).toBe(
      'Selected blocks'
    );
    expect(document.querySelector('[data-feedback-target-detail]')?.textContent).toBe(
      '2 blocks · heading to paragraph'
    );
    expect(document.querySelector('[data-feedback-focus]')).toBeNull();
    selectionSpy.mockRestore();
  });

  it('revalidates the live selection before opening a composer from a stale action', async () => {
    const editor = createEditorFixture();
    const controller = createFeedbackReviewController({ editor, host });
    controller.activate({
      sessionId: 'session-1',
      source: 'docs/guide.md',
      sourceSha256: 'e'.repeat(64),
      round: 'round-1',
      anchors: [
        { ordinal: 0, startLine: 1, endLine: 1 },
        { ordinal: 1, startLine: 3, endLine: 3 },
      ],
      items: [],
    });
    const titleText = editor.view.dom.children[0].firstChild;
    const paragraphText = editor.view.dom.children[1].firstChild;
    let currentSelection = {
      anchorNode: titleText,
      focusNode: paragraphText,
      anchorOffset: 0,
      focusOffset: 5,
      isCollapsed: false,
      rangeCount: 0,
      toString: () => 'Title\nAlpha',
    } as unknown as Selection;
    const selectionSpy = jest
      .spyOn(window, 'getSelection')
      .mockImplementation(() => currentSelection);

    try {
      document.dispatchEvent(new Event('selectionchange'));
      await waitForFeedbackFrame();
      const staleAction = document.querySelector<HTMLButtonElement>(
        '[data-feedback-selection-action]'
      );
      expect(staleAction).not.toBeNull();

      currentSelection = {
        anchorNode: paragraphText,
        focusNode: paragraphText,
        anchorOffset: 0,
        focusOffset: 5,
        isCollapsed: false,
        rangeCount: 0,
        toString: () => 'Alpha',
      } as unknown as Selection;
      staleAction?.click();

      expect(document.querySelector('[data-feedback-target-label]')?.textContent).toBe(
        'Whole paragraph'
      );
      expect(document.querySelector('[data-feedback-target-detail]')?.textContent).toBe(
        'paragraph'
      );
      expect(document.querySelector('[data-feedback-focus]')?.textContent).toBe('Alpha beta');
    } finally {
      selectionSpy.mockRestore();
      controller.deactivate();
    }
  });

  it('removes the selection action when the live browser range is cleared', async () => {
    const editor = createEditorFixture();
    (
      editor.state as unknown as { selection: { from: number; to: number; empty: boolean } }
    ).selection = { from: 1, to: 6, empty: false };
    const controller = createFeedbackReviewController({ editor, host });
    controller.activate({
      sessionId: 'session-1',
      source: 'docs/guide.md',
      sourceSha256: 'e'.repeat(64),
      round: 'round-1',
      anchors: [{ ordinal: 0, startLine: 1, endLine: 1 }],
      items: [],
    });
    const selectionRect = {
      left: 180,
      right: 240,
      top: 220,
      bottom: 242,
      width: 60,
      height: 22,
      x: 180,
      y: 220,
      toJSON: () => ({}),
    } as DOMRect;
    let currentSelection = {
      anchorNode: editor.view.dom.children[0].firstChild,
      focusNode: editor.view.dom.children[0].firstChild,
      anchorOffset: 0,
      focusOffset: 5,
      isCollapsed: false,
      rangeCount: 1,
      getRangeAt: () =>
        ({
          getClientRects: () => [selectionRect],
          getBoundingClientRect: () => selectionRect,
        }) as unknown as Range,
      toString: () => 'Title',
    } as unknown as Selection;
    const selectionSpy = jest
      .spyOn(window, 'getSelection')
      .mockImplementation(() => currentSelection);

    try {
      document.dispatchEvent(new Event('selectionchange'));
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      expect(document.querySelector('[data-feedback-selection-action]')).not.toBeNull();

      currentSelection = {
        anchorNode: null,
        focusNode: null,
        isCollapsed: true,
        rangeCount: 0,
        toString: () => '',
      } as unknown as Selection;
      document.dispatchEvent(new Event('selectionchange'));
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));

      expect(document.querySelector('[data-feedback-selection-action]')).toBeNull();
    } finally {
      selectionSpy.mockRestore();
    }
  });

  it('keeps explicit keyboard commenting available for a ProseMirror-only selection', () => {
    const editor = createEditorFixture();
    (
      editor.state as unknown as { selection: { from: number; to: number; empty: boolean } }
    ).selection = { from: 1, to: 6, empty: false };
    const controller = createFeedbackReviewController({ editor, host });
    controller.activate({
      sessionId: 'session-1',
      source: 'docs/guide.md',
      sourceSha256: 'e'.repeat(64),
      round: 'round-1',
      anchors: [{ ordinal: 0, startLine: 1, endLine: 1 }],
      items: [],
    });
    const selectionSpy = jest.spyOn(window, 'getSelection').mockReturnValue({
      anchorNode: null,
      focusNode: null,
      isCollapsed: true,
      rangeCount: 0,
      toString: () => '',
    } as unknown as Selection);

    try {
      expect(controller.commentOnSelection()).toBe(true);
      expect(document.querySelector('.feedback-composer')).not.toBeNull();
      expect(document.querySelector('[data-feedback-focus]')?.textContent).toBe('Title');
      expect(document.querySelector('[data-feedback-text-block-selector]')).toBeNull();
    } finally {
      selectionSpy.mockRestore();
    }
  });

  it('never turns text selected inside a feedback card into recursive feedback', () => {
    const editor = createEditorFixture();
    (
      editor.state as unknown as { selection: { from: number; to: number; empty: boolean } }
    ).selection = { from: 1, to: 6, empty: false };
    const controller = createFeedbackReviewController({ editor, host });
    controller.activate({
      sessionId: 'session-1',
      source: 'docs/guide.md',
      sourceSha256: 'e'.repeat(64),
      round: 'round-1',
      anchors: [{ ordinal: 0, startLine: 1, endLine: 1 }],
      items: [
        {
          id: 'F1',
          kind: 'text',
          startOrdinal: 0,
          endOrdinal: 0,
          startLine: 1,
          endLine: 1,
          focus: 'Title',
          feedback: 'Clarify this heading.',
        },
      ],
    });
    (document.querySelector('[data-feedback-marker]') as HTMLButtonElement).click();
    const cardFocus = document.querySelector('[data-feedback-card-focus]') as HTMLElement;
    const cardText = cardFocus.firstChild!;
    const selectionSpy = jest.spyOn(window, 'getSelection').mockReturnValue({
      anchorNode: cardText,
      focusNode: cardText,
      anchorOffset: 0,
      focusOffset: cardText.textContent?.length ?? 0,
      isCollapsed: false,
      rangeCount: 1,
      getRangeAt: () => document.createRange(),
      toString: () => 'Title',
    } as unknown as Selection);

    try {
      document.dispatchEvent(new Event('selectionchange'));

      expect(document.querySelector('[data-feedback-selection-action]')).toBeNull();
      expect(controller.commentOnSelection()).toBe(false);
      expect(document.querySelector('.feedback-composer')).toBeNull();
      expect(document.querySelector('[data-feedback-text-block-selector]')).toBeNull();
    } finally {
      selectionSpy.mockRestore();
    }
  });

  it('observes editor layout changes and disconnects the observer on destroy', () => {
    const originalResizeObserver = global.ResizeObserver;
    const observe = jest.fn();
    const unobserve = jest.fn();
    const disconnect = jest.fn();
    let callback: ResizeObserverCallback | undefined;
    Object.defineProperty(global, 'ResizeObserver', {
      configurable: true,
      writable: true,
      value: class {
        constructor(nextCallback: ResizeObserverCallback) {
          callback = nextCallback;
        }
        observe = observe;
        unobserve = unobserve;
        disconnect = disconnect;
      },
    });
    const editor = createEditorFixture();
    const controller = createFeedbackReviewController({ editor, host });
    controller.activate({
      sessionId: 'session-1',
      source: 'docs/guide.md',
      sourceSha256: 'f'.repeat(64),
      round: 'round-1',
      items: [],
    });

    expect(observe).toHaveBeenCalledWith(editor.view.dom);
    controller.openTextComposer({
      startOrdinal: 1,
      endOrdinal: 1,
      startLine: 3,
      endLine: 3,
      focus: 'Alpha beta',
    });
    const composer = document.querySelector<HTMLElement>('.feedback-composer');
    expect(composer).not.toBeNull();
    expect(observe).toHaveBeenCalledWith(composer);
    document.querySelector<HTMLButtonElement>('.feedback-composer-actions button')?.click();
    expect(unobserve).toHaveBeenCalledWith(composer);
    expect(callback).toBeDefined();
    const destroyHandler = (editor.on as jest.Mock).mock.calls.find(
      call => call[0] === 'destroy'
    )?.[1] as (() => void) | undefined;
    destroyHandler?.();
    expect(disconnect).toHaveBeenCalled();
    Object.defineProperty(global, 'ResizeObserver', {
      configurable: true,
      writable: true,
      value: originalResizeObserver,
    });
  });

  it('announces a matching draft and enters read-only mode only after Resume is chosen', () => {
    const editor = createEditorFixture();
    const controller = createFeedbackReviewController({ editor, host });

    controller.handleHostMessage({
      type: 'feedback.drafts.available',
      drafts: [
        {
          round: '20260821T093000Z-k4p9',
          createdAt: '2026-08-21T09:30:00.000Z',
          itemCount: 2,
          feedbackFile: '.md4h/feedback/docs/guide.md--20260821T093000Z-k4p9/feedback.md',
        },
      ],
    });

    expect(editor.view.dom.getAttribute('aria-readonly')).toBeNull();
    expect(document.querySelector('[data-feedback-draft-banner]')?.textContent).toContain(
      '2 comments'
    );

    const resumeListener = jest.fn();
    window.addEventListener('feedbackResumeRequested', resumeListener);
    (document.querySelector('[data-feedback-draft-resume]') as HTMLButtonElement).click();

    expect(editor.view.dom.getAttribute('aria-readonly')).toBe('true');
    expect(
      Array.from(
        document.querySelectorAll<HTMLButtonElement | HTMLSelectElement>(
          '[data-feedback-draft-banner] button, [data-feedback-draft-banner] select'
        )
      ).every(control => control.disabled)
    ).toBe(true);
    expect(host.postMessage).toHaveBeenCalledWith({
      type: 'feedback.draft.resume',
      requestId: expect.any(String),
      round: '20260821T093000Z-k4p9',
    });
    expect(resumeListener).toHaveBeenCalledTimes(1);
    window.removeEventListener('feedbackResumeRequested', resumeListener);
  });

  it('asks the host to revalidate a cached saved draft whenever Start is clicked', () => {
    const editor = createEditorFixture();
    const controller = createFeedbackReviewController({ editor, host });
    controller.handleHostMessage({
      type: 'feedback.drafts.available',
      drafts: [
        {
          round: '20260821T093000Z-k4p9',
          createdAt: '2026-08-21T09:30:00.000Z',
          itemCount: 2,
          feedbackFile: '.md4h/feedback/docs/guide.md--20260821T093000Z-k4p9/feedback.md',
        },
      ],
    });
    const notNow = Array.from(
      document.querySelectorAll<HTMLButtonElement>('.feedback-draft-actions button')
    ).find(button => button.textContent === 'Not now');
    notNow?.click();
    (host.postMessage as jest.Mock).mockClear();

    controller.start();

    expect(host.postMessage).toHaveBeenCalledWith({
      type: 'feedback.start',
      requestId: expect.any(String),
    });
    const serialize = (
      editor as unknown as { storage: { markdown: { serializer: { serialize: jest.Mock } } } }
    ).storage.markdown.serializer.serialize;
    expect(serialize).not.toHaveBeenCalled();
  });

  it('makes starting a new round explicit from a saved-draft prompt', () => {
    const editor = createEditorFixture();
    const controller = createFeedbackReviewController({ editor, host });
    controller.handleHostMessage({
      type: 'feedback.drafts.available',
      drafts: [
        {
          round: '20260821T093000Z-k4p9',
          createdAt: '2026-08-21T09:30:00.000Z',
          itemCount: 2,
          feedbackFile: '.md4h/feedback/docs/guide.md--20260821T093000Z-k4p9/feedback.md',
        },
      ],
    });

    const startNew = document.querySelector<HTMLButtonElement>('[data-feedback-start-new]');
    startNew?.click();
    expect(host.postMessage).toHaveBeenCalledWith({
      type: 'feedback.start.new',
      requestId: expect.any(String),
    });
  });

  it('turns a correlated active-session conflict into a focused Resume choice', () => {
    const editor = createEditorFixture();
    const controller = createFeedbackReviewController({ editor, host });
    const onLocalError = jest.fn();
    window.addEventListener('feedbackLocalError', onLocalError);
    controller.start();
    const start = (host.postMessage as jest.Mock).mock.calls
      .map(call => call[0] as FeedbackWebviewMessage)
      .find(message => message.type === 'feedback.start');
    if (!start) throw new Error('Start request was not posted.');

    controller.handleHostMessage({
      type: 'feedback.resume.available',
      requestId: 'stale-start',
      kind: 'active-owner',
      drafts: [
        {
          round: '20260821T093000Z-k4p9',
          createdAt: '2026-08-21T09:30:00.000Z',
          itemCount: 1,
          feedbackFile: '.md4h/feedback/docs/guide.md--20260821T093000Z-k4p9/feedback.md',
        },
      ],
    });
    expect(document.querySelector('[data-feedback-resume-offer]')).toBeNull();

    controller.handleHostMessage({
      type: 'feedback.resume.available',
      requestId: start.requestId,
      kind: 'active-owner',
      drafts: [
        {
          round: '20260821T093000Z-k4p9',
          createdAt: '2026-08-21T09:30:00.000Z',
          itemCount: 1,
          feedbackFile: '.md4h/feedback/docs/guide.md--20260821T093000Z-k4p9/feedback.md',
        },
      ],
    });

    const resume = document.querySelector<HTMLButtonElement>('[data-feedback-draft-resume]');
    expect(document.querySelector('[data-feedback-resume-offer]')?.textContent).toContain(
      'Resume Feedback session?'
    );
    expect(editor.view.dom.getAttribute('aria-readonly')).toBe('true');
    expect(document.activeElement).toBe(resume);
    expect(onLocalError).not.toHaveBeenCalled();

    resume?.click();
    expect(host.postMessage).toHaveBeenCalledWith({
      type: 'feedback.draft.resume',
      requestId: expect.any(String),
      round: '20260821T093000Z-k4p9',
    });
    window.removeEventListener('feedbackLocalError', onLocalError);
  });

  it('explains that resuming an active peer moves the session and labels the action Resume here', () => {
    const editor = createEditorFixture();
    const controller = createFeedbackReviewController({ editor, host });
    controller.start();
    const start = (host.postMessage as jest.Mock).mock.calls
      .map(call => call[0] as FeedbackWebviewMessage)
      .find(message => message.type === 'feedback.start');
    if (!start) throw new Error('Start request was not posted.');

    controller.handleHostMessage({
      type: 'feedback.resume.available',
      requestId: start.requestId,
      kind: 'active-peer',
      drafts: [
        {
          round: '20260821T093000Z-k4p9',
          createdAt: '2026-08-21T09:30:00.000Z',
          itemCount: 3,
          feedbackFile: '.md4h/feedback/docs/guide.md--20260821T093000Z-k4p9/feedback.md',
        },
      ],
    });

    const offer = document.querySelector<HTMLElement>('[data-feedback-resume-offer]');
    const resume = offer?.querySelector<HTMLButtonElement>('[data-feedback-draft-resume]');
    expect(offer?.textContent).toMatch(/another rich view/i);
    expect(offer?.textContent).toMatch(/move(?:s)? .*session.*this view/i);
    expect(resume?.textContent).toBe('Resume here');
  });

  it('unlocks a stale active offer when exact source validation rejects Resume', () => {
    const editor = createEditorFixture();
    const controller = createFeedbackReviewController({ editor, host });
    controller.start();
    const start = (host.postMessage as jest.Mock).mock.calls
      .map(call => call[0] as FeedbackWebviewMessage)
      .find(message => message.type === 'feedback.start');
    if (!start) throw new Error('Start request was not posted.');
    controller.handleHostMessage({
      type: 'feedback.resume.available',
      requestId: start.requestId,
      kind: 'active-owner',
      drafts: [
        {
          round: '20260821T093000Z-k4p9',
          createdAt: '2026-08-21T09:30:00.000Z',
          itemCount: 1,
          feedbackFile: '.md4h/feedback/docs/guide.md--20260821T093000Z-k4p9/feedback.md',
        },
      ],
    });
    document.querySelector<HTMLButtonElement>('[data-feedback-draft-resume]')?.click();
    const resume = (host.postMessage as jest.Mock).mock.calls
      .map(call => call[0] as FeedbackWebviewMessage)
      .reverse()
      .find(message => message.type === 'feedback.draft.resume');
    if (!resume) throw new Error('Resume request was not posted.');

    controller.handleHostMessage({
      type: 'feedback.error',
      requestId: resume.requestId,
      code: FEEDBACK_ERROR_CODES.sourceChanged,
      message: 'The source changed.',
      recoverable: true,
    });

    expect(document.querySelector('[data-feedback-draft-banner]')).toBeNull();
    expect(editor.view.dom.getAttribute('aria-readonly')).toBeNull();
    expect(document.body.classList.contains('feedback-review-starting')).toBe(false);
  });

  it('deactivates only the matching old runtime after an explicit session transfer', () => {
    const editor = createEditorFixture();
    const controller = createFeedbackReviewController({ editor, host });
    controller.activate({
      sessionId: 'old-session',
      source: 'docs/guide.md',
      sourceSha256: 'a'.repeat(64),
      round: '20260821T093000Z-k4p9',
      items: [],
    });

    controller.handleHostMessage({
      type: 'feedback.session.transferred',
      oldSessionId: 'stale-session',
      lockId: 'new-session',
      message: 'Feedback moved elsewhere.',
    });
    expect(controller.getSession()?.sessionId).toBe('old-session');

    controller.handleHostMessage({
      type: 'feedback.session.transferred',
      oldSessionId: 'old-session',
      lockId: 'new-session',
      message: 'Feedback moved elsewhere.',
    });
    expect(controller.getSession()).toBeNull();
    expect(editor.view.dom.getAttribute('aria-readonly')).toBeNull();
  });

  it('stages an incoming ownership transfer as non-writable until exact commit', () => {
    const editor = createEditorFixture();
    const controller = createFeedbackReviewController({ editor, host });
    const apply = {
      type: 'feedback.session.transfer' as const,
      phase: 'apply' as const,
      role: 'new-owner' as const,
      transferId: 'transfer-incoming',
      requestId: 'resume-incoming',
      oldSessionId: 'session-old',
      newSessionId: 'session-new',
      viewGeneration: 'view-new',
      revision: 1,
      documentVersion: 7,
      sourceSha256: 'a'.repeat(64),
      peerLockMessage: 'Feedback is active in another editor split.',
      session: {
        sessionId: 'session-new',
        source: 'docs/guide.md',
        sourceSha256: 'a'.repeat(64),
        round: '20260821T093000Z-k4p9',
        feedbackFile: '.md4h/feedback/docs/guide/feedback.md',
        anchors: [],
        items: [],
      },
    };

    expect(controller.prepareSessionTransfer(apply)).toBe(true);
    expect(controller.getSession()?.sessionId).toBe('session-new');
    expect(controller.isWritable()).toBe(false);
    expect(controller.prepareSessionTransfer(apply)).toBe(true);

    const identity = omitTransferSession(apply);
    expect(controller.commitSessionTransfer({ ...identity, phase: 'commit' })).toBe(true);
    expect(controller.getSession()?.sessionId).toBe('session-new');
    expect(controller.isWritable()).toBe(true);
  });

  it('freezes the old owner and retires only on an exact transfer commit', () => {
    const editor = createEditorFixture();
    const controller = createFeedbackReviewController({ editor, host });
    controller.activate({
      sessionId: 'session-old',
      source: 'docs/guide.md',
      sourceSha256: 'a'.repeat(64),
      round: '20260821T093000Z-k4p9',
      items: [],
    });
    const apply = {
      type: 'feedback.session.transfer' as const,
      phase: 'apply' as const,
      role: 'old-owner' as const,
      transferId: 'transfer-outgoing',
      requestId: 'resume-outgoing',
      oldSessionId: 'session-old',
      newSessionId: 'session-new',
      viewGeneration: 'view-old',
      revision: 1,
      documentVersion: 7,
      sourceSha256: 'a'.repeat(64),
      peerLockMessage: 'Feedback is active in another editor split.',
      session: {
        sessionId: 'session-new',
        source: 'docs/guide.md',
        sourceSha256: 'a'.repeat(64),
        round: '20260821T093000Z-k4p9',
        feedbackFile: '.md4h/feedback/docs/guide/feedback.md',
        anchors: [],
        items: [],
      },
    };

    expect(controller.prepareSessionTransfer(apply)).toBe(true);
    expect(controller.getSession()?.sessionId).toBe('session-old');
    expect(controller.isWritable()).toBe(false);
    const identity = omitTransferSession(apply);
    expect(
      controller.commitSessionTransfer({ ...identity, phase: 'commit', role: 'new-owner' })
    ).toBe(false);
    expect(controller.getSession()?.sessionId).toBe('session-old');

    expect(controller.commitSessionTransfer({ ...identity, phase: 'commit' })).toBe(true);
    expect(controller.getSession()).toBeNull();
  });

  it('rolls back staged incoming and outgoing transfers to their prior review state', () => {
    const incomingEditor = createEditorFixture();
    const incoming = createFeedbackReviewController({ editor: incomingEditor, host });
    const apply = {
      type: 'feedback.session.transfer' as const,
      phase: 'apply' as const,
      role: 'new-owner' as const,
      transferId: 'transfer-rollback',
      requestId: 'resume-rollback',
      oldSessionId: 'session-old',
      newSessionId: 'session-new',
      viewGeneration: 'view-new',
      revision: 1,
      documentVersion: 7,
      sourceSha256: 'a'.repeat(64),
      peerLockMessage: 'Feedback is active in another editor split.',
      session: {
        sessionId: 'session-new',
        source: 'docs/guide.md',
        sourceSha256: 'a'.repeat(64),
        round: '20260821T093000Z-k4p9',
        feedbackFile: '.md4h/feedback/docs/guide/feedback.md',
        anchors: [],
        items: [],
      },
    };
    const identity = omitTransferSession(apply);
    const abort = { ...identity, phase: 'abort' as const };

    expect(incoming.prepareSessionTransfer(apply)).toBe(true);
    expect(incoming.abortSessionTransfer(abort)).toBe(true);
    expect(incoming.getSession()).toBeNull();

    const outgoingEditor = createEditorFixture();
    const outgoing = createFeedbackReviewController({ editor: outgoingEditor, host });
    outgoing.activate({
      sessionId: 'session-old',
      source: 'docs/guide.md',
      sourceSha256: 'a'.repeat(64),
      round: '20260821T093000Z-k4p9',
      items: [],
    });
    expect(outgoing.prepareSessionTransfer({ ...apply, role: 'old-owner' })).toBe(true);
    expect(outgoing.isWritable()).toBe(false);
    expect(outgoing.abortSessionTransfer({ ...abort, role: 'old-owner' })).toBe(true);
    expect(outgoing.getSession()?.sessionId).toBe('session-old');
    expect(outgoing.isWritable()).toBe(true);
  });

  it('moves focus from a resumed draft action to Finish when activation succeeds', () => {
    const editor = createEditorFixture();
    const controller = createFeedbackReviewController({ editor, host });
    const finish = document.createElement('button');
    finish.setAttribute('data-feedback-finish', '');
    document.body.append(finish);
    controller.handleHostMessage({
      type: 'feedback.drafts.available',
      drafts: [
        {
          round: '20260821T093000Z-k4p9',
          createdAt: '2026-08-21T09:30:00.000Z',
          itemCount: 2,
          feedbackFile: '.md4h/feedback/docs/guide.md--20260821T093000Z-k4p9/feedback.md',
        },
      ],
    });
    const resume = document.querySelector('[data-feedback-draft-resume]') as HTMLButtonElement;
    resume.focus();
    resume.click();
    const request = (host.postMessage as jest.Mock).mock.calls
      .map(call => call[0])
      .find(message => message.type === 'feedback.draft.resume');

    controller.handleHostMessage({
      type: 'feedback.started',
      requestId: request.requestId,
      sessionId: 'session-1',
      source: 'docs/guide.md',
      sourceSha256: 'a'.repeat(64),
      round: '20260821T093000Z-k4p9',
      feedbackFile: '.md4h/feedback/docs/guide.md--20260821T093000Z-k4p9/feedback.md',
      anchors: [],
      items: [],
    });

    expect(document.activeElement).toBe(finish);
  });

  it('lets the user choose among multiple matching drafts before acting', () => {
    const editor = createEditorFixture();
    const controller = createFeedbackReviewController({ editor, host });
    controller.handleHostMessage({
      type: 'feedback.drafts.available',
      drafts: [
        {
          round: '20260821T103000Z-k4p9',
          createdAt: '2026-08-21T10:30:00.000Z',
          itemCount: 2,
          feedbackFile: '.md4h/feedback/docs/guide.md--20260821T103000Z-k4p9/feedback.md',
        },
        {
          round: '20260821T093000Z-a1b2',
          createdAt: '2026-08-21T09:30:00.000Z',
          itemCount: 1,
          feedbackFile: '.md4h/feedback/docs/guide.md--20260821T093000Z-a1b2/feedback.md',
        },
      ],
    });

    const picker = document.querySelector<HTMLSelectElement>('[data-feedback-draft-picker]');
    expect(picker?.options).toHaveLength(2);
    if (!picker) throw new Error('Draft picker was not rendered.');
    picker.value = '20260821T093000Z-a1b2';
    picker.dispatchEvent(new Event('change', { bubbles: true }));
    const reveal = Array.from(
      document.querySelectorAll<HTMLButtonElement>('.feedback-draft-actions button')
    ).find(button => button.textContent === 'Reveal');
    reveal?.click();

    expect(host.postMessage).toHaveBeenCalledWith({
      type: 'feedback.draft.reveal',
      requestId: expect.any(String),
      round: '20260821T093000Z-a1b2',
    });
    expect(document.querySelector('.feedback-draft-detail')?.textContent).toContain('1 comment');
  });

  it.each(['cancel', 'success', 'error'] as const)(
    'locks an inactive-draft discard owner until the correlated peer unlock on %s',
    outcome => {
      const editor = createEditorFixture();
      const onReadOnlyChange = jest.fn();
      const controller = createFeedbackReviewController({ editor, host, onReadOnlyChange });
      controller.handleHostMessage({
        type: 'feedback.drafts.available',
        drafts: [
          {
            round: '20260821T093000Z-a1b2',
            createdAt: '2026-08-21T09:30:00.000Z',
            itemCount: 1,
            feedbackFile: '.md4h/feedback/docs/guide.md--20260821T093000Z-a1b2/feedback.md',
          },
        ],
      });
      const discard = Array.from(
        document.querySelectorAll<HTMLButtonElement>('.feedback-draft-actions button')
      ).find(button => button.textContent === 'Discard');
      discard?.click();
      const request = (host.postMessage as jest.Mock).mock.calls
        .map(call => call[0])
        .find(message => message.type === 'feedback.draft.discard');

      expect(request).toEqual({
        type: 'feedback.draft.discard',
        requestId: expect.any(String),
        round: '20260821T093000Z-a1b2',
      });
      expect(editor.view.dom.getAttribute('aria-readonly')).toBe('true');
      expect(document.body.classList).toContain('feedback-review-starting');
      expect(onReadOnlyChange).toHaveBeenLastCalledWith(true);

      controller.handleHostMessage({
        type: 'feedback.transition.locked',
        requestId: 'stale-discard-request',
        lockId: 'stale-transition-lock',
      } as unknown as FeedbackHostMessage);
      expect(controller.completeTransition('stale-transition-lock')).toBe(false);
      expect(editor.view.dom.getAttribute('aria-readonly')).toBe('true');

      controller.handleHostMessage({
        type: 'feedback.transition.locked',
        requestId: request.requestId,
        lockId: 'discard-transition-lock',
      } as unknown as FeedbackHostMessage);

      if (outcome === 'success') {
        controller.handleHostMessage({
          type: 'feedback.draft.discarded',
          requestId: request.requestId,
          round: request.round,
        });
      } else if (outcome === 'error') {
        controller.handleHostMessage({
          type: 'feedback.error',
          requestId: request.requestId,
          code: 'MD4H-FB-STORE-002',
          message: 'The draft could not be moved to Trash.',
          recoverable: true,
        });
      }

      expect(controller.completeTransition('stale-transition-lock')).toBe(false);
      expect(editor.view.dom.getAttribute('aria-readonly')).toBe('true');
      expect(controller.completeTransition('discard-transition-lock')).toBe(true);
      expect(editor.view.dom.getAttribute('aria-readonly')).toBeNull();
      expect(document.body.classList).not.toContain('feedback-review-starting');
      expect(onReadOnlyChange).toHaveBeenLastCalledWith(false);
    }
  );

  it('returns focus to the editor after discarding the final inactive draft', () => {
    const editor = createEditorFixture();
    const controller = createFeedbackReviewController({ editor, host });
    controller.handleHostMessage({
      type: 'feedback.drafts.available',
      drafts: [
        {
          round: '20260821T093000Z-a1b2',
          createdAt: '2026-08-21T09:30:00.000Z',
          itemCount: 1,
          feedbackFile: '.md4h/feedback/docs/guide.md--20260821T093000Z-a1b2/feedback.md',
        },
      ],
    });
    const discard = Array.from(
      document.querySelectorAll<HTMLButtonElement>('.feedback-draft-actions button')
    ).find(button => button.textContent === 'Discard');
    discard?.focus();
    discard?.click();
    const request = (host.postMessage as jest.Mock).mock.calls
      .map(call => call[0])
      .find(message => message.type === 'feedback.draft.discard');
    controller.handleHostMessage({
      type: 'feedback.transition.locked',
      requestId: request.requestId,
      lockId: 'discard-transition-lock',
    } as unknown as FeedbackHostMessage);
    controller.handleHostMessage({
      type: 'feedback.draft.discarded',
      requestId: request.requestId,
      round: request.round,
    });

    expect(controller.completeTransition('discard-transition-lock')).toBe(true);
    expect(document.querySelector('[data-feedback-draft-banner]')).toBeNull();
    expect(document.activeElement).toBe(editor.view.dom);
  });

  it('keeps the remaining recovery choice after one of several drafts is discarded', () => {
    const editor = createEditorFixture();
    const controller = createFeedbackReviewController({ editor, host });
    controller.handleHostMessage({
      type: 'feedback.drafts.available',
      drafts: [
        {
          round: '20260821T103000Z-k4p9',
          createdAt: '2026-08-21T10:30:00.000Z',
          itemCount: 2,
          feedbackFile: '.md4h/feedback/docs/guide.md--20260821T103000Z-k4p9/feedback.md',
        },
        {
          round: '20260821T093000Z-a1b2',
          createdAt: '2026-08-21T09:30:00.000Z',
          itemCount: 1,
          feedbackFile: '.md4h/feedback/docs/guide.md--20260821T093000Z-a1b2/feedback.md',
        },
      ],
    });
    const picker = document.querySelector<HTMLSelectElement>('[data-feedback-draft-picker]');
    if (!picker) throw new Error('Draft picker was not rendered.');
    picker.value = '20260821T093000Z-a1b2';
    picker.dispatchEvent(new Event('change', { bubbles: true }));
    const discard = Array.from(
      document.querySelectorAll<HTMLButtonElement>('.feedback-draft-actions button')
    ).find(button => button.textContent === 'Discard');
    discard?.click();
    const request = (host.postMessage as jest.Mock).mock.calls
      .map(call => call[0])
      .find(message => message.type === 'feedback.draft.discard');

    controller.handleHostMessage({
      type: 'feedback.transition.locked',
      requestId: request.requestId,
      lockId: 'discard-transition-lock',
    } as unknown as FeedbackHostMessage);
    controller.handleHostMessage({
      type: 'feedback.draft.discarded',
      requestId: request.requestId,
      round: request.round,
    });

    const remainingBanner = document.querySelector<HTMLElement>('[data-feedback-draft-banner]');
    expect(remainingBanner).not.toBeNull();
    expect(document.querySelector('[data-feedback-draft-picker]')).toBeNull();
    expect(document.querySelector('.feedback-draft-detail')?.textContent).toContain('2 comments');
    expect(remainingBanner?.getAttribute('aria-busy')).toBe('true');
    expect(
      Array.from(remainingBanner?.querySelectorAll<HTMLButtonElement>('button') ?? []).every(
        button => button.disabled
      )
    ).toBe(true);

    expect(controller.completeTransition('discard-transition-lock')).toBe(true);
    expect(remainingBanner?.hasAttribute('aria-busy')).toBe(false);
    expect(
      Array.from(remainingBanner?.querySelectorAll<HTMLButtonElement>('button') ?? []).every(
        button => !button.disabled
      )
    ).toBe(true);
  });
});
