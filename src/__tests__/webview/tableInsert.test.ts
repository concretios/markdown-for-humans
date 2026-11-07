/**
 * @jest-environment jsdom
 */

import type { Editor } from '@tiptap/core';
import {
  createTableInsertDialog,
  hideTableInsertDialog,
  showTableInsertDialog,
} from '../../webview/features/tableInsert';
import * as l10n from '../../webview/l10n';

const createMockEditor = () => {
  const insertTable = jest.fn(() => ({ run: jest.fn() }));
  const chain = jest.fn(() => ({
    focus: jest.fn(() => ({
      insertTable,
      run: jest.fn(),
    })),
  }));

  // Cast as unknown then Editor since we're using a partial mock
  return { editor: { chain } as unknown as Editor, insertTable };
};

afterEach(() => {
  hideTableInsertDialog();
  document.body.innerHTML = '';
});

describe('tableInsert dialog', () => {
  it('clamps oversized values and inserts table with header row', () => {
    const { editor, insertTable } = createMockEditor();

    showTableInsertDialog(editor);

    const colsInput = document.querySelector('#table-cols-input') as HTMLInputElement;
    const rowsInput = document.querySelector('#table-rows-input') as HTMLInputElement;
    const okButton = document.querySelector('#table-ok-btn') as HTMLButtonElement;

    colsInput.value = '15'; // above max 10
    rowsInput.value = '25'; // above max 20

    okButton.click();

    expect(insertTable).toHaveBeenCalledWith({ rows: 20, cols: 10, withHeaderRow: true });
    expect(document.querySelector('.export-settings-overlay')?.classList.contains('visible')).toBe(
      false
    );
  });

  it('keeps dialog open and focuses invalid input when value is non-numeric', () => {
    const { editor, insertTable } = createMockEditor();

    showTableInsertDialog(editor);

    const colsInput = document.querySelector('#table-cols-input') as HTMLInputElement;
    const okButton = document.querySelector('#table-ok-btn') as HTMLButtonElement;

    colsInput.value = 'abc'; // invalid
    okButton.click();

    expect(insertTable).not.toHaveBeenCalled();
    expect(document.querySelector('.export-settings-overlay')?.classList.contains('visible')).toBe(
      true
    );
    expect(document.activeElement).toBe(colsInput);
  });
});

describe('tableInsert dialog localization', () => {
  afterEach(() => {
    l10n.resetL10n();
  });

  it('shows English when no bundle is loaded', () => {
    const dialog = createTableInsertDialog();

    expect(dialog.getAttribute('aria-label')).toBe('Insert Table');
    expect(dialog.querySelector('.export-settings-overlay-title')?.textContent).toBe(
      'Insert Table'
    );
    expect(dialog.querySelector('#table-ok-btn')?.textContent?.trim()).toBe('OK');
  });

  it('shows the translated title, labels, buttons and tooltips', () => {
    l10n.configureL10n({
      'Insert Table': '插入表格',
      'Close dialog': '关闭对话框',
      'Close (Esc)': '关闭 (Esc)',
      Columns: '列数',
      Rows: '行数',
      Cancel: '取消',
    });

    const dialog = createTableInsertDialog();

    const close = dialog.querySelector('.export-settings-overlay-close') as HTMLElement;
    expect(dialog.getAttribute('aria-label')).toBe('插入表格');
    expect(dialog.querySelector('.export-settings-overlay-title')?.textContent).toBe('插入表格');
    expect(close.getAttribute('aria-label')).toBe('关闭对话框');
    expect(close.title).toBe('关闭 (Esc)');
    expect(dialog.querySelector('label[for="table-cols-input"]')?.textContent?.trim()).toBe('列数');
    expect(dialog.querySelector('label[for="table-rows-input"]')?.textContent?.trim()).toBe('行数');
    expect(dialog.querySelector('#table-cancel-btn')?.textContent?.trim()).toBe('取消');
    // Not in the bundle: falls back to English.
    expect(dialog.querySelector('#table-ok-btn')?.textContent?.trim()).toBe('OK');
  });
});
