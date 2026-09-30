/**
 * Versioned contracts for renderer-to-host document synchronization.
 *
 * These validators intentionally cover only metadata and Markdown transport.
 * The VS Code adapter remains responsible for authorizing the sender against
 * the live webview and document before applying an accepted message.
 */

export const DOCUMENT_SYNC_PROTOCOL_VERSION = 2 as const;

const MAX_SYNC_IDENTIFIER_LENGTH = 256;
const MAX_SYNC_CONTENT_LENGTH = 64 * 1024 * 1024;

export type DocumentEditReason = 'typing' | 'save-policy-enforce';

export interface DocumentEditMessage {
  readonly type: 'edit';
  readonly protocolVersion: typeof DOCUMENT_SYNC_PROTOCOL_VERSION;
  readonly editId: string;
  readonly viewGeneration: string;
  readonly localRevision: number;
  readonly baseDocumentVersion: number;
  readonly content: string;
  readonly editReason: DocumentEditReason;
}

export interface DocumentEditAck {
  readonly type: 'document.edit.ack';
  readonly protocolVersion: typeof DOCUMENT_SYNC_PROTOCOL_VERSION;
  readonly editId: string;
  readonly viewGeneration: string;
  readonly localRevision: number;
  readonly accepted: boolean;
  readonly documentVersion: number;
}

/** Correlation fields safe to echo even when an edit payload is rejected. */
export interface DocumentEditIdentity {
  readonly editId: string;
  readonly viewGeneration: string;
  readonly localRevision: number;
}

export interface DocumentSyncReady {
  readonly type: 'ready';
  readonly protocolVersion: typeof DOCUMENT_SYNC_PROTOCOL_VERSION;
  readonly viewGeneration: string;
}

/** Host barrier that advances one renderer to an already-drained document version. */
export interface DocumentFlushBarrier {
  readonly type: 'flushPendingEdit';
  readonly protocolVersion: typeof DOCUMENT_SYNC_PROTOCOL_VERSION;
  readonly requestId: string;
  readonly viewGeneration: string;
  readonly documentVersion: number;
}

/** Renderer acknowledgement bound to the exact flush lineage it applied. */
export interface DocumentFlushAck {
  readonly type: 'flushPendingEditAck';
  readonly protocolVersion: typeof DOCUMENT_SYNC_PROTOCOL_VERSION;
  readonly requestId: string;
  readonly viewGeneration: string;
  readonly documentVersion: number;
  readonly ok: boolean;
}

/**
 * Final renderer revision pipelined behind its one in-flight edit before a
 * non-retained webview is destroyed.
 */
export interface DocumentTeardownEditMessage {
  readonly type: 'document.teardown.edit';
  readonly protocolVersion: typeof DOCUMENT_SYNC_PROTOCOL_VERSION;
  readonly editId: string;
  readonly viewGeneration: string;
  readonly localRevision: number;
  readonly baseDocumentVersion: number;
  readonly predecessorEditId: string;
  readonly predecessorLocalRevision: number;
  readonly content: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function isIdentifier(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_SYNC_IDENTIFIER_LENGTH &&
    !containsControlCharacter(value)
  );
}

