/**
 * Copyright (c) 2025-2026 Concret.io
 *
 * Licensed under the MIT License. See LICENSE file in the project root for details.
 */

/**
 * Image Resize Modal
 *
 * Shows a sticky modal dialog at bottom-right for resizing images.
 * Features:
 * - Transparent glass-like appearance
 * - Live preview as user changes width/height
 * - Sticky positioning (stays at bottom-right)
 */

import { Editor } from '@tiptap/core';
import { showImageResizeWarning } from './imageResizeWarning';
import { showLocalImageOutsideRepoDialog } from './localImageOutsideRepoDialog';
import { getDefaultImagePath } from './imageConfirmation';

/**
 * VS Code API type
 */
interface VsCodeApi {
  postMessage: (message: unknown) => void;
}

type WorkspaceCheckResult = { inWorkspace: boolean; absolutePath?: string };

/**
 * Resize history entry for undo/redo
 */
interface ResizeHistoryEntry {
  timestamp: string;
  backupPath: string;
  originalWidth: number;
  originalHeight: number;
  newWidth: number;
  newHeight: number;
  imageData: string; // base64 data URL
}

/**
 * Resize state for an image
 */
interface ImageResizeState {
  img: HTMLImageElement;
  originalWidth: number;
  originalHeight: number;
  history: ResizeHistoryEntry[];
  historyIndex: number; // Current position in history (-1 = no history)
}

/**
 * Map of image elements to their resize state
 */
const imageResizeStates = new WeakMap<HTMLImageElement, ImageResizeState>();

/**
 * Current modal state
 */
let currentModal: HTMLElement | null = null;
let currentImage: HTMLImageElement | null = null;
let currentVscodeApi: VsCodeApi | null = null;

/**
 * Check if image source is external (http/https URL)
 */
export function isExternalImage(src: string): boolean {
  if (!src) return false;
  return src.startsWith('http://') || src.startsWith('https://');
}

/**
 * Get or create resize state for an image
 */
function getResizeState(img: HTMLImageElement): ImageResizeState {
  let state = imageResizeStates.get(img);
  if (!state) {
    state = {
      img,
      originalWidth: img.naturalWidth || img.width,
      originalHeight: img.naturalHeight || img.height,
      history: [],
      historyIndex: -1,
    };
    imageResizeStates.set(img, state);
  }
  return state;
}

/**
 * Resize image using canvas
 */
async function resizeImageWithCanvas(
  img: HTMLImageElement,
  targetWidth: number,
  targetHeight: number
): Promise<string> {
  return new Promise((resolve, reject) => {
    // Ensure image is loaded
    if (!img.complete || !img.naturalWidth || !img.naturalHeight) {
      // Wait for image to load
      img.addEventListener(
        'load',
        () => {
          try {
            const canvas = document.createElement('canvas');
            canvas.width = targetWidth;
            canvas.height = targetHeight;
            const ctx = canvas.getContext('2d');

            if (!ctx) {
              reject(new Error('Failed to get canvas context'));
              return;
            }

            // Draw resized image
            ctx.drawImage(img, 0, 0, targetWidth, targetHeight);

            // Convert to data URL
            const dataUrl = canvas.toDataURL('image/png', 0.92);
            resolve(dataUrl);
          } catch (error) {
            reject(error);
          }
        },
        { once: true }
      );

      // Also handle error case
      img.addEventListener(
        'error',
        () => {
          reject(new Error('Image failed to load'));
        },
        { once: true }
      );
      return;
    }

    // Image is already loaded
    try {
      const canvas = document.createElement('canvas');
      canvas.width = targetWidth;
      canvas.height = targetHeight;
      const ctx = canvas.getContext('2d');

      if (!ctx) {
        reject(new Error('Failed to get canvas context'));
        return;
      }

      // Draw resized image
      ctx.drawImage(img, 0, 0, targetWidth, targetHeight);

      // Convert to data URL
      const dataUrl = canvas.toDataURL('image/png', 0.92);
      resolve(dataUrl);
    } catch (error) {
      reject(error);
    }
  });
}

/**
 * Copy local image (outside workspace) to workspace
 */
