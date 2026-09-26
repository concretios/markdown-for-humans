/**
 * @file feedbackSnapshotClient.ts - Strict renderer snapshot adapter
 * @description Inspects and applies generation-bound Feedback snapshots, then
 *              reports the exact renderer content and canonical block set.
 */

import type { CanonicalFeedbackBlock } from '../../shared/feedbackProtocol';
import {
  FEEDBACK_SNAPSHOT_PROTOCOL_VERSION,
  parseFeedbackSnapshotHostMessage,
} from '../../shared/feedbackSnapshotProtocol';

export interface FeedbackSnapshotClientOptions {
  readonly viewGeneration: string;
  readonly getLocalRevision: () => number;
  readonly isDirty: () => boolean;
  readonly serialize: () => string;
  /** Apply source and bind the renderer's accepted host document version. */
  readonly applyAuthoritativeContent: (content: string, documentVersion: number) => boolean;
  readonly enumerateCanonicalBlocks: () => readonly CanonicalFeedbackBlock[];
  readonly postMessage: (message: unknown) => void;
}

export type FeedbackSnapshotMessageDisposition = 'ignored' | 'handled' | 'rejected';

/**
 * Handle one possible snapshot message synchronously.
 *
 * An applied acknowledgement is withheld if content replacement or canonical
 * enumeration fails. The host timeout then follows the fail-closed recovery
 * path instead of accepting a partial renderer state.
 */
export function handleFeedbackSnapshotMessage(
  value: unknown,
  options: FeedbackSnapshotClientOptions
): FeedbackSnapshotMessageDisposition {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('type' in value) ||
    typeof value.type !== 'string' ||
    !value.type.startsWith('feedback.snapshot.')
  ) {
    return 'ignored';
  }

  const message = parseFeedbackSnapshotHostMessage(value);
  if (!message) return 'rejected';

  try {
    if (message.type === 'feedback.snapshot.inspect') {
      options.postMessage({
        type: 'feedback.snapshot.report',
        protocolVersion: FEEDBACK_SNAPSHOT_PROTOCOL_VERSION,
        requestId: message.requestId,
        operationId: message.operationId,
        documentVersion: message.documentVersion,
        stage: 'inspect',
        viewGeneration: options.viewGeneration,
        localRevision: options.getLocalRevision(),
        dirty: options.isDirty(),
        content: options.serialize(),
      });
      return 'handled';
    }

    if (!options.applyAuthoritativeContent(message.content, message.documentVersion)) {
      return 'rejected';
    }
    // Report the editor's actual post-apply serialization. The host hashes this
    // value independently instead of trusting the digest carried in its request.
    const content = options.serialize();
    const blocks = message.includeCanonicalBlocks ? options.enumerateCanonicalBlocks() : undefined;
    options.postMessage({
      type: 'feedback.snapshot.report',
      protocolVersion: FEEDBACK_SNAPSHOT_PROTOCOL_VERSION,
      requestId: message.requestId,
      operationId: message.operationId,
      documentVersion: message.documentVersion,
      stage: 'applied',
      viewGeneration: options.viewGeneration,
      localRevision: options.getLocalRevision(),
      dirty: false,
      content,
      canonicalDescriptorRevision: message.descriptorRevision,
      ...(blocks === undefined ? {} : { blocks }),
    });
    return 'handled';
  } catch (error) {
    console.error('[MD4H] Feedback snapshot renderer stage failed:', error);
    return 'rejected';
  }
}
