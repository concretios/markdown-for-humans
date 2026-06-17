import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import type { Node as ProsemirrorNode } from '@tiptap/pm/model';
import type { EditorView } from '@tiptap/pm/view';

type SortDirection = 'asc' | 'desc';

const tableSortingPluginKey = new PluginKey('tableSorting');

function getTableAtDom(
  view: EditorView,
  tableElement: HTMLTableElement
): { node: ProsemirrorNode; pos: number } | null {
  try {
    const domPos = view.posAtDOM(tableElement, 0);
    const $pos = view.state.doc.resolve(Math.max(0, Math.min(domPos, view.state.doc.content.size)));
    for (let depth = $pos.depth; depth > 0; depth--) {
      const node = $pos.node(depth);
      if (node.type.name === 'table' || node.type.spec.tableRole === 'table') {
        return { node, pos: $pos.before(depth) };
      }
    }
  } catch {
    return null;
  }
  return null;
}

function sortableCellText(row: ProsemirrorNode, columnIndex: number): string {
  const cell = row.child(columnIndex);
  return cell ? cell.textContent.trim() : '';
}

function compareCellText(a: string, b: string, direction: SortDirection): number {
  const aNumber = Number(a.replace(/,/g, ''));
  const bNumber = Number(b.replace(/,/g, ''));
  const bothNumeric = a !== '' && b !== '' && !Number.isNaN(aNumber) && !Number.isNaN(bNumber);

  const result = bothNumeric
    ? aNumber - bNumber
    : a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });

  return direction === 'asc' ? result : -result;
}

export function sortTableRowsByColumn(
  view: EditorView,
  tablePos: number,
  columnIndex: number,
  direction: SortDirection
): boolean {
  const table = view.state.doc.nodeAt(tablePos);
  if (!table || (table.type.name !== 'table' && table.type.spec.tableRole !== 'table'))
    return false;
  if (columnIndex < 0 || table.childCount < 3) return false;

  const headerRow = table.child(0);
  const bodyRows: ProsemirrorNode[] = [];
  table.forEach((row, _offset, index) => {
    if (index > 0) bodyRows.push(row);
  });

  bodyRows.sort((a, b) =>
    compareCellText(sortableCellText(a, columnIndex), sortableCellText(b, columnIndex), direction)
  );

  const sortedTable = table.type.create(table.attrs, [headerRow, ...bodyRows], table.marks);
  view.dispatch(
    view.state.tr.replaceWith(tablePos, tablePos + table.nodeSize, sortedTable).scrollIntoView()
  );
  return true;
}

export const TableSorting = Extension.create({
  name: 'tableSorting',

  addProseMirrorPlugins() {
    const sortDirections = new Map<string, SortDirection>();

    return [
      new Plugin({
        key: tableSortingPluginKey,
        props: {
          handleDOMEvents: {
            click: (view, event) => {
              const target = event.target;
              if (!(target instanceof Element)) return false;

              const headerCell = target.closest('th');
              const tableElement = headerCell?.closest('table');
              if (
                !(headerCell instanceof HTMLTableCellElement) ||
                !(tableElement instanceof HTMLTableElement)
              ) {
                return false;
              }

              const table = getTableAtDom(view, tableElement);
              if (!table) return false;

              const columnIndex = headerCell.cellIndex;
              const key = `${table.pos}:${columnIndex}`;
              const nextDirection: SortDirection =
                sortDirections.get(key) === 'asc' ? 'desc' : 'asc';

              if (!sortTableRowsByColumn(view, table.pos, columnIndex, nextDirection)) return false;

              sortDirections.set(key, nextDirection);
              event.preventDefault();
              event.stopPropagation();
              return true;
            },
          },
        },
      }),
    ];
  },
});