async function copyLocalImageToWorkspace(
  absolutePath: string,
  targetFolder: string,
  vscodeApi: VsCodeApi
): Promise<string | null> {
  try {
    // Generate placeholder ID
    const placeholderId = `copy-img-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

    // Send to extension to copy
    vscodeApi.postMessage({
      type: 'copyLocalImageToWorkspace',
      absolutePath,
      placeholderId,
      targetFolder,
    });

    // Return placeholder ID to track this copy
    return placeholderId;
  } catch (error) {
    console.error('[MD4H] Failed to copy local image:', error);
    return null;
  }
}

/**
 * Show resize modal for an image
 */
export async function showImageResizeModal(
  img: HTMLImageElement,
  editor: Editor,
  vscodeApi: VsCodeApi
): Promise<void> {
  // Close existing modal if open
  if (currentModal) {
    hideImageResizeModal();
  }

  // Check if image is external (HTTP/HTTPS URL)
  // Only check data-markdown-src (original markdown path), not the resolved src
  // The resolved src will be vscode-webview:// for local images, which is not external
  const imageSrc = img.getAttribute('data-markdown-src') || img.getAttribute('src') || '';

  // External = only HTTP/HTTPS URLs
  const isExternal = isExternalImage(imageSrc);

  if (isExternal) {
    console.log('[MD4H] External image detected, cannot resize:', imageSrc);

    // Show info message - cannot resize external images
    vscodeApi.postMessage({
      type: 'showError',
      message:
        'Cannot resize external images. Please download the image to your workspace first, then you can resize it.',
    });
    return;
  }

  const checkImageInWorkspace = async (
    pathToCheck: string,
    timeoutMs: number = 1500
  ): Promise<WorkspaceCheckResult> => {
    const requestId = `check-ws-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const callbacks: Map<string, (result: WorkspaceCheckResult) => void> =
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ((window as any)._workspaceCheckCallbacks as
        | Map<string, (result: WorkspaceCheckResult) => void>
        | undefined) ?? new Map();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any)._workspaceCheckCallbacks = callbacks;

    return new Promise(resolve => {
      let settled = false;

      const settle = (result: WorkspaceCheckResult) => {
        if (settled) return;
        settled = true;
        callbacks.delete(requestId);
        resolve(result);
      };

      const timer = window.setTimeout(() => {
        console.warn('[MD4H] checkImageInWorkspace timed out; showing resize modal anyway');
        settle({ inWorkspace: true });
      }, timeoutMs);

      callbacks.set(requestId, result => {
        clearTimeout(timer);
        settle(result);
      });

      try {
        vscodeApi.postMessage({
          type: 'checkImageInWorkspace',
          imagePath: pathToCheck,
          requestId,
        });
      } catch (error) {
        clearTimeout(timer);
        console.error('[MD4H] Failed to post checkImageInWorkspace:', error);
        settle({ inWorkspace: true });
      }
    });
  };

  // Check if image is local but outside workspace
  // Send message to extension to check if image is in workspace
  const workspaceCheck = await checkImageInWorkspace(imageSrc);

  // If image is outside workspace, show dialog with options
  if (!workspaceCheck.inWorkspace && workspaceCheck.absolutePath) {
    const localOptions = await showLocalImageOutsideRepoDialog(
      workspaceCheck.absolutePath,
      getDefaultImagePath()
    );
    if (!localOptions) {
      return; // User cancelled
    }

    if (localOptions.action === 'copy-to-repo') {
      // Copy image to workspace first, then resize
      const placeholderId = await copyLocalImageToWorkspace(
        workspaceCheck.absolutePath,
        localOptions.targetFolder || getDefaultImagePath(),
        vscodeApi
      );

      if (!placeholderId) {
        return; // Copy failed
      }

      // Store placeholder ID and image reference for when copy completes
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (img as any)._pendingDownloadPlaceholderId = placeholderId;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (img as any)._pendingResizeAfterDownload = true;
      return;
    } else {
      // Edit in place - resize the original file directly
      // We'll use the absolute path for resize
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (img as any)._absolutePath = workspaceCheck.absolutePath;
      showResizeModalForLocalImage(img, editor, vscodeApi);
      return;
    }
  }

  // For local images in workspace, show resize modal directly
  showResizeModalForLocalImage(img, editor, vscodeApi);
}

/**
 * Show resize modal for a local image (internal helper)
 */
