/**
 * Copyright (c) 2025-2026 Concret.io
 *
 * Licensed under the MIT License. See LICENSE file in the project root for details.
 */

/**
 * @file tableInsert.ts - Table insertion dialog UI
 * @description Provides a modal dialog for inserting tables with customizable rows and columns.
 */

import type { Editor } from '@tiptap/core';
import * as l10n from '../l10n';

/**
 * Table Insert Dialog state
 */
let tableDialogElement: HTMLElement | null = null;
let isVisible = false;
let currentEditor: Editor | null = null;

// Bounds for table dimensions
const MIN_COLS = 1;
const MAX_COLS = 10;
const MIN_ROWS = 1;
const MAX_ROWS = 20;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function focusEditor(editor: Editor | null) {
  try {
    const chain = editor?.chain?.();
    const maybeFocused = typeof chain?.focus === 'function' ? chain.focus() : chain;
    if (typeof maybeFocused?.run === 'function') {
      maybeFocused.run();
    }
  } catch (error) {
    console.warn('[MD4H] Failed to restore focus to editor after table dialog', error);
  }
}

/**
 * Create the Table Insert dialog element
 */
export function createTableInsertDialog(): HTMLElement {
  // Create overlay container
  const overlay = document.createElement('div');
  overlay.className = 'export-settings-overlay'; // Reuse existing overlay styles
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-label', l10n.t('Insert Table'));
  overlay.setAttribute('aria-modal', 'true');

  // Create backdrop
  const backdrop = document.createElement('div');
  backdrop.className = 'export-settings-overlay-backdrop';
  backdrop.onclick = () => hideTableInsertDialog();

  // Create content panel
  const panel = document.createElement('div');
  panel.className = 'export-settings-overlay-panel';
  panel.style.maxWidth = '400px';

  // Create header
  const header = document.createElement('div');
  header.className = 'export-settings-overlay-header';
  header.innerHTML = `
    <h2 class="export-settings-overlay-title">${l10n.html('Insert Table')}</h2>
    <button class="export-settings-overlay-close" aria-label="${l10n.html('Close dialog')}" title="${l10n.html('Close (Esc)')}">×</button>
  `;

  const closeBtn = header.querySelector('.export-settings-overlay-close') as HTMLElement;
  closeBtn.onclick = () => hideTableInsertDialog();

  // Create dialog content
  const content = document.createElement('div');
  content.className = 'export-settings-content';
  content.innerHTML = `
    <div class="export-settings-section table-insert-fields">
      <label class="export-settings-label" for="table-cols-input">
        ${l10n.html('Columns')}
        <input
          type="number"
          id="table-cols-input"
          class="export-settings-select table-insert-input"
          min="1"
          max="10"
          value="3"
        />
      </label>
      <label class="export-settings-label" for="table-rows-input">
        ${l10n.html('Rows')}
        <input
          type="number"
          id="table-rows-input"
          class="export-settings-select table-insert-input"
          min="1"
          max="20"
          value="4"
        />
      </label>
    </div>
    <div class="table-insert-actions">
      <button
        id="table-cancel-btn"
        class="export-settings-select"
        style="padding: 8px 24px; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: none; cursor: pointer; border-radius: 4px;"
      >
        ${l10n.html('Cancel')}
      </button>
      <button
        id="table-ok-btn"
        class="export-settings-select"
        style="padding: 8px 24px; background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; cursor: pointer; border-radius: 4px;"
      >
        ${l10n.html('OK')}
      </button>
    </div>
  `;

  // Handle button clicks
  const okBtn = content.querySelector('#table-ok-btn') as HTMLButtonElement;
  const cancelBtn = content.querySelector('#table-cancel-btn') as HTMLButtonElement;
  const colsInput = content.querySelector('#table-cols-input') as HTMLInputElement;
  const rowsInput = content.querySelector('#table-rows-input') as HTMLInputElement;

  okBtn.onclick = () => {
    const rawCols = parseInt(colsInput.value, 10);
    const rawRows = parseInt(rowsInput.value, 10);

    // Validate inputs and clamp to allowed range
    const validCols = Number.isInteger(rawCols) ? clamp(rawCols, MIN_COLS, MAX_COLS) : NaN;
    const validRows = Number.isInteger(rawRows) ? clamp(rawRows, MIN_ROWS, MAX_ROWS) : NaN;

    // If invalid, normalize to min and keep dialog open for correction
    if (!Number.isInteger(rawCols) || rawCols < MIN_COLS) {
      colsInput.value = String(MIN_COLS);
      colsInput.focus();
      return;
    }

    if (!Number.isInteger(rawRows) || rawRows < MIN_ROWS) {
      rowsInput.value = String(MIN_ROWS);
      rowsInput.focus();
      return;
    }

    const cols = clamp(validCols, MIN_COLS, MAX_COLS);
    const rows = clamp(validRows, MIN_ROWS, MAX_ROWS);
    colsInput.value = String(cols);
    rowsInput.value = String(rows);

    if (currentEditor && cols > 0 && rows > 0) {
      currentEditor.chain().focus().insertTable({ rows, cols, withHeaderRow: true }).run();
    }

    hideTableInsertDialog();
  };

  cancelBtn.onclick = () => hideTableInsertDialog();

  // Handle keyboard navigation
  overlay.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      hideTableInsertDialog();
    } else if (e.key === 'Enter' && (e.target === colsInput || e.target === rowsInput)) {
      e.preventDefault();
      okBtn.click();
    }
  });

  panel.appendChild(header);
  panel.appendChild(content);
  overlay.appendChild(backdrop);
  overlay.appendChild(panel);

  document.body.appendChild(overlay);
  tableDialogElement = overlay;

  return overlay;
}

/**
 * Show the Table Insert dialog
 */
export function showTableInsertDialog(editor: Editor): void {
  currentEditor = editor;

  if (!tableDialogElement) {
    createTableInsertDialog();
  }

  // Re-attach to DOM if it was removed (e.g., during tests)
  if (tableDialogElement && !document.body.contains(tableDialogElement)) {
    document.body.appendChild(tableDialogElement);
  }

  if (!tableDialogElement) return;

  // Show overlay
  tableDialogElement.classList.add('visible');
  isVisible = true;

  // Focus columns input
  requestAnimationFrame(() => {
    const colsInput = tableDialogElement?.querySelector('#table-cols-input') as HTMLInputElement;
    if (colsInput) {
      colsInput.select();
      colsInput.focus();
    }
  });
}

/**
 * Hide the Table Insert dialog
 */
export function hideTableInsertDialog(): void {
  const editorRef = currentEditor;

  if (!tableDialogElement) return;

  tableDialogElement.classList.remove('visible');
  isVisible = false;
  currentEditor = null;

  if (editorRef) {
    focusEditor(editorRef);
  }
}

/**
 * Check if Table Insert dialog is visible
 */
export function isTableInsertDialogVisible(): boolean {
  return isVisible;
}