function isRevision(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

/**
 * Parse only the correlation header of an edit-shaped message.
 *
 * Hosts use this after full payload validation fails so a renderer does not
 * wait forever on an edit identity that was observed but could not be applied.
 */
export function parseDocumentEditIdentity(
  value: unknown,
  type: 'edit' | 'document.teardown.edit'
): DocumentEditIdentity | null {
  if (!isRecord(value)) return null;
  if (value.type !== type || value.protocolVersion !== DOCUMENT_SYNC_PROTOCOL_VERSION) return null;
  if (
    !isIdentifier(value.editId) ||
    !isIdentifier(value.viewGeneration) ||
    !isRevision(value.localRevision)
  ) {
    return null;
  }
  return {
    editId: value.editId,
    viewGeneration: value.viewGeneration,
    localRevision: value.localRevision,
  };
}

/** Parse one current renderer edit envelope, rejecting legacy or malformed data. */
export function parseDocumentEditMessage(value: unknown): DocumentEditMessage | null {
  if (!isRecord(value)) return null;
  if (value.type !== 'edit' || value.protocolVersion !== DOCUMENT_SYNC_PROTOCOL_VERSION) {
    return null;
  }
  if (!isIdentifier(value.editId) || !isIdentifier(value.viewGeneration)) return null;
  if (!isRevision(value.localRevision) || !isRevision(value.baseDocumentVersion)) return null;
  if (
    typeof value.content !== 'string' ||
    value.content.length > MAX_SYNC_CONTENT_LENGTH ||
    (value.editReason !== 'typing' && value.editReason !== 'save-policy-enforce')
  ) {
    return null;
  }

  return {
    type: 'edit',
    protocolVersion: DOCUMENT_SYNC_PROTOCOL_VERSION,
    editId: value.editId,
    viewGeneration: value.viewGeneration,
    localRevision: value.localRevision,
    baseDocumentVersion: value.baseDocumentVersion,
    content: value.content,
    editReason: value.editReason,
  };
}

/** Parse a final revision that is explicitly dependent on one in-flight edit. */
export function parseDocumentTeardownEditMessage(
  value: unknown
): DocumentTeardownEditMessage | null {
  if (!isRecord(value)) return null;
  if (
    value.type !== 'document.teardown.edit' ||
    value.protocolVersion !== DOCUMENT_SYNC_PROTOCOL_VERSION ||
    !isIdentifier(value.editId) ||
    !isIdentifier(value.viewGeneration) ||
    !isRevision(value.localRevision) ||
    !isRevision(value.baseDocumentVersion) ||
    !isIdentifier(value.predecessorEditId) ||
    !isRevision(value.predecessorLocalRevision) ||
    typeof value.content !== 'string' ||
    value.content.length > MAX_SYNC_CONTENT_LENGTH
  ) {
    return null;
  }

  return {
    type: 'document.teardown.edit',
    protocolVersion: DOCUMENT_SYNC_PROTOCOL_VERSION,
    editId: value.editId,
    viewGeneration: value.viewGeneration,
    localRevision: value.localRevision,
    baseDocumentVersion: value.baseDocumentVersion,
    predecessorEditId: value.predecessorEditId,
    predecessorLocalRevision: value.predecessorLocalRevision,
    content: value.content,
  };
}

/** Parse an application-level acknowledgement for one renderer edit. */
export function parseDocumentEditAck(value: unknown): DocumentEditAck | null {
  if (!isRecord(value)) return null;
  if (
    value.type !== 'document.edit.ack' ||
    value.protocolVersion !== DOCUMENT_SYNC_PROTOCOL_VERSION ||
    !isIdentifier(value.editId) ||
    !isIdentifier(value.viewGeneration) ||
    !isRevision(value.localRevision) ||
    typeof value.accepted !== 'boolean' ||
    !isRevision(value.documentVersion)
  ) {
    return null;
  }

  return {
    type: 'document.edit.ack',
    protocolVersion: DOCUMENT_SYNC_PROTOCOL_VERSION,
    editId: value.editId,
    viewGeneration: value.viewGeneration,
    localRevision: value.localRevision,
    accepted: value.accepted,
    documentVersion: value.documentVersion,
  };
}

/** Parse the renderer-generation handshake sent after each script startup. */
export function parseDocumentSyncReady(value: unknown): DocumentSyncReady | null {
  if (
    !isRecord(value) ||
    value.type !== 'ready' ||
    value.protocolVersion !== DOCUMENT_SYNC_PROTOCOL_VERSION ||
    !isIdentifier(value.viewGeneration)
  ) {
    return null;
  }

  return {
    type: 'ready',
    protocolVersion: DOCUMENT_SYNC_PROTOCOL_VERSION,
    viewGeneration: value.viewGeneration,
  };
}

/** Parse a host flush barrier used to order a renderer's newest revision before save. */
export function parseDocumentFlushBarrier(value: unknown): DocumentFlushBarrier | null {
  if (
    !isRecord(value) ||
    value.type !== 'flushPendingEdit' ||
    value.protocolVersion !== DOCUMENT_SYNC_PROTOCOL_VERSION ||
    !isIdentifier(value.requestId) ||
    !isIdentifier(value.viewGeneration) ||
    !isRevision(value.documentVersion)
  ) {
    return null;
  }

  return {
    type: 'flushPendingEdit',
    protocolVersion: DOCUMENT_SYNC_PROTOCOL_VERSION,
    requestId: value.requestId,
    viewGeneration: value.viewGeneration,
    documentVersion: value.documentVersion,
  };
}

/** Parse an application acknowledgement for one host flush barrier. */
export function parseDocumentFlushAck(value: unknown): DocumentFlushAck | null {
  if (
    !isRecord(value) ||
    value.type !== 'flushPendingEditAck' ||
    value.protocolVersion !== DOCUMENT_SYNC_PROTOCOL_VERSION ||
    !isIdentifier(value.requestId) ||
    !isIdentifier(value.viewGeneration) ||
    !isRevision(value.documentVersion) ||
    typeof value.ok !== 'boolean'
  ) {
    return null;
  }

  return {
    type: 'flushPendingEditAck',
    protocolVersion: DOCUMENT_SYNC_PROTOCOL_VERSION,
    requestId: value.requestId,
    viewGeneration: value.viewGeneration,
    documentVersion: value.documentVersion,
    ok: value.ok,
  };
}