function showResizeModalForLocalImage(
  img: HTMLImageElement,
  editor: Editor,
  vscodeApi: VsCodeApi
): void {
  void editor; // reserved for future editor-aware behaviors
  currentImage = img;
  currentVscodeApi = vscodeApi;

  // Prime resize state for this image
  getResizeState(img);
  const originalWidth = img.naturalWidth || img.width;
  const originalHeight = img.naturalHeight || img.height;

  // Create modal overlay (transparent, for glass effect)
  const overlay = document.createElement('div');
  overlay.className = 'image-resize-modal-overlay';
  overlay.style.cssText = `
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: transparent;
    pointer-events: none;
    z-index: 150;
  `;

  // Create modal panel (sticky bottom-right)
  const panel = document.createElement('div');
  panel.className = 'image-resize-modal-panel';
  panel.style.cssText = `
    position: fixed;
    bottom: 20px;
    right: 20px;
    width: 320px;
    background: var(--vscode-editor-background);
    border: 1px solid var(--vscode-panel-border);
    border-radius: 8px;
    padding: 16px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.3);
    backdrop-filter: blur(20px);
    opacity: 0.95;
    z-index: 200;
    pointer-events: auto;
  `;

  const aspectRatio = originalWidth / originalHeight;

  panel.innerHTML = `
    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px;">
      <h3 style="margin: 0; color: var(--vscode-foreground); font-size: 14px; font-weight: 600;">
        Resize Image
      </h3>
      <button id="close-resize-modal" style="
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

    <div id="resize-impact" style="
      margin: -6px 0 10px 0;
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
      line-height: 1.4;
    ">
      <div id="resize-impact-loading">Checking references…</div>
      <div id="resize-impact-content" style="display: none;">
        <div id="resize-impact-other-files" style="display: none;">
          Referenced in
          <button
            id="resize-references-pill"
            type="button"
            aria-expanded="false"
            style="
              display: inline-flex;
              align-items: center;
              justify-content: center;
              min-width: 26px;
              padding: 0 8px;
              height: 18px;
              margin: 0 4px;
              border-radius: 999px;
              border: 1px solid var(--vscode-button-background);
              background: transparent;
              color: var(--vscode-foreground);
              cursor: pointer;
              font-size: 11px;
              line-height: 1;
            "
          >0</button>
          other file<span id="resize-references-plural">s</span>
        </div>
        <div id="resize-impact-current-file" style="display: none;">
          Also used <span id="resize-current-count">0</span> times in this file
        </div>
      </div>
    </div>

    <div id="resize-backup-note" style="
      margin: 0 0 12px 0;
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
    ">
      A backup of the original will be saved to <code style="font-size: 11px;">.md4h/image-backups/</code>
    </div>

    <div
      id="resize-references-popover"
      style="
        display: none;
        position: absolute;
        z-index: 300;
        min-width: 280px;
        max-width: 360px;
        max-height: 240px;
        overflow: auto;
        background: var(--vscode-editor-background);
        border: 1px solid var(--vscode-panel-border);
        border-radius: 8px;
        box-shadow: 0 10px 32px rgba(0, 0, 0, 0.35);
        padding: 10px;
      "
    ></div>

    <div style="margin-bottom: 12px;">
      <label style="display: block; margin-bottom: 6px; color: var(--vscode-foreground); font-size: 12px;">
        Width (px)
      </label>
      <input
        type="number"
        id="resize-width-input"
        value="${originalWidth}"
        min="1"
        style="
          width: 100%;
          padding: 6px 8px;
          background: var(--vscode-input-background);
          color: var(--vscode-input-foreground);
          border: 1px solid var(--vscode-input-border);
          border-radius: 4px;
          font-family: var(--vscode-font-family);
          font-size: 13px;
        "
      />
    </div>

    <div style="margin-bottom: 12px;">
      <label style="display: block; margin-bottom: 6px; color: var(--vscode-foreground); font-size: 12px;">
        Height (px)
      </label>
      <input
        type="number"
        id="resize-height-input"
        value="${originalHeight}"
        min="1"
        style="
          width: 100%;
          padding: 6px 8px;
          background: var(--vscode-input-background);
          color: var(--vscode-input-foreground);
          border: 1px solid var(--vscode-input-border);
          border-radius: 4px;
          font-family: var(--vscode-font-family);
          font-size: 13px;
        "
      />
    </div>

    <div style="margin-bottom: 16px; display: flex; gap: 8px;">
      <button id="reset-resize" style="
        flex: 1;
        padding: 6px 12px;
        background: var(--vscode-button-secondaryBackground);
        color: var(--vscode-button-secondaryForeground);
        border: none;
        border-radius: 4px;
        cursor: pointer;
        font-family: var(--vscode-font-family);
        font-size: 12px;
      ">Reset</button>
      <button id="cancel-resize" style="
        flex: 1;
        padding: 6px 12px;
        background: var(--vscode-button-secondaryBackground);
        color: var(--vscode-button-secondaryForeground);
        border: none;
        border-radius: 4px;
        cursor: pointer;
        font-family: var(--vscode-font-family);
        font-size: 12px;
      ">Cancel</button>
      <button id="confirm-resize" style="
        flex: 1;
        padding: 6px 12px;
        background: var(--vscode-button-background);
        color: var(--vscode-button-foreground);
        border: none;
        border-radius: 4px;
        cursor: pointer;
        font-family: var(--vscode-font-family);
        font-size: 12px;
        font-weight: 500;
      ">Resize</button>
    </div>
  `;

  overlay.appendChild(panel);
  document.body.appendChild(overlay);
  currentModal = overlay;

  // Get input elements
  const widthInput = panel.querySelector('#resize-width-input') as HTMLInputElement;
  const heightInput = panel.querySelector('#resize-height-input') as HTMLInputElement;
  const resetBtn = panel.querySelector('#reset-resize') as HTMLButtonElement;
  const cancelBtn = panel.querySelector('#cancel-resize') as HTMLButtonElement;
  const confirmBtn = panel.querySelector('#confirm-resize') as HTMLButtonElement;
  const closeBtn = panel.querySelector('#close-resize-modal') as HTMLButtonElement;

  const impactRoot = panel.querySelector('#resize-impact') as HTMLElement;
  const impactLoading = panel.querySelector('#resize-impact-loading') as HTMLElement;
  const impactContent = panel.querySelector('#resize-impact-content') as HTMLElement;
  const impactOtherFilesRow = panel.querySelector('#resize-impact-other-files') as HTMLElement;
  const referencesPill = panel.querySelector('#resize-references-pill') as HTMLButtonElement;
  const referencesPlural = panel.querySelector('#resize-references-plural') as HTMLElement;
  const impactCurrentFileRow = panel.querySelector('#resize-impact-current-file') as HTMLElement;
  const currentCount = panel.querySelector('#resize-current-count') as HTMLElement;
  const referencesPopover = panel.querySelector('#resize-references-popover') as HTMLElement;

  // Add error message element for upscaling
  const errorContainer = document.createElement('div');
  errorContainer.id = 'resize-error-message';
  errorContainer.style.cssText = `
    color: var(--vscode-errorForeground);
    font-size: 11px;
    margin-top: 4px;
    display: none;
  `;
  widthInput.parentElement?.appendChild(errorContainer);

  // Track if aspect ratio lock is enabled (default: true)
  const lockAspectRatio = true;

  type ReferenceRow = { fsPath: string; matches: Array<{ line: number; text: string }> };
  type ReferencePayload = {
    currentFileCount: number;
    otherFiles: ReferenceRow[];
    error?: string;
  };

  let referencePayload: ReferencePayload | null = null;
  let isReferencesPopoverOpen = false;

  const closeReferencesPopover = () => {
    referencesPopover.style.display = 'none';
    referencesPill.setAttribute('aria-expanded', 'false');
    isReferencesPopoverOpen = false;
  };

  const renderReferencesPopover = (payload: ReferencePayload) => {
    referencesPopover.replaceChildren();

    const header = document.createElement('div');
    header.style.cssText = `
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 8px;
      gap: 8px;
    `;

    const title = document.createElement('div');
    title.textContent = 'Referenced in other files';
    title.style.cssText = `
      font-size: 12px;
      font-weight: 600;
      color: var(--vscode-foreground);
    `;

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.textContent = '×';
    closeBtn.style.cssText = `
      background: transparent;
      border: none;
      color: var(--vscode-foreground);
      cursor: pointer;
      padding: 2px 6px;
      font-size: 16px;
      line-height: 1;
      opacity: 0.7;
    `;
    closeBtn.addEventListener('click', e => {
      e.preventDefault();
      e.stopPropagation();
      closeReferencesPopover();
    });

    header.appendChild(title);
    header.appendChild(closeBtn);
    referencesPopover.appendChild(header);

    if (!payload.otherFiles || payload.otherFiles.length === 0) {
      const empty = document.createElement('div');
      empty.textContent = 'No other references found.';
      empty.style.cssText = `
        font-size: 12px;
        color: var(--vscode-descriptionForeground);
      `;
      referencesPopover.appendChild(empty);
      return;
    }

    for (const fileRef of payload.otherFiles) {
      const firstMatch = fileRef.matches?.[0];
      const firstLine = typeof firstMatch?.line === 'number' ? firstMatch.line + 1 : 1;
      const additional =
        (fileRef.matches?.length ?? 0) > 1 ? ` (+${fileRef.matches.length - 1} more)` : '';

      const row = document.createElement('div');
      row.style.cssText = `
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 10px;
        padding: 8px 6px;
        border-radius: 6px;
      `;
      row.addEventListener('mouseenter', () => {
        row.style.background = 'var(--vscode-list-hoverBackground)';
      });
      row.addEventListener('mouseleave', () => {
        row.style.background = 'transparent';
      });

      const left = document.createElement('div');
      left.style.cssText = `
        min-width: 0;
        flex: 1;
      `;

      const pathLabel = document.createElement('div');
      pathLabel.textContent = fileRef.fsPath;
      pathLabel.style.cssText = `
        font-size: 12px;
        color: var(--vscode-foreground);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      `;
      pathLabel.title = fileRef.fsPath;

      const meta = document.createElement('div');
      meta.textContent = `Line ${firstLine}${additional}`;
      meta.style.cssText = `
        margin-top: 2px;
        font-size: 11px;
        color: var(--vscode-descriptionForeground);
      `;

      left.appendChild(pathLabel);
      left.appendChild(meta);

      const actions = document.createElement('div');
      actions.style.cssText = `
        display: flex;
        gap: 6px;
        flex-shrink: 0;
      `;

      const makeActionButton = (label: string) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = label;
        btn.style.cssText = `
          padding: 2px 8px;
          font-size: 11px;
          background: var(--vscode-button-secondaryBackground);
          color: var(--vscode-button-secondaryForeground);
          border: none;
          border-radius: 4px;
          cursor: pointer;
          white-space: nowrap;
        `;
        return btn;
      };

      const openBtn = makeActionButton('Open');
      openBtn.addEventListener('click', e => {
        e.preventDefault();
        e.stopPropagation();
        vscodeApi.postMessage({
          type: 'openFileAtLocation',
          fsPath: fileRef.fsPath,
          line: firstLine,
          openToSide: false,
        });
      });

      const openSideBtn = makeActionButton('Side');
      openSideBtn.addEventListener('click', e => {
        e.preventDefault();
        e.stopPropagation();
        vscodeApi.postMessage({
          type: 'openFileAtLocation',
          fsPath: fileRef.fsPath,
          line: firstLine,
          openToSide: true,
        });
      });

      actions.appendChild(openBtn);
      actions.appendChild(openSideBtn);

      row.appendChild(left);
      row.appendChild(actions);
      referencesPopover.appendChild(row);
    }
  };

  const openReferencesPopover = () => {
    if (!referencePayload || referencePayload.otherFiles.length === 0) {
      return;
    }

    renderReferencesPopover(referencePayload);

    const pillRect = referencesPill.getBoundingClientRect();
    const panelRect = panel.getBoundingClientRect();
    const left = Math.max(8, Math.min(pillRect.left - panelRect.left, panelRect.width - 280));
    const top = pillRect.bottom - panelRect.top + 8;
    referencesPopover.style.left = `${left}px`;
    referencesPopover.style.top = `${top}px`;

    referencesPopover.style.display = 'block';
    referencesPill.setAttribute('aria-expanded', 'true');
    isReferencesPopoverOpen = true;
  };

  const toggleReferencesPopover = () => {
    if (isReferencesPopoverOpen) {
      closeReferencesPopover();
      return;
    }
    openReferencesPopover();
  };

  // Start hidden until references arrive.
  impactOtherFilesRow.style.display = 'none';
  impactCurrentFileRow.style.display = 'none';
  impactContent.style.display = 'none';
  referencesPopover.style.display = 'none';

  referencesPill.addEventListener('click', e => {
    e.preventDefault();
    e.stopPropagation();
    toggleReferencesPopover();
  });

  panel.addEventListener('click', e => {
    if (!isReferencesPopoverOpen) {
      return;
    }
    const target = e.target as Node | null;
    if (!target) {
      closeReferencesPopover();
      return;
    }
    if (referencesPopover.contains(target) || referencesPill.contains(target)) {
      return;
    }
    closeReferencesPopover();
  });

  // Request references once per modal open.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const absolutePath = (img as any)._absolutePath;
  const imagePathForReferences =
    absolutePath || img.getAttribute('data-markdown-src') || img.getAttribute('src') || '';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const getImageReferences = (window as any).getImageReferences as
    | ((path: string) => Promise<unknown>)
    | undefined;

  if (typeof getImageReferences === 'function' && imagePathForReferences) {
    getImageReferences(imagePathForReferences)
      .then(result => {
        const payload = result as Partial<ReferencePayload>;
        referencePayload = {
          currentFileCount:
            typeof payload.currentFileCount === 'number' ? payload.currentFileCount : 0,
          otherFiles: Array.isArray(payload.otherFiles)
            ? (payload.otherFiles as ReferenceRow[])
            : [],
          error: typeof payload.error === 'string' ? payload.error : undefined,
        };

        impactLoading.style.display = 'none';
        impactContent.style.display = 'block';

        const otherCount = referencePayload.otherFiles.length;
        if (otherCount > 0) {
          referencesPill.textContent = String(otherCount);
          referencesPlural.textContent = otherCount === 1 ? '' : 's';
          impactOtherFilesRow.style.display = 'block';
        }

        if (referencePayload.currentFileCount > 1) {
          currentCount.textContent = String(referencePayload.currentFileCount);
          impactCurrentFileRow.style.display = 'block';
        }

        if (otherCount === 0 && referencePayload.currentFileCount <= 1) {
          impactRoot.style.display = 'none';
        }
      })
      .catch(error => {
        console.warn('[MD4H] Failed to fetch image references:', error);
        impactLoading.textContent = 'References unavailable';
      });
  } else {
    impactRoot.style.display = 'none';
  }

  // Helper to show/hide error message
  const showError = (message: string) => {
    errorContainer.textContent = message;
    errorContainer.style.display = 'block';
  };

  const hideError = () => {
    errorContainer.style.display = 'none';
  };

  // Update image preview when width/height changes
  const updatePreview = () => {
    if (!currentImage) return;

    let width = parseInt(widthInput.value) || 1;
    let height = parseInt(heightInput.value) || 1;

    // Block upscaling - clamp to original dimensions
    let hasError = false;
    if (width > originalWidth) {
      width = originalWidth;
      widthInput.value = String(originalWidth);
      showError(`Cannot exceed original width (${originalWidth}px)`);
      hasError = true;
    }
    if (height > originalHeight) {
      height = originalHeight;
      heightInput.value = String(originalHeight);
      showError(`Cannot exceed original height (${originalHeight}px)`);
      hasError = true;
    }

    if (!hasError) {
      hideError();
    }

    // Disable inputs if at max
    widthInput.disabled = width >= originalWidth;
    heightInput.disabled = height >= originalHeight;

    // Update image display
    currentImage.style.width = `${width}px`;
    currentImage.style.height = `${height}px`;

    // Disable resize button if at original size or trying to upscale
    if (width >= originalWidth && height >= originalHeight) {
      confirmBtn.disabled = true;
      confirmBtn.style.opacity = '0.5';
      confirmBtn.style.cursor = 'not-allowed';
    } else {
      confirmBtn.disabled = false;
      confirmBtn.style.opacity = '1';
      confirmBtn.style.cursor = 'pointer';
    }
  };

  // Handle width change
  widthInput.addEventListener('input', () => {
    let newWidth = parseInt(widthInput.value) || 1;

    // Clamp to original width
    if (newWidth > originalWidth) {
      newWidth = originalWidth;
      widthInput.value = String(originalWidth);
    }

    if (lockAspectRatio) {
      const newHeight = Math.round(newWidth / aspectRatio);
      // Also clamp height
      const clampedHeight = Math.min(newHeight, originalHeight);
      heightInput.value = String(clampedHeight);
    }
    updatePreview();
  });

  // Handle height change
  heightInput.addEventListener('input', () => {
    let newHeight = parseInt(heightInput.value) || 1;

    // Clamp to original height
    if (newHeight > originalHeight) {
      newHeight = originalHeight;
      heightInput.value = String(originalHeight);
    }

    if (lockAspectRatio) {
      const newWidth = Math.round(newHeight * aspectRatio);
      // Also clamp width
      const clampedWidth = Math.min(newWidth, originalWidth);
      widthInput.value = String(clampedWidth);
    }
    updatePreview();
  });

  // Reset to original dimensions
  resetBtn.addEventListener('click', () => {
    widthInput.value = String(originalWidth);
    heightInput.value = String(originalHeight);
    updatePreview();
  });

  // Cancel - restore original size and close
  const handleCancel = () => {
    if (currentImage) {
      currentImage.style.width = '';
      currentImage.style.height = '';
    }
    hideImageResizeModal();
  };

  cancelBtn.addEventListener('click', handleCancel);
  closeBtn.addEventListener('click', handleCancel);

  // Confirm resize
  confirmBtn.addEventListener('click', async () => {
    // Capture references before any async operations
    const img = currentImage;
    const vscodeApi = currentVscodeApi;

    if (!img || !vscodeApi) {
      console.warn('[MD4H] Cannot resize: image or vscodeApi is null');
      return;
    }

    const newWidth = parseInt(widthInput.value) || originalWidth;
    const newHeight = parseInt(heightInput.value) || originalHeight;

    // Only proceed if size actually changed and is smaller
    if (
      (newWidth >= originalWidth && newHeight >= originalHeight) ||
      (newWidth === originalWidth && newHeight === originalHeight)
    ) {
      // No change or trying to upsize - just close
      handleCancel();
      return;
    }

    // Show warning dialog (check setting first)
    // Explicitly check if skipResizeWarning is true (not just truthy)
    // undefined or false should both show the warning
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const skipWarning = (window as any).skipResizeWarning === true;
    if (!skipWarning) {
      const warning = await showImageResizeWarning();
      if (!warning || !warning.confirmed) {
        // User cancelled - restore original size
        handleCancel();
        return;
      }

      // Update setting if "never ask again" was checked
      if (warning.neverAskAgain) {
        // Update local variable immediately so it takes effect right away
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (window as any).skipResizeWarning = true;

        // Also save to VS Code settings (use captured reference)
        vscodeApi.postMessage({
          type: 'updateSetting',
          key: 'markdownForHumans.imageResize.skipWarning',
          value: true,
        });
      }
    }

    // Resize image using canvas
    try {
      const resizedData = await resizeImageWithCanvas(img, newWidth, newHeight);
      // Store the exact resized payload so undo/redo can reapply without re-encoding.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (img as any)._pendingResizeDataUrl = resizedData;

      // Get image path from data-markdown-src or src
      // If image is outside workspace (edit in place), use absolute path
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const absolutePath = (img as any)._absolutePath;
      const imagePath =
        absolutePath || img.getAttribute('data-markdown-src') || img.getAttribute('src') || '';

      // Send resize request to extension (use captured reference)
      vscodeApi.postMessage({
        type: 'resizeImage',
        imagePath,
        absolutePath: absolutePath || undefined, // Include if editing in place
        newWidth,
        newHeight,
        originalWidth,
        originalHeight,
        imageData: resizedData,
      });

      // Close modal
      hideImageResizeModal();
    } catch (error) {
      console.error('[MD4H] Failed to resize image:', error);
      // Restore original size on error
      handleCancel();
    }
  });

  // Close on Escape; auto-close when user returns to typing in the editor.
  const handleKeypress = (e: KeyboardEvent) => {
    if (!currentModal) return;

    if (e.key === 'Escape') {
      if (isReferencesPopoverOpen) {
        closeReferencesPopover();
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      handleCancel();
      return;
    }

    // If the user is interacting with the modal, don't auto-close on keypresses.
    // But if they're typing in the editor (outside the panel), close to get out of the way.
    const targetNode = e.target as Node | null;
    const isInsidePanel = !!targetNode && panel.contains(targetNode);
    if (!isInsidePanel) {
      handleCancel();
    }
  };
  document.addEventListener('keydown', handleKeypress);

  // Close on click outside modal
  const handleDocumentClick = (e: MouseEvent) => {
    if (currentModal && !panel.contains(e.target as Node)) {
      handleCancel();
    }
  };
  document.addEventListener('click', handleDocumentClick, true);

  // Close on scroll with small debounce to avoid accidental closes
  let scrollTimeout: ReturnType<typeof setTimeout> | null = null;
  const handleScroll = () => {
    if (!currentModal) return;

    if (document.activeElement === widthInput || document.activeElement === heightInput) {
      return;
    }
    // Debounce scroll - only close if scrolling persists for 100ms
    if (scrollTimeout) {
      clearTimeout(scrollTimeout);
    }
    scrollTimeout = setTimeout(() => {
      if (currentModal) {
        handleCancel();
      }
    }, 100);
  };
  window.addEventListener('scroll', handleScroll, true);

  // Store all handlers for cleanup
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (panel as any)._keypressHandler = handleKeypress;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (panel as any)._clickHandler = handleDocumentClick;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (panel as any)._scrollHandler = handleScroll;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (panel as any)._scrollTimeout = scrollTimeout;

  // Focus width input
  widthInput.focus();
  widthInput.select();
}

