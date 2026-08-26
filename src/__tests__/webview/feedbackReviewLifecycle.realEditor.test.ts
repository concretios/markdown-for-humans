/** @jest-environment jsdom */

import { Editor } from '@tiptap/core';
import { Markdown } from '@tiptap/markdown';
import { Table, TableCell, TableHeader, TableRow } from '@tiptap/extension-table';
import { CellSelection } from '@tiptap/pm/tables';
import StarterKit from '@tiptap/starter-kit';
import {
  createFeedbackNodeViewInteractionGuards,
  createFeedbackReviewController,
  feedbackReadOnlyPluginKey,
  type FeedbackReviewController,
} from '../../webview/features/feedbackReview';
import type { FeedbackHostMessage } from '../../shared/feedbackProtocol';
import { fingerprintFeedbackTable } from '../../webview/features/feedbackSelectionMapping';

function createLifecycleEditor(content = '<p>Alpha beta</p>'): Editor {
  document.body.innerHTML = `
    <div class="formatting-toolbar"></div>
    <main><div id="editor"></div></main>
  `;
  return new Editor({
    element: document.querySelector('#editor') as HTMLElement,
    extensions: [StarterKit, Markdown],
    content,
  });
}

function activateEmptySession(controller: FeedbackReviewController): void {
  controller.activate({
    sessionId: 'session-1',
    source: 'docs/guide.md',
    sourceSha256: 'a'.repeat(64),
    round: '20260822T093000Z-k4p9',
    anchors: [{ ordinal: 0, startLine: 1, endLine: 1 }],
    items: [],
  });
}

