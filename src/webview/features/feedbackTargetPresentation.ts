/**
 * Copyright (c) 2025-2026 Concret.io
 *
 * Licensed under the MIT License. See LICENSE file in the project root for details.
 *
 * @fileoverview Bounded, renderer-local descriptions of frozen Feedback targets.
 * The rich document remains the canonical preview. This module never parses
 * Markdown, executes a NodeView renderer, or serializes presentation metadata.
 */

import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { TableMap } from '@tiptap/pm/tables';
import type {
  FeedbackCellTargetInputV1,
  FeedbackRenderedRangeInputV1,
} from '../../shared/feedbackProtocol';
import {
  fingerprintFeedbackTable,
  isFeedbackCellRectangleWithinExactLimit,
} from './feedbackSelectionMapping';

export const FEEDBACK_CELL_PREVIEW_ROW_LIMIT = 4;
export const FEEDBACK_CELL_PREVIEW_COLUMN_LIMIT = 4;
const FEEDBACK_CELL_PREVIEW_TEXT_LIMIT = 120;
const FEEDBACK_TEXT_PREVIEW_LIMIT = 4_000;
const FEEDBACK_COLLAPSED_PREVIEW_LINE_LIMIT = 6;
const FEEDBACK_COLLAPSED_PREVIEW_CHARACTER_LIMIT = 600;

/** Why an otherwise block-shaped target reached the Feedback composer. */
export type FeedbackTargetPresentationReason =
  | 'whole-block-action'
  | 'manual-block-range'
  | 'opaque-node'
  | 'unmappable-dom'
  | 'block-selection'
  | 'structural-node-selection'
  | 'structural-block-selection'
  | 'unmappable-text-range'
  | 'merged-table-cells'
  | 'irregular-table'
  | 'large-table-selection'
  | 'session-cell-budget';

/** Minimal target shape consumed by the presentation layer. */
export interface FeedbackTargetPresentationInput {
  readonly startOrdinal: number;
  readonly endOrdinal: number;
  readonly focus: string;
  readonly renderedRange?: FeedbackRenderedRangeInputV1;
  readonly cellTarget?: FeedbackCellTargetInputV1;
  readonly presentationReason?: FeedbackTargetPresentationReason;
}

export interface FeedbackTextTargetPreview {
  readonly kind: 'quote' | 'code';
  readonly text: string;
  readonly collapsedText: string;
  readonly hasMore: boolean;
  readonly truncated: boolean;
}

export interface FeedbackCellPreviewValue {
  readonly text: string;
  readonly header: boolean;
}

export interface FeedbackCellTargetPreview {
  readonly kind: 'cells';
  readonly rows: readonly (readonly FeedbackCellPreviewValue[])[];
  readonly truncated: boolean;
}

export type FeedbackTargetPreview = FeedbackTextTargetPreview | FeedbackCellTargetPreview;

export type FeedbackTargetPresentationKind =
  | 'selected-text'
  | 'selected-code'
  | 'selected-cells'
  | 'whole-code'
  | 'whole-table'
  | 'opaque-block'
  | 'whole-block'
  | 'multi-block'
  | 'unknown';

/** Safe, bounded description rendered in composers and expanded cards. */
export interface FeedbackTargetPresentation {
  readonly kind: FeedbackTargetPresentationKind;
  readonly label: string;
  readonly detail: string;
  readonly preferredComposerSize: 'compact' | 'wide';
  readonly lineContext: 'source' | 'containing-source';
  readonly preview: FeedbackTargetPreview | null;
  readonly explanation: string | null;
}

type TargetDocument = Pick<ProseMirrorNode, 'childCount' | 'maybeChild' | 'nodeAt'>;

function normalizeText(value: string): string {
  return value.replace(/\r\n/g, '\n');
}

function truncateText(
  value: string,
  limit: number,
  forceTruncation = false
): { text: string; truncated: boolean } {
  if (!forceTruncation && value.length <= limit) return { text: value, truncated: false };
  return { text: `${value.slice(0, Math.max(0, limit - 1))}…`, truncated: true };
}

function collapsePreviewText(value: string): string {
  const lines = value.split('\n');
  const lineBounded = lines.slice(0, FEEDBACK_COLLAPSED_PREVIEW_LINE_LIMIT).join('\n');
  return truncateText(lineBounded, FEEDBACK_COLLAPSED_PREVIEW_CHARACTER_LIMIT).text;
}

