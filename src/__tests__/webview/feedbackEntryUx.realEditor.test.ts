/** @jest-environment jsdom */

/**
 * Feedback entry with the real TipTap editor and the real TOC, Find, audit, Link
 * and Table modules. Start must not be refused by a dialog that is already closed,
 * guidance must be visible in an open dialog and must not outlive a reused one,
 * and a failed or successful Start must not leave focus on a control that Start
 * hid, or move the caret or reading position.
 *
 * jsdom has no CSS transitions, layout, scrolling or focus rules for hidden
 * elements. The 07 plan lists the manual VS Code checks for those.
 */

import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import {
  createFeedbackReviewController,
  type FeedbackReviewController,
} from '../../webview/features/feedbackReview';
import { captureSelectedFeedbackBlocks } from '../../webview/features/feedbackCaptureWorkflow';
import { hideLinkDialog, showLinkDialog } from '../../webview/features/linkDialog';
import { hideSearchOverlay, showSearchOverlay } from '../../webview/features/searchOverlay';
import { hideTableInsertDialog, showTableInsertDialog } from '../../webview/features/tableInsert';
import { hideTocOverlay, showTocOverlay } from '../../webview/features/tocOverlay';
import { showAuditOverlay } from '../../webview/features/auditOverlay';
import type { FeedbackWebviewMessage } from '../../shared/feedbackProtocol';

const DIALOG_NOTICE = 'Complete or close this dialog before starting Feedback.';

async function nextFrame(): Promise<void> {
  await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
}

