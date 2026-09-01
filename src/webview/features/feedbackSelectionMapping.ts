/**
 * Pure mapping from one coalesced ProseMirror/native selection sample to a
 * typed Feedback target.
 *
 * ProseMirror owns structural selections. Native selection data is accepted
 * only as an already-mapped text range and cannot erase a CellSelection merely
 * because Chromium temporarily reports a collapsed caret.
 */

import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { AllSelection, NodeSelection, type Selection } from '@tiptap/pm/state';
import { CellSelection, TableMap } from '@tiptap/pm/tables';
import {
  isFeedbackCellRectangleWithinExactLimit,
  type FeedbackRenderedRangeInputV1,
} from '../../shared/feedbackProtocol';
import { blockRelativeRangeFromPositions } from './feedbackRenderedRange';

export {
  FEEDBACK_MAX_EXACT_CELL_COUNT,
  isFeedbackCellRectangleWithinExactLimit,
} from '../../shared/feedbackProtocol';

export interface FeedbackBlockRange {
  readonly fromOrdinal: number;
  readonly toOrdinal: number;
}

export interface FeedbackTextSelectionTarget {
  readonly kind: 'text';
  readonly authority: 'native-text' | 'prosemirror-text';
  readonly blockRange: FeedbackBlockRange;
  readonly renderedRange: FeedbackRenderedRangeInputV1;
  readonly focusText: string;
}

export type FeedbackBlockFallbackReason =
  | 'structural-node-selection'
  | 'structural-block-selection'
  | 'unmappable-text-range'
  | 'merged-table-cells'
  | 'irregular-table'
  | 'large-table-selection';

export interface FeedbackBlockSelectionTarget {
  readonly kind: 'blocks';
  readonly authority: 'prosemirror-structural';
  readonly blockRange: FeedbackBlockRange;
  readonly focusText: string;
  readonly reason: FeedbackBlockFallbackReason;
}

export interface FeedbackCellRectangle {
  /** Zero-based, inclusive row. */
  readonly top: number;
  /** Zero-based, inclusive column. */
  readonly left: number;
  /** Zero-based, exclusive row. */
  readonly bottom: number;
  /** Zero-based, exclusive column. */
  readonly right: number;
}

export interface FeedbackCellSelectionTarget {
  readonly kind: 'cells';
  readonly authority: 'prosemirror-structural';
  readonly tableOrdinal: number;
  readonly rectangle: FeedbackCellRectangle;
  readonly tableFingerprint: string;
  readonly blockRange: FeedbackBlockRange;
  readonly focusText: string;
}

export type FeedbackSelectionFailureReason =
  | 'native-selection-outside-editor'
  | 'native-selection-collapsed'
  | 'no-selection'
  | 'empty-selection'
  | 'unmapped-block'
  | 'invalid-native-text-target'
  | 'invalid-table-selection';

export interface FeedbackSelectionFailure {
  readonly kind: 'failure';
  readonly reason: FeedbackSelectionFailureReason;
}

export type FeedbackSelectionMappingResult =
  | FeedbackTextSelectionTarget
  | FeedbackBlockSelectionTarget
  | FeedbackCellSelectionTarget
  | FeedbackSelectionFailure;

export interface FeedbackNativeTextTargetInput {
  readonly blockRange: FeedbackBlockRange;
  readonly renderedRange: FeedbackRenderedRangeInputV1;
  readonly focusText: string;
}

export type FeedbackNativeSelectionSample =
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'collapsed-inside' }
  | { readonly kind: 'outside-editor' }
  | { readonly kind: 'text'; readonly target: FeedbackNativeTextTargetInput };

export interface FeedbackSelectionMappingInput {
  readonly doc: ProseMirrorNode;
  readonly selection: Selection;
  readonly mappedOrdinals: readonly number[];
  readonly nativeSelection: FeedbackNativeSelectionSample;
}

export interface FeedbackTableFingerprintInput {
  readonly version: 1;
  readonly tableOrdinal: number;
  readonly table: ProseMirrorNode;
}

export interface FeedbackTableFingerprintOutput {
  readonly version: 1;
  readonly tableOrdinal: number;
  /** Deterministic identity, not a security digest. */
  readonly fingerprint: string;
}

