/** @jest-environment jsdom */

/**
 * Right-clicking a table cell must put the caret in that cell before the table
 * menu opens.
 *
 * The handler asked whether the table was active before the click had moved the
 * selection, so the first right-click from outside a table showed nothing. When
 * the caret sat in a different cell, the menu acted on that cell, not the one
 * the user clicked.
 */

import { Editor } from '@tiptap/core';
import { Markdown } from '@tiptap/markdown';
import StarterKit from '@tiptap/starter-kit';
import { TableCell, TableHeader, TableRow } from '@tiptap/extension-table';
import { CellSelection } from '@tiptap/pm/tables';
import { HtmlPreservingTable } from '../../webview/extensions/htmlPreservingTable';
import { MarkdownParagraph } from '../../webview/extensions/markdownParagraph';
import { selectTableCellAtTarget } from '../../webview/BubbleMenuView';
import { setMarkdownContentPreservingSource } from '../../webview/utils/markdownSerialization';

const DOC = 'Outside paragraph.\n\n| A | B |\n| --- | --- |\n| one | two |\n| three | four |';

function createEditor(): Editor {
  const element = document.createElement('div');
  document.body.appendChild(element);
  const editor = new Editor({
    element,
    extensions: [
      StarterKit.configure({ paragraph: false }),
      MarkdownParagraph,
      Markdown.configure({ markedOptions: { gfm: true } }),
      HtmlPreservingTable.configure({ resizable: false }),
      TableRow,
      TableHeader,
      TableCell,
    ],
    content: '',
    contentType: 'markdown',
  });
  setMarkdownContentPreservingSource(editor, DOC);
  return editor;
}

function cellContaining(editor: Editor, text: string): HTMLElement {
  const cell = [...editor.view.dom.querySelectorAll('td, th')].find(c => c.textContent === text);
  if (!cell) throw new Error(`No cell with text "${text}"`);
  return cell as HTMLElement;
}

function selectedCellText(editor: Editor): string | null {
  const { node } = editor.view.domAtPos(editor.state.selection.from);
  const el = node.nodeType === 3 ? node.parentElement : (node as HTMLElement);
  return el?.closest('td, th')?.textContent ?? null;
}

describe('selectTableCellAtTarget', () => {
  afterEach(() => document.body.replaceChildren());

  it('moves the caret into the cell when it starts outside the table', () => {
    const editor = createEditor();
    editor.commands.setTextSelection(3);
    expect(editor.isActive('table')).toBe(false);

    expect(selectTableCellAtTarget(editor, cellContaining(editor, 'one'))).toBe(true);

    expect(editor.isActive('table')).toBe(true);
    expect(selectedCellText(editor)).toBe('one');
    editor.destroy();
  });

  it('moves the caret to the clicked cell when it sits in another cell', () => {
    const editor = createEditor();
    selectTableCellAtTarget(editor, cellContaining(editor, 'one'));
    expect(selectedCellText(editor)).toBe('one');

    selectTableCellAtTarget(editor, cellContaining(editor, 'four'));

    expect(selectedCellText(editor)).toBe('four');
    editor.destroy();
  });

  it('leaves a text selection alone when it is already inside the clicked cell', () => {
    const editor = createEditor();
    selectTableCellAtTarget(editor, cellContaining(editor, 'three'));
    const start = editor.state.selection.from;
    editor.commands.setTextSelection({ from: start, to: start + 3 });
    const before = editor.state.selection.toJSON();

    selectTableCellAtTarget(editor, cellContaining(editor, 'three'));

    expect(editor.state.selection.toJSON()).toEqual(before);
    editor.destroy();
  });

  it('keeps a multi-cell selection when the click is inside it', () => {
    const editor = createEditor();
    const cellPos = (text: string): number => {
      let found = -1;
      editor.state.doc.descendants((node, pos) => {
        if (node.type.name.startsWith('table') && node.textContent === text && node.isBlock) {
          if (node.type.name === 'tableCell' || node.type.name === 'tableHeader') found = pos;
        }
      });
      return found;
    };
    const select = (): void => {
      editor.view.dispatch(
        editor.state.tr.setSelection(
          CellSelection.create(editor.state.doc, cellPos('one'), cellPos('four'))
        )
      );
    };
    for (const text of ['one', 'two', 'three', 'four']) {
      select();
      selectTableCellAtTarget(editor, cellContaining(editor, text));
      expect(editor.state.selection).toBeInstanceOf(CellSelection);
    }
    editor.destroy();
  });

  it('moves the selection when the click is on a cell outside a multi-cell selection', () => {
    const editor = createEditor();
    let one = -1;
    let two = -1;
    editor.state.doc.descendants((node, pos) => {
      if (node.type.name === 'tableCell' && node.textContent === 'one') one = pos;
      if (node.type.name === 'tableCell' && node.textContent === 'two') two = pos;
    });
    editor.view.dispatch(
      editor.state.tr.setSelection(CellSelection.create(editor.state.doc, one, two))
    );

    selectTableCellAtTarget(editor, cellContaining(editor, 'four'));

    expect(editor.state.selection).not.toBeInstanceOf(CellSelection);
    expect(selectedCellText(editor)).toBe('four');
    editor.destroy();
  });

  it('places the caret inside the cell paragraph, a valid text position', () => {
    const editor = createEditor();
    editor.commands.setTextSelection(3);

    selectTableCellAtTarget(editor, cellContaining(editor, 'one'));

    expect(editor.state.selection.$from.parent.inlineContent).toBe(true);
    editor.destroy();
  });

  it('does nothing and returns false outside a table', () => {
    const editor = createEditor();
    editor.commands.setTextSelection(3);
    const before = editor.state.selection.toJSON();
    const paragraph = editor.view.dom.querySelector('p') as HTMLElement;

    expect(selectTableCellAtTarget(editor, paragraph)).toBe(false);

    expect(editor.state.selection.toJSON()).toEqual(before);
    editor.destroy();
  });

  it('ignores a cell that is not part of this editor', () => {
    const editor = createEditor();
    const foreign = document.createElement('td');
    document.body.appendChild(foreign);

    expect(selectTableCellAtTarget(editor, foreign)).toBe(false);
    editor.destroy();
  });
});
