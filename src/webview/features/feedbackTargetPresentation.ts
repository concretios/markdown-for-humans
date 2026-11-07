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
import { boundedNodeText, codePointLength, codePointPrefix } from './feedbackRenderedRange';
import {
  fingerprintFeedbackTable,
  isFeedbackCellRectangleWithinExactLimit,
} from './feedbackSelectionMapping';
import * as l10n from '../l10n';

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
  readonly sectionLabel?: string;
  readonly structuralScope?: { readonly label: string };
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

/** Bounds `value` to `limit` code points, ellipsis included, without splitting a surrogate pair. */
function truncateText(
  value: string,
  limit: number,
  forceTruncation = false
): { text: string; truncated: boolean } {
  if (!forceTruncation && codePointLength(value) <= limit) return { text: value, truncated: false };
  return { text: `${codePointPrefix(value, Math.max(0, limit - 1))}…`, truncated: true };
}

function collapsePreviewText(value: string): string {
  const lines = value.split('\n');
  const lineBounded = lines.slice(0, FEEDBACK_COLLAPSED_PREVIEW_LINE_LIMIT).join('\n');
  return truncateText(lineBounded, FEEDBACK_COLLAPSED_PREVIEW_CHARACTER_LIMIT).text;
}

function textPreview(
  kind: 'quote' | 'code',
  value: string,
  forceTruncation = false
): FeedbackTextTargetPreview {
  const normalized = normalizeText(value);
  const bounded = truncateText(normalized, FEEDBACK_TEXT_PREVIEW_LIMIT, forceTruncation);
  const collapsedText = collapsePreviewText(bounded.text);
  return {
    kind,
    text: bounded.text,
    collapsedText,
    hasMore: collapsedText !== bounded.text,
    truncated: bounded.truncated,
  };
}

/**
 * Builds a human-facing preview from the frozen rich node, not the persisted
 * feedback Focus. Whole-block Focus is durable source evidence after saving,
 * so rendering it here would expose Markdown syntax in reopened cards.
 */
function wholeBlockTextPreview(node: ProseMirrorNode): FeedbackTextTargetPreview | null {
  if (node.isAtom || node.content.size === 0) return null;
  const bounded = boundedNodeText(node, FEEDBACK_TEXT_PREVIEW_LIMIT);
  const semanticText = normalizeText(bounded.text);
  if (semanticText.trim().length === 0) return null;
  return textPreview('quote', semanticText, bounded.truncated);
}

function lineCount(value: string): number {
  const normalized = normalizeText(value);
  return normalized.length === 0 ? 0 : normalized.split('\n').length;
}

function lineCountText(lines: number): string {
  return l10n.t(lines === 1 ? '{0} line' : '{0} lines', lines);
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
  if (!language) return lineCountText(lines);
  return l10n.t(lines === 1 ? '{0} · {1} line' : '{0} · {1} lines', language, lines);
}

function readableBlockKind(node: ProseMirrorNode): string {
  const labels: Record<string, () => string> = {
    blockquote: () => l10n.t('block quote'),
    bulletList: () => l10n.t('bullet list'),
    codeBlock: () => l10n.t('code block'),
    githubAlert: () => l10n.t('alert'),
    heading: () => l10n.t('heading'),
    horizontalRule: () => l10n.t('divider'),
    image: () => l10n.t('image'),
    mathBlock: () => l10n.t('math block'),
    mermaid: () => l10n.t('Mermaid diagram'),
    orderedList: () => l10n.t('numbered list'),
    paragraph: () => l10n.t('paragraph'),
    table: () => l10n.t('table'),
    taskList: () => l10n.t('task list'),
  };
  return (
    labels[node.type.name]?.() ?? node.type.name.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase()
  );
}