export interface FeedbackPersistedCellTarget {
  readonly version: 1;
  readonly tableOrdinal: number;
  readonly rectangle: FeedbackCellRectangle;
  readonly tableFingerprint: string;
}

/** One bounded semantic cell sent by the renderer for a v2 cell target. */
export interface FeedbackTableCellEvidenceCellV2 {
  readonly role: 'header' | 'data';
  readonly text: string;
  readonly complete: boolean;
}

/** Renderer-owned semantic matrix. Its independently validated locator remains authoritative. */
export interface FeedbackTableCellEvidenceInputV2 {
  readonly kind: 'table-cells';
  readonly complete: boolean;
  readonly rows: readonly (readonly FeedbackTableCellEvidenceCellV2[])[];
}

export interface FeedbackResolvedCellNode {
  /** Absolute ProseMirror node boundary. */
  readonly from: number;
  readonly to: number;
}

export type FeedbackCellTargetResolution =
  | { readonly kind: 'cells'; readonly cells: readonly FeedbackResolvedCellNode[] }
  | { readonly kind: 'fallback' };

// Exact cell rectangles contain at most 256 cells. A 240-character per-cell
// ceiling, including its sentinel, keeps every cell represented while leaving
// the aggregate Focus safely below 64 KiB after row and column separators.
const FEEDBACK_SELECTED_CELL_FOCUS_MAX_LENGTH = 64 * 1024;
const FEEDBACK_SELECTED_CELL_TEXT_MAX_LENGTH = 240;
const FEEDBACK_TEXTUAL_EVIDENCE_MAX_UTF8_BYTES = 64 * 1024;
const FEEDBACK_SELECTED_CELL_TRUNCATION_SENTINEL = '… [truncated]';
const FEEDBACK_SELECTED_CELL_AGGREGATE_TRUNCATION_SENTINEL = '\n[Selected cell Focus truncated]';
const FEEDBACK_TABLE_FOCUS_TRUNCATION_SENTINEL = '\n[Table Focus truncated]';

function failure(reason: FeedbackSelectionFailureReason): FeedbackSelectionFailure {
  return { kind: 'failure', reason };
}

function textWithTruncationSentinel(
  value: string,
  maximumLength: number,
  sentinel: string
): string {
  const boundedSentinel = sentinel.slice(0, maximumLength);
  const prefixLength = Math.max(0, maximumLength - boundedSentinel.length);
  return `${value.slice(0, prefixLength)}${boundedSentinel}`;
}

function boundedSemanticText(
  node: ProseMirrorNode,
  maximumLength: number,
  sentinel: string
): string {
  const traversalEnd = Math.min(node.content.size, maximumLength);
  const value = node.textBetween(0, traversalEnd, '\n', '\n').replace(/\r\n/g, '\n');
  return traversalEnd < node.content.size || value.length > maximumLength
    ? textWithTruncationSentinel(value, maximumLength, sentinel)
    : value;
}

function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      return Number.isFinite(value) ? String(value) : JSON.stringify(String(value));
    case 'string':
      return JSON.stringify(value);
    case 'undefined':
      return 'null';
    case 'object': {
      const record = value as Record<string, unknown>;
      return `{${Object.keys(record)
        .sort()
        .map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
        .join(',')}}`;
    }
    default:
      return JSON.stringify(String(value));
  }
}

function fnv1a64(value: string): string {
  const mask = 0xffffffffffffffffn;
  const prime = 0x100000001b3n;
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    hash ^= BigInt(codeUnit & 0xff);
    hash = (hash * prime) & mask;
    hash ^= BigInt(codeUnit >>> 8);
    hash = (hash * prime) & mask;
  }
  return hash.toString(16).padStart(16, '0');
}

const tableFingerprintCache = new WeakMap<ProseMirrorNode, string>();
const topLevelOffsetsByDocument = new WeakMap<ProseMirrorNode, readonly number[]>();

interface FeedbackTableValidationShape {
  readonly map: TableMap;
  readonly unitCellPositions: ReadonlySet<number>;
}

const tableValidationShapeCache = new WeakMap<
  ProseMirrorNode,
  FeedbackTableValidationShape | null
>();

