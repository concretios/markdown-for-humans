import type { EditorState } from 'prosemirror-state';

export interface TableLineMapping {
  start: number;
  end: number;
}

export interface SelectedTableLinesResult {
  selectedLines: TableLineMapping[];
  tr: any;
}

/**
 * Helper to get the lines within the current table cell selection.
 * Returns the precise boundaries of each logical line (separated by <br />) that overlaps with the user's current selection.
 *
 * @param state - ProseMirror EditorState
 * @param selection - ProseMirror Selection Object
 * @returns Object containing the array of selected lines and the transaction object, or null if not in a table.
 */
export function getSelectedTableLines(
  state: EditorState,
  selection: any
): SelectedTableLinesResult | null {
  let cellPos = -1;
  let cellNode = null;

  for (let d = selection.$anchor.depth; d > 0; d--) {
    const node = selection.$anchor.node(d);
    if (node.type.name === 'tableCell' || node.type.name === 'tableHeader') {
      cellNode = node;
      cellPos = selection.$anchor.before(d);
      break;
    }
  }

  if (!cellNode || cellPos === -1) return null;

  const paragraphPos = cellPos + 1;
  const paragraphNode = cellNode.firstChild;
  if (!paragraphNode || paragraphNode.type.name !== 'paragraph') return null;

  const lines: TableLineMapping[] = [];
  let currentStart = paragraphPos + 1;

  paragraphNode.forEach((node: any, offset: number) => {
    if (node.type.name === 'hardBreak') {
      const nodePos = paragraphPos + 1 + offset;
      lines.push({ start: currentStart, end: nodePos });
      currentStart = nodePos + node.nodeSize;
    }
  });
  lines.push({ start: currentStart, end: paragraphPos + paragraphNode.nodeSize });

  const { from, to } = selection;
  // Select lines that overlap with [from, to]
  // If selection is a cursor, from === to, which works fine.
  const selectedLines = lines.filter(line => {
    return line.start <= to && line.end >= from;
  });

  if (selectedLines.length === 0) {
    selectedLines.push(lines[0]);
  }

  return { selectedLines, tr: state.tr };
}
