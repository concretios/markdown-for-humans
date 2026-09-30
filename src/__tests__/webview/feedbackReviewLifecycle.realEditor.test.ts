/** @jest-environment jsdom */

import { Editor, Node as TiptapNode } from '@tiptap/core';
import { Markdown } from '@tiptap/markdown';
import { Table, TableCell, TableHeader, TableRow } from '@tiptap/extension-table';
import { GapCursor } from '@tiptap/pm/gapcursor';
import { AllSelection, NodeSelection, TextSelection } from '@tiptap/pm/state';
import { CellSelection } from '@tiptap/pm/tables';
import StarterKit from '@tiptap/starter-kit';
import {
  createFeedbackNodeViewInteractionGuards,
  createFeedbackReviewController,
  feedbackReadOnlyPluginKey,
  type FeedbackReviewController,
} from '../../webview/features/feedbackReview';
import type { FeedbackHostMessage } from '../../shared/feedbackProtocol';
import { PENDING_FEEDBACK_ANNOTATION_ID } from '../../webview/features/feedbackAnnotations';
import { fingerprintFeedbackTable } from '../../webview/features/feedbackSelectionMapping';

const MermaidLikeOpaqueNodeView = TiptapNode.create({
  name: 'mermaid',
  group: 'block',
  content: 'text*',
  marks: '',
  isolating: true,

  addAttributes() {
    return { language: { default: 'mermaid' } };
  },

  renderHTML() {
    return ['pre', { 'data-language': 'mermaid' }, ['code', 0]];
  },

  addNodeView() {
    return ({ node }) => {
      const dom = document.createElement('div');
      dom.className = 'mermaid-wrapper';
      dom.setAttribute('data-md4h-mermaid-state', 'ready');

      const source = document.createElement('pre');
      source.className = 'mermaid-source hidden';
      source.textContent = node.textContent;

      const rendered = document.createElement('div');
      rendered.className = 'mermaid-render rendered';
      rendered.textContent = 'Participants to Product lead';
      dom.append(source, rendered);
      return { dom };
    };
  },
});

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

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    left,
    right: left + width,
    top,
    bottom: top + height,
    width,
    height,
    x: left,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

