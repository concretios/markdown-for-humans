/**
 * Copyright (c) 2025-2026 Concret.io
 *
 * Licensed under the MIT License. See LICENSE file in the project root for details.
 */

/**
 * @file aiReferenceProtocol.ts - Copy Reference for AI messages
 * @description How the rich view describes a caret or selection to the host:
 *              which top-level block, which child at each level below it, and
 *              which line inside the innermost text block. The view never sends
 *              a line number; the host reads those from the saved text.
 */

import type { CanonicalFeedbackBlock } from './feedbackProtocol';
import { parseCanonicalFeedbackBlocks } from './feedbackSnapshotProtocol';

/** Node kinds the host can follow from the rich view into Markdown source. */
export type AiReferenceNodeKind =
  | 'paragraph'
  | 'heading'
  | 'list'
  | 'item'
  | 'blockquote'
  | 'alert'
  | 'code'
  | 'table'
  | 'row'
  | 'other';

/** One step down the tree: child `index` of a parent that has `count` children. */
export interface AiReferenceStep {
  kind: AiReferenceNodeKind;
  index: number;
  count: number;
}

/** A 0-based rendered line inside a text or code block that shows `count` lines. */
export interface AiReferenceLine {
  index: number;
  count: number;
}

/** One end of the selection, described structurally. */
export interface AiReferencePoint {
  /** Index of the top-level ProseMirror child, as in `CanonicalFeedbackBlock.ordinal`. */
  ordinal: number;
  steps: AiReferenceStep[];
  line?: AiReferenceLine;
}

export interface AiReferenceSelection {
  start: AiReferencePoint;
  end: AiReferencePoint;
}

/** Webview to host: copy a reference for this selection. */
export interface AiReferenceRequest {
  type: 'copyReferenceForAi';
  selection: AiReferenceSelection;
  blocks: readonly CanonicalFeedbackBlock[];
}

const MAX_STEPS = 64;

const NODE_KINDS: Record<string, AiReferenceNodeKind> = {
  paragraph: 'paragraph',
  heading: 'heading',
  bulletList: 'list',
  orderedList: 'list',
  taskList: 'list',
  listItem: 'item',
  taskItem: 'item',
  blockquote: 'blockquote',
  githubAlert: 'alert',
  codeBlock: 'code',
  table: 'table',
  tableRow: 'row',
};

const KNOWN_KINDS = new Set<string>([...Object.values(NODE_KINDS), 'other']);

/**
 * Name a ProseMirror node type in the vocabulary both sides share.
 *
 * @param typeName - `node.type.name`
 * @returns The shared kind, or `other` for nodes the host does not follow into
 */
export function aiReferenceNodeKind(typeName: string): AiReferenceNodeKind {
  return NODE_KINDS[typeName] ?? 'other';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isIndexWithin(index: unknown, count: unknown): boolean {
  return (
    Number.isSafeInteger(index) &&
    Number.isSafeInteger(count) &&
    (index as number) >= 0 &&
    (index as number) < (count as number)
  );
}

function parsePoint(value: unknown): AiReferencePoint | null {
  if (
    !isRecord(value) ||
    !Number.isSafeInteger(value.ordinal) ||
    (value.ordinal as number) < 0 ||
    !Array.isArray(value.steps) ||
    value.steps.length > MAX_STEPS
  ) {
    return null;
  }

  const steps: AiReferenceStep[] = [];
  for (const step of value.steps) {
    if (
      !isRecord(step) ||
      typeof step.kind !== 'string' ||
      !KNOWN_KINDS.has(step.kind) ||
      !isIndexWithin(step.index, step.count)
    ) {
      return null;
    }
    steps.push({
      kind: step.kind as AiReferenceNodeKind,
      index: step.index as number,
      count: step.count as number,
    });
  }

  const point: AiReferencePoint = { ordinal: value.ordinal as number, steps };
  if (value.line !== undefined) {
    if (!isRecord(value.line) || !isIndexWithin(value.line.index, value.line.count)) return null;
    point.line = { index: value.line.index as number, count: value.line.count as number };
  }
  return point;
}

/**
 * Validate the structural selection description shared by AI-reference messages.
 *
 * @param value - Raw `selection` field of an untrusted message
 * @returns The selection, or null when either end is malformed
 */
export function parseAiReferenceSelection(value: unknown): AiReferenceSelection | null {
  if (!isRecord(value)) return null;
  const start = parsePoint(value.start);
  const end = parsePoint(value.end);
  if (!start || !end) return null;
  return { start, end };
}

/**
 * Validate an untrusted `copyReferenceForAi` message from the rich view.
 *
 * @param value - Raw message
 * @returns The request, or null when any part is malformed
 */
export function parseAiReferenceRequest(value: unknown): AiReferenceRequest | null {
  if (!isRecord(value) || value.type !== 'copyReferenceForAi' || !isRecord(value.selection)) {
    return null;
  }

  const selection = parseAiReferenceSelection(value.selection);
  // An empty document has no canonical blocks, which the Feedback parser rejects.
  const blocks =
    Array.isArray(value.blocks) && value.blocks.length === 0
      ? []
      : parseCanonicalFeedbackBlocks(value.blocks);
  if (!selection || !blocks) return null;

  return { type: 'copyReferenceForAi', selection, blocks };
}