/**
 * Hide resize modal and clean up all event listeners
 */
export function hideImageResizeModal(): void {
  if (currentModal) {
    const panel = currentModal.querySelector('.image-resize-modal-panel') as HTMLElement;
    if (panel) {
      // Clear scroll timeout
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if ((panel as any)._scrollTimeout) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        clearTimeout((panel as any)._scrollTimeout);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (panel as any)._scrollTimeout = null;
      }

      // Remove keypress handler (consolidated key handler)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if ((panel as any)._keypressHandler) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        document.removeEventListener('keydown', (panel as any)._keypressHandler);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (panel as any)._keypressHandler = null;
      }

      // Remove click handler
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if ((panel as any)._clickHandler) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        document.removeEventListener('click', (panel as any)._clickHandler, true);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (panel as any)._clickHandler = null;
      }

      // Remove scroll handler
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if ((panel as any)._scrollHandler) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        window.removeEventListener('scroll', (panel as any)._scrollHandler, true);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (panel as any)._scrollHandler = null;
      }
    }

    // Remove modal from DOM
    currentModal.remove();
    currentModal = null;
    currentImage = null;
    currentVscodeApi = null;
  }
}

/**
 * Show resize modal after external image is downloaded
 * Called from editor.ts when externalImageDownloaded message is received
 */