function topLevelOffsets(doc: ProseMirrorNode): readonly number[] {
  const cached = topLevelOffsetsByDocument.get(doc);
  if (cached) return cached;
  const offsets: number[] = [];
  doc.forEach((_node, offset, ordinal) => {
    offsets[ordinal] = offset;
  });
  const immutable = Object.freeze(offsets);
  topLevelOffsetsByDocument.set(doc, immutable);
  return immutable;
}

function feedbackTableValidationShape(table: ProseMirrorNode): FeedbackTableValidationShape | null {
  if (tableValidationShapeCache.has(table)) {
    return tableValidationShapeCache.get(table) ?? null;
  }
  let map: TableMap;
  try {
    map = TableMap.get(table);
  } catch {
    tableValidationShapeCache.set(table, null);
    return null;
  }
  if (map.problems?.length) {
    tableValidationShapeCache.set(table, null);
    return null;
  }
  const positionCounts = new Map<number, number>();
  for (const position of map.map) {
    positionCounts.set(position, (positionCounts.get(position) ?? 0) + 1);
  }
  const unitCellPositions = new Set<number>();
  for (const [position, count] of positionCounts) {
    if (count === 1) unitCellPositions.add(position);
  }
  const shape = { map, unitCellPositions };
  tableValidationShapeCache.set(table, shape);
  return shape;
}

/**
 * Fingerprints canonical ProseMirror table JSON. Identical node JSON produces
 * the same value across renderer instances, independent of object identity.
 */
export function fingerprintFeedbackTable(
  input: FeedbackTableFingerprintInput
): FeedbackTableFingerprintOutput {
  let fingerprint = tableFingerprintCache.get(input.table);
  if (fingerprint === undefined) {
    const canonical = canonicalJson({ version: input.version, table: input.table.toJSON() });
    fingerprint = `md4h-table/v1:${fnv1a64(canonical)}`;
    tableFingerprintCache.set(input.table, fingerprint);
  }
  return {
    version: 1,
    tableOrdinal: input.tableOrdinal,
    fingerprint,
  };
}

interface ValidFeedbackCellTarget {
  readonly table: ProseMirrorNode;
  readonly map: TableMap;
  readonly rectangle: FeedbackCellRectangle;
}

/**
 * Validates exact cell metadata without allocating absolute cell geometry.
 * This is used at the irreversible Finish boundary, where only locator
 * validity is needed and rebuilding thousands of decorations would be wasteful.
 */
function validateFeedbackCellTarget(
  doc: ProseMirrorNode,
  target: FeedbackPersistedCellTarget
): ValidFeedbackCellTarget | null {
  if (
    target.version !== 1 ||
    !Number.isSafeInteger(target.tableOrdinal) ||
    target.tableOrdinal < 0 ||
    target.tableOrdinal >= doc.childCount ||
    !isFeedbackCellRectangleWithinExactLimit(target.rectangle)
  ) {
    return null;
  }
  const table = doc.maybeChild(target.tableOrdinal);
  if (!table || table.type.spec.tableRole !== 'table') return null;
  if (
    fingerprintFeedbackTable({ version: 1, tableOrdinal: target.tableOrdinal, table })
      .fingerprint !== target.tableFingerprint
  ) {
    return null;
  }

  const shape = feedbackTableValidationShape(table);
  if (!shape) return null;
  const { map, unitCellPositions } = shape;
  const rectangle = target.rectangle;
  if (rectangle.bottom > map.height || rectangle.right > map.width) {
    return null;
  }

  const seen = new Set<number>();
  for (let row = rectangle.top; row < rectangle.bottom; row += 1) {
    for (let column = rectangle.left; column < rectangle.right; column += 1) {
      const relativePosition = map.map[row * map.width + column];
      if (seen.has(relativePosition) || !unitCellPositions.has(relativePosition)) return null;
      seen.add(relativePosition);
    }
  }
  return { table, map, rectangle };
}

function hasUnsafeEvidenceControl(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 8 || (code >= 11 && code <= 12) || (code >= 14 && code <= 31) || code === 127) {
      return true;
    }
  }
  return false;
}

function utf8CodePointBytes(codePoint: number): number {
  if (codePoint <= 0x7f) return 1;
  if (codePoint <= 0x7ff) return 2;
  if (codePoint <= 0xffff) return 3;
  return 4;
}