function textPreview(kind: 'quote' | 'code', value: string): FeedbackTextTargetPreview {
  const normalized = normalizeText(value);
  const bounded = truncateText(normalized, FEEDBACK_TEXT_PREVIEW_LIMIT);
  const collapsedText = collapsePreviewText(bounded.text);
  return {
    kind,
    text: bounded.text,
    collapsedText,
    hasMore: collapsedText !== bounded.text,
    truncated: bounded.truncated,
  };
}

function lineCount(value: string): number {
  const normalized = normalizeText(value);
  return normalized.length === 0 ? 0 : normalized.split('\n').length;
}

function plural(value: number, singular: string, pluralValue = `${singular}s`): string {
  return value === 1 ? singular : pluralValue;
}

function readableLanguage(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim().length === 0) return null;
  const language = value.trim().slice(0, 40);
  const known: Record<string, string> = {
    bash: 'Bash',
    csharp: 'C#',
    css: 'CSS',
    html: 'HTML',
    java: 'Java',
    javascript: 'JavaScript',
    js: 'JavaScript',
    json: 'JSON',
    jsx: 'JSX',
    markdown: 'Markdown',
    md: 'Markdown',
    python: 'Python',
    ruby: 'Ruby',
    rust: 'Rust',
    shell: 'Shell',
    sql: 'SQL',
    ts: 'TypeScript',
    tsx: 'TSX',
    typescript: 'TypeScript',
  };
  return known[language.toLowerCase()] ?? `${language[0]?.toUpperCase() ?? ''}${language.slice(1)}`;
}

function codeDetail(node: ProseMirrorNode, focus: string): string {
  const language = readableLanguage(node.attrs?.language);
  const lines = lineCount(focus);
  return [language, `${lines} ${plural(lines, 'line')}`].filter(Boolean).join(' · ');
}

function readableBlockKind(node: ProseMirrorNode): string {
  const labels: Record<string, string> = {
    blockquote: 'block quote',
    bulletList: 'bullet list',
    codeBlock: 'code block',
    githubAlert: 'alert',
    heading: 'heading',
    horizontalRule: 'divider',
    image: 'image',
    mathBlock: 'math block',
    mermaid: 'Mermaid diagram',
    orderedList: 'numbered list',
    paragraph: 'paragraph',
    table: 'table',
    taskList: 'task list',
  };
  return labels[node.type.name] ?? node.type.name.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
}

function tableDimensions(node: ProseMirrorNode): { rows: number; columns: number } | null {
  try {
    const map = TableMap.get(node);
    return { rows: map.height, columns: map.width };
  } catch {
    return null;
  }
}

function safeTableCellText(node: ProseMirrorNode): string {
  const traversalEnd = Math.min(node.content.size, FEEDBACK_CELL_PREVIEW_TEXT_LIMIT);
  const value = normalizeText(node.textBetween(0, traversalEnd, '\n', '\n'));
  return truncateText(value, FEEDBACK_CELL_PREVIEW_TEXT_LIMIT, traversalEnd < node.content.size)
    .text;
}

function cellPreview(
  doc: TargetDocument,
  target: FeedbackCellTargetInputV1
): FeedbackCellTargetPreview | null {
  if (!isFeedbackCellRectangleWithinExactLimit(target.rectangle)) return null;
  const table = doc.maybeChild(target.tableOrdinal) as ProseMirrorNode | null;
  if (!table || table.type.spec.tableRole !== 'table') return null;
  if (
    fingerprintFeedbackTable({ version: 1, tableOrdinal: target.tableOrdinal, table })
      .fingerprint !== target.tableFingerprint
  ) {
    return null;
  }

  let map: TableMap;
  try {
    map = TableMap.get(table);
  } catch {
    return null;
  }

  const rectangle = target.rectangle;
  const selectedRows = target.rectangle.bottom - target.rectangle.top;
  const selectedColumns = target.rectangle.right - target.rectangle.left;
  if (
    map.problems?.length ||
    !Number.isSafeInteger(rectangle.top) ||
    !Number.isSafeInteger(rectangle.left) ||
    !Number.isSafeInteger(rectangle.bottom) ||
    !Number.isSafeInteger(rectangle.right) ||
    rectangle.top < 0 ||
    rectangle.left < 0 ||
    selectedRows <= 0 ||
    selectedColumns <= 0 ||
    rectangle.bottom > map.height ||
    rectangle.right > map.width
  ) {
    return null;
  }
  const previewRows = Math.min(selectedRows, FEEDBACK_CELL_PREVIEW_ROW_LIMIT);
  const previewColumns = Math.min(selectedColumns, FEEDBACK_CELL_PREVIEW_COLUMN_LIMIT);
  const rows: FeedbackCellPreviewValue[][] = [];
  const seen = new Set<number>();
  for (let row = 0; row < previewRows; row += 1) {
    const values: FeedbackCellPreviewValue[] = [];
    for (let column = 0; column < previewColumns; column += 1) {
      const relativePosition = map.map[(rectangle.top + row) * map.width + rectangle.left + column];
      if (seen.has(relativePosition)) return null;
      seen.add(relativePosition);
      const cell = table.nodeAt(relativePosition);
      if (
        !cell ||
        (cell.type.spec.tableRole !== 'cell' && cell.type.spec.tableRole !== 'header_cell') ||
        Number(cell.attrs.colspan ?? 1) !== 1 ||
        Number(cell.attrs.rowspan ?? 1) !== 1
      ) {
        return null;
      }
      values.push({
        text: safeTableCellText(cell),
        header: cell.type.spec.tableRole === 'header_cell',
      });
    }
    rows.push(values);
  }
  return {
    kind: 'cells',
    rows,
    truncated: previewRows < selectedRows || previewColumns < selectedColumns,
  };
}

