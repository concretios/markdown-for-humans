/**
 * Copyright (c) 2025-2026 Concret.io
 *
 * Licensed under the MIT License. See LICENSE file in the project root for details.
 */

/**
 * Image Insert Dialog
 *
 * Provides a dialog for inserting images via:
 * - File picker (Choose Files button)
 * - Drag & drop zone
 * - Shows hints about all supported methods (copy/paste, drag-drop, file attach)
 */

import { Editor } from '@tiptap/core';
import {
  confirmImageDrop,
  getRememberedFolder,
  setRememberedFolder,
  getDefaultImagePath,
} from './imageConfirmation';
import { showHugeImageDialog, isHugeImage } from './hugeImageDialog';
import {
  isImageFile,
  insertImage,
  extractImagePathFromDataTransfer,
  hasImageFiles,
} from './imageDragDrop';

/**
 * VS Code API type
 */
interface VsCodeApi {
  readonly viewGeneration: string;
  postMessage: (message: unknown) => void;
}

/**
 * Show image insert dialog
 */
export async function showImageInsertDialog(editor: Editor, vscodeApi: VsCodeApi): Promise<void> {
  return new Promise(resolve => {
    // Create modal overlay
    const overlay = document.createElement('div');
    overlay.className = 'image-insert-dialog-overlay';
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
    dialog.className = 'image-insert-dialog';
    dialog.style.cssText = `
      background: var(--vscode-editor-background);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 6px;
      padding: 20px;
      min-width: 500px;
      max-width: 600px;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
    `;

    // Create hidden file input
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = 'image/*';
    fileInput.multiple = true;
    fileInput.style.display = 'none';

    let selectedFiles: File[] = [];
    let targetFolder = getRememberedFolder() || getDefaultImagePath();

    dialog.innerHTML = `
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px;">
        <h3 style="margin: 0; color: var(--vscode-foreground);">
          📷 Insert Image
        </h3>
        <button id="close-insert-dialog" style="
          background: transparent;
          border: none;
          color: var(--vscode-foreground);
          cursor: pointer;
          padding: 4px;
          font-size: 18px;
          line-height: 1;
          opacity: 0.7;
        ">×</button>
      </div>

      <div id="drop-zone" style="
        border: 2px dashed var(--vscode-panel-border);
        border-radius: 6px;
        padding: 40px;
        text-align: center;
        margin-bottom: 20px;
        background: var(--vscode-editorWidget-background);
        transition: all 0.2s;
        cursor: pointer;
      ">
        <div style="font-size: 48px; margin-bottom: 12px;">📁</div>
        <div style="color: var(--vscode-foreground); font-size: 14px; margin-bottom: 8px;">
          Drag & drop images here
        </div>
        <div style="color: var(--vscode-descriptionForeground); font-size: 12px;">
          or click to browse
        </div>
      </div>

      <div style="text-align: center; margin-bottom: 20px;">
        <span style="color: var(--vscode-descriptionForeground); font-size: 12px; margin: 0 12px;">OR</span>
      </div>

      <div style="margin-bottom: 20px;">
        <button id="choose-files-btn" style="
          width: 100%;
          padding: 10px 16px;
          background: var(--vscode-button-background);
          color: var(--vscode-button-foreground);
          border: none;
          border-radius: 4px;
          cursor: pointer;
          font-family: var(--vscode-font-family);
          font-size: 13px;
          font-weight: 500;
        ">📁 Choose Files...</button>
      </div>

      <div id="selected-files" style="display: none; margin-bottom: 20px;">
        <div style="font-size: 12px; color: var(--vscode-foreground); margin-bottom: 8px;">
          Selected: <span id="file-count"></span>
        </div>
        <div id="file-list" style="
          max-height: 150px;
          overflow-y: auto;
          padding: 8px;
          background: var(--vscode-editorWidget-background);
          border-radius: 4px;
          font-size: 11px;
          color: var(--vscode-descriptionForeground);
        "></div>
      </div>

      <div style="margin-bottom: 20px; padding-top: 16px; border-top: 1px solid var(--vscode-panel-border);">
        <div style="font-size: 12px; color: var(--vscode-foreground); margin-bottom: 8px;">
          💡 Tip: You can also do the following directly in the editor:
        </div>
        <div style="font-size: 11px; color: var(--vscode-descriptionForeground); line-height: 1.6;">
          • Copy & paste images (${navigator.platform.toLowerCase().includes('mac') ? 'Cmd' : 'Ctrl'}+V)<br>
          • Drag & drop from Finder/File Explorer<br>
          • Drag & drop from VS Code file explorer
        </div>
      </div>

      <div style="display: flex; gap: 8px; justify-content: flex-end;">
        <button id="cancel-insert" style="
          padding: 6px 14px;
          background: var(--vscode-button-secondaryBackground);
          color: var(--vscode-button-secondaryForeground);
          border: none;
          border-radius: 3px;
          cursor: pointer;
          font-family: var(--vscode-font-family);
        ">Cancel</button>
        <button id="insert-images" style="
          padding: 6px 14px;
          background: var(--vscode-button-background);
          color: var(--vscode-button-foreground);
          border: none;
          border-radius: 3px;
          cursor: pointer;
          font-family: var(--vscode-font-family);
          font-weight: 500;
          display: none;
        ">Insert Image<span id="insert-count"></span></button>
      </div>
    `;

    overlay.appendChild(dialog);
    document.body.appendChild(fileInput);
    document.body.appendChild(overlay);

    // Window-level drag blocker function to prevent browser from opening files
    // This must be defined before adding listeners
    const blockWindowDrop = (e: DragEvent) => {
      // Check if drag contains image files or workspace image paths
      if (hasImageFiles(e.dataTransfer) || extractImagePathFromDataTransfer(e.dataTransfer)) {
        e.preventDefault();
        // Don't stop propagation - let event reach element handlers
        if (e.dataTransfer) {
          e.dataTransfer.dropEffect = 'copy';
        }
      }
    };

    // Handle window drag leave
    const handleWindowDragLeave = (e: DragEvent) => {
      // Only reset if leaving window entirely
      if (e.relatedTarget === null) {
        // Could reset any global drag state here if needed
      }
    };

    // Add window-level listeners IMMEDIATELY when dialog opens
    // Use capture phase to intercept before browser default behavior
    window.addEventListener('dragover', blockWindowDrop, { capture: true });
    window.addEventListener('drop', blockWindowDrop, { capture: true });
    window.addEventListener('dragleave', handleWindowDragLeave, { capture: true });

    // Get elements
    const dropZone = dialog.querySelector('#drop-zone') as HTMLElement;
    const chooseFilesBtn = dialog.querySelector('#choose-files-btn') as HTMLButtonElement;
    const cancelBtn = dialog.querySelector('#cancel-insert') as HTMLButtonElement;
    const insertBtn = dialog.querySelector('#insert-images') as HTMLButtonElement;
    const closeBtn = dialog.querySelector('#close-insert-dialog') as HTMLButtonElement;
    const selectedFilesDiv = dialog.querySelector('#selected-files') as HTMLElement;
    const fileList = dialog.querySelector('#file-list') as HTMLElement;
    const fileCount = dialog.querySelector('#file-count') as HTMLElement;
    const insertCount = dialog.querySelector('#insert-count') as HTMLElement;

    // Update selected files display
    const updateSelectedFiles = (files: File[]) => {
      selectedFiles = files;
      if (files.length > 0) {
        selectedFilesDiv.style.display = 'block';
        insertBtn.style.display = 'block';
        fileCount.textContent = `${files.length} file${files.length > 1 ? 's' : ''}`;
        insertCount.textContent = files.length > 1 ? `s (${files.length})` : '';

        fileList.innerHTML = files
          .map((f, i) => `${i + 1}. ${f.name} (${(f.size / 1024).toFixed(1)} KB)`)
          .join('<br>');
      } else {
        selectedFilesDiv.style.display = 'none';
        insertBtn.style.display = 'none';
      }
    };

    // Handle file selection
    const handleFilesSelected = async (files: FileList | File[]) => {
      const imageFiles = Array.from(files).filter(isImageFile);

      if (imageFiles.length === 0) {
        // Show error for non-image files
        alert('Please select image files only.');
        return;
      }

      updateSelectedFiles(imageFiles);
    };

    // File picker button
    chooseFilesBtn.addEventListener('click', () => {
      fileInput.click();
    });

    fileInput.addEventListener('change', e => {
      const target = e.target as HTMLInputElement;
      if (target.files) {
        handleFilesSelected(target.files);
      }
    });

    // Drop zone handlers
    dropZone.addEventListener('click', () => {
      fileInput.click();
    });

    dropZone.addEventListener('dragover', e => {
      e.preventDefault();
      e.stopPropagation();
      dropZone.style.borderColor = 'var(--vscode-button-background)';
      dropZone.style.background = 'var(--vscode-list-hoverBackground)';
    });

    dropZone.addEventListener('dragleave', () => {
      dropZone.style.borderColor = 'var(--vscode-panel-border)';
      dropZone.style.background = 'var(--vscode-editorWidget-background)';
    });

    dropZone.addEventListener('drop', async e => {
      e.preventDefault();
      e.stopPropagation();
      dropZone.style.borderColor = 'var(--vscode-panel-border)';
      dropZone.style.background = 'var(--vscode-editorWidget-background)';

      const dt = e.dataTransfer;
      if (!dt) return;

      // Check for workspace image paths first (VS Code file explorer)
      // These come as text/uri-list or text/plain, not File objects
      const imagePath = extractImagePathFromDataTransfer(dt);
      if (imagePath) {
        // Close dialog
        handleCancel();

        // Clean up the path - could be file:// URI or absolute path
        let filePath = imagePath.trim();
        if (filePath.startsWith('file://')) {
          filePath = decodeURIComponent(filePath.replace('file://', ''));
        }

        // Extract filename from path (handle both / and \ separators)
        const fileName = filePath.split(/[/\\]/).pop() || 'image.png';

        // Send to extension to handle (will insert via insertWorkspaceImage)
        vscodeApi.postMessage({
          type: 'handleWorkspaceImage',
          sourcePath: filePath,
          fileName: fileName,
          insertPosition: editor.state.selection.from,
        });
        return;
      }

      // Otherwise, handle File objects (from desktop/finder)
      if (dt.files && dt.files.length > 0) {
        await handleFilesSelected(dt.files);
      }
    });

    // Cleanup function to remove window-level listeners
    const cleanupWindowListeners = () => {
      window.removeEventListener('dragover', blockWindowDrop, { capture: true });
      window.removeEventListener('drop', blockWindowDrop, { capture: true });
      window.removeEventListener('dragleave', handleWindowDragLeave, { capture: true });
    };

    // Insert images
    const handleInsert = async () => {
      if (selectedFiles.length === 0) return;

      // Get folder preference
      if (!targetFolder) {
        const options = await confirmImageDrop(selectedFiles.length, getDefaultImagePath());
        if (!options) {
          return; // User cancelled
        }
        targetFolder = options.targetFolder;
        if (options.rememberChoice) {
          setRememberedFolder(targetFolder);
        }
      }

      // Get cursor position
      const pos = editor.state.selection.from;

      // Process each file
      for (const file of selectedFiles) {
        // Check if huge image
        let resizeOptions: { width: number; height: number } | undefined;
        if (isHugeImage(file)) {
          const hugeImageOptions = await showHugeImageDialog(file);
          if (!hugeImageOptions) {
            continue; // User cancelled
          }

          if (
            hugeImageOptions.action === 'resize-suggested' &&
            hugeImageOptions.customWidth &&
            hugeImageOptions.customHeight
          ) {
            resizeOptions = {
              width: hugeImageOptions.customWidth,
              height: hugeImageOptions.customHeight,
            };
          } else if (hugeImageOptions.action === 'use-original') {
            resizeOptions = undefined;
          }
        }

        await insertImage(editor, file, vscodeApi, targetFolder, 'pasted', pos, resizeOptions);
      }

      // Clean up window listeners
      cleanupWindowListeners();

      // Close dialog
      document.body.removeChild(overlay);
      document.body.removeChild(fileInput);
      resolve();
    };

    insertBtn.addEventListener('click', handleInsert);

    // Cancel
    const handleCancel = () => {
      // Clean up window listeners
      cleanupWindowListeners();

      // Remove dialog elements
      document.body.removeChild(overlay);
      document.body.removeChild(fileInput);
      resolve();
    };

    cancelBtn.addEventListener('click', handleCancel);
    closeBtn.addEventListener('click', handleCancel);

    // Close on overlay click
    overlay.addEventListener('click', e => {
      if (e.target === overlay) {
        handleCancel();
      }
    });

    // Shared drop handler logic for both overlay and dialog
    const handleDropAnywhere = async (e: DragEvent) => {
      // Prevent default to stop browser from opening file
      e.preventDefault();
      e.stopPropagation();

      const dt = e.dataTransfer;
      if (!dt) return;

      // Check for workspace image paths first (VS Code file explorer)
      const imagePath = extractImagePathFromDataTransfer(dt);
      if (imagePath) {
        // Close dialog
        handleCancel();

        // Clean up the path - could be file:// URI or absolute path
        let filePath = imagePath.trim();
        if (filePath.startsWith('file://')) {
          filePath = decodeURIComponent(filePath.replace('file://', ''));
        }

        // Extract filename from path
        const fileName = filePath.split(/[/\\]/).pop() || 'image.png';

        // Send to extension to handle (will insert via insertWorkspaceImage)
        vscodeApi.postMessage({
          type: 'handleWorkspaceImage',
          sourcePath: filePath,
          fileName: fileName,
          insertPosition: editor.state.selection.from,
        });
        return;
      }

      // Otherwise, handle File objects (from desktop/finder/local folders)
      if (dt.files && dt.files.length > 0) {
        await handleFilesSelected(dt.files);
      }
    };

    // Overlay-level drag handlers to prevent default browser behavior
    // This prevents files from being opened when dragged over the overlay
    overlay.addEventListener('dragover', (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.dataTransfer) {
        e.dataTransfer.dropEffect = 'copy';
      }
    });

    overlay.addEventListener('drop', handleDropAnywhere);

    // Dialog-level drag handlers to handle drops on the dialog itself
    // (not just the dropZone or overlay background)
    dialog.addEventListener('dragover', (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.dataTransfer) {
        e.dataTransfer.dropEffect = 'copy';
      }
      // Show visual feedback on dropZone when dragging over dialog
      dropZone.style.borderColor = 'var(--vscode-button-background)';
      dropZone.style.background = 'var(--vscode-list-hoverBackground)';
    });

    dialog.addEventListener('dragleave', (e: DragEvent) => {
      // Only reset styling if leaving the dialog entirely
      if (!dialog.contains(e.relatedTarget as Node)) {
        dropZone.style.borderColor = 'var(--vscode-panel-border)';
        dropZone.style.background = 'var(--vscode-editorWidget-background)';
      }
    });

    dialog.addEventListener('drop', handleDropAnywhere);

    // Escape to close
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        handleCancel();
      }
    };
    document.addEventListener('keydown', handleEscape);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (overlay as any)._escapeHandler = handleEscape;
  });
}