function setVisibleReviewGeometry(editor: Editor): void {
  const container = editor.view.dom.closest<HTMLElement>('#editor');
  const toolbar = document.querySelector<HTMLElement>('.formatting-toolbar');
  if (!container || !toolbar) throw new Error('Missing real-editor review geometry');
  container.getBoundingClientRect = () => rect(0, 0, 900, 720);
  toolbar.getBoundingClientRect = () => rect(0, 0, 900, 40);
  Array.from(editor.view.dom.children).forEach((element, ordinal) => {
    (element as HTMLElement).getBoundingClientRect = () => rect(80, 80 + ordinal * 96, 700, 72);
  });
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

function mockNativeDomRangeSelection(
  start: Text,
  startOffset: number,
  end: Text,
  endOffset: number
) {
  const range = document.createRange();
  range.setStart(start, startOffset);
  range.setEnd(end, endOffset);
  const selection = {
    anchorNode: start,
    focusNode: end,
    anchorOffset: startOffset,
    focusOffset: endOffset,
    isCollapsed: false,
    rangeCount: 1,
    getRangeAt: (index: number) => {
      if (index !== 0) throw new DOMException('Index out of bounds', 'IndexSizeError');
      return range;
    },
    toString: () => range.toString(),
  } as unknown as Selection;
  return { range, spy: jest.spyOn(window, 'getSelection').mockReturnValue(selection) };
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
    for (const event of ['focusin', 'pointerover', 'pointerdown', 'pointerleave']) {
      expect(domAdd.mock.calls.filter(([type]) => type === event)).toHaveLength(0);
    }
    for (const event of ['pointerup', 'pointercancel']) {
      expect(documentAdd.mock.calls.filter(([type]) => type === event)).toHaveLength(0);
    }
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
    const focusRegistration = domAdd.mock.calls.find(([event]) => event === 'focusin');
    const pointerOverRegistration = domAdd.mock.calls.find(([event]) => event === 'pointerover');
    const pointerDownRegistration = domAdd.mock.calls.find(
      ([event, , capture]) => event === 'pointerdown' && capture === true
    );
    const pointerLeaveRegistration = domAdd.mock.calls.find(([event]) => event === 'pointerleave');
    const pointerUpRegistration = documentAdd.mock.calls.find(
      ([event, , capture]) => event === 'pointerup' && capture === true
    );
    const pointerCancelRegistration = documentAdd.mock.calls.find(
      ([event, , capture]) => event === 'pointercancel' && capture === true
    );
    expect(editorOn.mock.calls.filter(([event]) => event === 'selectionUpdate')).toHaveLength(1);
    expect(documentAdd.mock.calls.filter(([event]) => event === 'selectionchange')).toHaveLength(1);
    expect(windowAdd.mock.calls.filter(([event]) => event === 'resize')).toHaveLength(1);
    expect(domAdd.mock.calls.filter(([event]) => event === 'focusin')).toHaveLength(1);
    expect(domAdd.mock.calls.filter(([event]) => event === 'pointerover')).toHaveLength(1);
    expect(
      domAdd.mock.calls.filter(([event, , capture]) => event === 'pointerdown' && capture === true)
    ).toHaveLength(1);
    expect(domAdd.mock.calls.filter(([event]) => event === 'pointerleave')).toHaveLength(1);
    for (const event of ['pointerup', 'pointercancel']) {
      expect(
        documentAdd.mock.calls.filter(([type, , capture]) => type === event && capture === true)
      ).toHaveLength(1);
    }
    for (const event of ['beforeinput', 'cut', 'paste', 'drop']) {
      expect(
        domAdd.mock.calls.filter(([type, , capture]) => type === event && capture === true)
      ).toHaveLength(1);
    }

    controller.deactivate();

    expect(editorOff).toHaveBeenCalledWith(...(selectionUpdateRegistration ?? []));
    expect(documentRemove).toHaveBeenCalledWith(...(nativeSelectionRegistration ?? []));
    expect(windowRemove).toHaveBeenCalledWith(...(resizeRegistration ?? []));
    expect(domRemove).toHaveBeenCalledWith(...(focusRegistration ?? []));
    expect(domRemove).toHaveBeenCalledWith(...(pointerOverRegistration ?? []));
    expect(domRemove).toHaveBeenCalledWith(...(pointerDownRegistration ?? []));
    expect(domRemove).toHaveBeenCalledWith(...(pointerLeaveRegistration ?? []));
    expect(documentRemove).toHaveBeenCalledWith(...(pointerUpRegistration ?? []));
    expect(documentRemove).toHaveBeenCalledWith(...(pointerCancelRegistration ?? []));
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

    expect(document.querySelector('[data-feedback-target-label]')?.textContent).toBe(
      'Whole code block'
    );
    expect(document.querySelector('[data-feedback-target-detail]')?.textContent).toContain(
      '2 lines'
    );
    expect(document.querySelector('[data-feedback-target-preview]')).toBeNull();
    controller.deactivate();
    editor.destroy();
  });

  it('keeps a native partial code selection exact through composer, highlight, and submission', () => {
    const source = 'before();\n  const answer = 42;\n    return answer;\nafter();';
    const exactFocus = '  const answer = 42;\n    return answer;';
    const startOffset = source.indexOf(exactFocus);
    const endOffset = startOffset + exactFocus.length;
    const editor = createLifecycleEditor();
    editor.commands.setContent({
      type: 'doc',
      content: [
        {
          type: 'codeBlock',
          attrs: { language: 'typescript' },
          content: [{ type: 'text', text: source }],
        },
      ],
    });
    setVisibleReviewGeometry(editor);
    const codeBlock = editor.view.dom.firstElementChild;
    const codeText = codeBlock?.querySelector('code')?.firstChild;
    if (!(codeBlock instanceof HTMLElement) || !(codeText instanceof Text)) {
      throw new Error('Missing rendered code text');
    }
    const nativeSelection = mockNativeDomRangeSelection(codeText, startOffset, codeText, endOffset);
    expect(nativeSelection.range.toString()).toBe(exactFocus);
    const postMessage = jest.fn();
    const controller = createFeedbackReviewController({ editor, host: { postMessage } });

    try {
      controller.activate({
        sessionId: 'session-partial-code',
        evidenceVersion: 2,
        source: 'docs/code.md',
        sourceSha256: 'c'.repeat(64),
        round: '20260830T120000Z-code',
        anchors: [{ ordinal: 0, startLine: 1, endLine: 6 }],
        items: [],
      });

      expect(controller.commentOnSelection()).toBe(true);
      expect(document.querySelector('[data-feedback-target-label]')?.textContent).toBe(
        'Selected code'
      );
      expect(document.querySelector('[data-feedback-target-detail]')?.textContent).toBe(
        'TypeScript · 2 lines'
      );
      expect(document.querySelector('[data-feedback-target-preview]')?.textContent).toBe(
        exactFocus
      );
      expect(document.querySelector('[data-feedback-lines]')?.textContent).toBe(
        'Containing source lines 1-6'
      );
      const pending = editor.view.dom.querySelector<HTMLElement>(
        `[data-feedback-ids="${PENDING_FEEDBACK_ANNOTATION_ID}"]`
      );
      expect(pending?.textContent).toBe(exactFocus);
      expect(codeBlock.classList).not.toContain('feedback-pending-target');

      const feedbackInput = document.querySelector('[data-feedback-input]') as HTMLTextAreaElement;
      feedbackInput.value = 'Keep the indentation while revising this branch.';
      feedbackInput.dispatchEvent(new Event('input', { bubbles: true }));
      feedbackInput.form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

      const message = postMessage.mock.calls
        .map(([candidate]) => candidate)
        .find(candidate => candidate.type === 'feedback.text.add');
      expect(message).toEqual(
        expect.objectContaining({
          type: 'feedback.text.add',
          sessionId: 'session-partial-code',
          startOrdinal: 0,
          endOrdinal: 0,
          feedback: 'Keep the indentation while revising this branch.',
          target: {
            version: 2,
            requestedScope: 'rendered-text',
            locator: {
              kind: 'rendered-range',
              value: {
                version: 1,
                startOrdinal: 0,
                startOffset,
                endOrdinal: 0,
                endOffset,
              },
            },
          },
          evidence: {
            kind: 'rendered-text',
            text: exactFocus,
            complete: true,
            language: 'typescript',
          },
        })
      );
      expect(message).not.toHaveProperty('focus');
      expect(message).not.toHaveProperty('cellTarget');
    } finally {
      controller.deactivate();
      nativeSelection.spy.mockRestore();
      editor.destroy();
    }
  });

  it('keeps a full-content native code drag rendered-text scoped in v2', () => {
    const source = 'const alpha = 1;\n  return alpha;';
    const editor = createLifecycleEditor();
    editor.commands.setContent({
      type: 'doc',
      content: [
        {
          type: 'codeBlock',
          attrs: { language: 'typescript' },
          content: [{ type: 'text', text: source }],
        },
      ],
    });
    setVisibleReviewGeometry(editor);
    const codeBlock = editor.view.dom.firstElementChild;
    const codeText = codeBlock?.querySelector('code')?.firstChild;
    if (!(codeBlock instanceof HTMLElement) || !(codeText instanceof Text)) {
      throw new Error('Missing rendered code text');
    }
    const nativeSelection = mockNativeDomRangeSelection(codeText, 0, codeText, source.length);
    const postMessage = jest.fn();
    const controller = createFeedbackReviewController({ editor, host: { postMessage } });

    try {
      controller.activate({
        sessionId: 'session-full-native-code',
        evidenceVersion: 2,
        source: 'docs/code.md',
        sourceSha256: 'c'.repeat(64),
        round: '20260830T120000Z-full-code',
        anchors: [{ ordinal: 0, startLine: 1, endLine: 4 }],
        items: [],
      });

      expect(controller.commentOnSelection()).toBe(true);
      expect(document.querySelector('[data-feedback-target-label]')?.textContent).toBe(
        'Selected code'
      );
      expect(document.querySelector('[data-feedback-target-preview]')?.textContent).toBe(source);
      expect(document.querySelector('[data-feedback-lines]')?.textContent).toBe(
        'Containing source lines 1-4'
      );

      const feedbackInput = document.querySelector('[data-feedback-input]') as HTMLTextAreaElement;
      feedbackInput.value = 'Keep this rendered selection exact.';
      feedbackInput.dispatchEvent(new Event('input', { bubbles: true }));
      feedbackInput.form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

      const message = postMessage.mock.calls
        .map(([candidate]) => candidate)
        .find(candidate => candidate.type === 'feedback.text.add');
      expect(message).toEqual(
        expect.objectContaining({
          type: 'feedback.text.add',
          sessionId: 'session-full-native-code',
          target: {
            version: 2,
            requestedScope: 'rendered-text',
            locator: {
              kind: 'rendered-range',
              value: {
                version: 1,
                startOrdinal: 0,
                startOffset: 0,
                endOrdinal: 0,
                endOffset: source.length,
              },
            },
          },
          evidence: {
            kind: 'rendered-text',
            text: source,
            complete: true,
            language: 'typescript',
          },
        })
      );
      expect(message).not.toHaveProperty('focus');
    } finally {
      controller.deactivate();
      nativeSelection.spy.mockRestore();
      editor.destroy();
    }
  });

  it('turns a partial rendered Mermaid selection into an honest whole-diagram target', () => {
    const source = 'flowchart LR\n  A[Participants] --> B[Product lead]';
    document.body.innerHTML = `
      <div class="formatting-toolbar"></div>
      <main><div id="editor"></div></main>
    `;
    const editor = new Editor({
      element: document.querySelector('#editor') as HTMLElement,
      extensions: [StarterKit, Markdown, MermaidLikeOpaqueNodeView],
      content: {
        type: 'doc',
        content: [
          {
            type: 'mermaid',
            attrs: { language: 'mermaid' },
            content: [{ type: 'text', text: source }],
          },
        ],
      },
    });
    setVisibleReviewGeometry(editor);
    const mermaidBlock = editor.view.dom.firstElementChild;
    const renderedText = mermaidBlock?.querySelector('.mermaid-render')?.firstChild;
    if (!(mermaidBlock instanceof HTMLElement) || !(renderedText instanceof Text)) {
      throw new Error('Missing rendered Mermaid text');
    }
    const selectedLabel = 'Participants';
    const startOffset = renderedText.data.indexOf(selectedLabel);
    const nativeSelection = mockNativeDomRangeSelection(
      renderedText,
      startOffset,
      renderedText,
      startOffset + selectedLabel.length
    );
    expect(nativeSelection.range.toString()).toBe(selectedLabel);
    const postMessage = jest.fn();
    const controller = createFeedbackReviewController({ editor, host: { postMessage } });

    try {
      controller.activate({
        sessionId: 'session-partial-mermaid',
        evidenceVersion: 2,
        source: 'docs/diagram.md',
        sourceSha256: 'd'.repeat(64),
        round: '20260830T120000Z-mermaid',
        anchors: [{ ordinal: 0, startLine: 1, endLine: 4 }],
        items: [],
      });

      expect(controller.commentOnSelection()).toBe(true);
      expect(document.querySelector('[data-feedback-target-label]')?.textContent).toBe(
        'Whole Mermaid diagram'
      );
      expect(document.querySelector('[data-feedback-target-detail]')?.textContent).toBe(
        'Mermaid diagram'
      );
      expect(document.querySelector('[data-feedback-target-preview]')).toBeNull();
      expect(document.querySelector('[data-feedback-target-explanation]')?.textContent).toBe(
        'Rendered diagram parts cannot be anchored independently. This feedback applies to the whole diagram. Use Capture area for a visual sub-area.'
      );
      expect(document.querySelector('[data-feedback-lines]')?.textContent).toBe('Source lines 1-4');
      expect(mermaidBlock.classList).toContain('feedback-pending-target');
      expect(
        editor.view.dom.querySelector(`[data-feedback-ids="${PENDING_FEEDBACK_ANNOTATION_ID}"]`)
      ).toBeNull();

      const feedbackInput = document.querySelector('[data-feedback-input]') as HTMLTextAreaElement;
      feedbackInput.value = 'Clarify the participant relationship.';
      feedbackInput.dispatchEvent(new Event('input', { bubbles: true }));
      feedbackInput.form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

      const message = postMessage.mock.calls
        .map(([candidate]) => candidate)
        .find(candidate => candidate.type === 'feedback.text.add');
      expect(message).toEqual(
        expect.objectContaining({
          type: 'feedback.text.add',
          sessionId: 'session-partial-mermaid',
          startOrdinal: 0,
          endOrdinal: 0,
          feedback: 'Clarify the participant relationship.',
          target: {
            version: 2,
            requestedScope: 'visual-region',
            constraint: { reason: 'opaque-node' },
          },
          evidence: {
            kind: 'semantic-text',
            text: source,
            complete: true,
          },
        })
      );
      expect(message).not.toHaveProperty('focus');
      expect(message).not.toHaveProperty('renderedRange');
      expect(message).not.toHaveProperty('cellTarget');
    } finally {
      controller.deactivate();
      nativeSelection.spy.mockRestore();
      editor.destroy();
    }
  });

  it('submits a whole real table from a nested cell as a plain block target', async () => {
    document.body.innerHTML = `
      <div class="formatting-toolbar"></div>
      <main><div id="editor"></div></main>
    `;
    const editor = createTableEditor();
    setVisibleReviewGeometry(editor);
    const cell = editor.view.dom.querySelector<HTMLElement>('th, td');
    const cellText = cell?.querySelector('p')?.firstChild ?? cell?.firstChild ?? null;
    if (!cell || !cellText) throw new Error('Missing rendered table cell');
    const nativeSelection = jest.spyOn(window, 'getSelection').mockReturnValue({
      anchorNode: cellText,
      focusNode: cellText,
      anchorOffset: 1,
      focusOffset: 1,
      isCollapsed: true,
      rangeCount: 0,
      toString: () => '',
    } as unknown as Selection);
    const postMessage = jest.fn();
    const controller = createFeedbackReviewController({
      editor,
      host: { postMessage },
    });

    try {
      controller.activate({
        sessionId: 'session-table-block',
        evidenceVersion: 2,
        source: 'docs/table.md',
        sourceSha256: 'b'.repeat(64),
        round: '20260826T120000Z-ab12',
        anchors: [{ ordinal: 0, startLine: 1, endLine: 6 }],
        items: [],
      });
      dispatchFeedbackBlockHover(cell);
      await waitForFeedbackFrame();

      const action = document.querySelector<HTMLButtonElement>('[data-feedback-block-action]');
      expect(action).not.toBeNull();
      expect(action?.hidden).toBe(false);
      expect(action?.getAttribute('aria-label')).toBe('Add feedback to this table');
      expect(document.querySelector('[data-feedback-selection-action]')).toBeNull();
      action?.click();

      expect(document.querySelector('[data-feedback-target-label]')?.textContent).toBe(
        'Whole table'
      );
      expect(document.querySelector('[data-feedback-target-detail]')?.textContent).toBe(
        '4 rows × 4 columns'
      );
      expect(document.querySelector('[data-feedback-target-preview]')).toBeNull();
      const feedbackInput = document.querySelector('[data-feedback-input]') as HTMLTextAreaElement;
      feedbackInput.value = 'Review this whole table.';
      feedbackInput.dispatchEvent(new Event('input', { bubbles: true }));
      (document.querySelector('[data-feedback-submit]') as HTMLButtonElement).click();

      const message = postMessage.mock.calls
        .map(([candidate]) => candidate)
        .find(candidate => candidate.type === 'feedback.text.add');
      expect(message).toEqual(
        expect.objectContaining({
          type: 'feedback.text.add',
          sessionId: 'session-table-block',
          startOrdinal: 0,
          endOrdinal: 0,
          feedback: 'Review this whole table.',
          target: { version: 2, requestedScope: 'blocks' },
        })
      );
      expect(message).not.toHaveProperty('focus');
      expect(message).not.toHaveProperty('evidence');
      expect(message).not.toHaveProperty('renderedRange');
      expect(message).not.toHaveProperty('cellTarget');
    } finally {
      controller.deactivate();
      nativeSelection.mockRestore();
      editor.destroy();
    }
  });

  it('shows the collapsed caret block without changing the keyboard range picker', async () => {
    const editor = createLifecycleEditor('<p>Alpha</p><p>Beta gamma</p>');
    const secondBlockPosition = editor.state.doc.child(0).nodeSize + 1;
    editor.commands.setTextSelection(secondBlockPosition);
    setVisibleReviewGeometry(editor);
    const secondBlock = editor.view.dom.children[1] as HTMLElement;
    const secondText = secondBlock.firstChild;
    if (!secondText) throw new Error('Missing second paragraph text');
    const nativeSelection = jest.spyOn(window, 'getSelection').mockReturnValue({
      anchorNode: secondText,
      focusNode: secondText,
      anchorOffset: 0,
      focusOffset: 0,
      isCollapsed: true,
      rangeCount: 0,
      toString: () => '',
    } as unknown as Selection);
    const controller = createFeedbackReviewController({
      editor,
      host: { postMessage: jest.fn() },
    });

    try {
      controller.activate({
        sessionId: 'session-caret-block',
        source: 'docs/guide.md',
        sourceSha256: 'a'.repeat(64),
        round: '20260822T093000Z-k4p9',
        anchors: [
          { ordinal: 0, startLine: 1, endLine: 1 },
          { ordinal: 1, startLine: 3, endLine: 3 },
        ],
        items: [],
      });
      await waitForFeedbackFrame();

      const action = document.querySelector<HTMLButtonElement>('[data-feedback-block-action]');
      expect(action).not.toBeNull();
      expect(action?.hidden).toBe(false);
      expect(action?.getAttribute('aria-label')).toBe('Add feedback to this block');
      expect(action?.style.top).toBe('178px');

      expect(controller.commentOnSelection()).toBe(true);
      expect(action?.hidden).toBe(true);
      expect(document.querySelector('[data-feedback-text-block-selector]')).not.toBeNull();
      expect(document.querySelector('.feedback-composer')).toBeNull();
    } finally {
      controller.deactivate();
      nativeSelection.mockRestore();
      editor.destroy();
    }
  });

  it.each([
    {
      selectionKind: 'a nonempty TextSelection',
      createSelection: (editor: Editor) => TextSelection.create(editor.state.doc, 1, 5),
    },
    {
      selectionKind: 'a NodeSelection',
      createSelection: (editor: Editor) => NodeSelection.create(editor.state.doc, 0),
    },
    {
      selectionKind: 'an AllSelection',
      createSelection: (editor: Editor) => new AllSelection(editor.state.doc),
    },
  ])(
    'suppresses the block action for $selectionKind when native endpoints are unavailable',
    async ({ createSelection }) => {
      const editor = createLifecycleEditor('<p>Alpha beta</p><p>Gamma</p>');
      setVisibleReviewGeometry(editor);
      const nativeSelection = jest.spyOn(window, 'getSelection').mockReturnValue({
        anchorNode: null,
        focusNode: null,
        isCollapsed: true,
        rangeCount: 0,
        toString: () => '',
      } as unknown as Selection);
      const controller = createFeedbackReviewController({
        editor,
        host: { postMessage: jest.fn() },
      });

      try {
        controller.activate({
          sessionId: 'session-pm-selection',
          source: 'docs/guide.md',
          sourceSha256: 'a'.repeat(64),
          round: '20260822T093000Z-k4p9',
          anchors: [
            { ordinal: 0, startLine: 1, endLine: 1 },
            { ordinal: 1, startLine: 3, endLine: 3 },
          ],
          items: [],
        });
        dispatchFeedbackBlockHover(editor.view.dom.children[0]);
        await waitForFeedbackFrame();

        const action = document.querySelector<HTMLButtonElement>('[data-feedback-block-action]');
        expect(action).not.toBeNull();
        expect(action?.hidden).toBe(false);

        editor.view.dispatch(editor.state.tr.setSelection(createSelection(editor)));
        await waitForFeedbackFrame();
        dispatchFeedbackBlockHover(editor.view.dom.children[0]);
        await waitForFeedbackFrame();

        expect(action?.hidden).toBe(true);
        expect(document.querySelector('[data-feedback-selection-action]')).toBeNull();
      } finally {
        controller.deactivate();
        nativeSelection.mockRestore();
        editor.destroy();
      }
    }
  );

  it('keeps mapped ordinals stable across a direct-child GapCursor widget', async () => {
    const editor = createLifecycleEditor('<p>Alpha</p><p>Beta</p><p>Gamma</p>');
    const gapPosition = editor.state.doc.child(0).nodeSize;
    editor.view.dispatch(
      editor.state.tr.setSelection(new GapCursor(editor.state.doc.resolve(gapPosition)))
    );
    const widget = Array.from(editor.view.dom.children).find(element =>
      element.matches('.ProseMirror-gapcursor.ProseMirror-widget')
    );
    const beta = Array.from(editor.view.dom.children).find(
      element => element.textContent === 'Beta'
    );
    const alpha = Array.from(editor.view.dom.children).find(
      element => element.textContent === 'Alpha'
    );
    const gamma = Array.from(editor.view.dom.children).find(
      element => element.textContent === 'Gamma'
    );
    if (!widget || !alpha || !beta || !gamma) {
      throw new Error('Missing live GapCursor widget or mapped paragraph block');
    }
    setVisibleReviewGeometry(editor);
    const nativeSelection = jest.spyOn(window, 'getSelection').mockReturnValue({
      anchorNode: null,
      focusNode: null,
      isCollapsed: true,
      rangeCount: 0,
      toString: () => '',
    } as unknown as Selection);
    const controller = createFeedbackReviewController({
      editor,
      host: { postMessage: jest.fn() },
    });

    try {
      expect(widget.parentElement).toBe(editor.view.dom);
      expect(Array.from(editor.view.dom.children).indexOf(widget)).toBe(1);
      expect(Array.from(editor.view.dom.children).indexOf(beta)).toBe(2);
      controller.activate({
        sessionId: 'session-gapcursor',
        source: 'docs/guide.md',
        sourceSha256: 'a'.repeat(64),
        round: '20260822T093000Z-k4p9',
        anchors: [
          { ordinal: 0, startLine: 1, endLine: 1 },
          { ordinal: 1, startLine: 3, endLine: 3 },
          { ordinal: 2, startLine: 5, endLine: 5 },
        ],
        items: [],
      });
      dispatchFeedbackBlockHover(beta);
      await waitForFeedbackFrame();

      const action = document.querySelector<HTMLButtonElement>('[data-feedback-block-action]');
      expect(action).not.toBeNull();
      expect(action?.hidden).toBe(false);
      action?.click();

      expect(document.querySelector('[data-feedback-focus]')?.textContent).toBe('Beta');
      expect(document.querySelector('[data-feedback-lines]')?.textContent).toBe('Source line 3');
      expect(beta.classList.contains('feedback-pending-target')).toBe(true);
      expect(widget.classList.contains('feedback-pending-target')).toBe(false);
      expect(alpha.classList.contains('feedback-pending-target')).toBe(false);
      expect(gamma.classList.contains('feedback-pending-target')).toBe(false);
    } finally {
      controller.deactivate();
      nativeSelection.mockRestore();
      editor.destroy();
    }
  });

  it('uses the mapped atom DOM for rendered Focus when a GapCursor widget shifts raw children', async () => {
    const editor = createLifecycleEditor('<p>Prelude</p><hr><p>Alpha</p><hr><p>Beta</p>');
    const gapPosition = editor.state.doc.child(0).nodeSize;
    editor.view.dispatch(
      editor.state.tr.setSelection(new GapCursor(editor.state.doc.resolve(gapPosition)))
    );
    const widget = Array.from(editor.view.dom.children).find(element =>
      element.matches('.ProseMirror-gapcursor.ProseMirror-widget')
    );
    let secondRuleOffset = -1;
    editor.state.doc.forEach((_node, offset, ordinal) => {
      if (ordinal === 3) secondRuleOffset = offset;
    });
    const secondRule = editor.view.nodeDOM(secondRuleOffset);
    const alpha = Array.from(editor.view.dom.children).find(
      element => element.textContent === 'Alpha'
    );
    if (!widget || !alpha || !(secondRule instanceof HTMLElement)) {
      throw new Error('Missing live GapCursor widget or mapped horizontal rule');
    }
    for (const element of Array.from(editor.view.dom.children)) {
      (element as HTMLElement).scrollIntoView = jest.fn();
    }
    setVisibleReviewGeometry(editor);
    const nativeSelection = jest.spyOn(window, 'getSelection').mockReturnValue({
      anchorNode: null,
      focusNode: null,
      isCollapsed: true,
      rangeCount: 0,
      toString: () => '',
    } as unknown as Selection);
    const controller = createFeedbackReviewController({
      editor,
      host: { postMessage: jest.fn() },
    });

    try {
      expect(widget.parentElement).toBe(editor.view.dom);
      expect(secondRule.parentElement).toBe(editor.view.dom);
      controller.activate({
        sessionId: 'session-gapcursor-atom',
        source: 'docs/guide.md',
        sourceSha256: 'a'.repeat(64),
        round: '20260822T093000Z-k4p9',
        anchors: [{ ordinal: 3, startLine: 7, endLine: 7 }],
        items: [
          {
            id: 'F1',
            kind: 'text',
            startOrdinal: 3,
            endOrdinal: 3,
            startLine: 7,
            endLine: 7,
            focus: '[horizontalRule]',
            feedback: 'Review this divider.',
          },
        ],
      });
      controller.navigateFeedback('next');

      expect(secondRule.classList.contains('feedback-active-target')).toBe(true);
      expect(widget.classList.contains('feedback-active-target')).toBe(false);
      expect(alpha.classList.contains('feedback-active-target')).toBe(false);

      dispatchFeedbackBlockHover(secondRule);
      await waitForFeedbackFrame();

      const action = document.querySelector<HTMLButtonElement>('[data-feedback-block-action]');
      expect(action).not.toBeNull();
      expect(action?.hidden).toBe(false);
      action?.click();

      expect(document.querySelector('[data-feedback-target-label]')?.textContent).toBe(
        'Whole divider'
      );
      expect(document.querySelector('[data-feedback-target-detail]')?.textContent).toBe('divider');
      expect(document.querySelector('[data-feedback-focus]')).toBeNull();
      expect(document.querySelector('[data-feedback-lines]')?.textContent).toBe('Source line 7');
      expect(secondRule.classList.contains('feedback-pending-target')).toBe(true);
      expect(widget.classList.contains('feedback-pending-target')).toBe(false);
      expect(alpha.classList.contains('feedback-pending-target')).toBe(false);
    } finally {
      controller.deactivate();
      nativeSelection.mockRestore();
      editor.destroy();
    }
  });

  it.each([
    { nativeState: 'a collapsed native caret', outsideEditor: false },
    { nativeState: 'transient native endpoints outside the editor', outsideEditor: true },
  ])(
    'opens the comment composer for a 4x4 CellSelection despite $nativeState',
    async ({ outsideEditor }) => {
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
        evidenceVersion: 2,
        source: 'docs/table.md',
        sourceSha256: 'b'.repeat(64),
        round: '20260826T120000Z-ab12',
        anchors: [{ ordinal: 0, startLine: 1, endLine: 6 }],
        items: [],
      });
      await waitForFeedbackFrame();
      expect(
        document.querySelector('[data-feedback-selection-action]')?.getAttribute('aria-label')
      ).toBe('Add feedback to selected table cells');

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
      selectionFrames[0](0);
      const selectionAction = document.querySelector<HTMLButtonElement>(
        '[data-feedback-selection-action]'
      );
      expect(selectionAction).not.toBeNull();
      expect(selectionAction?.getAttribute('aria-label')).toBe(
        'Add feedback to selected table cells'
      );
      const blockAction = document.querySelector<HTMLButtonElement>('[data-feedback-block-action]');
      expect(blockAction).not.toBeNull();
      expect(blockAction?.hidden).toBe(true);

      const selectedCell = editor.view.dom.querySelector<HTMLElement>('th, td');
      if (!selectedCell) throw new Error('Missing selected table cell');
      dispatchFeedbackBlockHover(selectedCell);
      expect(requestAnimationFrame).toHaveBeenCalledTimes(2);
      selectionFrames[1](0);
      expect(blockAction?.hidden).toBe(true);
      expect(document.querySelector('[data-feedback-selection-action]')).toBe(selectionAction);
      expect(
        Array.from(
          document.querySelectorAll<HTMLButtonElement>(
            '[data-feedback-selection-action], [data-feedback-block-action]'
          )
        ).filter(action => !action.hidden)
      ).toEqual([selectionAction]);

      expect(controller.commentOnSelection()).toBe(true);
      expect(document.querySelector('[data-feedback-text-block-selector]')).toBeNull();
      expect(document.querySelector('.feedback-composer')).not.toBeNull();
      expect(document.querySelector('[data-feedback-target-label]')?.textContent).toBe(
        'Selected cells'
      );
      expect(document.querySelector('[data-feedback-target-detail]')?.textContent).toBe(
        'Rows 1–4 · Columns 1–4 · 16 cells'
      );
      const pendingCells = Array.from(
        editor.view.dom.querySelectorAll<HTMLElement>('.md4h-feedback-annotation-cell')
      ).filter(cell =>
        cell.dataset.feedbackIds?.split(',').includes(PENDING_FEEDBACK_ANNOTATION_ID)
      );
      expect(pendingCells).toHaveLength(16);
      expect(pendingCells.map(cell => cell.textContent)).toEqual([
        'R1C1',
        'R1C2',
        'R1C3',
        'R1C4',
        'R2C1',
        'R2C2',
        'R2C3',
        'R2C4',
        'R3C1',
        'R3C2',
        'R3C3',
        'R3C4',
        'R4C1',
        'R4C2',
        'R4C3',
        'R4C4',
      ]);
      expect(editor.view.dom.firstElementChild?.classList.contains('feedback-pending-target')).toBe(
        false
      );

      const feedbackInput = document.querySelector('[data-feedback-input]') as HTMLTextAreaElement;
      feedbackInput.value = 'Review this table rectangle.';
      feedbackInput.dispatchEvent(new Event('input', { bubbles: true }));
      (document.querySelector('[data-feedback-submit]') as HTMLButtonElement).click();
      expect(postMessage).toHaveBeenLastCalledWith(
        expect.objectContaining({
          type: 'feedback.text.add',
          startOrdinal: 0,
          endOrdinal: 0,
          target: {
            version: 2,
            requestedScope: 'table-cells',
            locator: {
              kind: 'table-cells',
              value: {
                version: 1,
                tableOrdinal: 0,
                rectangle: { top: 0, left: 0, bottom: 4, right: 4 },
                tableFingerprint: expect.stringMatching(/^md4h-table\/v1:[a-f0-9]{16}$/),
              },
            },
          },
          evidence: {
            kind: 'table-cells',
            complete: true,
            rows: Array.from({ length: 4 }, (_, row) =>
              Array.from({ length: 4 }, (_, column) => ({
                role: row === 0 ? 'header' : 'data',
                text: `R${row + 1}C${column + 1}`,
                complete: true,
              }))
            ),
          },
        })
      );
      const addMessage = postMessage.mock.calls.at(-1)?.[0];
      expect(addMessage).not.toHaveProperty('focus');
      expect(addMessage).not.toHaveProperty('cellTarget');

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

  it('refreshes Finish validity without rebuilding annotation decorations', () => {
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
    const session = tableSession(fingerprint);
    const postMessage = jest.fn();
    const controller = createFeedbackReviewController({ editor, host: { postMessage } });
    controller.activate(session);
    const dispatch = jest.spyOn(editor.view, 'dispatch');
    session.items[0].cellTarget.tableFingerprint = 'md4h-table/v1:0123456789abcdef';

    controller.finish();
    dispatch.mockClear();
    document.querySelector<HTMLButtonElement>('[data-feedback-completion-confirm]')?.click();

    expect(dispatch).not.toHaveBeenCalled();
    expect(postMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type: 'feedback.finish',
        sessionId: session.sessionId,
        degradedTargetIds: ['F1'],
      })
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
