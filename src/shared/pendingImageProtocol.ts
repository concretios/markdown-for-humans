/**
 * Copyright (c) 2025-2026 Concret.io
 *
 * Licensed under the MIT License. See LICENSE file in the project root for details.
 *
 * @fileoverview Compact pending-image Markdown markers and the versioned,
 * generation-bound completion and application-acknowledgement protocol.
 */

/** Compact renderer-to-host marker for an image whose file write is pending. */
export const PENDING_IMAGE_DESTINATION_PREFIX = 'md4h-pending-image:';

/** Version for correlated host-to-renderer image-save completion delivery. */
export const IMAGE_SAVE_COMPLETION_PROTOCOL_VERSION = 1 as const;

/** Maximum concurrent renderer image operations accepted by the host. */
export const MAX_PENDING_IMAGE_SAVES = 128;

interface PendingImageSaveCompletionIdentity {
  readonly protocolVersion: typeof IMAGE_SAVE_COMPLETION_PROTOCOL_VERSION;
  readonly completionId: string;
  readonly placeholderId: string;
  readonly viewGeneration: string;
}

/** Host completion retained and retried until the renderer applies it. */
export type PendingImageSaveCompletion =
  | (PendingImageSaveCompletionIdentity & {
      readonly type: 'imageSaved';
      readonly newSrc: string;
    })
  | (PendingImageSaveCompletionIdentity & {
      readonly type: 'imageError';
      readonly error: string;
    });

/** Renderer acknowledgement for one exact applied completion. */
export interface PendingImageSaveCompletionAck extends PendingImageSaveCompletionIdentity {
  readonly type: 'imageSaveCompletionAck';
}

const MAX_PENDING_IMAGE_IDENTIFIER_LENGTH = 256;
const MAX_PENDING_IMAGE_COMPLETION_TEXT_LENGTH = 32 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isSafeIdentifier(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_PENDING_IMAGE_IDENTIFIER_LENGTH
  ) {
    return false;
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return false;
  }
  return true;
}

function isCompletionText(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_PENDING_IMAGE_COMPLETION_TEXT_LENGTH
  );
}

/** Parse one supported, bounded host completion message. */
export function parsePendingImageSaveCompletion(value: unknown): PendingImageSaveCompletion | null {
  if (
    !isRecord(value) ||
    value.protocolVersion !== IMAGE_SAVE_COMPLETION_PROTOCOL_VERSION ||
    !isSafeIdentifier(value.completionId) ||
    !isSafeIdentifier(value.placeholderId) ||
    !isSafeIdentifier(value.viewGeneration)
  ) {
    return null;
  }
  if (value.type === 'imageSaved' && isCompletionText(value.newSrc)) {
    return {
      type: 'imageSaved',
      protocolVersion: IMAGE_SAVE_COMPLETION_PROTOCOL_VERSION,
      completionId: value.completionId,
      placeholderId: value.placeholderId,
      viewGeneration: value.viewGeneration,
      newSrc: value.newSrc,
    };
  }
  if (value.type === 'imageError' && isCompletionText(value.error)) {
    return {
      type: 'imageError',
      protocolVersion: IMAGE_SAVE_COMPLETION_PROTOCOL_VERSION,
      completionId: value.completionId,
      placeholderId: value.placeholderId,
      viewGeneration: value.viewGeneration,
      error: value.error,
    };
  }
  return null;
}

/** Parse a renderer ACK without accepting partial or cross-version identities. */
export function parsePendingImageSaveCompletionAck(
  value: unknown
): PendingImageSaveCompletionAck | null {
  if (
    !isRecord(value) ||
    value.type !== 'imageSaveCompletionAck' ||
    value.protocolVersion !== IMAGE_SAVE_COMPLETION_PROTOCOL_VERSION ||
    !isSafeIdentifier(value.completionId) ||
    !isSafeIdentifier(value.placeholderId) ||
    !isSafeIdentifier(value.viewGeneration)
  ) {
    return null;
  }
  return {
    type: 'imageSaveCompletionAck',
    protocolVersion: IMAGE_SAVE_COMPLETION_PROTOCOL_VERSION,
    completionId: value.completionId,
    placeholderId: value.placeholderId,
    viewGeneration: value.viewGeneration,
  };
}

/** Build the exact application ACK for one parsed completion. */
export function createPendingImageSaveCompletionAck(
  completion: PendingImageSaveCompletion
): PendingImageSaveCompletionAck {
  return {
    type: 'imageSaveCompletionAck',
    protocolVersion: IMAGE_SAVE_COMPLETION_PROTOCOL_VERSION,
    completionId: completion.completionId,
    placeholderId: completion.placeholderId,
    viewGeneration: completion.viewGeneration,
  };
}

/** Build a Markdown destination without transporting the base64 preview. */
export function createPendingImageDestination(placeholderId: string): string {
  return `${PENDING_IMAGE_DESTINATION_PREFIX}${encodeURIComponent(placeholderId)}`;
}

/** Format one resolved path using the same whitespace rule as image serialization. */
export function formatMarkdownImageDestination(destination: string): string {
  return /\s/.test(destination) ? `<${destination}>` : destination;
}

/** Replace one exact pending-image destination without touching other images. */
export function replacePendingImageDestination(
  markdown: string,
  placeholderId: string,
  resolvedDestination: string
): string {
  const pendingDestination = createPendingImageDestination(placeholderId);
  return markdown
    .split(pendingDestination)
    .join(formatMarkdownImageDestination(resolvedDestination));
}