export function showResizeModalAfterDownload(
  img: HTMLImageElement,
  editor: Editor,
  vscodeApi: VsCodeApi
): void {
  // Clear pending download flags
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete (img as any)._pendingDownloadPlaceholderId;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete (img as any)._pendingResizeAfterDownload;

  // Now show resize modal (image is now local)
  showResizeModalForLocalImage(img, editor, vscodeApi);
}

// Removed setupImageResize function - image click handler removed
// Only the resize icon should open the modal (handled in customImage.ts)

/**
 * Handle resize completion from extension
 */
export function handleImageResized(backupPath: string, img: HTMLImageElement): void {
  const state = getResizeState(img);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pendingResizeDataUrl = (img as any)._pendingResizeDataUrl;
  if (typeof pendingResizeDataUrl === 'string') {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (img as any)._pendingResizeDataUrl;
  }

  // Add to history
  const historyEntry: ResizeHistoryEntry = {
    timestamp: new Date().toISOString().replace(/[-:]/g, '').split('.')[0],
    backupPath,
    originalWidth: state.originalWidth,
    originalHeight: state.originalHeight,
    newWidth: parseInt(img.style.width) || img.width,
    newHeight: parseInt(img.style.height) || img.height,
    imageData: typeof pendingResizeDataUrl === 'string' ? pendingResizeDataUrl : img.src,
  };

  // Clear future history if we're not at the end
  if (state.historyIndex < state.history.length - 1) {
    state.history = state.history.slice(0, state.historyIndex + 1);
  }

  state.history.push(historyEntry);
  state.historyIndex = state.history.length - 1;

  // Limit history to 10 entries
  if (state.history.length > 10) {
    state.history.shift();
    state.historyIndex = state.history.length - 1;
  }
}

