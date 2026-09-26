/**
 * Copyright (c) 2025-2026 Concret.io
 *
 * Licensed under the MIT License. See LICENSE file in the project root for details.
 */

import {
  IMAGE_SAVE_COMPLETION_PROTOCOL_VERSION,
  type PendingImageSaveCompletion,
} from '../../shared/pendingImageProtocol';
import { createPendingImageCompletionClient } from '../../webview/features/pendingImageCompletionClient';

function saved(completionId = 'completion-1'): PendingImageSaveCompletion {
  return {
    type: 'imageSaved',
    protocolVersion: IMAGE_SAVE_COMPLETION_PROTOCOL_VERSION,
    completionId,
    placeholderId: 'image-1',
    viewGeneration: 'view-1',
    newSrc: './images/image-1.png',
  };
}

describe('pending image completion client', () => {
  it('applies one completion once and ACKs every exact replay', () => {
    const pending = new Set(['image-1']);
    const applySaved = jest.fn((placeholderId: string) => pending.delete(placeholderId));
    const postAcknowledgement = jest.fn();
    const client = createPendingImageCompletionClient({
      viewGeneration: 'view-1',
      isPending: placeholderId => pending.has(placeholderId),
      applySaved,
      applyError: jest.fn(() => true),
      postAcknowledgement,
      maxRetainedCompletions: 8,
    });
    const message = saved();

    expect(client.handle(message)).toBe('applied');
    expect(client.handle(message)).toBe('replayed');

    expect(applySaved).toHaveBeenCalledTimes(1);
    expect(applySaved).toHaveBeenCalledWith('image-1', './images/image-1.png');
    expect(postAcknowledgement).toHaveBeenCalledTimes(2);
    expect(postAcknowledgement.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        type: 'imageSaveCompletionAck',
        completionId: 'completion-1',
        placeholderId: 'image-1',
      })
    );
  });

  it('ACKs an absent same-generation placeholder and rejects conflicting retained reuse', () => {
    const pending = new Set(['image-1']);
    const applySaved = jest.fn((placeholderId: string) => pending.delete(placeholderId));
    const postAcknowledgement = jest.fn();
    const client = createPendingImageCompletionClient({
      viewGeneration: 'view-1',
      isPending: placeholderId => pending.has(placeholderId),
      applySaved,
      applyError: jest.fn(() => true),
      postAcknowledgement,
      maxRetainedCompletions: 8,
    });

    expect(client.handle({ ...saved('absent-completion'), placeholderId: 'absent-image' })).toBe(
      'acknowledged-absent'
    );
    expect(client.handle(saved())).toBe('applied');
    expect(
      client.handle({ ...saved(), placeholderId: 'different-image', newSrc: './different.png' })
    ).toBe('ignored');

    expect(applySaved).toHaveBeenCalledTimes(1);
    expect(postAcknowledgement).toHaveBeenCalledTimes(2);
  });

  it('ACKs an applied completion again after bounded history eviction', () => {
    const pending = new Set(['image-1']);
    const applySaved = jest.fn((placeholderId: string) => pending.delete(placeholderId));
    const postAcknowledgement = jest.fn();
    const client = createPendingImageCompletionClient({
      viewGeneration: 'view-1',
      isPending: placeholderId => pending.has(placeholderId),
      applySaved,
      applyError: jest.fn(() => true),
      postAcknowledgement,
      maxRetainedCompletions: 1,
    });
    const first = saved('completion-1');

    expect(client.handle(first)).toBe('applied');
    pending.add('image-1');
    expect(client.handle(saved('completion-2'))).toBe('applied');
    expect(client.handle(first)).toBe('acknowledged-absent');

    expect(applySaved).toHaveBeenCalledTimes(2);
    expect(postAcknowledgement).toHaveBeenCalledTimes(3);
  });

  it('stops applying and acknowledging after disposal', () => {
    const postAcknowledgement = jest.fn();
    const applySaved = jest.fn();
    const client = createPendingImageCompletionClient({
      viewGeneration: 'view-1',
      isPending: () => true,
      applySaved,
      applyError: jest.fn(() => true),
      postAcknowledgement,
      maxRetainedCompletions: 8,
    });

    client.dispose();

    expect(client.handle(saved())).toBe('disposed');
    expect(applySaved).not.toHaveBeenCalled();
    expect(postAcknowledgement).not.toHaveBeenCalled();
  });

  it('keeps pending state and withholds ACK when ProseMirror application fails', () => {
    const postAcknowledgement = jest.fn();
    const applySaved = jest.fn(() => false);
    const client = createPendingImageCompletionClient({
      viewGeneration: 'view-1',
      isPending: () => true,
      applySaved,
      applyError: jest.fn(() => false),
      postAcknowledgement,
      maxRetainedCompletions: 8,
    });

    expect(client.handle(saved())).toBe('failed');
    expect(applySaved).toHaveBeenCalledTimes(1);
    expect(postAcknowledgement).not.toHaveBeenCalled();
  });
});