function boundedUnicodePrefix(
  value: string,
  maximumCharacters: number,
  maximumUtf8Bytes: number
): { readonly text: string; readonly complete: boolean; readonly utf8Bytes: number } {
  let characters = 0;
  let codeUnits = 0;
  let utf8Bytes = 0;
  for (const character of value) {
    const characterBytes = utf8CodePointBytes(character.codePointAt(0) ?? 0);
    if (characters >= maximumCharacters || utf8Bytes > maximumUtf8Bytes - characterBytes) break;
    characters += 1;
    codeUnits += character.length;
    utf8Bytes += characterBytes;
  }
  return {
    text: value.slice(0, codeUnits),
    complete: codeUnits === value.length,
    utf8Bytes,
  };
}

/**
 * Build a complete rectangular semantic matrix only at the add boundary.
 *
 * Every cell remains present even when its bounded text is incomplete. The
 * exact table locator is validated first, and the shared 64 KiB UTF-8 budget
 * is allocated in deterministic row-major order without splitting Unicode.
 */
export function buildFeedbackTableCellEvidence(
  doc: ProseMirrorNode,
  target: FeedbackPersistedCellTarget
): FeedbackTableCellEvidenceInputV2 | null {
  const validated = validateFeedbackCellTarget(doc, target);
  if (!validated) return null;
  const { table, map, rectangle } = validated;
  const rows: FeedbackTableCellEvidenceCellV2[][] = [];
  let remainingUtf8Bytes = FEEDBACK_TEXTUAL_EVIDENCE_MAX_UTF8_BYTES;
  let matrixComplete = true;

  for (let row = rectangle.top; row < rectangle.bottom; row += 1) {
    const values: FeedbackTableCellEvidenceCellV2[] = [];
    for (let column = rectangle.left; column < rectangle.right; column += 1) {
      const relativePosition = map.map[row * map.width + column];
      const cell = table.nodeAt(relativePosition);
      if (
        !cell ||
        (cell.type.spec.tableRole !== 'cell' && cell.type.spec.tableRole !== 'header_cell')
      ) {
        return null;
      }
      // Reading 512 document positions is enough to determine the 240-character
      // prefix while keeping pathological nested cell content bounded.
      const traversalEnd = Math.min(cell.content.size, 512);
      const semanticText = cell.textBetween(0, traversalEnd, '\n', '\n').replace(/\r\n?/g, '\n');
      if (hasUnsafeEvidenceControl(semanticText)) return null;
      const bounded = boundedUnicodePrefix(
        semanticText,
        FEEDBACK_SELECTED_CELL_TEXT_MAX_LENGTH,
        remainingUtf8Bytes
      );
      const complete = bounded.complete && traversalEnd === cell.content.size;
      matrixComplete &&= complete;
      remainingUtf8Bytes -= bounded.utf8Bytes;
      values.push({
        role: cell.type.spec.tableRole === 'header_cell' ? 'header' : 'data',
        text: bounded.text,
        complete,
      });
    }
    rows.push(values);
  }

  return { kind: 'table-cells', complete: matrixComplete, rows };
}

/** Returns fresh locator validity without expanding per-cell geometry. */
export function isFeedbackCellTargetValid(
  doc: ProseMirrorNode,
  target: FeedbackPersistedCellTarget
): boolean {
  return validateFeedbackCellTarget(doc, target) !== null;
}

/**
 * Revalidate persisted structural metadata against the current frozen editor
 * document before resolving any table-cell geometry. Invalid, stale, merged,
 * or irregular tables fail closed to their containing block.
 */