describe('Feedback review-only lifecycle with a real editor', () => {
  afterEach(() => {
    document.body.replaceChildren();
    jest.restoreAllMocks();
  });

  it('installs its transaction filter only for Feedback and preserves selection transactions', () => {
    const editor = createLifecycleEditor();
    const onReadOnlyChange = jest.fn();
    const postMessage = jest.fn();
    const controller = createFeedbackReviewController({
      editor,
      host: { postMessage },
      onReadOnlyChange,
    });

    expect(feedbackReadOnlyPluginKey.get(editor.state)).toBeUndefined();
    editor.commands.insertContentAt(1, 'Before ');
    expect(editor.getText()).toBe('Before Alpha beta');

    activateEmptySession(controller);

    expect(feedbackReadOnlyPluginKey.get(editor.state)).toBeDefined();
    const frozenDocument = editor.state.doc.toJSON();
    editor.commands.insertContentAt(1, 'Blocked ');
    expect(editor.state.doc.toJSON()).toEqual(frozenDocument);
    editor.commands.setTextSelection(4);
    expect(editor.state.selection.from).toBe(4);

    controller.deactivate();

    expect(feedbackReadOnlyPluginKey.get(editor.state)).toBeUndefined();
    editor.commands.insertContentAt(1, 'After ');
    expect(editor.getText()).toBe('After Before Alpha beta');
    expect(onReadOnlyChange.mock.calls).toEqual([[true], [false]]);
    editor.destroy();
  });

  it('binds review listeners once across start and activation, then removes the same callbacks', () => {
    const editor = createLifecycleEditor();
    const editorOn = jest.spyOn(editor, 'on');
    const editorOff = jest.spyOn(editor, 'off');
    const documentAdd = jest.spyOn(document, 'addEventListener');
    const documentRemove = jest.spyOn(document, 'removeEventListener');
    const windowAdd = jest.spyOn(window, 'addEventListener');
    const windowRemove = jest.spyOn(window, 'removeEventListener');
    const editorDom = editor.view.dom as HTMLElement;
    const domAdd = jest.spyOn(editorDom, 'addEventListener');
    const domRemove = jest.spyOn(editorDom, 'removeEventListener');
    const controller = createFeedbackReviewController({
      editor,
      host: { postMessage: jest.fn() },
    });

    expect(editorOn.mock.calls.filter(([event]) => event === 'selectionUpdate')).toHaveLength(0);
    expect(documentAdd.mock.calls.filter(([event]) => event === 'selectionchange')).toHaveLength(0);
    expect(windowAdd.mock.calls.filter(([event]) => event === 'resize')).toHaveLength(0);
    for (const event of ['beforeinput', 'cut', 'paste', 'drop']) {
      expect(domAdd.mock.calls.filter(([type]) => type === event)).toHaveLength(0);
    }

    controller.start();
    controller.start();
    activateEmptySession(controller);

    const selectionUpdateRegistration = editorOn.mock.calls.find(
      ([event]) => event === 'selectionUpdate'
    );
    const nativeSelectionRegistration = documentAdd.mock.calls.find(
      ([event]) => event === 'selectionchange'
    );
    const resizeRegistration = windowAdd.mock.calls.find(([event]) => event === 'resize');
    expect(editorOn.mock.calls.filter(([event]) => event === 'selectionUpdate')).toHaveLength(1);
    expect(documentAdd.mock.calls.filter(([event]) => event === 'selectionchange')).toHaveLength(1);
    expect(windowAdd.mock.calls.filter(([event]) => event === 'resize')).toHaveLength(1);
    for (const event of ['beforeinput', 'cut', 'paste', 'drop']) {
      expect(
        domAdd.mock.calls.filter(([type, , capture]) => type === event && capture === true)
      ).toHaveLength(1);
    }

    controller.deactivate();

    expect(editorOff).toHaveBeenCalledWith(...(selectionUpdateRegistration ?? []));
    expect(documentRemove).toHaveBeenCalledWith(...(nativeSelectionRegistration ?? []));
    expect(windowRemove).toHaveBeenCalledWith(...(resizeRegistration ?? []));
    for (const event of ['beforeinput', 'cut', 'paste', 'drop']) {
      const registration = domAdd.mock.calls.find(
        ([type, , capture]) => type === event && capture === true
      );
      expect(domRemove).toHaveBeenCalledWith(...(registration ?? []));
    }
    expect(feedbackReadOnlyPluginKey.get(editor.state)).toBeUndefined();
    editor.destroy();
  });

  it('unlocks and unbinds when a pending start is rejected', () => {
    const editor = createLifecycleEditor();
    const host = { postMessage: jest.fn() };
    const controller = createFeedbackReviewController({ editor, host });
    const editorDom = editor.view.dom as HTMLElement;

    controller.start();
    const requestId = host.postMessage.mock.calls.find(
      ([message]) => message.type === 'feedback.start'
    )?.[0].requestId as string;
    const guardedBeforeInput = new InputEvent('beforeinput', {
      bubbles: true,
      cancelable: true,
      inputType: 'insertText',
    });
    expect(editorDom.dispatchEvent(guardedBeforeInput)).toBe(false);
    expect(feedbackReadOnlyPluginKey.get(editor.state)).toBeDefined();

    controller.handleHostMessage({
      type: 'feedback.error',
      requestId,
      code: 'MD4H-FB-STORE-001',
      message: 'Could not save the snapshot.',
      recoverable: true,
    });

    expect(feedbackReadOnlyPluginKey.get(editor.state)).toBeUndefined();
    expect(
      editorDom.dispatchEvent(
        new InputEvent('beforeinput', {
          bubbles: true,
          cancelable: true,
          inputType: 'insertText',
        })
      )
    ).toBe(true);
    editor.destroy();
  });

  it('rolls back every renderer effect when activation fails after read-only setup', () => {
    const editor = createLifecycleEditor();
    const originalRegisterPlugin = editor.registerPlugin.bind(editor);
    let registrationCount = 0;
    jest.spyOn(editor, 'registerPlugin').mockImplementation(plugin => {
      registrationCount += 1;
      if (registrationCount === 2) throw new Error('annotation plugin setup failed');
      return originalRegisterPlugin(plugin);
    });
    const controller = createFeedbackReviewController({
      editor,
      host: { postMessage: jest.fn() },
    });

    expect(() => activateEmptySession(controller)).toThrow('annotation plugin setup failed');

    expect(controller.getSession()).toBeNull();
    expect(controller.isEditingLocked()).toBe(false);
    expect(feedbackReadOnlyPluginKey.get(editor.state)).toBeUndefined();
    expect(editor.view.dom.getAttribute('aria-readonly')).toBeNull();
    expect(document.body.classList.contains('feedback-review-active')).toBe(false);
    expect(document.querySelector('[data-feedback-annotation-layer]')).toBeNull();
    editor.commands.insertContentAt(1, 'Editable ');
    expect(editor.getText()).toBe('Editable Alpha beta');
    editor.destroy();
  });

  it('restores one host-owned active session idempotently into a recreated controller', () => {
    const editor = createLifecycleEditor();
    const onReadOnlyChange = jest.fn();
    const controller = createFeedbackReviewController({
      editor,
      host: { postMessage: jest.fn() },
      onReadOnlyChange,
    }) as FeedbackReviewController & {
      restoreActiveSession(session: Parameters<FeedbackReviewController['activate']>[0]): boolean;
    };
    const restoredSession = {
      sessionId: 'restored-session-1',
      source: 'docs/guide.md',
      sourceSha256: 'a'.repeat(64),
      round: '20260822T093000Z-k4p9',
      feedbackFile: '.md4h/feedback/docs/guide/feedback.md',
      anchors: [{ ordinal: 0, startLine: 1, endLine: 1 }],
      items: [],
    };

    expect(controller.restoreActiveSession(restoredSession)).toBe(true);
    expect(controller.getSession()).toEqual(restoredSession);
    expect(document.querySelectorAll('[data-feedback-annotation-layer]')).toHaveLength(1);

    expect(controller.restoreActiveSession(restoredSession)).toBe(true);
    expect(document.querySelectorAll('[data-feedback-annotation-layer]')).toHaveLength(1);
    expect(onReadOnlyChange).toHaveBeenCalledTimes(1);

    expect(
      controller.restoreActiveSession({ ...restoredSession, sessionId: 'stale-session' })
    ).toBe(false);
    expect(controller.getSession()?.sessionId).toBe(restoredSession.sessionId);
    editor.destroy();
  });

  it('blocks real document transactions immediately while inactive-draft discard awaits confirmation', () => {
    const editor = createLifecycleEditor();
    const host = { postMessage: jest.fn() };
    const controller = createFeedbackReviewController({ editor, host });
    controller.handleHostMessage({
      type: 'feedback.drafts.available',
      drafts: [
        {
          round: '20260822T093000Z-k4p9',
          createdAt: '2026-08-22T09:30:00.000Z',
          itemCount: 1,
          feedbackFile: '.md4h/feedback/docs/guide.md--20260822T093000Z-k4p9/feedback.md',
        },
      ],
    });
    const discard = Array.from(
      document.querySelectorAll<HTMLButtonElement>('.feedback-draft-actions button')
    ).find(button => button.textContent === 'Discard');
    discard?.click();
    const request = host.postMessage.mock.calls
      .map(([message]) => message)
      .find(message => message.type === 'feedback.draft.discard');
    const frozenDocument = editor.state.doc.toJSON();

    expect(request).toEqual(
      expect.objectContaining({ type: 'feedback.draft.discard', requestId: expect.any(String) })
    );
    expect(feedbackReadOnlyPluginKey.get(editor.state)).toBeDefined();
    expect(editor.view.dom.getAttribute('aria-readonly')).toBe('true');
    editor.commands.insertContentAt(1, 'Blocked before host lock ');
    expect(editor.state.doc.toJSON()).toEqual(frozenDocument);

    controller.handleHostMessage({
      type: 'feedback.transition.locked',
      requestId: request.requestId,
      lockId: 'discard-transition-lock',
    } as unknown as FeedbackHostMessage);
    editor.commands.insertContentAt(1, 'Blocked during confirmation ');
    expect(editor.state.doc.toJSON()).toEqual(frozenDocument);

    expect(controller.completeTransition('discard-transition-lock')).toBe(true);
    expect(feedbackReadOnlyPluginKey.get(editor.state)).toBeUndefined();
    editor.commands.insertContentAt(1, 'Editable after cancel ');
    expect(editor.getText()).toBe('Editable after cancel Alpha beta');
    editor.destroy();
  });

  it('registers NodeView guards only while locked and balances every listener exactly once', () => {
    document.body.innerHTML = `
      <div id="guard-root">
        <button type="button">Open image menu</button>
        <div class="image-wrapper"><img alt="Example"></div>
        <p>Ordinary prose</p>
      </div>
    `;
    const root = document.querySelector('#guard-root') as HTMLElement;
    const add = jest.spyOn(root, 'addEventListener');
    const remove = jest.spyOn(root, 'removeEventListener');
    const guards = createFeedbackNodeViewInteractionGuards(root);

    expect(guards.isActive()).toBe(false);
    expect(add).not.toHaveBeenCalled();
    guards.setActive(true);
    guards.setActive(true);

    expect(guards.isActive()).toBe(true);
    expect(add).toHaveBeenCalledTimes(5);
    const blockedClick = new MouseEvent('click', { bubbles: true, cancelable: true });
    expect(root.querySelector('button')?.dispatchEvent(blockedClick)).toBe(false);
    const proseClick = new MouseEvent('click', { bubbles: true, cancelable: true });
    expect(root.querySelector('p')?.dispatchEvent(proseClick)).toBe(true);

    guards.setActive(false);
    guards.dispose();

    expect(guards.isActive()).toBe(false);
    expect(remove).toHaveBeenCalledTimes(5);
    for (const registration of add.mock.calls) {
      expect(remove).toHaveBeenCalledWith(...registration);
    }
    expect(
      root
        .querySelector('button')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    ).toBe(true);
  });

  it.each([
    {
      type: 'feedback.finished' as const,
      requestId: 'finish-1',
      sessionId: 'session-1',
      feedbackFile: '.md4h/feedback/docs/guide/feedback.md',
      itemCount: 1,
      prompt: 'Implement the sealed feedback bundle.',
      promptCopied: true,
    },
    { type: 'feedback.discarded' as const, requestId: 'discard-1', sessionId: 'session-1' },
  ])('keeps the review-only plugin after $type until correlated close completion', message => {
    const editor = createLifecycleEditor();
    const host = { postMessage: jest.fn() };
    const controller = createFeedbackReviewController({
      editor,
      host,
    });
    activateEmptySession(controller);
    const frozenDocument = editor.state.doc.toJSON();
    let correlatedMessage: FeedbackHostMessage = message;
    if (message.type === 'feedback.finished') {
      controller.updateItems([
        {
          id: 'F1',
          kind: 'text',
          startOrdinal: 0,
          endOrdinal: 0,
          startLine: 1,
          endLine: 1,
          focus: 'Alpha beta',
          feedback: 'Clarify this sentence.',
        },
      ]);
      controller.finish();
      document.querySelector<HTMLButtonElement>('[data-feedback-completion-confirm]')?.click();
      const finishRequest = host.postMessage.mock.calls
        .map(([posted]) => posted)
        .find(posted => posted.type === 'feedback.finish');
      correlatedMessage = { ...message, requestId: finishRequest.requestId };
    }

    controller.handleHostMessage(correlatedMessage);

    expect(feedbackReadOnlyPluginKey.get(editor.state)).toBeDefined();
    editor.commands.insertContentAt(1, 'Blocked ');
    expect(editor.state.doc.toJSON()).toEqual(frozenDocument);
    expect(host.postMessage).toHaveBeenCalledWith({
      type: 'feedback.close.ready',
      requestId: correlatedMessage.requestId,
      sessionId: correlatedMessage.sessionId,
    });
    expect(
      controller.applyCloseSync(
        {
          type: 'feedback.close.sync',
          requestId: correlatedMessage.requestId,
          sessionId: correlatedMessage.sessionId,
          revision: 1,
          content: 'Alpha beta\n',
        },
        () => true
      )
    ).toBe(true);
    controller.handleHostMessage({
      type: 'feedback.close.release',
      requestId: correlatedMessage.requestId,
      sessionId: correlatedMessage.sessionId,
      revision: 1,
    });
    expect(controller.completeClose(correlatedMessage.sessionId)).toBe(true);
    expect(feedbackReadOnlyPluginKey.get(editor.state)).toBeUndefined();
    editor.commands.insertContentAt(1, 'Editable ');
    expect(editor.getText()).toBe('Editable Alpha beta');
    editor.destroy();
  });

  it('removes the review listeners and filter when the editor is destroyed', () => {
    const editor = createLifecycleEditor();
    const editorOff = jest.spyOn(editor, 'off');
    const unregisterPlugin = jest.spyOn(editor, 'unregisterPlugin');
    const domRemove = jest.spyOn(editor.view.dom, 'removeEventListener');
    const controller = createFeedbackReviewController({
      editor,
      host: { postMessage: jest.fn() },
    });
    activateEmptySession(controller);

    editor.destroy();

    expect(unregisterPlugin).toHaveBeenCalledWith(feedbackReadOnlyPluginKey);
    expect(editorOff.mock.calls.filter(([event]) => event === 'selectionUpdate')).toHaveLength(1);
    for (const event of ['beforeinput', 'cut', 'paste', 'drop']) {
      expect(domRemove.mock.calls.filter(([type]) => type === event).length).toBeGreaterThanOrEqual(
        1
      );
    }
  });

  it('uses semantic block Focus for keyboard ranges, preserving code whitespace and hiding chrome', () => {
    const editor = createLifecycleEditor();
    editor.commands.setContent({
      type: 'doc',
      content: [
        {
          type: 'codeBlock',
          attrs: { language: null },
          content: [{ type: 'text', text: '  const answer = 42;\n    return answer;' }],
        },
      ],
    });
    const chrome = document.createElement('button');
    chrome.textContent = 'Copy code';
    chrome.className = 'code-block-copy-button';
    editor.view.dom.firstElementChild?.append(chrome);
    const controller = createFeedbackReviewController({
      editor,
      host: { postMessage: jest.fn() },
    });
    controller.activate({
      sessionId: 'session-1',
      source: 'docs/guide.md',
      sourceSha256: 'a'.repeat(64),
      round: '20260822T093000Z-k4p9',
      anchors: [{ ordinal: 0, startLine: 1, endLine: 4 }],
      items: [],
    });

    expect(controller.commentOnSelection()).toBe(true);
    document
      .querySelector<HTMLFormElement>('[data-feedback-text-block-selector]')
      ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

    expect(document.querySelector('[data-feedback-focus]')?.textContent).toBe(
      '  const answer = 42;\n    return answer;'
    );
    controller.deactivate();
    editor.destroy();
  });

  it.each([
    { nativeState: 'a collapsed native caret', outsideEditor: false },
    { nativeState: 'transient native endpoints outside the editor', outsideEditor: true },
  ])(
    'opens the comment composer for a 4x4 CellSelection despite $nativeState',
    ({ outsideEditor }) => {
      document.body.innerHTML = `
      <div class="formatting-toolbar"></div>
      <main><div id="editor"></div></main>
    `;
      const editor = new Editor({
        element: document.querySelector('#editor') as HTMLElement,
        extensions: [StarterKit, Markdown, Table, TableRow, TableHeader, TableCell],
        content: {
          type: 'doc',
          content: [
            {
              type: 'table',
              content: Array.from({ length: 4 }, (_, row) => ({
                type: 'tableRow',
                content: Array.from({ length: 4 }, (_, column) => ({
                  type: row === 0 ? 'tableHeader' : 'tableCell',
                  content: [
                    {
                      type: 'paragraph',
                      content: [{ type: 'text', text: `R${row + 1}C${column + 1}` }],
                    },
                  ],
                })),
              })),
            },
          ],
        },
      });
      const cellPositions: number[] = [];
      editor.state.doc.descendants((node, position) => {
        if (node.type.spec.tableRole === 'cell' || node.type.spec.tableRole === 'header_cell') {
          cellPositions.push(position);
        }
      });
      editor.view.dispatch(
        editor.state.tr.setSelection(
          CellSelection.create(editor.state.doc, cellPositions[0], cellPositions[15])
        )
      );
      const nativeEndpoint = outsideEditor
        ? document.querySelector('.formatting-toolbar')
        : editor.view.dom.firstChild;
      const nativeSelection = jest.spyOn(window, 'getSelection').mockReturnValue({
        anchorNode: nativeEndpoint,
        focusNode: nativeEndpoint,
        isCollapsed: true,
        rangeCount: 0,
        toString: () => '',
      } as unknown as Selection);
      const postMessage = jest.fn();
      const controller = createFeedbackReviewController({
        editor,
        host: { postMessage },
      });
      controller.activate({
        sessionId: 'session-table',
        source: 'docs/table.md',
        sourceSha256: 'b'.repeat(64),
        round: '20260826T120000Z-ab12',
        anchors: [{ ordinal: 0, startLine: 1, endLine: 6 }],
        items: [],
      });

      const selectionFrames: FrameRequestCallback[] = [];
      const requestAnimationFrame = jest
        .spyOn(window, 'requestAnimationFrame')
        .mockImplementation(callback => {
          selectionFrames.push(callback);
          return selectionFrames.length;
        });
      editor.view.dispatch(
        editor.state.tr.setSelection(
          CellSelection.create(editor.state.doc, cellPositions[15], cellPositions[0])
        )
      );
      document.dispatchEvent(new Event('selectionchange'));
      expect(requestAnimationFrame).toHaveBeenCalledTimes(1);
      expect(document.querySelector('[data-feedback-selection-action]')).toBeNull();
      selectionFrames[0](0);
      expect(document.querySelector('[data-feedback-selection-action]')).not.toBeNull();
      expect(
        document.querySelector('[data-feedback-selection-action]')?.getAttribute('aria-label')
      ).toBe('Add feedback to selected table cells');

      expect(controller.commentOnSelection()).toBe(true);
      expect(document.querySelector('[data-feedback-text-block-selector]')).toBeNull();
      expect(document.querySelector('.feedback-composer')).not.toBeNull();
      expect(document.querySelector('[data-feedback-focus]')?.textContent).toContain('R1C1');
      expect(document.querySelector('[data-feedback-focus]')?.textContent).toContain('R4C4');

      const feedbackInput = document.querySelector('[data-feedback-input]') as HTMLTextAreaElement;
      feedbackInput.value = 'Review this table rectangle.';
      feedbackInput.dispatchEvent(new Event('input', { bubbles: true }));
      (document.querySelector('[data-feedback-submit]') as HTMLButtonElement).click();
      expect(postMessage).toHaveBeenLastCalledWith(
        expect.objectContaining({
          type: 'feedback.text.add',
          startOrdinal: 0,
          endOrdinal: 0,
          cellTarget: {
            version: 1,
            tableOrdinal: 0,
            rectangle: { top: 0, left: 0, bottom: 4, right: 4 },
            tableFingerprint: expect.stringMatching(/^md4h-table\/v1:[a-f0-9]{16}$/),
          },
        })
      );

      nativeSelection.mockRestore();
      requestAnimationFrame.mockRestore();
      controller.deactivate();
      editor.destroy();
    }
  );

  it('restores an exact persisted cell rectangle only after its table fingerprint validates', () => {
    document.body.innerHTML = `
      <div class="formatting-toolbar"></div>
      <main><div id="editor"></div></main>
    `;
    const editor = createTableEditor();
    const fingerprint = fingerprintFeedbackTable({
      version: 1,
      tableOrdinal: 0,
      table: editor.state.doc.child(0),
    }).fingerprint;
    const controller = createFeedbackReviewController({
      editor,
      host: { postMessage: jest.fn() },
    });

    controller.activate(tableSession(fingerprint));

    const exactCells = Array.from(
      editor.view.dom.querySelectorAll<HTMLElement>('.md4h-feedback-annotation-cell')
    );
    expect(exactCells).toHaveLength(4);
    expect(exactCells.map(cell => cell.textContent)).toEqual(['R2C2', 'R2C3', 'R3C2', 'R3C3']);
    expect(document.querySelector('[data-feedback-anchor-alert]')).toBeNull();

    controller.deactivate();
    editor.destroy();
  });

  it('shows a block fallback and warning when a restored cell fingerprint is stale', () => {
    document.body.innerHTML = `
      <div class="formatting-toolbar"></div>
      <main><div id="editor"></div></main>
    `;
    const editor = createTableEditor();
    const controller = createFeedbackReviewController({
      editor,
      host: { postMessage: jest.fn() },
    });

    controller.activate(tableSession('md4h-table/v1:0123456789abcdef'));

    expect(editor.view.dom.querySelectorAll('.md4h-feedback-annotation-cell')).toHaveLength(0);
    expect(editor.view.dom.querySelector('.md4h-feedback-annotation-node')).not.toBeNull();
    expect(document.querySelector('[data-feedback-anchor-alert]')?.textContent).toContain(
      'Safe block-level fallback is shown'
    );

    controller.deactivate();
    editor.destroy();
  });
});

