/**
 * Copyright (c) 2025-2026 Concret.io
 *
 * Licensed under the MIT License. See LICENSE file in the project root for details.
 */

/**
 * Local Image Outside Repo Dialog
 *
 * Shows a dialog when user tries to resize an image that's on the local filesystem
 * but outside the current workspace/repo. Offers two options:
 * 1. Edit in place (resize the original file)
 * 2. Copy to repo and edit (copy to user's chosen directory, then resize)
 */

import { getRememberedFolder, setRememberedFolder, getDefaultImagePath } from './imageConfirmation';

/**
 * Options for handling local image outside repo
 */
export interface LocalImageOutsideRepoOptions {
  action: 'edit-in-place' | 'copy-to-repo';
  targetFolder?: string; // Only used if action is 'copy-to-repo'
}

/**
 * Show dialog for local image outside repo
 */
export async function showLocalImageOutsideRepoDialog(
  imagePath: string,
  defaultFolder?: string
): Promise<LocalImageOutsideRepoOptions | null> {
  return new Promise(resolve => {
    // Check if we have a remembered folder preference
    const rememberedFolder = getRememberedFolder();
    const targetFolder = rememberedFolder || defaultFolder || getDefaultImagePath();

    // Create modal overlay
    const overlay = document.createElement('div');
    overlay.className = 'local-image-outside-repo-overlay';
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
    dialog.className = 'local-image-outside-repo-dialog';
    dialog.style.cssText = `
      background: var(--vscode-editor-background);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 6px;
      padding: 20px;
      min-width: 450px;
      max-width: 550px;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
    `;

    dialog.innerHTML = `
      <div style="display: flex; align-items: center; margin-bottom: 16px;">
        <span style="font-size: 24px; margin-right: 12px;">📁</span>
        <h3 style="margin: 0; color: var(--vscode-foreground);">
          Image Outside Workspace
        </h3>
      </div>

      <p style="margin: 0 0 16px 0; color: var(--vscode-foreground); line-height: 1.5;">
        This image is on your local disk but outside the current workspace. How would you like to proceed?
      </p>

      <div style="margin-bottom: 12px; padding: 8px; background: var(--vscode-textBlockQuote-background); border-left: 3px solid var(--vscode-textBlockQuote-border); border-radius: 3px;">
        <div style="font-size: 11px; color: var(--vscode-descriptionForeground); margin-bottom: 4px;">Image Path:</div>
        <div id="local-image-path" style="font-size: 12px; color: var(--vscode-foreground); word-break: break-all; font-family: var(--vscode-editor-font-family, monospace);"></div>
      </div>

      <div style="margin-bottom: 20px;">
        <label style="display: flex; align-items: flex-start; padding: 12px; border: 1px solid var(--vscode-panel-border); border-radius: 4px; margin-bottom: 8px; cursor: pointer; background: var(--vscode-list-hoverBackground);">
          <input type="radio" name="local-image-action" value="edit-in-place" checked style="margin-right: 12px; margin-top: 2px;">
          <div style="flex: 1;">
            <div style="font-weight: 500; color: var(--vscode-foreground); margin-bottom: 4px;">Edit in Place</div>
            <div style="font-size: 11px; color: var(--vscode-descriptionForeground);">
              Resize the original image file directly. The image will be modified at its current location.
            </div>
          </div>
        </label>

        <label style="display: flex; align-items: flex-start; padding: 12px; border: 1px solid var(--vscode-panel-border); border-radius: 4px; cursor: pointer;">
          <input type="radio" name="local-image-action" value="copy-to-repo" style="margin-right: 12px; margin-top: 2px;">
          <div style="flex: 1;">
            <div style="font-weight: 500; color: var(--vscode-foreground); margin-bottom: 4px;">Copy to Workspace & Edit</div>
            <div style="font-size: 11px; color: var(--vscode-descriptionForeground); margin-bottom: 8px;">
              Copy the image to your workspace first, then resize it. The original file remains unchanged.
            </div>
            <div id="copy-folder-input-container" style="display: none; margin-top: 8px;">
              <input
                type="text"
                id="copy-image-folder-input"
                style="
                  width: 100%;
                  padding: 6px 8px;
                  background: var(--vscode-input-background);
                  color: var(--vscode-input-foreground);
                  border: 1px solid var(--vscode-input-border);
                  border-radius: 3px;
                  font-family: var(--vscode-font-family);
                  font-size: 12px;
                "
                placeholder="e.g., images, assets/img"
              />
              <small style="display: block; margin-top: 4px; color: var(--vscode-descriptionForeground); font-size: 11px;">
                Relative to current markdown file
              </small>
            </div>
          </div>
        </label>
      </div>

      <div style="margin-bottom: 20px;">
        <label style="display: flex; align-items: center; color: var(--vscode-foreground); cursor: pointer;">
          <input type="checkbox" id="remember-local-choice" style="margin-right: 8px;">
          Remember for this session
        </label>
      </div>

      <div style="display: flex; gap: 8px; justify-content: flex-end;">
        <button id="cancel-local-image" style="
          padding: 6px 14px;
          background: var(--vscode-button-secondaryBackground);
          color: var(--vscode-button-secondaryForeground);
          border: none;
          border-radius: 3px;
          cursor: pointer;
          font-family: var(--vscode-font-family);
        ">Cancel</button>
        <button id="confirm-local-image" style="
          padding: 6px 14px;
          background: var(--vscode-button-background);
          color: var(--vscode-button-foreground);
          border: none;
          border-radius: 3px;
          cursor: pointer;
          font-family: var(--vscode-font-family);
          font-weight: 500;
        ">Continue</button>
      </div>
    `;

    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    // Get elements
    const editInPlaceRadio = dialog.querySelector(
      'input[value="edit-in-place"]'
    ) as HTMLInputElement;
    const copyToRepoRadio = dialog.querySelector('input[value="copy-to-repo"]') as HTMLInputElement;
    const copyFolderContainer = dialog.querySelector('#copy-folder-input-container') as HTMLElement;
    const copyFolderInput = dialog.querySelector('#copy-image-folder-input') as HTMLInputElement;
    // Host path and folder are file-system/settings text, never markup.
    (dialog.querySelector('#local-image-path') as HTMLElement).textContent = imagePath;
    copyFolderInput.value = targetFolder;
    const rememberCheckbox = dialog.querySelector('#remember-local-choice') as HTMLInputElement;
    const cancelBtn = dialog.querySelector('#cancel-local-image') as HTMLButtonElement;
    const confirmBtn = dialog.querySelector('#confirm-local-image') as HTMLButtonElement;

    // Show/hide folder input based on selection
    const updateFolderInputVisibility = () => {
      if (copyToRepoRadio.checked) {
        copyFolderContainer.style.display = 'block';
        copyFolderInput.focus();
      } else {
        copyFolderContainer.style.display = 'none';
      }
    };

    editInPlaceRadio.addEventListener('change', updateFolderInputVisibility);
    copyToRepoRadio.addEventListener('change', updateFolderInputVisibility);

    // Handle confirm
    const handleConfirm = () => {
      const action = editInPlaceRadio.checked ? 'edit-in-place' : 'copy-to-repo';
      const folder = copyToRepoRadio.checked
        ? copyFolderInput.value.trim() || defaultFolder
        : undefined;
      const remember = rememberCheckbox.checked;

      if (remember && folder) {
        setRememberedFolder(folder);
      }

      document.body.removeChild(overlay);
      resolve({
        action: action as 'edit-in-place' | 'copy-to-repo',
        targetFolder: folder,
      });
    };

    // Handle cancel
    const handleCancel = () => {
      document.body.removeChild(overlay);
      resolve(null);
    };

    // Event listeners
    confirmBtn.addEventListener('click', handleConfirm);
    cancelBtn.addEventListener('click', handleCancel);
    overlay.addEventListener('click', e => {
      if (e.target === overlay) handleCancel();
    });

    // Enter to confirm, Escape to cancel
    dialog.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        e.preventDefault();
        handleConfirm();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        handleCancel();
      }
    });
  });
}
