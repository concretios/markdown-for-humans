/**
 * Copyright (c) 2025-2026 Concret.io
 *
 * Licensed under the MIT License. See LICENSE file in the project root for details.
 *
 * @fileoverview Peer navigation reveals an existing host-owned session without creating,
 * transferring, unlocking, or writing a Feedback draft.
 */
import * as vscode from 'vscode';
import { MarkdownEditorProvider } from '../../editor/MarkdownEditorProvider';

interface NavigationInternals {
  handleWebviewMessage(
    message: Record<string, unknown> & { type: string },
    document: vscode.TextDocument,
    webview: vscode.Webview
  ): void;
  openPanels: Map<
    string,
    Map<vscode.WebviewPanel, { document: vscode.TextDocument; webview: vscode.Webview }>
  >;
  feedbackWebviews: Map<string, Set<vscode.Webview>>;
  feedbackSessions: Map<
    string,
    {
      ownerWebview: vscode.Webview;
      sessionId: string;
      phase: string;
      mutationIdleWaiters: Set<() => void>;
    }
  >;
  feedbackTransitions: Map<string, unknown>;
  pendingFeedbackSessionTransfers: Map<string, unknown>;
  editViewGenerations: WeakMap<vscode.Webview, string>;
  appliedFeedbackPeerLocks: WeakMap<vscode.Webview, { lockId: string; viewGeneration: string }>;
}