export function resolveFeedbackCellTarget(
  doc: ProseMirrorNode,
  target: FeedbackPersistedCellTarget
): FeedbackCellTargetResolution {
  const validated = validateFeedbackCellTarget(doc, target);
  if (!validated) return { kind: 'fallback' };
  const { table, map, rectangle } = validated;
  const tableOffset = topLevelOffsets(doc)[target.tableOrdinal];
  if (tableOffset === undefined) return { kind: 'fallback' };

  const seen = new Set<number>();
  const cells: FeedbackResolvedCellNode[] = [];
  for (let row = rectangle.top; row < rectangle.bottom; row += 1) {
    for (let column = rectangle.left; column < rectangle.right; column += 1) {
      const relativePosition = map.map[row * map.width + column];
      if (seen.has(relativePosition)) return { kind: 'fallback' };
      seen.add(relativePosition);
      const cell = table.nodeAt(relativePosition);
      if (
        !cell ||
        (cell.type.spec.tableRole !== 'cell' && cell.type.spec.tableRole !== 'header_cell') ||
        Number(cell.attrs.colspan ?? 1) !== 1 ||
        Number(cell.attrs.rowspan ?? 1) !== 1
      ) {
        return { kind: 'fallback' };
      }
      const from = tableOffset + 1 + relativePosition;
      cells.push({ from, to: from + cell.nodeSize });
    }
  }
  return cells.length > 0 ? { kind: 'cells', cells } : { kind: 'fallback' };
}

function mappedOrdinalSet(ordinals: readonly number[]): ReadonlySet<number> {
  return new Set(ordinals.filter(ordinal => Number.isSafeInteger(ordinal) && ordinal >= 0));
}

function allOrdinalsMapped(range: FeedbackBlockRange, mapped: ReadonlySet<number>): boolean {
  if (
    !Number.isSafeInteger(range.fromOrdinal) ||
    !Number.isSafeInteger(range.toOrdinal) ||
    range.fromOrdinal < 0 ||
    range.toOrdinal < range.fromOrdinal
  ) {
    return false;
  }
  for (let ordinal = range.fromOrdinal; ordinal <= range.toOrdinal; ordinal += 1) {
    if (!mapped.has(ordinal)) return false;
  }
  return true;
}

function blockRangeForPositions(
  doc: ProseMirrorNode,
  from: number,
  to: number
): FeedbackBlockRange | null {
  let first = -1;
  let last = -1;
  doc.forEach((node, offset, ordinal) => {
    if (offset + node.nodeSize > from && offset < to) {
      if (first < 0) first = ordinal;
      last = ordinal;
    }
  });
  return first >= 0 && last >= first ? { fromOrdinal: first, toOrdinal: last } : null;
}

function blockFocus(doc: ProseMirrorNode, range: FeedbackBlockRange): string {
  const values: string[] = [];
  for (let ordinal = range.fromOrdinal; ordinal <= range.toOrdinal; ordinal += 1) {
    const node = doc.maybeChild(ordinal);
    if (!node) continue;
    const text = node.textBetween(0, node.content.size, '\n', '\n');
    values.push(text.trim().length > 0 ? text : `[${node.type.name}]`);
  }
  return values.join('\n');
}

function structuralBlockTarget(
  input: FeedbackSelectionMappingInput,
  mapped: ReadonlySet<number>,
  reason: Extract<
    FeedbackBlockFallbackReason,
    'structural-node-selection' | 'structural-block-selection'
  >
): FeedbackSelectionMappingResult {
  const range = blockRangeForPositions(input.doc, input.selection.from, input.selection.to);
  if (!range) return failure('no-selection');
  if (!allOrdinalsMapped(range, mapped)) return failure('unmapped-block');
  const focusText = blockFocus(input.doc, range);
  return focusText.trim().length > 0
    ? {
        kind: 'blocks',
        authority: 'prosemirror-structural',
        blockRange: range,
        focusText,
        reason,
      }
    : failure('empty-selection');
}

function validRenderedRange(range: FeedbackRenderedRangeInputV1): boolean {
  return (
    range.version === 1 &&
    Number.isSafeInteger(range.startOrdinal) &&
    Number.isSafeInteger(range.endOrdinal) &&
    Number.isSafeInteger(range.startOffset) &&
    Number.isSafeInteger(range.endOffset) &&
    range.startOrdinal >= 0 &&
    range.endOrdinal >= range.startOrdinal &&
    range.startOffset >= 0 &&
    range.endOffset >= 0 &&
    (range.startOrdinal < range.endOrdinal || range.startOffset < range.endOffset)
  );
}

