/**
 * Copyright (c) 2025-2026 Concret.io
 *
 * Licensed under the MIT License. See LICENSE file in the project root for details.
 */

import { ImageSaveCompletionDelivery } from '../../editor/imageSaveCompletionDelivery';
import {
  IMAGE_SAVE_COMPLETION_PROTOCOL_VERSION,
  createPendingImageSaveCompletionAck,
  type PendingImageSaveCompletion,
} from '../../shared/pendingImageProtocol';

const completion: PendingImageSaveCompletion = {
  type: 'imageSaved',
  protocolVersion: IMAGE_SAVE_COMPLETION_PROTOCOL_VERSION,
  completionId: 'completion-1',
  placeholderId: 'image-1',
  viewGeneration: 'view-1',
  newSrc: './images/image-1.png',
};

function createDelivery(postMessage: jest.Mock, maxAttempts = 10) {
  return new ImageSaveCompletionDelivery({
    message: completion,
    postMessage,
    ackTimeoutMs: 20,
    retryDelayMs: 5,
    maxRetryDelayMs: 20,
    maxAttempts,
  });
}

describe('ImageSaveCompletionDelivery', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it.each(['false', 'rejected'] as const)(
    'retries the exact completion after a %s post',
    async failureMode => {
      const postMessage = jest
        .fn()
        .mockImplementationOnce(() =>
          failureMode === 'false'
            ? Promise.resolve(false)
            : Promise.reject(new Error('webview unavailable'))
        )
        .mockResolvedValue(true);
      const delivery = createDelivery(postMessage);

      delivery.start();
      await Promise.resolve();
      await Promise.resolve();
      await jest.advanceTimersByTimeAsync(5);

      expect(postMessage).toHaveBeenCalledTimes(2);
      expect(postMessage.mock.calls.every(([message]) => message === completion)).toBe(true);

      expect(delivery.acceptAcknowledgement(createPendingImageSaveCompletionAck(completion))).toBe(
        'accepted'
      );
      await jest.advanceTimersByTimeAsync(1_000);
      expect(postMessage).toHaveBeenCalledTimes(2);
    }
  );

  it('retries a queued completion when its ACK is lost, then accepts a delayed duplicate ACK', async () => {
    const postMessage = jest.fn().mockResolvedValue(true);
    const delivery = createDelivery(postMessage);
    const acknowledgement = createPendingImageSaveCompletionAck(completion);

    delivery.start();
    await Promise.resolve();
    await jest.advanceTimersByTimeAsync(20);
    await jest.advanceTimersByTimeAsync(5);

    expect(postMessage).toHaveBeenCalledTimes(2);
    expect(delivery.acceptAcknowledgement(acknowledgement)).toBe('accepted');
    expect(delivery.acceptAcknowledgement(acknowledgement)).toBe('duplicate');
    expect(
      delivery.acceptAcknowledgement({ ...acknowledgement, completionId: 'foreign-completion' })
    ).toBe('ignored');

    await jest.advanceTimersByTimeAsync(1_000);
    expect(postMessage).toHaveBeenCalledTimes(2);
  });

  it('cancels retry and ignores late post settlement after disposal', async () => {
    let rejectPost: ((error: Error) => void) | undefined;
    const postMessage = jest.fn(
      () =>
        new Promise<boolean>((_resolve, reject) => {
          rejectPost = reject;
        })
    );
    const delivery = createDelivery(postMessage);

    delivery.start();
    delivery.dispose();
    rejectPost?.(new Error('disposed'));
    await Promise.resolve();
    await jest.advanceTimersByTimeAsync(1_000);

    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(delivery.acceptAcknowledgement(createPendingImageSaveCompletionAck(completion))).toBe(
      'ignored'
    );
  });

  it('gives up and stops retrying once maxAttempts is reached', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const postMessage = jest.fn().mockResolvedValue(false);
    const delivery = createDelivery(postMessage, 2);

    delivery.start();
    await Promise.resolve();
    await Promise.resolve();
    await jest.advanceTimersByTimeAsync(5);
    await Promise.resolve();
    await Promise.resolve();

    expect(postMessage).toHaveBeenCalledTimes(2);
    expect(jest.getTimerCount()).toBe(0);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain('[MD4H]');

    warnSpy.mockRestore();
  });
});
