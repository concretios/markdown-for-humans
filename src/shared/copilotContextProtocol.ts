/**
 * Copyright (c) 2025-2026 Concret.io
 *
 * Licensed under the MIT License. See LICENSE file in the project root for details.
 */

/**
 * @file copilotContextProtocol.ts - Add to GitHub Copilot messages
 * @description How the rich view offers its caret or selection to GitHub
 *              Copilot Chat and how the host reports back. The view describes
 *              the selection structurally exactly as `copyReferenceForAi` does;
 *              the host resolves source lines, attaches a context chip and
 *              answers with the toast text. Every message from the view is
 *              untrusted and parsed fail-closed before use.
 */

import type { AiReferenceSelection } from './aiReferenceProtocol';
import { parseAiReferenceSelection } from './aiReferenceProtocol';
import type { CanonicalFeedbackBlock } from './feedbackProtocol';
import { parseCanonicalFeedbackBlocks } from './feedbackSnapshotProtocol';

/** Webview to host: offer this selection to GitHub Copilot as context. */
export interface CopilotContextRequest {
  type: 'addToCopilot';
  selection: AiReferenceSelection;
  blocks: readonly CanonicalFeedbackBlock[];
}

/** Host to webview: the outcome of one add attempt, shown as a toast. */
export interface CopilotContextResult {
  type: 'addToCopilot.result';
  ok: boolean;
  message: string;
}

/** Host to webview: whether the GitHub Copilot actions may be shown. */
export interface CopilotChatAvailability {
  type: 'copilotChatAvailability';
  available: boolean;
}

/**
 * Validate an untrusted `addToCopilot` message from the rich view.
 *
 * @param value - Raw message
 * @returns The request, or null when any part is malformed
 */
export function parseCopilotContextRequest(value: unknown): CopilotContextRequest | null {
  if (typeof value !== 'object' || value === null) return null;
  const message = value as Record<string, unknown>;
  if (message.type !== 'addToCopilot') return null;

  const selection = parseAiReferenceSelection(message.selection);
  // An empty document has no canonical blocks, which the Feedback parser rejects.
  const blocks =
    Array.isArray(message.blocks) && message.blocks.length === 0
      ? []
      : parseCanonicalFeedbackBlocks(message.blocks);
  if (!selection || !blocks) return null;

  return { type: 'addToCopilot', selection, blocks };
}

/**
 * Validate an untrusted `copilotChatAvailability` message.
 *
 * @param value - Raw message
 * @returns The message, or null when malformed
 */
export function parseCopilotChatAvailability(value: unknown): CopilotChatAvailability | null {
  if (typeof value !== 'object' || value === null) return null;
  const message = value as Record<string, unknown>;
  if (message.type !== 'copilotChatAvailability' || typeof message.available !== 'boolean') {
    return null;
  }
  return { type: 'copilotChatAvailability', available: message.available };
}