function nativeTextTarget(
  target: FeedbackNativeTextTargetInput,
  mapped: ReadonlySet<number>
): FeedbackSelectionMappingResult {
  if (
    !validRenderedRange(target.renderedRange) ||
    target.renderedRange.startOrdinal !== target.blockRange.fromOrdinal ||
    target.renderedRange.endOrdinal !== target.blockRange.toOrdinal ||
    !allOrdinalsMapped(target.blockRange, mapped) ||
    target.focusText.trim().length === 0
  ) {
    return failure('invalid-native-text-target');
  }
  return {
    kind: 'text',
    authority: 'native-text',
    blockRange: { ...target.blockRange },
    renderedRange: { ...target.renderedRange },
    focusText: target.focusText.replace(/\r\n/g, '\n'),
  };
}

interface CellSelectionContext {
  readonly table: ProseMirrorNode;
  readonly tableOrdinal: number;
  readonly map: TableMap;
  readonly rectangle: FeedbackCellRectangle;
}

function cellSelectionContext(
  doc: ProseMirrorNode,
  selection: CellSelection
): CellSelectionContext | null {
  const anchorTable = selection.$anchorCell.node(-1);
  const headTable = selection.$headCell.node(-1);
  if (
    anchorTable !== headTable ||
    anchorTable.type.spec.tableRole !== 'table' ||
    selection.$anchorCell.node(0) !== doc
  ) {
    return null;
  }

  try {
    const tableStart = selection.$anchorCell.start(-1);
    const map = TableMap.get(anchorTable);
    const rectangle = map.rectBetween(
      selection.$anchorCell.pos - tableStart,
      selection.$headCell.pos - tableStart
    );
    const tableOrdinal = selection.$anchorCell.index(0);
    if (
      !Number.isSafeInteger(tableOrdinal) ||
      tableOrdinal < 0 ||
      rectangle.left < 0 ||
      rectangle.top < 0 ||
      rectangle.right <= rectangle.left ||
      rectangle.bottom <= rectangle.top ||
      rectangle.right > map.width ||
      rectangle.bottom > map.height
    ) {
      return null;
    }
    return { table: anchorTable, tableOrdinal, map, rectangle };
  } catch {
    return null;
  }
}

function tableBlockFallback(
  context: CellSelectionContext,
  reason: Extract<
    FeedbackBlockFallbackReason,
    'merged-table-cells' | 'irregular-table' | 'large-table-selection'
  >
): FeedbackBlockSelectionTarget {
  const blockRange = {
    fromOrdinal: context.tableOrdinal,
    toOrdinal: context.tableOrdinal,
  };
  const tableText =
    reason === 'large-table-selection'
      ? ''
      : boundedSemanticText(
          context.table,
          FEEDBACK_SELECTED_CELL_FOCUS_MAX_LENGTH,
          FEEDBACK_TABLE_FOCUS_TRUNCATION_SENTINEL
        );
  return {
    kind: 'blocks',
    authority: 'prosemirror-structural',
    blockRange,
    focusText: tableText.trim().length > 0 ? tableText : `[${context.table.type.name}]`,
    reason,
  };
}

function selectedCellsAreMerged(context: CellSelectionContext): boolean {
  const { map, rectangle, table } = context;
  const seen = new Set<number>();
  for (let row = rectangle.top; row < rectangle.bottom; row += 1) {
    for (let column = rectangle.left; column < rectangle.right; column += 1) {
      const position = map.map[row * map.width + column];
      if (seen.has(position)) return true;
      seen.add(position);
      const cell = table.nodeAt(position);
      if (!cell || Number(cell.attrs.colspan ?? 1) !== 1 || Number(cell.attrs.rowspan ?? 1) !== 1) {
        return true;
      }
    }
  }
  return false;
}

/** Build row-major selected-cell Focus without materializing unbounded cell text or joins. */
function selectedCellFocus(context: CellSelectionContext): string | null {
  const { map, rectangle, table } = context;
  let focus = '';
  for (let row = rectangle.top; row < rectangle.bottom; row += 1) {
    for (let column = rectangle.left; column < rectangle.right; column += 1) {
      const position = map.map[row * map.width + column];
      const cell = table.nodeAt(position);
      if (!cell) return null;
      const separator = column > rectangle.left ? '\t' : row > rectangle.top ? '\n' : '';
      const remainingLength =
        FEEDBACK_SELECTED_CELL_FOCUS_MAX_LENGTH - focus.length - separator.length;
      if (remainingLength <= FEEDBACK_SELECTED_CELL_AGGREGATE_TRUNCATION_SENTINEL.length) {
        return textWithTruncationSentinel(
          focus,
          FEEDBACK_SELECTED_CELL_FOCUS_MAX_LENGTH,
          FEEDBACK_SELECTED_CELL_AGGREGATE_TRUNCATION_SENTINEL
        );
      }
      const cellText = boundedSemanticText(
        cell,
        Math.min(FEEDBACK_SELECTED_CELL_TEXT_MAX_LENGTH, remainingLength),
        FEEDBACK_SELECTED_CELL_TRUNCATION_SENTINEL
      );
      focus += separator + cellText;
    }
  }
  return focus;
}

