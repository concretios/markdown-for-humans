/**
 * Copyright (c) 2025-2026 Concret.io
 *
 * Licensed under the MIT License. See LICENSE file in the project root for details.
 *
 * @fileoverview Generation-bound renderer client for applying image-save
 * completions once and acknowledging only verified ProseMirror mutations.
 */

import {
  createPendingImageSaveCompletionAck,
  parsePendingImageSaveCompletion,
  type PendingImageSaveCompletion,
  type PendingImageSaveCompletionAck,
} from '../../shared/pendingImageProtocol';

/** Observable result of handling one possible image completion message. */
export type PendingImageCompletionDisposition =
  'applied' | 'replayed' | 'acknowledged-absent' | 'failed' | 'ignored' | 'disposed';

/** Renderer lifecycle for idempotent image completion application. */
export interface PendingImageCompletionClient {
  /** Parse and apply one possible host completion. */
  readonly handle: (message: unknown) => PendingImageCompletionDisposition;
  /** Stop application and release bounded replay history. */
  readonly dispose: () => void;
}

/** Generation, mutation, acknowledgement, and memory dependencies. */
export interface PendingImageCompletionClientOptions {
  /** Exact renderer lifetime authorized to consume completions. */
  readonly viewGeneration: string;
  /** Report whether this renderer still owns the placeholder. */
  readonly isPending: (placeholderId: string) => boolean;
  /** Apply and verify a successful save in one editor transaction. */
  readonly applySaved: (placeholderId: string, newSrc: string) => boolean;
  /** Apply and verify a failed save in one editor transaction. */
  readonly applyError: (placeholderId: string, error: string) => boolean;
  /** Send an application-level acknowledgement to the extension host. */
  readonly postAcknowledgement: (acknowledgement: PendingImageSaveCompletionAck) => void;
  /** Maximum exact completions retained for immediate replay detection. */
  readonly maxRetainedCompletions: number;
}

function sameCompletion(
  left: PendingImageSaveCompletion,
  right: PendingImageSaveCompletion
): boolean {
  if (
    left.type !== right.type ||
    left.protocolVersion !== right.protocolVersion ||
    left.completionId !== right.completionId ||
    left.placeholderId !== right.placeholderId ||
    left.viewGeneration !== right.viewGeneration
  ) {
    return false;
  }
  return left.type === 'imageSaved' && right.type === 'imageSaved'
    ? left.newSrc === right.newSrc
    : left.type === 'imageError' && right.type === 'imageError' && left.error === right.error;
}

/**
 * Apply correlated host completions once and replay their exact ACK on retry.
 *
 * @param options - Exact renderer generation and mutation dependencies
 * @returns An idempotent client that must be disposed with the editor
 */
export function createPendingImageCompletionClient(
  options: PendingImageCompletionClientOptions
): PendingImageCompletionClient {
  if (!Number.isInteger(options.maxRetainedCompletions) || options.maxRetainedCompletions < 1) {
    throw new RangeError('maxRetainedCompletions must be a positive integer');
  }

  const applied = new Map<string, PendingImageSaveCompletion>();
  let disposed = false;

  const postAcknowledgement = (completion: PendingImageSaveCompletion): void => {
    try {
      options.postAcknowledgement(createPendingImageSaveCompletionAck(completion));
    } catch {
      // The host will replay the immutable completion after its ACK deadline.
    }
  };

  return {
    handle(message) {
      if (disposed) return 'disposed';
      const completion = parsePendingImageSaveCompletion(message);
      if (!completion) return 'ignored';
      if (completion.viewGeneration !== options.viewGeneration) return 'ignored';

      const retained = applied.get(completion.completionId);
      if (retained) {
        if (!sameCompletion(retained, completion)) return 'ignored';
        applied.delete(completion.completionId);
        applied.set(completion.completionId, retained);
        postAcknowledgement(retained);
        return 'replayed';
      }
      if (!options.isPending(completion.placeholderId)) {
        // In this exact renderer generation the saveImage request is posted
        // only after the pending id is registered. Its later absence is
        // therefore semantic proof that the completion was already applied or
        // the placeholder was removed. ACK even after bounded-history eviction.
        applied.set(completion.completionId, completion);
        while (applied.size > options.maxRetainedCompletions) {
          const oldest = applied.keys().next().value as string | undefined;
          if (oldest === undefined) break;
          applied.delete(oldest);
        }
        postAcknowledgement(completion);
        return 'acknowledged-absent';
      }

      const appliedSuccessfully =
        completion.type === 'imageSaved'
          ? options.applySaved(completion.placeholderId, completion.newSrc)
          : options.applyError(completion.placeholderId, completion.error);
      if (!appliedSuccessfully) return 'failed';
      applied.set(completion.completionId, completion);
      while (applied.size > options.maxRetainedCompletions) {
        const oldest = applied.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        applied.delete(oldest);
      }
      postAcknowledgement(completion);
      return 'applied';
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      applied.clear();
    },
  };
}
