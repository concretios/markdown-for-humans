/**
 * @jest-environment jsdom
 */

/**
 * Copyright (c) 2025-2026 Concret.io
 *
 * Licensed under the MIT License. See LICENSE file in the project root for details.
 *
 * @fileoverview Fail-closed retry contracts for Feedback close synchronization.
 */

import type { Editor } from '@tiptap/core';
import {
  createFeedbackReviewController,
  type FeedbackReviewController,
  type FeedbackReviewHost,
} from '../../webview/features/feedbackReview';

interface CloseSyncMessage {
  type: 'feedback.close.sync';
  requestId: string;
  sessionId: string;
  revision: number;
  content: string;
}

describe('Feedback close synchronization retry', () => {
  let host: FeedbackReviewHost;

  beforeEach(() => {
    host = { postMessage: jest.fn() };
  });

  afterEach(() => {
    window.dispatchEvent(new CustomEvent('feedbackSessionEnded'));
    document.body.innerHTML = '';
  });

  it.each([
    {
      label: 'returns false',
      applyFirst: () => false,
    },
    {
      label: 'throws',
      applyFirst: () => {
        throw new Error('TipTap setContent failed');
      },
    },
  ])(
    'keeps the session locked, offers a correlated retry, and applies the resent revision when sync $label',
    ({ applyFirst }) => {
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
      const closeController = controller as FeedbackReviewController & {
        applyCloseSync(sync: CloseSyncMessage, apply: (content: string) => boolean): boolean;
      };
      const firstSync: CloseSyncMessage = {
        type: 'feedback.close.sync',
        requestId: 'discard-current',
        sessionId: 'current-session',
        revision: 1,
        content: '# First authoritative source\n',
      };
      const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);

      expect(closeController.applyCloseSync(firstSync, applyFirst)).toBe(false);

      expect(controller.getSession()?.sessionId).toBe('current-session');
      expect(editor.view.dom.getAttribute('aria-readonly')).toBe('true');
      expect(document.body.classList).toContain('feedback-review-active');
      expect(host.postMessage).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: 'feedback.close.applied' })
      );

      const retry = document.querySelector<HTMLButtonElement>('[data-feedback-close-retry]');
      expect(retry).not.toBeNull();
      expect(retry?.getAttribute('aria-label')).toMatch(/retry/i);
      retry?.click();

      expect(host.postMessage).toHaveBeenCalledWith({
        type: 'feedback.close.retry',
        requestId: 'discard-current',
        sessionId: 'current-session',
        revision: 1,
      });
      expect(controller.getSession()?.sessionId).toBe('current-session');
      expect(editor.view.dom.getAttribute('aria-readonly')).toBe('true');

      const applyRetriedContent = jest.fn(() => true);
      expect(
        closeController.applyCloseSync(
          {
            type: 'feedback.close.sync',
            requestId: 'discard-current',
            sessionId: 'current-session',
            revision: 2,
            content: '# Latest authoritative source\n',
          },
          applyRetriedContent
        )
      ).toBe(true);
      expect(applyRetriedContent).toHaveBeenCalledWith('# Latest authoritative source\n');
      expect(host.postMessage).toHaveBeenCalledWith({
        type: 'feedback.close.applied',
        requestId: 'discard-current',
        sessionId: 'current-session',
        revision: 2,
      });
      expect(document.querySelector('[data-feedback-close-retry]')).toBeNull();
      expect(controller.getSession()?.sessionId).toBe('current-session');
      expect(editor.view.dom.getAttribute('aria-readonly')).toBe('true');

      consoleError.mockRestore();
    }
  );

  it('keeps keyboard focus in the editor when a successful retry removes its alert', () => {
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

    const firstSync: CloseSyncMessage = {
      type: 'feedback.close.sync',
      requestId: 'discard-current',
      sessionId: 'current-session',
      revision: 1,
      content: '# First authoritative source\n',
    };
    expect(controller.applyCloseSync(firstSync, () => false)).toBe(false);

    const retry = document.querySelector<HTMLButtonElement>('[data-feedback-close-retry]');
    expect(document.activeElement).toBe(retry);
    retry?.click();
    expect(retry?.disabled).toBe(true);

    expect(
      controller.applyCloseSync(
        {
          ...firstSync,
          revision: 2,
          content: '# Latest authoritative source\n',
        },
        () => true
      )
    ).toBe(true);

    expect(document.querySelector('[data-feedback-close-retry]')).toBeNull();
    expect(document.activeElement).toBe(editor.view.dom);
  });

  it('makes a closing session non-writable and ignores duplicate close actions', () => {
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
    (host.postMessage as jest.Mock).mockClear();
    jest.spyOn(window, 'confirm').mockReturnValue(true);

    expect(controller.isWritable()).toBe(false);
    controller.finish();
    controller.discard();

    expect(host.postMessage).not.toHaveBeenCalled();
  });

  it('re-enables Retry when the host rejects a retry without releasing the close lock', () => {
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
    expect(
      controller.applyCloseSync(
        {
          type: 'feedback.close.sync',
          requestId: 'discard-current',
          sessionId: 'current-session',
          revision: 1,
          content: '# Authoritative source\n',
        },
        () => false
      )
    ).toBe(false);

    const retry = document.querySelector<HTMLButtonElement>('[data-feedback-close-retry]');
    retry?.click();
    expect(retry?.disabled).toBe(true);
    expect(retry?.textContent).toBe('Retrying…');

    controller.handleHostMessage({
      type: 'feedback.error',
      requestId: 'discard-current',
      sessionId: 'current-session',
      code: 'MD4H-FB-STORE-001',
      message: 'The latest Markdown source could not be read.',
      recoverable: true,
    });

    expect(retry?.disabled).toBe(false);
    expect(retry?.textContent).toBe('Retry');
    expect(document.activeElement).toBe(retry);
  });
});

function createEditorFixture(): Editor {
  document.body.innerHTML = `
    <div class="formatting-toolbar"></div>
    <main id="editor-shell">
      <div id="editor"><div class="tiptap" contenteditable="true"><p>Body</p></div></div>
    </main>
  `;

  const paragraph = {
    type: { name: 'paragraph' },
    nodeSize: 6,
    isAtom: false,
    attrs: {},
    content: { size: 4 },
    textBetween: () => 'Body',
  };
  const doc = {
    childCount: 1,
    child: () => paragraph,
    maybeChild: (index: number) => (index === 0 ? paragraph : null),
    forEach: (callback: (node: typeof paragraph, offset: number, ordinal: number) => void) =>
      callback(paragraph, 0, 0),
    textBetween: () => 'Body',
  };
  const fixture = {
    state: { doc, selection: { from: 1, to: 1, empty: true } },
    view: { dom: document.querySelector('.tiptap') as HTMLElement },
    storage: {
      markdown: {
        serializer: { serialize: jest.fn(() => 'Body') },
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
  (fixture.view.dom.firstElementChild as HTMLElement).getBoundingClientRect = () =>
    ({
      top: 24,
      bottom: 64,
      left: 32,
      right: 720,
      width: 688,
      height: 40,
      x: 32,
      y: 24,
      toJSON: () => ({}),
    }) as DOMRect;

  return fixture as unknown as Editor;
}
