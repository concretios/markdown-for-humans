/** @jest-environment jsdom */
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Table, TableCell, TableHeader, TableRow } from '@tiptap/extension-table';
import { feedbackTableScopes } from '../../webview/features/feedbackTableScopes';
import * as l10n from '../../webview/l10n';

describe('explicit table scopes', () => {
  let editor: Editor;
  afterEach(() => editor.destroy());
  it('offers a cell, its full row and column without changing the editor selection', () => {
    editor = new Editor({
      extensions: [StarterKit, Table, TableRow, TableHeader, TableCell],
      content: '<table><tr><th>A</th><th>B</th></tr><tr><td>C</td><td>D</td></tr></table>',
    });
    const selection = editor.state.selection;
    const choices = feedbackTableScopes(editor.state.doc, 4, {
      ordinal: 0,
      startLine: 1,
      endLine: 4,
    });
    expect(choices.map(choice => choice.scopeLabel)).toEqual([
      'Current cell',
      'Full row',
      'Full column',
    ]);
    expect(choices.map(choice => choice.cellTarget?.rectangle)).toEqual([
      { top: 0, left: 0, bottom: 1, right: 1 },
      { top: 0, left: 0, bottom: 1, right: 2 },
      { top: 0, left: 0, bottom: 2, right: 1 },
    ]);
    expect(editor.state.selection).toBe(selection);
  });
  it('does not offer exact rectangles for merged tables', () => {
    editor = new Editor({
      extensions: [StarterKit, Table, TableRow, TableHeader, TableCell],
      content: '<table><tr><th colspan="2">A</th></tr><tr><td>C</td><td>D</td></tr></table>',
    });
    expect(
      feedbackTableScopes(editor.state.doc, 4, { ordinal: 0, startLine: 1, endLine: 4 })
    ).toEqual([]);
  });
});

describe('explicit table scope localization', () => {
  let editor: Editor;
  afterEach(() => {
    editor.destroy();
    l10n.resetL10n();
  });
  it('translates the scope labels and keeps the stored focus as document text', () => {
    // Leaves out "Full column" on purpose, to exercise the fallback to English.
    l10n.configureL10n({ 'Current cell': 'Cellule actuelle', 'Full row': 'Ligne entière' });
    editor = new Editor({
      extensions: [StarterKit, Table, TableRow, TableHeader, TableCell],
      content: '<table><tr><th>A</th><th>B</th></tr><tr><td>C</td><td>D</td></tr></table>',
    });
    const choices = feedbackTableScopes(editor.state.doc, 4, {
      ordinal: 0,
      startLine: 1,
      endLine: 4,
    });
    expect(choices.map(choice => choice.scopeLabel)).toEqual([
      'Cellule actuelle',
      'Ligne entière',
      'Full column',
    ]);
    expect(choices.map(choice => choice.focus)).toEqual(['A', 'A\tB', 'A\nC']);
  });
});
