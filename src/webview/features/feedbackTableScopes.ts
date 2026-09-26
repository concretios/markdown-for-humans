/** Explicit table scopes reuse v2 rectangular evidence and never dispatch a selection. */
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { TableMap } from '@tiptap/pm/tables';
import type { FeedbackBlockActionAnchor } from './feedbackBlockAction';
import type { FeedbackTextTarget } from './feedbackReview';
import {
  buildFeedbackTableCellEvidence,
  fingerprintFeedbackTable,
} from './feedbackSelectionMapping';

/** Resolve only a cell in a top-level, regular, mapped table. Unsupported grids stay whole-table. */
export function feedbackTableScopes(
  doc: ProseMirrorNode,
  position: number,
  anchor: FeedbackBlockActionAnchor
): FeedbackTextTarget[] {
  if (!Number.isInteger(position) || position < 0 || position > doc.content.size) return [];
  const resolved = doc.resolve(position);
  if (resolved.index(0) !== anchor.ordinal) return [];
  const table = doc.maybeChild(anchor.ordinal);
  if (table?.type.spec.tableRole !== 'table') return [];
  let cellDepth = resolved.depth;
  while (
    cellDepth > 0 &&
    !['cell', 'header_cell'].includes(resolved.node(cellDepth).type.spec.tableRole ?? '')
  )
    cellDepth--;
  if (cellDepth !== 3) return [];
  try {
    const map = TableMap.get(table);
    const cell = map.findCell(resolved.before(cellDepth) - resolved.start(1));
    const rectangles = [
      { label: 'Current cell', value: cell },
      {
        label: 'Full row',
        value: { top: cell.top, bottom: cell.bottom, left: 0, right: map.width },
      },
      {
        label: 'Full column',
        value: { top: 0, bottom: map.height, left: cell.left, right: cell.right },
      },
    ];
    const fingerprint = fingerprintFeedbackTable({
      version: 1,
      tableOrdinal: anchor.ordinal,
      table,
    }).fingerprint;
    return rectangles.flatMap(({ label, value }) => {
      const cellTarget = {
        version: 1 as const,
        tableOrdinal: anchor.ordinal,
        rectangle: value,
        tableFingerprint: fingerprint,
      };
      const evidence = buildFeedbackTableCellEvidence(doc, cellTarget);
      if (!evidence) return [];
      return [
        {
          startOrdinal: anchor.ordinal,
          endOrdinal: anchor.ordinal,
          startLine: anchor.startLine,
          endLine: anchor.endLine,
          scopePosition: position,
          scopeLabel: label,
          cellTarget,
          focus:
            evidence.rows.map(row => row.map(cell => cell.text).join('\t')).join('\n') ||
            '[Empty cells]',
        },
      ];
    });
  } catch {
    return [];
  }
}
