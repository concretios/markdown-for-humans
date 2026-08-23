/** @jest-environment jsdom */

import { Editor } from '@tiptap/core';
import { Markdown } from '@tiptap/markdown';
import StarterKit from '@tiptap/starter-kit';
import {
  createFeedbackNodeViewInteractionGuards,
  createFeedbackReviewController,
  feedbackReadOnlyPluginKey,
  type FeedbackReviewController,
} from '../../webview/features/feedbackReview';
import type { FeedbackHostMessage } from '../../shared/feedbackProtocol';

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
    const controller = createFeedbackReviewController({
      editor,
      host: { postMessage: jest.fn() },
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
});
