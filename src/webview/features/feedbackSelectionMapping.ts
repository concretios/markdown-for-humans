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
import type { FeedbackRenderedRangeInputV1 } from '../../shared/feedbackProtocol';
import { blockRelativeRangeFromPositions } from './feedbackRenderedRange';

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
  | 'irregular-table';

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

export interface FeedbackResolvedCellNode {
  /** Absolute ProseMirror node boundary. */
  readonly from: number;
  readonly to: number;
}

export type FeedbackCellTargetResolution =
  | { readonly kind: 'cells'; readonly cells: readonly FeedbackResolvedCellNode[] }
  | { readonly kind: 'fallback' };

function failure(reason: FeedbackSelectionFailureReason): FeedbackSelectionFailure {
  return { kind: 'failure', reason };
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

/**
 * Revalidate persisted structural metadata against the current frozen editor
 * document before resolving any table-cell geometry. Invalid, stale, merged,
 * or irregular tables fail closed to their containing block.
 */
export function resolveFeedbackCellTarget(
  doc: ProseMirrorNode,
  target: FeedbackPersistedCellTarget
): FeedbackCellTargetResolution {
  if (
    target.version !== 1 ||
    !Number.isSafeInteger(target.tableOrdinal) ||
    target.tableOrdinal < 0 ||
    target.tableOrdinal >= doc.childCount
  ) {
    return { kind: 'fallback' };
  }
  const table = doc.maybeChild(target.tableOrdinal);
  if (!table || table.type.spec.tableRole !== 'table') return { kind: 'fallback' };
  if (
    fingerprintFeedbackTable({ version: 1, tableOrdinal: target.tableOrdinal, table })
      .fingerprint !== target.tableFingerprint
  ) {
    return { kind: 'fallback' };
  }

  let map: TableMap;
  try {
    map = TableMap.get(table);
  } catch {
    return { kind: 'fallback' };
  }
  const rectangle = target.rectangle;
  if (
    map.problems?.length ||
    !Number.isSafeInteger(rectangle.top) ||
    !Number.isSafeInteger(rectangle.left) ||
    !Number.isSafeInteger(rectangle.bottom) ||
    !Number.isSafeInteger(rectangle.right) ||
    rectangle.top < 0 ||
    rectangle.left < 0 ||
    rectangle.bottom <= rectangle.top ||
    rectangle.right <= rectangle.left ||
    rectangle.bottom > map.height ||
    rectangle.right > map.width
  ) {
    return { kind: 'fallback' };
  }

  let tableOffset = -1;
  doc.forEach((_node, offset, ordinal) => {
    if (ordinal === target.tableOrdinal) tableOffset = offset;
  });
  if (tableOffset < 0) return { kind: 'fallback' };

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
  reason: Extract<FeedbackBlockFallbackReason, 'merged-table-cells' | 'irregular-table'>
): FeedbackBlockSelectionTarget {
  const blockRange = {
    fromOrdinal: context.tableOrdinal,
    toOrdinal: context.tableOrdinal,
  };
  const tableText = context.table.textBetween(0, context.table.content.size, '\n', '\n');
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

function selectedCellFocus(context: CellSelectionContext): string | null {
  const { map, rectangle, table } = context;
  const rows: string[] = [];
  for (let row = rectangle.top; row < rectangle.bottom; row += 1) {
    const cells: string[] = [];
    for (let column = rectangle.left; column < rectangle.right; column += 1) {
      const position = map.map[row * map.width + column];
      const cell = table.nodeAt(position);
      if (!cell) return null;
      cells.push(cell.textBetween(0, cell.content.size, '\n', '\n').replace(/\r\n/g, '\n'));
    }
    rows.push(cells.join('\t'));
  }
  return rows.join('\n');
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