function multiBlockDetail(doc: TargetDocument, startOrdinal: number, endOrdinal: number): string {
  const count = endOrdinal - startOrdinal + 1;
  const first = doc.maybeChild(startOrdinal) as ProseMirrorNode | null;
  const last = doc.maybeChild(endOrdinal) as ProseMirrorNode | null;
  if (!first || !last) return `${count} ${plural(count, 'block')}`;
  return `${count} ${plural(count, 'block')} · ${readableBlockKind(first)} to ${readableBlockKind(last)}`;
}

function opaqueExplanation(node: ProseMirrorNode): string {
  if (node.type.name === 'mermaid') {
    return 'Rendered diagram parts cannot be anchored independently. This feedback applies to the whole diagram. Use Capture area for a visual sub-area.';
  }
  const kind = readableBlockKind(node);
  return `Rendered ${kind} parts cannot be anchored independently. This feedback applies to the whole ${kind}. Use Capture area for a visual sub-area.`;
}

function fallbackExplanation(reason: FeedbackTargetPresentationReason | undefined): string | null {
  if (reason === 'large-table-selection') {
    return 'This selection is too large to anchor cell by cell. This feedback applies to the whole table.';
  }
  if (reason === 'session-cell-budget') {
    return 'This feedback session has reached its exact cell detail limit. This feedback applies to the whole table.';
  }
  if (reason === 'merged-table-cells' || reason === 'irregular-table') {
    return 'This table structure cannot be anchored as one exact rectangle. This feedback applies to the whole table.';
  }
  if (reason === 'unmappable-dom' || reason === 'unmappable-text-range') {
    return 'This selection could not be anchored exactly. This feedback applies to the complete containing block.';
  }
  return null;
}

/**
 * Derives one bounded presentation from the frozen document and target.
 * Work is limited to selected endpoints and a fixed cell preview. Exact cell
 * decoration validation remains the annotation layer's responsibility.
 * Invalid ordinals fail closed to a generic summary.
 */
