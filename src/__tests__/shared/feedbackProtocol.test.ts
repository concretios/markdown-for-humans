import type { FeedbackHostMessage } from '../../shared/feedbackProtocol';
import {
  FEEDBACK_ERROR_CODES,
  parseFeedbackHostMessage,
  parseFeedbackWebviewMessage,
} from '../../shared/feedbackProtocol';

describe('feedback protocol', () => {
  it.each(['nextFeedback', 'previousFeedback'] as const)(
    'includes the %s host navigation command',
    command => {
      const message = {
        type: 'feedback.command',
        command,
      } satisfies FeedbackHostMessage;

      expect(message).toEqual({ type: 'feedback.command', command });
    }
  );

  it('accepts a structurally valid start request', () => {
    const message = parseFeedbackWebviewMessage({
      type: 'feedback.start',
      requestId: 'request-1',
      blocks: [
        { ordinal: 0, kind: 'heading', markdown: '# Title', contentSize: 5 },
        { ordinal: 1, kind: 'paragraph', markdown: 'Body', contentSize: 4 },
      ],
    });

    expect(message).toEqual({
      type: 'feedback.start',
      requestId: 'request-1',
      blocks: [
        { ordinal: 0, kind: 'heading', markdown: '# Title', contentSize: 5 },
        { ordinal: 1, kind: 'paragraph', markdown: 'Body', contentSize: 4 },
      ],
    });
  });

  it('accepts only an explicit new-round start bypass', () => {
    const message = {
      type: 'feedback.start.new',
      requestId: 'request-new-1',
      blocks: [{ ordinal: 0, kind: 'paragraph', markdown: 'Body', contentSize: 4 }],
    };

    expect(parseFeedbackWebviewMessage(message)).toEqual(message);
    expect(parseFeedbackWebviewMessage({ ...message, skipResume: true })).toBeNull();
  });

  it('accepts only an exact correlated close readiness message', () => {
    const message = {
      type: 'feedback.close.ready',
      requestId: 'finish-1',
      sessionId: 'session-1',
    };
    expect(parseFeedbackWebviewMessage(message)).toEqual(message);
    expect(parseFeedbackWebviewMessage({ ...message, outcome: 'finished' })).toBeNull();
  });

  it('requires a positive sync revision on close application', () => {
    const message = {
      type: 'feedback.close.applied',
      requestId: 'finish-1',
      sessionId: 'session-1',
      revision: 1,
    };
    expect(parseFeedbackWebviewMessage(message)).toEqual(message);
    expect(parseFeedbackWebviewMessage({ ...message, revision: 0 })).toBeNull();
    expect(parseFeedbackWebviewMessage({ ...message, revision: undefined })).toBeNull();
  });

  it('requires an exact positive release revision acknowledgement', () => {
    const message = {
      type: 'feedback.close.released',
      requestId: 'finish-1',
      sessionId: 'session-1',
      revision: 1,
    };
    expect(parseFeedbackWebviewMessage(message)).toEqual(message);
    expect(parseFeedbackWebviewMessage({ ...message, revision: 0 })).toBeNull();
    expect(parseFeedbackWebviewMessage({ ...message, released: true })).toBeNull();
  });

  it('accepts only an exact correlated close retry', () => {
    const message = {
      type: 'feedback.close.retry',
      requestId: 'finish-1',
      sessionId: 'session-1',
      revision: 1,
    };
    expect(parseFeedbackWebviewMessage(message)).toEqual(message);
    expect(parseFeedbackWebviewMessage({ ...message, revision: 0 })).toBeNull();
    expect(parseFeedbackWebviewMessage({ ...message, reason: 'leaked detail' })).toBeNull();
  });

  it('requires an exact correlated transition application acknowledgement', () => {
    const message = {
      type: 'feedback.transition.applied',
      requestId: 'start-1',
      lockId: 'transition-lock-1',
      revision: 1,
    };
    expect(parseFeedbackWebviewMessage(message)).toEqual(message);
    expect(parseFeedbackWebviewMessage({ ...message, revision: 0 })).toBeNull();
    expect(parseFeedbackWebviewMessage({ ...message, sessionId: 'not-a-transition' })).toBeNull();
  });

  it('accepts only an exact correlated transition retry', () => {
    const message = {
      type: 'feedback.transition.retry',
      requestId: 'start-1',
      lockId: 'transition-lock-1',
      revision: 1,
    };
    expect(parseFeedbackWebviewMessage(message)).toEqual(message);
    expect(parseFeedbackWebviewMessage({ ...message, revision: 0 })).toBeNull();
    expect(parseFeedbackWebviewMessage({ ...message, reason: 'leaked detail' })).toBeNull();
  });

  it('rejects the legacy one-phase close acknowledgement', () => {
    expect(
      parseFeedbackWebviewMessage({
        type: 'feedback.close.ack',
        requestId: 'finish-1',
        sessionId: 'session-1',
      })
    ).toBeNull();
  });

  it('accepts only an exact correlated authoritative close sync', () => {
    const message = {
      type: 'feedback.close.sync',
      requestId: 'finish-1',
      sessionId: 'session-1',
      revision: 1,
      content: '# Current saved source\n',
    };

    expect(parseFeedbackHostMessage(message)).toEqual(message);
    expect(parseFeedbackHostMessage({ ...message, force: true })).toBeNull();
    expect(parseFeedbackHostMessage({ ...message, content: undefined })).toBeNull();
  });

  it('accepts only a correlated final release for an applied revision', () => {
    const message = {
      type: 'feedback.close.release',
      requestId: 'finish-1',
      sessionId: 'session-1',
      revision: 2,
    };
    expect(parseFeedbackHostMessage(message)).toEqual(message);
    expect(parseFeedbackHostMessage({ ...message, revision: 0 })).toBeNull();
    expect(parseFeedbackHostMessage({ ...message, content: '# Leaked' })).toBeNull();
  });

  it('accepts only an exact correlated authoritative transition sync', () => {
    const message = {
      type: 'feedback.transition.sync',
      requestId: 'start-1',
      lockId: 'transition-lock-1',
      revision: 1,
      content: '# Current source\n',
    };
    expect(parseFeedbackHostMessage(message)).toEqual(message);
    expect(parseFeedbackHostMessage({ ...message, revision: 0 })).toBeNull();
    expect(parseFeedbackHostMessage({ ...message, force: true })).toBeNull();
  });

  it('accepts only an exact host-owned transition lock', () => {
    const message = {
      type: 'feedback.transition.locked',
      requestId: 'discard-1',
      lockId: 'transition-lock-1',
    };

    expect(parseFeedbackHostMessage(message)).toEqual(message);
    expect(parseFeedbackHostMessage({ ...message, round: 'must-not-cross' })).toBeNull();
    expect(parseFeedbackHostMessage({ ...message, requestId: '' })).toBeNull();
    expect(parseFeedbackHostMessage({ ...message, lockId: '' })).toBeNull();
    expect(parseFeedbackWebviewMessage(message)).toBeNull();
  });

  it.each(['active-owner', 'active-peer', 'saved-draft'] as const)(
    'accepts only an exact %s resume offer',
    kind => {
      const message = {
        type: 'feedback.resume.available',
        requestId: 'resume-offer-1',
        kind,
        drafts: [
          {
            round: '20260821T093000Z-k4p9',
            createdAt: '2026-08-21T09:30:00.000Z',
            itemCount: 2,
            feedbackFile: '.md4h/feedback/docs/guide/feedback.md',
          },
        ],
      };

      expect(parseFeedbackHostMessage(message)).toEqual(message);
      expect(parseFeedbackHostMessage({ ...message, requestId: '' })).toBeNull();
      expect(parseFeedbackHostMessage({ ...message, kind: 'unknown' })).toBeNull();
      expect(parseFeedbackHostMessage({ ...message, drafts: [] })).toBeNull();
      expect(parseFeedbackHostMessage({ ...message, sessionId: 'must-not-cross' })).toBeNull();
    }
  );

  it('accepts only a bounded session-transfer notice', () => {
    const message = {
      type: 'feedback.session.transferred',
      oldSessionId: 'session-1',
      lockId: 'session-2',
      message: 'Feedback moved to another rich-view tab.',
    };

    expect(parseFeedbackHostMessage(message)).toEqual(message);
    expect(parseFeedbackHostMessage({ ...message, oldSessionId: '' })).toBeNull();
    expect(parseFeedbackHostMessage({ ...message, lockId: '' })).toBeNull();
    expect(parseFeedbackHostMessage({ ...message, message: '' })).toBeNull();
    expect(parseFeedbackHostMessage({ ...message, message: `unsafe\0message` })).toBeNull();
    expect(parseFeedbackHostMessage({ ...message, message: 'x'.repeat(100_001) })).toBeNull();
    expect(parseFeedbackHostMessage({ ...message, requestId: 'must-not-cross' })).toBeNull();
  });

  it('accepts strictly increasing non-contiguous ProseMirror ordinals', () => {
    expect(
      parseFeedbackWebviewMessage({
        type: 'feedback.start',
        requestId: 'request-1',
        blocks: [
          { ordinal: 2, kind: 'heading', markdown: '# Title', contentSize: 5 },
          { ordinal: 5, kind: 'paragraph', markdown: 'Body', contentSize: 4 },
        ],
      })
    ).toEqual({
      type: 'feedback.start',
      requestId: 'request-1',
      blocks: [
        { ordinal: 2, kind: 'heading', markdown: '# Title', contentSize: 5 },
        { ordinal: 5, kind: 'paragraph', markdown: 'Body', contentSize: 4 },
      ],
    });
  });

  it.each([
    null,
    {},
    { type: 'feedback.start', requestId: '', blocks: [] },
    {
      type: 'feedback.start',
      requestId: 'request-1',
      blocks: [
        { ordinal: 1, kind: 'paragraph', markdown: 'first', contentSize: 5 },
        { ordinal: 0, kind: 'paragraph', markdown: 'out of order', contentSize: 12 },
      ],
    },
    {
      type: 'feedback.text.add',
      requestId: 'request-2',
      sessionId: 'session-1',
      startOrdinal: 2,
      endOrdinal: 1,
      focus: 'bad range',
      feedback: 'Fix this',
    },
    {
      type: 'feedback.screenshot.add',
      requestId: 'request-3',
      sessionId: 'session-1',
      startOrdinal: 0,
      endOrdinal: 0,
      imageDataUrl: 'data:image/jpeg;base64,AAAA',
      feedback: 'Wrong MIME',
    },
    { type: 'totally.unknown', documentText: 'must not pass through' },
  ])('rejects malformed or unknown host-bound input %#', candidate => {
    expect(parseFeedbackWebviewMessage(candidate)).toBeNull();
  });

  it.each([
    {
      type: 'feedback.start',
      requestId: 'missing-content-size',
      blocks: [{ ordinal: 0, kind: 'paragraph', markdown: 'Body' }],
    },
    {
      type: 'feedback.start',
      requestId: 'negative-content-size',
      blocks: [{ ordinal: 0, kind: 'paragraph', markdown: 'Body', contentSize: -1 }],
    },
    {
      type: 'feedback.start',
      requestId: 'fractional-content-size',
      blocks: [{ ordinal: 0, kind: 'paragraph', markdown: 'Body', contentSize: 1.5 }],
    },
  ])('rejects canonical blocks without a safe ProseMirror content size %#', candidate => {
    expect(parseFeedbackWebviewMessage(candidate)).toBeNull();
  });

  it('accepts a versioned block-relative rendered range without trusting block hashes', () => {
    expect(
      parseFeedbackWebviewMessage({
        type: 'feedback.text.add',
        requestId: 'add-exact',
        sessionId: 'session-1',
        startOrdinal: 2,
        endOrdinal: 5,
        focus: 'exact visible text',
        feedback: 'Clarify this.',
        renderedRange: {
          version: 1,
          startOrdinal: 2,
          startOffset: 1,
          endOrdinal: 5,
          endOffset: 3,
        },
      })
    ).toEqual({
      type: 'feedback.text.add',
      requestId: 'add-exact',
      sessionId: 'session-1',
      startOrdinal: 2,
      endOrdinal: 5,
      focus: 'exact visible text',
      feedback: 'Clarify this.',
      renderedRange: {
        version: 1,
        startOrdinal: 2,
        startOffset: 1,
        endOrdinal: 5,
        endOffset: 3,
      },
    });
  });

  it.each([
    { version: 1, startOrdinal: 0, startOffset: 0, endOrdinal: 0 },
    { version: 1, startOrdinal: 0, startOffset: -1, endOrdinal: 0, endOffset: 1 },
    { version: 1, startOrdinal: 0, startOffset: 1, endOrdinal: 0, endOffset: 1 },
    { version: 1, startOrdinal: 1, startOffset: 0, endOrdinal: 0, endOffset: 1 },
    { version: 2, startOrdinal: 0, startOffset: 0, endOrdinal: 0, endOffset: 1 },
    {
      version: 1,
      startOrdinal: 0,
      startOffset: 0,
      endOrdinal: 0,
      endOffset: 1,
      startBlockSha256: 'webview-must-not-supply-hashes',
    },
    {
      version: 1,
      startOrdinal: 0,
      startOffset: 0,
      endOrdinal: 0,
      endOffset: 1,
      unknown: true,
    },
  ])(
    'rejects malformed, partial, collapsed, or non-canonical rendered ranges %#',
    renderedRange => {
      expect(
        parseFeedbackWebviewMessage({
          type: 'feedback.text.add',
          requestId: 'add-invalid-range',
          sessionId: 'session-1',
          startOrdinal: 0,
          endOrdinal: 0,
          focus: 'Body',
          feedback: 'Clarify this.',
          renderedRange,
        })
      ).toBeNull();
    }
  );

  it('continues to accept an explicit block-level text target without inline metadata', () => {
    expect(
      parseFeedbackWebviewMessage({
        type: 'feedback.text.add',
        requestId: 'add-block-target',
        sessionId: 'session-1',
        startOrdinal: 0,
        endOrdinal: 0,
        focus: 'Body',
        feedback: 'Clarify this.',
      })
    ).toEqual({
      type: 'feedback.text.add',
      requestId: 'add-block-target',
      sessionId: 'session-1',
      startOrdinal: 0,
      endOrdinal: 0,
      focus: 'Body',
      feedback: 'Clarify this.',
    });
  });

  it('forbids rendered text metadata on screenshot messages', () => {
    expect(
      parseFeedbackWebviewMessage({
        type: 'feedback.screenshot.add',
        requestId: 'screenshot-with-text-range',
        sessionId: 'session-1',
        startOrdinal: 0,
        endOrdinal: 0,
        imageDataUrl: 'data:image/png;base64,AAAA',
        feedback: 'Visual note.',
        renderedRange: {
          version: 1,
          startOrdinal: 0,
          startOffset: 0,
          endOrdinal: 0,
          endOffset: 1,
        },
      })
    ).toBeNull();
  });

  it('accepts exact lifecycle and item mutations', () => {
    expect(
      parseFeedbackWebviewMessage({
        type: 'feedback.finish',
        requestId: 'r',
        sessionId: 's',
      })
    ).toEqual({ type: 'feedback.finish', requestId: 'r', sessionId: 's' });

    expect(
      parseFeedbackWebviewMessage({
        type: 'feedback.item.edit',
        requestId: 'r',
        sessionId: 's',
        id: 'F9',
        feedback: 'Updated',
      })
    ).toEqual({
      type: 'feedback.item.edit',
      requestId: 'r',
      sessionId: 's',
      id: 'F9',
      feedback: 'Updated',
    });

    expect(
      parseFeedbackWebviewMessage({
        type: 'feedback.capture.error',
        requestId: 'capture-error-1',
        sessionId: 's',
        code: 'MD4H-FB-CAPTURE-002',
      })
    ).toEqual({
      type: 'feedback.capture.error',
      requestId: 'capture-error-1',
      sessionId: 's',
      code: 'MD4H-FB-CAPTURE-002',
    });
  });

  it.each([
    {
      type: 'feedback.finish',
      requestId: 'r',
      sessionId: 's',
      leaked: true,
    },
    {
      type: 'feedback.item.edit',
      requestId: 'r',
      sessionId: 's',
      id: 'F9',
      feedback: 'Updated',
      leaked: 'must reject',
    },
    {
      type: 'feedback.start',
      requestId: 'r',
      blocks: [
        {
          ordinal: 0,
          kind: 'paragraph',
          markdown: 'Body',
          contentSize: 4,
          documentText: 'must reject',
        },
      ],
    },
    {
      type: 'feedback.capture.error',
      requestId: 'capture-error-1',
      sessionId: 's',
      code: 'MD4H-FB-CAPTURE-002',
      imageDataUrl: 'must reject',
    },
  ])('rejects unknown keys anywhere in a host-bound Feedback request %#', candidate => {
    expect(parseFeedbackWebviewMessage(candidate)).toBeNull();
  });

  it('rejects an unrecognized diagnostics error code', () => {
    expect(
      parseFeedbackWebviewMessage({
        type: 'feedback.capture.error',
        requestId: 'capture-error-1',
        sessionId: 's',
        code: 'NODE-ERR-LEAK',
      })
    ).toBeNull();
  });

  it('accepts validated opt-in draft recovery requests', () => {
    expect(
      parseFeedbackWebviewMessage({
        type: 'feedback.draft.resume',
        requestId: 'resume-1',
        round: '20260821T093000Z-k4p9',
        blocks: [{ ordinal: 4, kind: 'paragraph', markdown: 'Body', contentSize: 4 }],
      })
    ).toEqual({
      type: 'feedback.draft.resume',
      requestId: 'resume-1',
      round: '20260821T093000Z-k4p9',
      blocks: [{ ordinal: 4, kind: 'paragraph', markdown: 'Body', contentSize: 4 }],
    });

    expect(
      parseFeedbackWebviewMessage({
        type: 'feedback.draft.reveal',
        requestId: 'reveal-1',
        round: '20260821T093000Z-k4p9',
      })
    ).toEqual({
      type: 'feedback.draft.reveal',
      requestId: 'reveal-1',
      round: '20260821T093000Z-k4p9',
    });

    expect(
      parseFeedbackWebviewMessage({
        type: 'feedback.draft.discard',
        requestId: 'discard-1',
        round: '20260821T093000Z-k4p9',
      })
    ).toEqual({
      type: 'feedback.draft.discard',
      requestId: 'discard-1',
      round: '20260821T093000Z-k4p9',
    });
  });

  it('rejects unsafe draft recovery identifiers and empty resume maps', () => {
    expect(
      parseFeedbackWebviewMessage({
        type: 'feedback.draft.resume',
        requestId: 'resume-1',
        round: '../../outside',
        blocks: [{ ordinal: 0, kind: 'paragraph', markdown: 'Body', contentSize: 4 }],
      })
    ).toBeNull();
    expect(
      parseFeedbackWebviewMessage({
        type: 'feedback.draft.resume',
        requestId: 'resume-1',
        round: '20260821T093000Z-k4p9',
        blocks: [],
      })
    ).toBeNull();
  });

  it('exports the stable public error codes', () => {
    expect(FEEDBACK_ERROR_CODES).toEqual({
      targetDoesNotMap: 'MD4H-FB-ANCHOR-001',
      blockMismatch: 'MD4H-FB-ANCHOR-002',
      resourceUnavailable: 'MD4H-FB-CAPTURE-001',
      rasterizationFailed: 'MD4H-FB-CAPTURE-002',
      sourceChanged: 'MD4H-FB-SNAPSHOT-001',
    });
  });

  it('accepts and reconstructs every exact webview-bound Feedback message shape', () => {
    const messages: FeedbackHostMessage[] = [
      {
        type: 'feedback.drafts.available',
        drafts: [
          {
            round: '20260821T093000Z-k4p9',
            createdAt: '2026-08-21T09:30:00.000Z',
            itemCount: 2,
            feedbackFile: '.md4h/feedback/docs/guide/feedback.md',
          },
        ],
      },
      {
        type: 'feedback.resume.available',
        requestId: 'resume-offer-1',
        kind: 'active-owner',
        drafts: [
          {
            round: '20260821T093000Z-k4p9',
            createdAt: '2026-08-21T09:30:00.000Z',
            itemCount: 2,
            feedbackFile: '.md4h/feedback/docs/guide/feedback.md',
          },
        ],
      },
      {
        type: 'feedback.session.transferred',
        oldSessionId: 'session-previous',
        lockId: 'session-current',
        message: 'Feedback moved to another rich-view tab.',
      },
      {
        type: 'feedback.started',
        requestId: 'start-1',
        sessionId: 'session-1',
        source: 'docs/guide.md',
        sourceSha256: 'a'.repeat(64),
        round: '20260821T093000Z-k4p9',
        feedbackFile: '.md4h/feedback/docs/guide/feedback.md',
        anchors: [{ ordinal: 0, startLine: 1, endLine: 2 }],
        items: [
          {
            id: 'F1',
            kind: 'text',
            startOrdinal: 0,
            endOrdinal: 0,
            startLine: 1,
            endLine: 2,
            focus: 'Visible text',
            feedback: 'Clarify this.',
            renderedRange: {
              version: 1,
              startOrdinal: 0,
              startOffset: 0,
              endOrdinal: 0,
              endOffset: 7,
              startBlockSha256: 'b'.repeat(64),
              endBlockSha256: 'b'.repeat(64),
            },
          },
        ],
      },
      {
        type: 'feedback.updated',
        requestId: 'update-1',
        sessionId: 'session-1',
        items: [
          {
            id: 'F2',
            kind: 'screenshot',
            startOrdinal: 1,
            endOrdinal: 2,
            startLine: 3,
            endLine: 8,
            feedback: 'Improve this visual.',
            imageUri: 'vscode-webview://feedback/F2.png?revision=1',
          },
        ],
      },
      {
        type: 'feedback.finished',
        requestId: 'finish-1',
        sessionId: 'session-1',
        feedbackFile: '.md4h/feedback/docs/guide/feedback.md',
        itemCount: 2,
        prompt: 'Implement the sealed feedback bundle.',
        promptCopied: true,
      } as unknown as FeedbackHostMessage,
      { type: 'feedback.discarded', requestId: 'discard-1', sessionId: 'session-1' },
      {
        type: 'feedback.draft.discarded',
        requestId: 'draft-discard-1',
        round: '20260821T093000Z-k4p9',
      },
      {
        type: 'feedback.diagnosticsCopied',
        requestId: 'diagnostics-1',
        sessionId: 'session-1',
      },
      {
        type: 'feedback.invalidated',
        sessionId: 'session-1',
        code: FEEDBACK_ERROR_CODES.sourceChanged,
        message: 'The source changed.',
      },
      {
        type: 'feedback.error',
        requestId: 'request-1',
        sessionId: 'session-1',
        code: 'MD4H-FB-STORE-001',
        message: 'Could not write the draft.',
        recoverable: true,
      },
      {
        type: 'feedback.peer.locked',
        lockId: 'peer-lock-1',
        message: 'Feedback is active in another editor split.',
      },
      { type: 'feedback.peer.unlocked', lockId: 'peer-lock-1' },
      { type: 'feedback.command', command: 'nextFeedback' },
    ];

    for (const message of messages) {
      expect(parseFeedbackHostMessage(message)).toEqual(message);
    }
  });

  it('requires an exact positive item count and safe prompt on a finished response', () => {
    const message = {
      type: 'feedback.finished',
      requestId: 'finish-1',
      sessionId: 'session-1',
      feedbackFile: '.md4h/feedback/docs/guide/feedback.md',
      itemCount: 2,
      prompt: 'Implement the sealed feedback bundle.',
      promptCopied: true,
    };

    expect(parseFeedbackHostMessage(message)).toEqual(message);
    expect(parseFeedbackHostMessage({ ...message, itemCount: undefined })).toBeNull();
    expect(parseFeedbackHostMessage({ ...message, itemCount: 0 })).toBeNull();
    expect(parseFeedbackHostMessage({ ...message, itemCount: -1 })).toBeNull();
    expect(parseFeedbackHostMessage({ ...message, itemCount: 1.5 })).toBeNull();
    expect(parseFeedbackHostMessage({ ...message, itemCount: 100_001 })).toBeNull();
    expect(parseFeedbackHostMessage({ ...message, prompt: undefined })).toBeNull();
    expect(parseFeedbackHostMessage({ ...message, prompt: '' })).toBeNull();
    expect(parseFeedbackHostMessage({ ...message, prompt: `unsafe\0prompt` })).toBeNull();
    expect(parseFeedbackHostMessage({ ...message, prompt: 'x'.repeat(1_000_001) })).toBeNull();
    expect(parseFeedbackHostMessage({ ...message, leaked: true })).toBeNull();
  });

  it.each([
    { type: 'feedback.updated', requestId: 'update-1', items: [] },
    {
      type: 'feedback.finished',
      requestId: 'finish-1',
      feedbackFile: '.md4h/feedback/docs/guide/feedback.md',
      itemCount: 2,
      prompt: 'Implement the sealed feedback bundle.',
      promptCopied: true,
    },
    { type: 'feedback.discarded', requestId: 'discard-1' },
    { type: 'feedback.diagnosticsCopied', requestId: 'diagnostics-1' },
    {
      type: 'feedback.invalidated',
      code: FEEDBACK_ERROR_CODES.sourceChanged,
      message: 'The source changed.',
    },
  ])('rejects an active-session host response without its runtime token %#', candidate => {
    expect(parseFeedbackHostMessage(candidate)).toBeNull();
  });

  it.each([
    [
      'text without Focus',
      {
        id: 'F1',
        kind: 'text',
        startOrdinal: 0,
        endOrdinal: 0,
        startLine: 1,
        endLine: 1,
        feedback: 'Clarify this.',
      },
    ],
    [
      'text without feedback',
      {
        id: 'F1',
        kind: 'text',
        startOrdinal: 0,
        endOrdinal: 0,
        startLine: 1,
        endLine: 1,
        focus: 'Visible text',
      },
    ],
    [
      'screenshot without feedback',
      {
        id: 'F1',
        kind: 'screenshot',
        startOrdinal: 0,
        endOrdinal: 0,
        startLine: 1,
        endLine: 1,
        imageUri: 'vscode-webview://feedback/F1.png',
      },
    ],
    [
      'screenshot without an image URI',
      {
        id: 'F1',
        kind: 'screenshot',
        startOrdinal: 0,
        endOrdinal: 0,
        startLine: 1,
        endLine: 1,
        feedback: 'Improve this visual.',
      },
    ],
  ])('rejects a %s summary instead of accepting a partial discriminated item', (_label, item) => {
    expect(
      parseFeedbackHostMessage({
        type: 'feedback.updated',
        requestId: 'update-partial-item',
        sessionId: 'session-1',
        items: [item],
      })
    ).toBeNull();
  });

  it.each([
    [
      'text item with imageUri',
      {
        id: 'F1',
        kind: 'text',
        startOrdinal: 0,
        endOrdinal: 0,
        startLine: 1,
        endLine: 1,
        focus: 'Visible text',
        feedback: 'Clarify this.',
        imageUri: 'vscode-webview://feedback/F1.png',
      },
    ],
    [
      'screenshot item with Focus',
      {
        id: 'F1',
        kind: 'screenshot',
        startOrdinal: 0,
        endOrdinal: 0,
        startLine: 1,
        endLine: 1,
        feedback: 'Improve this visual.',
        imageUri: 'vscode-webview://feedback/F1.png',
        focus: 'must reject',
      },
    ],
    [
      'screenshot item with rendered-range metadata',
      {
        id: 'F1',
        kind: 'screenshot',
        startOrdinal: 0,
        endOrdinal: 0,
        startLine: 1,
        endLine: 1,
        feedback: 'Improve this visual.',
        imageUri: 'vscode-webview://feedback/F1.png',
        renderedRange: {
          version: 1,
          startOrdinal: 0,
          startOffset: 0,
          endOrdinal: 0,
          endOffset: 1,
          startBlockSha256: 'b'.repeat(64),
          endBlockSha256: 'b'.repeat(64),
        },
      },
    ],
  ])('rejects a %s because its fields belong to the other item kind', (_label, item) => {
    expect(
      parseFeedbackHostMessage({
        type: 'feedback.updated',
        requestId: 'update-cross-kind-field',
        sessionId: 'session-1',
        items: [item],
      })
    ).toBeNull();
  });

  it('rejects duplicate item IDs in one host update', () => {
    const item = {
      id: 'F1',
      kind: 'text',
      startOrdinal: 0,
      endOrdinal: 0,
      startLine: 1,
      endLine: 1,
      focus: 'Visible text',
      feedback: 'Clarify this.',
    };

    expect(
      parseFeedbackHostMessage({
        type: 'feedback.updated',
        requestId: 'update-duplicate-items',
        sessionId: 'session-1',
        items: [item, { ...item }],
      })
    ).toBeNull();
  });

  it.each([
    ['start', { startOrdinal: 1, endOrdinal: 2 }],
    ['end', { startOrdinal: 0, endOrdinal: 3 }],
  ])('rejects a rendered range whose %s ordinal disagrees with its item', (_endpoint, range) => {
    expect(
      parseFeedbackHostMessage({
        type: 'feedback.updated',
        requestId: 'update-mismatched-rendered-range',
        sessionId: 'session-1',
        items: [
          {
            id: 'F1',
            kind: 'text',
            startOrdinal: 0,
            endOrdinal: 2,
            startLine: 1,
            endLine: 4,
            focus: 'Visible text',
            feedback: 'Clarify this.',
            renderedRange: {
              version: 1,
              ...range,
              startOffset: 0,
              endOffset: 1,
              startBlockSha256: 'b'.repeat(64),
              endBlockSha256: 'c'.repeat(64),
            },
          },
        ],
      })
    ).toBeNull();
  });

  it.each([
    null,
    {},
    { type: 'feedback.updated', requestId: 'update-1', items: [], leaked: true },
    {
      type: 'feedback.drafts.available',
      drafts: [
        {
          round: '20260821T093000Z-k4p9',
          createdAt: '2026-08-21T09:30:00.000Z',
          itemCount: 0,
          feedbackFile: '.md4h/feedback/feedback.md',
          sourceText: 'must reject',
        },
      ],
    },
    {
      type: 'feedback.resume.available',
      requestId: 'resume-offer-1',
      kind: 'active-owner',
      drafts: [
        {
          round: '20260821T093000Z-k4p9',
          createdAt: '2026-08-21T09:30:00.000Z',
          itemCount: 1,
          feedbackFile: '.md4h/feedback/feedback.md',
          feedback: 'must reject',
        },
      ],
    },
    {
      type: 'feedback.started',
      requestId: 'start-1',
      sessionId: 'session-1',
      source: 'docs/guide.md',
      sourceSha256: 'not-a-sha256',
      round: '20260821T093000Z-k4p9',
      feedbackFile: '.md4h/feedback/feedback.md',
      anchors: [],
      items: [],
    },
    {
      type: 'feedback.started',
      requestId: 'start-1',
      sessionId: 'session-1',
      source: 'docs/guide.md',
      sourceSha256: 'a'.repeat(64),
      round: '20260821T093000Z-k4p9',
      feedbackFile: '.md4h/feedback/feedback.md',
      anchors: [{ ordinal: 0, startLine: 2, endLine: 1 }],
      items: [],
    },
    {
      type: 'feedback.updated',
      requestId: 'update-1',
      items: [
        {
          id: 'F1',
          kind: 'text',
          startOrdinal: 0,
          endOrdinal: 0,
          startLine: 1,
          endLine: 1,
          focus: 'Visible text',
          feedback: 'Clarify this.',
          renderedRange: {
            version: 1,
            startOrdinal: 0,
            startOffset: 0,
            endOrdinal: 0,
            endOffset: 7,
            startBlockSha256: 'b'.repeat(64),
            endBlockSha256: 'b'.repeat(64),
            documentText: 'must reject',
          },
        },
      ],
    },
    {
      type: 'feedback.updated',
      requestId: 'update-1',
      items: [
        {
          id: 'F2',
          kind: 'screenshot',
          startOrdinal: 1,
          endOrdinal: 1,
          startLine: 3,
          endLine: 4,
          feedback: 'Visual note.',
          imageUri: 42,
        },
      ],
    },
    {
      type: 'feedback.error',
      message: 'Bad request.',
      recoverable: false,
      imageDataUrl: 'must reject',
    },
    {
      type: 'feedback.peer.locked',
      lockId: '',
      message: 'Feedback is active elsewhere.',
    },
    {
      type: 'feedback.peer.locked',
      lockId: 'peer-lock-1',
      message: 'Feedback is active elsewhere.',
      sourceText: 'must reject',
    },
    { type: 'feedback.peer.unlocked', lockId: 'peer-lock-1', leaked: true },
    { type: 'feedback.command', command: 'not-a-command' },
  ])('rejects malformed or unknown webview-bound Feedback data %#', candidate => {
    expect(parseFeedbackHostMessage(candidate)).toBeNull();
  });
});
