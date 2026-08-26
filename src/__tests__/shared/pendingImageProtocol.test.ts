/**
 * Copyright (c) 2025-2026 Concret.io
 *
 * Licensed under the MIT License. See LICENSE file in the project root for details.
 */

import {
  IMAGE_SAVE_COMPLETION_PROTOCOL_VERSION,
  createPendingImageSaveCompletionAck,
  createPendingImageDestination,
  parsePendingImageSaveCompletion,
  parsePendingImageSaveCompletionAck,
  replacePendingImageDestination,
} from '../../shared/pendingImageProtocol';

describe('pending image protocol', () => {
  it('creates a compact destination that does not contain preview bytes', () => {
    expect(createPendingImageDestination('img-123')).toBe('md4h-pending-image:img-123');
  });

  it('replaces only the exact pending destination and quotes paths with spaces', () => {
    const markdown = [
      '![Pending](md4h-pending-image:img-123)',
      '![Other](md4h-pending-image:img-456)',
    ].join('\n');

    expect(replacePendingImageDestination(markdown, 'img-123', './images/my image.png')).toBe(
      ['![Pending](<./images/my image.png>)', '![Other](md4h-pending-image:img-456)'].join('\n')
    );
  });

  it('parses a correlated completion and builds its exact acknowledgement', () => {
    const completion = parsePendingImageSaveCompletion({
      type: 'imageSaved',
      protocolVersion: IMAGE_SAVE_COMPLETION_PROTOCOL_VERSION,
      completionId: 'completion-1',
      placeholderId: 'img-123',
      viewGeneration: 'view-1',
      newSrc: './images/saved.png',
    });

    expect(completion).not.toBeNull();
    const acknowledgement = createPendingImageSaveCompletionAck(completion!);
    expect(parsePendingImageSaveCompletionAck(acknowledgement)).toEqual({
      type: 'imageSaveCompletionAck',
      protocolVersion: IMAGE_SAVE_COMPLETION_PROTOCOL_VERSION,
      completionId: 'completion-1',
      placeholderId: 'img-123',
      viewGeneration: 'view-1',
    });
  });

  it('rejects malformed or mismatched completion identities', () => {
    expect(
      parsePendingImageSaveCompletion({
        type: 'imageSaved',
        protocolVersion: IMAGE_SAVE_COMPLETION_PROTOCOL_VERSION,
        completionId: '',
        placeholderId: 'img-123',
        viewGeneration: 'view-1',
        newSrc: './images/saved.png',
      })
    ).toBeNull();
    expect(
      parsePendingImageSaveCompletionAck({
        type: 'imageSaveCompletionAck',
        protocolVersion: IMAGE_SAVE_COMPLETION_PROTOCOL_VERSION + 1,
        completionId: 'completion-1',
        placeholderId: 'img-123',
        viewGeneration: 'view-1',
      })
    ).toBeNull();
  });
});