/** Label of a whole-block target, one whole message per known block kind. */
function wholeBlockLabel(node: ProseMirrorNode): string {
  const labels: Record<string, () => string> = {
    blockquote: () => l10n.t('Whole block quote'),
    bulletList: () => l10n.t('Whole bullet list'),
    githubAlert: () => l10n.t('Whole alert'),
    heading: () => l10n.t('Whole heading'),
    horizontalRule: () => l10n.t('Whole divider'),
    orderedList: () => l10n.t('Whole numbered list'),
    paragraph: () => l10n.t('Whole paragraph'),
    taskList: () => l10n.t('Whole task list'),
  };
  return labels[node.type.name]?.() ?? l10n.t('Whole {0}', readableBlockKind(node));
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
  const bounded = boundedNodeText(node, FEEDBACK_CELL_PREVIEW_TEXT_LIMIT);
  return truncateText(
    normalizeText(bounded.text),
    FEEDBACK_CELL_PREVIEW_TEXT_LIMIT,
    bounded.truncated
  ).text;
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
  if (!first || !last) return l10n.t(count === 1 ? '{0} block' : '{0} blocks', count);
  return l10n.t(
    count === 1 ? '{0} block · {1} to {2}' : '{0} blocks · {1} to {2}',
    count,
    readableBlockKind(first),
    readableBlockKind(last)
  );
}

function opaqueExplanation(node: ProseMirrorNode): string {
  if (node.type.name === 'mermaid') {
    return l10n.t(
      'Rendered diagram parts cannot be anchored independently. This feedback applies to the whole diagram. Use Capture area for a visual sub-area.'
    );
  }
  if (node.type.name === 'image') {
    return l10n.t(
      'Rendered image parts cannot be anchored independently. This feedback applies to the whole image. Use Capture area for a visual sub-area.'
    );
  }
  if (node.type.name === 'mathBlock') {
    return l10n.t(
      'Rendered math block parts cannot be anchored independently. This feedback applies to the whole math block. Use Capture area for a visual sub-area.'
    );
  }
  return l10n.t(
    'Rendered {0} parts cannot be anchored independently. This feedback applies to the whole {0}. Use Capture area for a visual sub-area.',
    readableBlockKind(node)
  );
}