function createTableEditor(): Editor {
  return new Editor({
    element: document.querySelector('#editor') as HTMLElement,
    extensions: [StarterKit, Markdown, Table, TableRow, TableHeader, TableCell],
    content: {
      type: 'doc',
      content: [
        {
          type: 'table',
          content: Array.from({ length: 4 }, (_, row) => ({
            type: 'tableRow',
            content: Array.from({ length: 4 }, (_, column) => ({
              type: row === 0 ? 'tableHeader' : 'tableCell',
              content: [
                {
                  type: 'paragraph',
                  content: [{ type: 'text', text: `R${row + 1}C${column + 1}` }],
                },
              ],
            })),
          })),
        },
      ],
    },
  });
}

function tableSession(tableFingerprint: string) {
  return {
    sessionId: 'session-restored-cells',
    source: 'docs/table.md',
    sourceSha256: 'b'.repeat(64),
    round: '20260826T120000Z-ab12',
    anchors: [{ ordinal: 0, startLine: 1, endLine: 6 }],
    items: [
      {
        id: 'F1',
        kind: 'text' as const,
        startOrdinal: 0,
        endOrdinal: 0,
        startLine: 1,
        endLine: 6,
        focus: 'R2C2\tR2C3\nR3C2\tR3C3',
        feedback: 'Review the middle cells.',
        cellTarget: {
          version: 1 as const,
          tableOrdinal: 0,
          rectangle: { top: 1, left: 1, bottom: 3, right: 3 },
          tableFingerprint,
          tableBlockSha256: 'c'.repeat(64),
        },
      },
    ],
  };
}