describe('Feedback entry with real editing overlays', () => {
  let editor: Editor;
  let controller: FeedbackReviewController;
  let posted: FeedbackWebviewMessage[];

  beforeAll(() => {
    // Closing Link or Table focuses TipTap with scrollIntoView, which measures a
    // DOM Range. jsdom implements neither Range measurement method.
    Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
    Range.prototype.getBoundingClientRect = () => new DOMRect(0, 0, 0, 0);
  });

  const startRequest = ():
    Extract<FeedbackWebviewMessage, { type: 'feedback.start' }> | undefined =>
    posted.find(
      (message): message is Extract<FeedbackWebviewMessage, { type: 'feedback.start' }> =>
        message.type === 'feedback.start'
    );

  beforeEach(() => {
    // The overlay modules keep mounted singletons, so replace only the editor shell.
    document.querySelector('#fixture-shell')?.remove();
    const shell = document.createElement('div');
    shell.id = 'fixture-shell';
    shell.innerHTML = '<div class="formatting-toolbar"></div><main><div id="editor"></div></main>';
    document.body.append(shell);
    editor = new Editor({
      element: shell.querySelector('#editor') as HTMLElement,
      extensions: [StarterKit],
      content: '<h1>Title</h1><p>Alpha beta</p>',
    });
    posted = [];
    controller = createFeedbackReviewController({
      editor,
      host: { postMessage: message => posted.push(message) },
    });
  });

  afterEach(() => {
    // Close every singleton so a failed test cannot leave a dialog open for the next.
    hideTocOverlay(editor, false);
    hideSearchOverlay(editor, false);
    hideLinkDialog();
    hideTableInsertDialog();
    controller.deactivate();
    editor.destroy();
    document.body.classList.remove('feedback-review-starting');
  });

  describe('E1: closed dialogs that are still fading out', () => {
    it('starts Feedback right after the TOC closes', async () => {
      showTocOverlay(editor);
      await nextFrame();

      // editor.ts closes the TOC, then starts. Without a stylesheet the closed TOC
      // still computes as visible, as it does in Chromium during its 200 ms fade.
      hideTocOverlay(editor, false);
      controller.start();

      expect(startRequest()).toBeDefined();
      expect(document.querySelector('[data-feedback-draft-notice]')).toBeNull();
    });

    it('starts Feedback right after the Table dialog closes', async () => {
      showTableInsertDialog(editor);
      await nextFrame();
      hideTableInsertDialog();

      controller.start();

      expect(startRequest()).toBeDefined();
      expect(document.querySelector('[data-feedback-draft-notice]')).toBeNull();
    });

    it('still redirects Start to a TOC that is open', async () => {
      showTocOverlay(editor);
      await nextFrame();

      controller.start();

      expect(startRequest()).toBeUndefined();
      // The TOC root is a full-viewport flex row under an opaque backdrop. Only
      // the panel paints above the backdrop, so the notice and outline go there.
      const panel = document.querySelector<HTMLElement>('.toc-overlay-panel')!;
      expect(panel.querySelector('[data-feedback-draft-notice]')?.textContent).toBe(DIALOG_NOTICE);
      expect(panel.classList).toContain('feedback-draft-attention');
      expect(document.querySelector('.toc-overlay')!.classList).not.toContain(
        'feedback-draft-attention'
      );
      hideTocOverlay(editor, false);
    });
  });

  describe('E3: guidance in reused dialogs', () => {
    it.each([
      ['Link', () => showLinkDialog(editor), () => hideLinkDialog(), '.link-dialog-popover'],
      [
        'Table',
        () => showTableInsertDialog(editor),
        () => hideTableInsertDialog(),
        '.export-settings-overlay',
      ],
    ])(
      'clears the Start notice when the %s dialog closes',
      async (_name, open, close, selector) => {
        open();
        await nextFrame();
        controller.start();

        const dialog = document.querySelector<HTMLElement>(selector)!;
        const panel = dialog.querySelector<HTMLElement>('.export-settings-overlay-panel')!;
        expect(startRequest()).toBeUndefined();
        expect(panel.querySelector('[data-feedback-draft-notice]')?.textContent).toBe(
          DIALOG_NOTICE
        );

        close();
        // MutationObserver records are delivered as a microtask.
        await Promise.resolve();
        open();
        await nextFrame();

        expect(document.querySelector('[data-feedback-draft-notice]')).toBeNull();
        expect(panel.classList).not.toContain('feedback-draft-attention');
        close();
      }
    );

    it('keeps the Start notice while the dialog stays open', async () => {
      // A dialog with no known panel, such as SVG display size, is its own notice
      // surface, so the attention timer changes the class the close observer watches.
      const dialog = document.createElement('form');
      dialog.setAttribute('role', 'dialog');
      dialog.setAttribute('aria-modal', 'true');
      dialog.innerHTML = '<h2>Display size</h2><input type="number" value="300" />';
      document.body.append(dialog);
      jest.useFakeTimers();
      try {
        controller.start();
        expect(dialog.classList).toContain('feedback-draft-attention');

        jest.advanceTimersByTime(1800);
        // MutationObserver records are delivered as a microtask.
        await Promise.resolve();

        expect(dialog.classList).not.toContain('feedback-draft-attention');
        expect(dialog.querySelector('[data-feedback-draft-notice]')?.textContent).toBe(
          DIALOG_NOTICE
        );
      } finally {
        jest.useRealTimers();
        dialog.remove();
      }
    });
  });

  describe('E4: focus after Start from Find or the TOC', () => {
    it('falls back to the editor when the remembered control refuses focus', () => {
      const button = document.createElement('button');
      button.type = 'button';
      document.querySelector('.formatting-toolbar')!.append(button);
      button.focus();

      controller.start();
      const request = startRequest();
      expect(request).toBeDefined();

      // Chromium blurs a control that becomes hidden and ignores focus() on it.
      // jsdom renders nothing, so model both.
      button.blur();
      const refuseFocus = jest.spyOn(button, 'focus').mockImplementation(() => undefined);
      try {
        controller.handleHostMessage({
          type: 'feedback.error',
          requestId: request!.requestId,
          message: 'Feedback could not start.',
          recoverable: true,
        });

        expect(document.body.classList).not.toContain('feedback-review-starting');
        expect(document.activeElement).toBe(editor.view.dom);
      } finally {
        refuseFocus.mockRestore();
      }
    });

    // Find and the TOC fade out after Start closes them. Their controls accept
    // focus during the fade, then Chromium drops focus to BODY. jsdom has no fade,
    // so focus left inside a closed overlay is the observable defect here.
    const focusFindAndStart = (): string => {
      showSearchOverlay(editor);
      document.querySelector<HTMLInputElement>('.search-overlay-input')!.focus();
      hideSearchOverlay(editor, false);
      controller.start();
      return startRequest()!.requestId;
    };

    it('moves focus to the editor when Start from Find fails during the fade', () => {
      const requestId = focusFindAndStart();
      controller.handleHostMessage({
        type: 'feedback.error',
        requestId,
        message: 'Feedback could not start.',
        recoverable: true,
      });

      expect(document.activeElement).toBe(editor.view.dom);
    });

    it('leaves focus in the editor when Start from Find succeeds', () => {
      const requestId = focusFindAndStart();
      controller.handleHostMessage({
        type: 'feedback.started',
        requestId,
        sessionId: 'session-1',
        source: 'docs/guide.md',
        sourceSha256: 'a'.repeat(64),
        round: '20260930T093000Z-k4p9',
        feedbackFile: '.md4h/feedback/guide.md--20260930T093000Z-k4p9/feedback.md',
        anchors: [{ ordinal: 0, startLine: 1, endLine: 1 }],
        items: [],
      });

      expect(controller.getSession()?.sessionId).toBe('session-1');
      expect(document.activeElement).toBe(editor.view.dom);
    });

    // Chromium's focus() on a contenteditable root collapses a selection that sits
    // elsewhere, such as in the Find input, to the start of the editor. It fires
    // focus first, and not at all while the window lacks system focus. ProseMirror
    // reads that caret on the next selectionchange. jsdom does none of this.
    const modelChromiumEditorFocus = (deliverFocusEvent: boolean): jest.SpyInstance => {
      const editorDom = editor.view.dom;
      const nativeFocus = HTMLElement.prototype.focus;
      const blockFocusEvent = (event: Event) => event.stopPropagation();
      return jest.spyOn(editorDom, 'focus').mockImplementation(focusOptions => {
        const selection = document.getSelection()!;
        const selectionInEditor =
          !!selection.anchorNode && editorDom.contains(selection.anchorNode);
        if (!deliverFocusEvent) window.addEventListener('focus', blockFocusEvent, true);
        try {
          nativeFocus.call(editorDom, focusOptions);
        } finally {
          window.removeEventListener('focus', blockFocusEvent, true);
        }
        if (!selectionInEditor) selection.collapse(editorDom, 0);
      });
    };
    // jsdom fires selectionchange in a task; ProseMirror's focus handler syncs after 20 ms.
    const settleSelection = () => new Promise(resolve => setTimeout(resolve, 40));

    it('keeps the reading position when Start from Find focuses the editor', async () => {
      editor.commands.setTextSelection(12);
      const scrollToSelection = jest.fn(() => true);
      const scrollProbe = new PluginKey('scrollProbe');
      editor.registerPlugin(
        new Plugin({ key: scrollProbe, props: { handleScrollToSelection: scrollToSelection } })
      );
      const editorFocus = modelChromiumEditorFocus(true);
      try {
        focusFindAndStart();
        await settleSelection();

        expect(editorFocus).toHaveBeenCalled();
        expect(document.activeElement).toBe(editor.view.dom);
        expect(scrollToSelection).not.toHaveBeenCalled();
        expect(editor.state.selection.from).toBe(12);
      } finally {
        editorFocus.mockRestore();
        editor.unregisterPlugin(scrollProbe);
      }
    });

    it('keeps the caret when Start from Find focuses the editor without a focus event', async () => {
      editor.commands.setTextSelection(12);
      const editorFocus = modelChromiumEditorFocus(false);
      try {
        focusFindAndStart();
        await settleSelection();

        expect(editorFocus).toHaveBeenCalled();
        expect(document.activeElement).toBe(editor.view.dom);
        expect(editor.state.selection.from).toBe(12);
      } finally {
        editorFocus.mockRestore();
      }
    });

    it('moves focus to the editor when Start succeeds after closing the audit overlay', () => {
      showAuditOverlay(editor, [
        { type: 'link', message: 'Broken link', pos: 8, nodeSize: 5, target: 'missing.md' },
      ]);
      document.querySelector<HTMLElement>('.audit-overlay-item')!.focus();
      // editor.ts closes the audit overlay through its close button, which only
      // removes `visible`; the overlay then fades like Find and the TOC.
      document
        .querySelector<HTMLButtonElement>('.audit-overlay.visible .audit-overlay-close')!
        .click();
      controller.start();
      controller.handleHostMessage({
        type: 'feedback.started',
        requestId: startRequest()!.requestId,
        sessionId: 'session-1',
        source: 'docs/guide.md',
        sourceSha256: 'a'.repeat(64),
        round: '20260930T093000Z-k4p9',
        feedbackFile: '.md4h/feedback/guide.md--20260930T093000Z-k4p9/feedback.md',
        anchors: [{ ordinal: 0, startLine: 1, endLine: 1 }],
        items: [],
      });

      expect(controller.getSession()?.sessionId).toBe('session-1');
      expect(document.activeElement).toBe(editor.view.dom);
    });

    it('moves focus to the editor when Start from Find runs during a session', () => {
      controller.activate({
        sessionId: 'session-1',
        source: 'docs/guide.md',
        sourceSha256: 'a'.repeat(64),
        round: '20260930T093000Z-k4p9',
        anchors: [{ ordinal: 0, startLine: 1, endLine: 1 }],
        items: [],
      });
      showSearchOverlay(editor);
      document.querySelector<HTMLInputElement>('.search-overlay-input')!.focus();
      hideSearchOverlay(editor, false);

      // Start is a no-op while a session is active, but editor.ts already closed Find.
      controller.start();

      expect(startRequest()).toBeUndefined();
      expect(document.activeElement).toBe(editor.view.dom);
    });

    it('moves focus to the editor when Start after closing the TOC fails', async () => {
      showTocOverlay(editor);
      await nextFrame();
      expect(document.activeElement?.closest('.toc-overlay')).not.toBeNull();

      hideTocOverlay(editor, false);
      controller.start();
      // Closing the TOC focuses TipTap one frame later; a host reply comes after.
      await nextFrame();
      controller.handleHostMessage({
        type: 'feedback.error',
        requestId: startRequest()!.requestId,
        message: 'Feedback could not start.',
        recoverable: true,
      });

      expect(document.activeElement).toBe(editor.view.dom);
    });

    it('returns focus to a remembered control that is still visible', () => {
      const button = document.createElement('button');
      button.type = 'button';
      document.querySelector('.formatting-toolbar')!.append(button);
      button.focus();

      controller.start();
      controller.handleHostMessage({
        type: 'feedback.error',
        requestId: startRequest()!.requestId,
        message: 'Feedback could not start.',
        recoverable: true,
      });

      expect(document.activeElement).toBe(button);
    });
  });

  describe('E7: capture blocked by an unfinished comment', () => {
    it('shows one message, on the comment, instead of a second toast', () => {
      controller.activate({
        sessionId: 'session-1',
        source: 'docs/guide.md',
        sourceSha256: 'a'.repeat(64),
        round: '20260930T093000Z-k4p9',
        anchors: [{ ordinal: 0, startLine: 1, endLine: 1 }],
        items: [],
      });
      const composer = document.createElement('section');
      const input = document.createElement('textarea');
      input.setAttribute('data-feedback-input', '');
      input.value = 'Keep this unfinished comment.';
      composer.append(input);
      document.body.append(composer);
      const lease = controller.draftSurfaceGate.claim({
        kind: 'text-composer',
        element: composer,
        focus: () => input.focus(),
      });
      const onLocalError = jest.fn();
      window.addEventListener('feedbackLocalError', onLocalError);

      try {
        captureSelectedFeedbackBlocks({ editor, review: controller, rasterize: jest.fn() });

        expect(document.activeElement).toBe(input);
        expect(input.value).toBe('Keep this unfinished comment.');
        const notices = document.querySelectorAll('[data-feedback-draft-notice]');
        expect(notices).toHaveLength(1);
        expect(composer.contains(notices[0]!)).toBe(true);
        expect(onLocalError).not.toHaveBeenCalled();
      } finally {
        window.removeEventListener('feedbackLocalError', onLocalError);
        lease?.release();
        composer.remove();
      }
    });
  });
});