function fallbackExplanation(reason: FeedbackTargetPresentationReason | undefined): string | null {
  if (reason === 'large-table-selection') {
    return l10n.t(
      'This selection is too large to anchor cell by cell. This feedback applies to the whole table.'
    );
  }
  if (reason === 'session-cell-budget') {
    return l10n.t(
      'This feedback session has reached its exact cell detail limit. This feedback applies to the whole table.'
    );
  }
  if (reason === 'merged-table-cells' || reason === 'irregular-table') {
    return l10n.t(
      'This table structure cannot be anchored as one exact rectangle. This feedback applies to the whole table.'
    );
  }
  if (reason === 'unmappable-dom' || reason === 'unmappable-text-range') {
    return l10n.t(
      'This selection could not be anchored exactly. This feedback applies to the complete containing block.'
    );
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
      label: l10n.t('Selected content'),
      detail: l10n.t('Target details unavailable'),
      preferredComposerSize: 'compact',
      lineContext: 'source',
      preview: null,
      explanation: null,
    };
  }

  if (target.structuralScope)
    return {
      kind: 'multi-block',
      label: target.structuralScope.label,
      detail: l10n.t(
        'Complete rendered text in this scope. Source lines identify the containing block.'
      ),
      preferredComposerSize: 'compact',
      lineContext: 'containing-source',
      preview: null,
      explanation: null,
    };
  if (target.sectionLabel && !target.renderedRange && !target.cellTarget) {
    return {
      kind: 'multi-block',
      label: l10n.t('Section: {0}', target.sectionLabel),
      detail: l10n.t('Includes the heading and all subsections'),
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
      label: l10n.t('Selected content'),
      detail: l10n.t('Target details unavailable'),
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
        label: l10n.t('Selected cells'),
        detail: l10n.t(
          count === 1
            ? 'Rows {0}–{1} · Columns {2}–{3} · {4} cell'
            : 'Rows {0}–{1} · Columns {2}–{3} · {4} cells',
          rectangle.top + 1,
          rectangle.bottom,
          rectangle.left + 1,
          rectangle.right,
          count
        ),
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
        ? lineCountText(lineCount(target.focus))
        : multiBlockDetail(doc, target.startOrdinal, target.endOrdinal);
    if (first.type.name === 'codeBlock' && target.startOrdinal === target.endOrdinal) {
      // Selection origin is authoritative. A native drag remains rendered
      // evidence even when its offsets happen to cover the complete code node.
      return {
        kind: 'selected-code',
        label: l10n.t('Selected code'),
        detail: codeDetail(first, target.focus),
        preferredComposerSize: 'wide',
        lineContext: 'containing-source',
        preview: textPreview('code', target.focus),
        explanation: null,
      };
    }
    return {
      kind: 'selected-text',
      label: l10n.t('Selected text'),
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
      label: l10n.t('Selected blocks'),
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
      label: l10n.t('Whole table'),
      detail: dimensions
        ? l10n.t(
            dimensions.rows === 1
              ? dimensions.columns === 1
                ? '{0} row × {1} column'
                : '{0} row × {1} columns'
              : dimensions.columns === 1
                ? '{0} rows × {1} column'
                : '{0} rows × {1} columns',
            dimensions.rows,
            dimensions.columns
          )
        : l10n.t('Table dimensions unavailable'),
      preferredComposerSize: 'wide',
      lineContext: 'source',
      preview: null,
      explanation: fallbackExplanation(target.presentationReason),
    };
  }

  if (first.type.name === 'codeBlock') {
    return {
      kind: 'whole-code',
      label: l10n.t('Whole code block'),
      detail: codeDetail(first, first.textContent || target.focus),
      preferredComposerSize: 'wide',
      lineContext: 'source',
      preview: null,
      explanation: fallbackExplanation(target.presentationReason),
    };
  }

  const opaqueLabels: Record<string, string> = {
    image: l10n.t('Whole image'),
    mathBlock: l10n.t('Whole math block'),
    mermaid: l10n.t('Whole Mermaid diagram'),
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

  const focus = wholeBlockTextPreview(first);
  return {
    kind: 'whole-block',
    label: wholeBlockLabel(first),
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
  let textOwner: HTMLElement = element;
  if (preview.kind === 'code') {
    const code = ownerDocument.createElement('code');
    element.append(code);
    textOwner = code;
  }
  textOwner.textContent = preview.collapsedText;
  container.append(element);

  if (!preview.hasMore && !preview.truncated) return;
  const disclosure = ownerDocument.createElement('details');
  disclosure.className = 'feedback-target-disclosure';
  const summary = ownerDocument.createElement('summary');
  summary.textContent = l10n.t('Show more selected content');
  disclosure.append(summary);
  disclosure.addEventListener('toggle', () => {
    textOwner.textContent = disclosure.open ? preview.text : preview.collapsedText;
    summary.textContent = disclosure.open
      ? l10n.t('Show less selected content')
      : l10n.t('Show more selected content');
    element.classList.toggle('feedback-target-preview-expanded', disclosure.open);
  });
  if (preview.truncated) {
    const note = ownerDocument.createElement('p');
    note.className = 'feedback-target-truncation';
    note.textContent = l10n.t(
      'Preview limited. The highlighted document remains the complete target.'
    );
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
  table.setAttribute('aria-label', l10n.t('{0} preview', presentation.detail));
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
    caption.textContent = l10n.t('Preview limited to the first 4 rows and 4 columns.');
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
  context.setAttribute('aria-label', l10n.t('Feedback target: {0}', presentation.label));

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
  if (startLine <= 0 || endLine <= 0) return l10n.t('Source lines validated when saved');
  if (context === 'containing-source') {
    return startLine === endLine
      ? l10n.t('Containing source line {0}', startLine)
      : l10n.t('Containing source lines {0}-{1}', startLine, endLine);
  }
  return startLine === endLine
    ? l10n.t('Source line {0}', startLine)
    : l10n.t('Source lines {0}-{1}', startLine, endLine);
}