function cellTarget(
  input: FeedbackSelectionMappingInput,
  mapped: ReadonlySet<number>,
  selection: CellSelection
): FeedbackSelectionMappingResult {
  const context = cellSelectionContext(input.doc, selection);
  if (!context) return failure('invalid-table-selection');
  const blockRange = {
    fromOrdinal: context.tableOrdinal,
    toOrdinal: context.tableOrdinal,
  };
  if (!allOrdinalsMapped(blockRange, mapped)) return failure('unmapped-block');
  if (!isFeedbackCellRectangleWithinExactLimit(context.rectangle)) {
    return tableBlockFallback(context, 'large-table-selection');
  }
  if (context.map.problems && context.map.problems.length > 0) {
    return tableBlockFallback(context, 'irregular-table');
  }
  if (selectedCellsAreMerged(context)) {
    return tableBlockFallback(context, 'merged-table-cells');
  }
  const focusText = selectedCellFocus(context);
  if (focusText === null) return failure('invalid-table-selection');
  return {
    kind: 'cells',
    authority: 'prosemirror-structural',
    tableOrdinal: context.tableOrdinal,
    rectangle: { ...context.rectangle },
    tableFingerprint: fingerprintFeedbackTable({
      version: 1,
      tableOrdinal: context.tableOrdinal,
      table: context.table,
    }).fingerprint,
    blockRange,
    focusText,
  };
}

function proseMirrorTextTarget(
  input: FeedbackSelectionMappingInput,
  mapped: ReadonlySet<number>
): FeedbackSelectionMappingResult {
  const { selection, doc } = input;
  if (selection.empty || selection.from >= selection.to) return failure('no-selection');
  const blockRange = blockRangeForPositions(doc, selection.from, selection.to);
  if (!blockRange) return failure('no-selection');
  if (!allOrdinalsMapped(blockRange, mapped)) return failure('unmapped-block');
  const renderedRange = blockRelativeRangeFromPositions(doc, selection.from, selection.to);
  const focusText = doc
    .textBetween(selection.from, selection.to, '\n', '\n')
    .replace(/\r\n/g, '\n');
  if (!renderedRange) {
    return {
      kind: 'blocks',
      authority: 'prosemirror-structural',
      blockRange,
      focusText: focusText.trim().length > 0 ? focusText : blockFocus(doc, blockRange),
      reason: 'unmappable-text-range',
    };
  }
  if (focusText.trim().length === 0) return failure('empty-selection');
  return {
    kind: 'text',
    authority: 'prosemirror-text',
    blockRange,
    renderedRange,
    focusText,
  };
}

/** Maps one animation-frame selection snapshot to a target or explicit failure. */
export function mapFeedbackSelection(
  input: FeedbackSelectionMappingInput
): FeedbackSelectionMappingResult {
  const mapped = mappedOrdinalSet(input.mappedOrdinals);
  if (input.selection instanceof CellSelection) {
    return cellTarget(input, mapped, input.selection);
  }
  if (input.nativeSelection.kind === 'outside-editor') {
    return failure('native-selection-outside-editor');
  }
  if (input.selection instanceof NodeSelection) {
    return structuralBlockTarget(input, mapped, 'structural-node-selection');
  }
  if (input.selection instanceof AllSelection) {
    return structuralBlockTarget(input, mapped, 'structural-block-selection');
  }

  if (input.nativeSelection.kind === 'text') {
    return nativeTextTarget(input.nativeSelection.target, mapped);
  }
  if (input.nativeSelection.kind === 'collapsed-inside') {
    return failure('native-selection-collapsed');
  }
  return proseMirrorTextTarget(input, mapped);
}