describe('Feedback peer owner navigation', () => {
  function createFixture() {
    const provider = new MarkdownEditorProvider({
      subscriptions: [],
    } as unknown as vscode.ExtensionContext);
    const state = provider as unknown as NavigationInternals;
    const documentKey = 'file:///workspace/guide.md';
    const document = { uri: { toString: () => documentKey } } as vscode.TextDocument;
    const owner = { postMessage: jest.fn() } as unknown as vscode.Webview;
    const peer = { postMessage: jest.fn() } as unknown as vscode.Webview;
    const reveal = jest.fn();
    const panel = { reveal, viewColumn: 2 } as unknown as vscode.WebviewPanel;
    const peerPanel = {} as vscode.WebviewPanel;
    const session = {
      ownerWebview: owner,
      sessionId: 'session-1',
      phase: 'active',
      mutationIdleWaiters: new Set<() => void>(),
    };
    state.openPanels.set(
      documentKey,
      new Map([
        [panel, { document, webview: owner }],
        [peerPanel, { document, webview: peer }],
      ])
    );
    state.feedbackWebviews.set(documentKey, new Set([owner, peer]));
    state.feedbackSessions.set(documentKey, session);
    state.editViewGenerations.set(peer, 'peer-generation');
    state.appliedFeedbackPeerLocks.set(peer, {
      lockId: 'session-1',
      viewGeneration: 'peer-generation',
    });
    const message = {
      type: 'feedback.peer.reveal',
      requestId: 'reveal-1',
      lockId: 'session-1',
      viewGeneration: 'peer-generation',
    };
    const navigate = (overrides: Record<string, unknown> = {}) =>
      state.handleWebviewMessage({ ...message, ...overrides }, document, peer);
    const dispose = () => {
      state.pendingFeedbackSessionTransfers.clear();
      provider.dispose();
    };
    return { state, owner, peer, panel, session, documentKey, navigate, reveal, dispose };
  }

  beforeEach(() => jest.clearAllMocks());

  it('focuses the same-document owner panel without transferring ownership or unlocking the peer', () => {
    const fixture = createFixture();
    try {
      fixture.navigate();
      expect(fixture.reveal).toHaveBeenCalledWith(2, false);
      expect(fixture.state.feedbackSessions.get(fixture.documentKey)).toBe(fixture.session);
      expect(fixture.session.ownerWebview).toBe(fixture.owner);
      expect(fixture.owner.postMessage).not.toHaveBeenCalled();
      expect(fixture.peer.postMessage).not.toHaveBeenCalled();
      expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
    } finally {
      fixture.dispose();
    }
  });

  it.each([
    'stale-lock',
    'stale-generation',
    'unregistered-peer',
    'missing-owner',
    'missing-session',
    'other-document',
  ])('keeps the peer locked and reports recoverable navigation failure for %s', failure => {
    const fixture = createFixture();
    try {
      if (failure === 'unregistered-peer')
        fixture.state.feedbackWebviews.get(fixture.documentKey)?.delete(fixture.peer);
      if (failure === 'missing-owner')
        fixture.state.openPanels.get(fixture.documentKey)?.delete(fixture.panel);
      if (failure === 'missing-session') fixture.state.feedbackSessions.delete(fixture.documentKey);
      if (failure === 'other-document') {
        fixture.state.openPanels.set(
          'file:///workspace/other.md',
          fixture.state.openPanels.get(fixture.documentKey)!
        );
        fixture.state.openPanels.delete(fixture.documentKey);
      }
      fixture.navigate(
        failure === 'stale-lock'
          ? { lockId: 'old-session' }
          : failure === 'stale-generation'
            ? { viewGeneration: 'old-generation' }
            : {}
      );
      expect(fixture.reveal).not.toHaveBeenCalled();
      // Both warnings contain "Try again"; only this one says "no longer available".
      expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
        expect.stringMatching(/no longer available/i)
      );
      expect(fixture.peer.postMessage).not.toHaveBeenCalled();
    } finally {
      fixture.dispose();
    }
  });

  it.each(['resuming', 'finishing', 'discarding', 'transition', 'transfer'])(
    'does not expose an owner during the %s state',
    phase => {
      const fixture = createFixture();
      try {
        if (phase === 'transition') fixture.state.feedbackTransitions.set(fixture.documentKey, {});
        else if (phase === 'transfer')
          fixture.state.pendingFeedbackSessionTransfers.set(fixture.documentKey, {});
        else fixture.session.phase = phase;
        fixture.navigate();
        expect(fixture.reveal).not.toHaveBeenCalled();
        // Both warnings contain "Try again"; only the transition one says "changing state".
        expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
          expect.stringMatching(/changing state/i)
        );
      } finally {
        fixture.dispose();
      }
    }
  );

  it('reports a Start or Resume transition whose lock is not a session id as changing state', () => {
    const fixture = createFixture();
    try {
      const transitionLockId = '9f1c2b7a4d6e8f00112233445566778899';
      fixture.state.feedbackSessions.delete(fixture.documentKey);
      fixture.state.feedbackTransitions.set(fixture.documentKey, {
        lockId: transitionLockId,
        ownerWebview: fixture.owner,
      });
      fixture.state.appliedFeedbackPeerLocks.set(fixture.peer, {
        lockId: transitionLockId,
        viewGeneration: 'peer-generation',
      });

      fixture.navigate({ lockId: transitionLockId });

      expect(fixture.reveal).not.toHaveBeenCalled();
      expect(vscode.window.showWarningMessage).toHaveBeenCalledTimes(1);
      expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
        expect.stringMatching(/changing state/i)
      );
      expect(fixture.peer.postMessage).not.toHaveBeenCalled();
    } finally {
      fixture.dispose();
    }
  });

  it.each(['stale-generation', 'unregistered-sender', 'stale-owner'])(
    'tells a %s renderer that its transition lock is no longer available',
    failure => {
      const fixture = createFixture();
      try {
        const transitionLockId = '9f1c2b7a4d6e8f00112233445566778899';
        fixture.state.feedbackTransitions.set(fixture.documentKey, {
          lockId: transitionLockId,
          ownerWebview: fixture.owner,
        });
        fixture.state.appliedFeedbackPeerLocks.set(fixture.peer, {
          lockId: transitionLockId,
          viewGeneration: 'peer-generation',
        });
        if (failure === 'unregistered-sender')
          fixture.state.feedbackWebviews.get(fixture.documentKey)?.delete(fixture.peer);
        fixture.state.editViewGenerations.set(fixture.owner, 'owner-generation');

        if (failure === 'stale-owner') {
          // A reloaded owner's old renderer asking about its own session.
          fixture.state.handleWebviewMessage(
            {
              type: 'feedback.peer.reveal',
              requestId: 'reveal-stale-owner',
              lockId: 'session-1',
              viewGeneration: 'old-owner-generation',
            },
            { uri: { toString: () => fixture.documentKey } } as vscode.TextDocument,
            fixture.owner
          );
        } else {
          fixture.navigate({
            lockId: transitionLockId,
            ...(failure === 'stale-generation' ? { viewGeneration: 'old-generation' } : {}),
          });
        }

        expect(fixture.reveal).not.toHaveBeenCalled();
        expect(vscode.window.showWarningMessage).toHaveBeenCalledTimes(1);
        expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
          expect.stringMatching(/no longer available/i)
        );
      } finally {
        fixture.dispose();
      }
    }
  );

  it('reports the owner restoring its own session as changing state', () => {
    const fixture = createFixture();
    try {
      fixture.state.editViewGenerations.set(fixture.owner, 'owner-generation');

      fixture.state.handleWebviewMessage(
        {
          type: 'feedback.peer.reveal',
          requestId: 'reveal-self',
          lockId: 'session-1',
          viewGeneration: 'owner-generation',
        },
        { uri: { toString: () => fixture.documentKey } } as vscode.TextDocument,
        fixture.owner
      );

      expect(fixture.reveal).not.toHaveBeenCalled();
      expect(vscode.window.showWarningMessage).toHaveBeenCalledTimes(1);
      expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
        expect.stringMatching(/changing state/i)
      );
    } finally {
      fixture.dispose();
    }
  });

  it('reports a recoverable error if the owner panel is disposed during reveal', () => {
    const fixture = createFixture();
    const logError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      fixture.reveal.mockImplementation(() => {
        throw new Error('Disposed');
      });
      fixture.navigate();
      expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
        expect.stringMatching(/reopen/i)
      );
      expect(fixture.state.feedbackSessions.get(fixture.documentKey)).toBe(fixture.session);
    } finally {
      fixture.dispose();
      logError.mockRestore();
    }
  });
});