/**
 * Undo last resize
 */
export function undoImageResize(img: HTMLImageElement, vscodeApi: VsCodeApi): void {
  const state = imageResizeStates.get(img);
  if (!state || state.historyIndex < 0) {
    return; // No history to undo
  }

  const entry = state.history[state.historyIndex];
  const imagePath = img.getAttribute('data-markdown-src') || img.getAttribute('src') || '';

  vscodeApi.postMessage({
    type: 'undoResize',
    imagePath,
    backupPath: entry.backupPath,
  });

  state.historyIndex--;
}

/**
 * Redo last resize
 */
export function redoImageResize(img: HTMLImageElement, vscodeApi: VsCodeApi): void {
  const state = imageResizeStates.get(img);
  if (!state || state.historyIndex >= state.history.length - 1) {
    return; // Nothing to redo
  }

  state.historyIndex++;
  const entry = state.history[state.historyIndex];
  const imagePath = img.getAttribute('data-markdown-src') || img.getAttribute('src') || '';
  if (!entry.imageData || !entry.imageData.startsWith('data:')) {
    console.warn('[MD4H] Cannot redo resize: missing image data URL');
    return;
  }

  vscodeApi.postMessage({
    type: 'redoResize',
    imagePath,
    newWidth: entry.newWidth,
    newHeight: entry.newHeight,
    imageData: entry.imageData,
  });
}
