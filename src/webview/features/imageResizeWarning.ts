/**
 * Copyright (c) 2025-2026 Concret.io
 *
 * Licensed under the MIT License. See LICENSE file in the project root for details.
 */

/**
 * Image Resize Warning Dialog
 *
 * Shows a warning dialog before resizing an image, allowing users to:
 * - Confirm or cancel the resize operation
 * - Opt out of future warnings ("Never ask again")
 */

export interface ImageResizeWarningOptions {
  confirmed: boolean;
  neverAskAgain: boolean;
}

/**
 * Show warning dialog before resizing image
 * Returns null if user cancels, otherwise returns options
 */
export async function showImageResizeWarning(): Promise<ImageResizeWarningOptions | null> {
  return new Promise(resolve => {
    // Create modal overlay
    const overlay = document.createElement('div');
    overlay.className = 'image-resize-warning-overlay';
    overlay.style.cssText = `
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(0, 0, 0, 0.5);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 10000;
    `;

    // Create dialog
    const dialog = document.createElement('div');
    dialog.className = 'image-resize-warning-dialog';
    dialog.style.cssText = `
      background: var(--vscode-editor-background);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 6px;
      padding: 20px;
      min-width: 400px;
      max-width: 500px;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
    `;

    dialog.innerHTML = `
      <h3 style="margin: 0 0 16px 0; color: var(--vscode-foreground);">
        ⚠️ Resize Image
      </h3>

      <p style="margin: 0 0 20px 0; color: var(--vscode-foreground); line-height: 1.5;">
        Markdown Editor for Humans will reduce the resolution of this image to fit the size. This action cannot be undone, but a backup will be created.
      </p>

      <div style="margin-bottom: 20px;">
        <label style="display: flex; align-items: center; color: var(--vscode-foreground); cursor: pointer;">
          <input type="checkbox" id="never-ask-again" style="margin-right: 8px;">
          Never ask again
        </label>
      </div>

      <div style="display: flex; gap: 8px; justify-content: flex-end;">
        <button id="cancel-btn" style="
          padding: 6px 14px;
          background: var(--vscode-button-secondaryBackground);
          color: var(--vscode-button-secondaryForeground);
          border: none;
          border-radius: 3px;
          cursor: pointer;
          font-family: var(--vscode-font-family);
        ">Cancel</button>
        <button id="resize-btn" style="
          padding: 6px 14px;
          background: var(--vscode-button-background);
          color: var(--vscode-button-foreground);
          border: none;
          border-radius: 3px;
          cursor: pointer;
          font-family: var(--vscode-font-family);
          font-weight: 500;
        ">Resize</button>
      </div>
    `;

    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    // Get elements
    const neverAskAgainCheckbox = dialog.querySelector('#never-ask-again') as HTMLInputElement;
    const cancelBtn = dialog.querySelector('#cancel-btn') as HTMLButtonElement;
    const resizeBtn = dialog.querySelector('#resize-btn') as HTMLButtonElement;

    // Focus resize button (primary action)
    resizeBtn.focus();

    // Handle resize
    const handleResize = () => {
      const neverAskAgain = neverAskAgainCheckbox.checked;

      document.body.removeChild(overlay);
      resolve({
        confirmed: true,
        neverAskAgain,
      });
    };

    // Handle cancel
    const handleCancel = () => {
      document.body.removeChild(overlay);
      resolve(null);
    };

    // Event listeners
    resizeBtn.addEventListener('click', handleResize);
    cancelBtn.addEventListener('click', handleCancel);
    overlay.addEventListener('click', e => {
      if (e.target === overlay) handleCancel();
    });

    // Enter to resize, Escape to cancel
    dialog.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        e.preventDefault();
        handleResize();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        handleCancel();
      }
    });
  });
}