export function getFeedbackTargetPresentation(
  doc: TargetDocument,
  target: FeedbackTargetPresentationInput
): FeedbackTargetPresentation {
  if (
    !Number.isSafeInteger(target.startOrdinal) ||
    !Number.isSafeInteger(target.endOrdinal) ||
    target.startOrdinal < 0 ||
    target.endOrdinal < target.startOrdinal ||
    target.endOrdinal >= doc.childCount
  ) {
    return {
      kind: 'unknown',
      label: 'Selected content',
      detail: 'Target details unavailable',
      preferredComposerSize: 'compact',
      lineContext: 'source',
      preview: null,
      explanation: null,
    };
  }

  const first = doc.maybeChild(target.startOrdinal) as ProseMirrorNode | null;
  const last = doc.maybeChild(target.endOrdinal) as ProseMirrorNode | null;
  if (!first || !last) {
    return {
      kind: 'unknown',
      label: 'Selected content',
      detail: 'Target details unavailable',
      preferredComposerSize: 'compact',
      lineContext: 'source',
      preview: null,
      explanation: null,
    };
  }

  if (target.cellTarget) {
    const rectangle = target.cellTarget.rectangle;
    const rows = rectangle.bottom - rectangle.top;
    const columns = rectangle.right - rectangle.left;
    const count = rows * columns;
    const preview = cellPreview(doc, target.cellTarget);
    if (preview) {
      return {
        kind: 'selected-cells',
        label: 'Selected cells',
        detail: `Rows ${rectangle.top + 1}–${rectangle.bottom} · Columns ${rectangle.left + 1}–${rectangle.right} · ${count} ${plural(count, 'cell')}`,
        preferredComposerSize: 'wide',
        lineContext: 'containing-source',
        preview,
        explanation: null,
      };
    }
  }

  if (target.renderedRange) {
    const exactDetail =
      target.startOrdinal === target.endOrdinal
        ? `${lineCount(target.focus)} ${plural(lineCount(target.focus), 'line')}`
        : multiBlockDetail(doc, target.startOrdinal, target.endOrdinal);
    if (first.type.name === 'codeBlock' && target.startOrdinal === target.endOrdinal) {
      // Selection origin is authoritative. A native drag remains rendered
      // evidence even when its offsets happen to cover the complete code node.
      return {
        kind: 'selected-code',
        label: 'Selected code',
        detail: codeDetail(first, target.focus),
        preferredComposerSize: 'wide',
        lineContext: 'containing-source',
        preview: textPreview('code', target.focus),
        explanation: null,
      };
    }
    return {
      kind: 'selected-text',
      label: 'Selected text',
      detail: exactDetail,
      preferredComposerSize: target.startOrdinal === target.endOrdinal ? 'compact' : 'wide',
      lineContext: 'containing-source',
      preview: textPreview('quote', target.focus),
      explanation: null,
    };
  }

  if (target.startOrdinal !== target.endOrdinal) {
    return {
      kind: 'multi-block',
      label: 'Selected blocks',
      detail: multiBlockDetail(doc, target.startOrdinal, target.endOrdinal),
      preferredComposerSize: 'wide',
      lineContext: 'source',
      preview: null,
      explanation: fallbackExplanation(target.presentationReason),
    };
  }

  if (first.type.name === 'table') {
    const dimensions = tableDimensions(first);
    return {
      kind: 'whole-table',
      label: 'Whole table',
      detail: dimensions
        ? `${dimensions.rows} ${plural(dimensions.rows, 'row')} × ${dimensions.columns} ${plural(dimensions.columns, 'column')}`
        : 'Table dimensions unavailable',
      preferredComposerSize: 'wide',
      lineContext: 'source',
      preview: null,
      explanation: fallbackExplanation(target.presentationReason),
    };
  }

  if (first.type.name === 'codeBlock') {
    return {
      kind: 'whole-code',
      label: 'Whole code block',
      detail: codeDetail(first, first.textContent || target.focus),
      preferredComposerSize: 'wide',
      lineContext: 'source',
      preview: null,
      explanation: fallbackExplanation(target.presentationReason),
    };
  }

  const opaqueLabels: Record<string, string> = {
    image: 'Whole image',
    mathBlock: 'Whole math block',
    mermaid: 'Whole Mermaid diagram',
  };
  const opaqueLabel = opaqueLabels[first.type.name];
  if (opaqueLabel) {
    return {
      kind: 'opaque-block',
      label: opaqueLabel,
      detail: readableBlockKind(first),
      preferredComposerSize: 'wide',
      lineContext: 'source',
      preview: null,
      explanation:
        target.presentationReason === 'opaque-node'
          ? opaqueExplanation(first)
          : fallbackExplanation(target.presentationReason),
    };
  }

  const focus =
    target.focus.trim().length > 0 && !/^\[[^\]]+\]$/.test(target.focus)
      ? textPreview('quote', target.focus)
      : null;
  return {
    kind: 'whole-block',
    label: `Whole ${readableBlockKind(first)}`,
    detail: readableBlockKind(first),
    preferredComposerSize: 'compact',
    lineContext: 'source',
    preview: focus,
    explanation: fallbackExplanation(target.presentationReason),
  };
}

