/**
 * Copyright (c) 2025-2026 Concret.io
 *
 * Licensed under the MIT License. See LICENSE file in the project root for details.
 */

/**
 * Mermaid Code Editor Modal
 *
 * Shows a modal dialog for editing mermaid diagram code, allowing users to:
 * - Edit code in a proper textarea (no key conflicts with TipTap)
 * - Save changes or cancel
 * - Escape key closes without saving
 */

import * as l10n from '../l10n';

interface MermaidEditResult {
  code: string;
  wasSaved: boolean;
}

/**
 * Show modal editor for mermaid code
 * Returns the edited code and whether it was saved
 */
export async function showMermaidEditor(initialCode: string): Promise<MermaidEditResult> {
  return new Promise(resolve => {
    // Create modal overlay
    const overlay = document.createElement('div');
    overlay.className = 'mermaid-editor-overlay';
    overlay.style.cssText = `
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(0, 0, 0, 0.6);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 10000;
    `;

    // Create dialog
    const dialog = document.createElement('div');
    dialog.className = 'mermaid-editor-dialog';
    dialog.style.cssText = `
      background: var(--vscode-editor-background);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 6px;
      padding: 0;
      width: clamp(60%, 70vw, 1100px);
      max-width: 90vw;
      min-width: 360px;
      height: clamp(60%, 70vh, 90vh);
      max-height: 90vh;
      min-height: 320px;
      display: flex;
      flex-direction: column;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
    `;

    // Header
    const header = document.createElement('div');
    header.style.cssText = `
      padding: 16px 20px;
      border-bottom: 1px solid var(--vscode-panel-border);
      display: flex;
      justify-content: space-between;
      align-items: center;
    `;
    header.innerHTML = `
      <h3 style="margin: 0; color: var(--vscode-foreground); font-size: 14px; font-weight: 600;">
        ${l10n.html('Edit Mermaid Diagram')}
      </h3>
      <button id="close-btn" style="
        background: none;
        border: none;
        color: var(--vscode-foreground);
        font-size: 24px;
        line-height: 1;
        cursor: pointer;
        padding: 0;
        width: 24px;
        height: 24px;
      " title="${l10n.html('Close (Esc)')}" aria-label="${l10n.html('Close')}">×</button>
    `;

    // Textarea
    const textarea = document.createElement('textarea');
    textarea.className = 'mermaid-editor-textarea';
    textarea.value = initialCode;
    textarea.style.cssText = `
      flex: 1;
      padding: 16px 20px;
      margin: 0;
      background: var(--vscode-editor-background);
      color: var(--vscode-editor-foreground);
      border: none;
      font-family: 'SF Mono', Monaco, 'Cascadia Code', 'Roboto Mono', Consolas, monospace;
      font-size: 13px;
      line-height: 1.6;
      resize: none;
      outline: none;
    `;

    // Footer with buttons
    const footer = document.createElement('div');
    footer.style.cssText = `
      padding: 12px 20px;
      border-top: 1px solid var(--vscode-panel-border);
      display: flex;
      gap: 8px;
      justify-content: flex-end;
      background: var(--vscode-editor-background);
    `;
    footer.innerHTML = `
      <button id="cancel-btn" style="
        padding: 6px 14px;
        background: var(--vscode-button-secondaryBackground);
        color: var(--vscode-button-secondaryForeground);
        border: none;
        border-radius: 3px;
        cursor: pointer;
        font-family: var(--vscode-font-family);
        font-size: 13px;
      ">${l10n.html('Cancel')}</button>
      <button id="save-btn" style="
        padding: 6px 14px;
        background: var(--vscode-button-background);
        color: var(--vscode-button-foreground);
        border: none;
        border-radius: 3px;
        cursor: pointer;
        font-family: var(--vscode-font-family);
        font-weight: 500;
        font-size: 13px;
      ">${l10n.html('Save')}</button>
    `;

    // Assemble dialog
    dialog.appendChild(header);
    dialog.appendChild(textarea);
    dialog.appendChild(footer);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    // Get button elements
    const closeBtn = header.querySelector('#close-btn') as HTMLButtonElement;
    const cancelBtn = footer.querySelector('#cancel-btn') as HTMLButtonElement;
    const saveBtn = footer.querySelector('#save-btn') as HTMLButtonElement;

    // Focus textarea
    setTimeout(() => {
      textarea.focus();
      textarea.setSelectionRange(0, 0); // Cursor at start
    }, 0);

    // Handle save
    const handleSave = () => {
      const code = textarea.value;
      document.body.removeChild(overlay);
      resolve({
        code,
        wasSaved: true,
      });
    };

    // Handle cancel
    const handleCancel = () => {
      document.body.removeChild(overlay);
      resolve({
        code: initialCode,
        wasSaved: false,
      });
    };

    // Event listeners
    saveBtn.addEventListener('click', handleSave);
    cancelBtn.addEventListener('click', handleCancel);
    closeBtn.addEventListener('click', handleCancel);

    // Click outside to cancel
    overlay.addEventListener('click', e => {
      if (e.target === overlay) handleCancel();
    });

    // Keyboard shortcuts
    overlay.addEventListener('keydown', e => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        handleCancel();
      } else if (e.key === 's' && (e.metaKey || e.ctrlKey)) {
        // Cmd/Ctrl+S to save
        e.preventDefault();
        e.stopPropagation();
        handleSave();
      }
    });
  });
}