function appendTextPreview(
  ownerDocument: Document,
  container: HTMLElement,
  preview: FeedbackTextTargetPreview,
  focusAttribute?: string
): void {
  const element = ownerDocument.createElement(preview.kind === 'code' ? 'pre' : 'blockquote');
  element.className = `feedback-target-preview feedback-target-${preview.kind}`;
  element.setAttribute('data-feedback-target-preview', '');
  if (focusAttribute) element.setAttribute(focusAttribute, '');
  if (preview.kind === 'code') {
    const code = ownerDocument.createElement('code');
    code.textContent = preview.collapsedText;
    element.append(code);
  } else {
    element.textContent = preview.collapsedText;
  }
  container.append(element);

  if (!preview.hasMore && !preview.truncated) return;
  const disclosure = ownerDocument.createElement('details');
  disclosure.className = 'feedback-target-disclosure';
  const summary = ownerDocument.createElement('summary');
  summary.textContent = 'Show more selected content';
  const expanded = ownerDocument.createElement(preview.kind === 'code' ? 'pre' : 'blockquote');
  expanded.className = `feedback-target-expanded feedback-target-${preview.kind}`;
  if (preview.kind === 'code') {
    const code = ownerDocument.createElement('code');
    code.textContent = preview.text;
    expanded.append(code);
  } else {
    expanded.textContent = preview.text;
  }
  disclosure.append(summary, expanded);
  if (preview.truncated) {
    const note = ownerDocument.createElement('p');
    note.className = 'feedback-target-truncation';
    note.textContent = 'Preview limited. The highlighted document remains the complete target.';
    disclosure.append(note);
  }
  container.append(disclosure);
}

function appendCellPreview(
  ownerDocument: Document,
  container: HTMLElement,
  presentation: FeedbackTargetPresentation,
  preview: FeedbackCellTargetPreview
): void {
  const figure = ownerDocument.createElement('figure');
  figure.className = 'feedback-target-preview feedback-target-cell-preview';
  figure.setAttribute('data-feedback-target-preview', '');
  const table = ownerDocument.createElement('table');
  table.setAttribute('aria-label', `${presentation.detail} preview`);
  const body = ownerDocument.createElement('tbody');
  for (const row of preview.rows) {
    const rowElement = ownerDocument.createElement('tr');
    for (const value of row) {
      const cell = ownerDocument.createElement(value.header ? 'th' : 'td');
      cell.textContent = value.text;
      rowElement.append(cell);
    }
    body.append(rowElement);
  }
  table.append(body);
  figure.append(table);
  if (preview.truncated) {
    const caption = ownerDocument.createElement('figcaption');
    caption.textContent = 'Preview limited to the first 4 rows and 4 columns.';
    figure.append(caption);
  }
  container.append(figure);
}

/** Creates safe DOM for one already-derived Feedback target presentation. */
export function createFeedbackTargetPresentationView(options: {
  readonly ownerDocument: Document;
  readonly presentation: FeedbackTargetPresentation;
  readonly focusAttribute?: string;
}): HTMLElement {
  const { ownerDocument, presentation, focusAttribute } = options;
  const context = ownerDocument.createElement('section');
  context.className = 'feedback-target-context';
  context.setAttribute('data-feedback-target-kind', presentation.kind);
  context.setAttribute('aria-label', `Feedback target: ${presentation.label}`);

  const header = ownerDocument.createElement('div');
  header.className = 'feedback-target-header';
  const label = ownerDocument.createElement('strong');
  label.className = 'feedback-target-label';
  label.setAttribute('data-feedback-target-label', '');
  label.textContent = presentation.label;
  const detail = ownerDocument.createElement('span');
  detail.className = 'feedback-target-detail';
  detail.setAttribute('data-feedback-target-detail', '');
  detail.textContent = presentation.detail;
  header.append(label, detail);
  context.append(header);

  if (presentation.explanation) {
    const explanation = ownerDocument.createElement('p');
    explanation.className = 'feedback-target-explanation';
    explanation.setAttribute('data-feedback-target-explanation', '');
    explanation.textContent = presentation.explanation;
    context.append(explanation);
  }
  if (presentation.preview?.kind === 'cells') {
    appendCellPreview(ownerDocument, context, presentation, presentation.preview);
  } else if (presentation.preview) {
    appendTextPreview(ownerDocument, context, presentation.preview, focusAttribute);
  }
  return context;
}

/** Formats the containing or complete source-line label for a target. */
export function formatFeedbackTargetSourceLines(
  startLine: number,
  endLine: number,
  context: FeedbackTargetPresentation['lineContext']
): string {
  if (startLine <= 0 || endLine <= 0) return 'Source lines validated when saved';
  const prefix = context === 'containing-source' ? 'Containing source' : 'Source';
  return startLine === endLine
    ? `${prefix} line ${startLine}`
    : `${prefix} lines ${startLine}-${endLine}`;
}
