/**
 * Copyright (c) 2025-2026 Concret.io
 *
 * Licensed under the MIT License. See LICENSE file in the project root for details.
 */

/**
 * Huge Image Dialog
 *
 * Shows a dialog when user drops/pastes a very large image (>2000px or >2MB),
 * offering to resize it to a suggested resolution before inserting.
 */

import { isSvgImageSource } from '../../shared/imageSource';

export interface HugeImageOptions {
  action: 'resize-suggested' | 'resize-custom' | 'use-original';
  customWidth?: number;
  customHeight?: number;
}

/**
 * Check if a raster image is large enough to consider file optimization.
 * SVG display dimensions never justify rasterizing its original bytes.
 */
export function isHugeImage(file: File): boolean {
  if (isSvgImageSource(encodeURIComponent(file.name), file.type)) return false;
  // File size threshold: > 2MB
  if (file.size > 2 * 1024 * 1024) {
    return true;
  }

  // Pixel threshold will be checked after image loads
  // For now, we'll check file size only
  return false;
}

/**
 * Get image dimensions from File
 * Returns null if dimensions can't be determined
 */
function getImageDimensions(file: File): Promise<{ width: number; height: number } | null> {
  return new Promise(resolve => {
    const img = new Image();
    const url = URL.createObjectURL(file);

    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve({ width: img.width, height: img.height });
    };

    img.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(null);
    };

    img.src = url;
  });
}

/**
 * Calculate suggested resolution based on editor width
 * Uses 80% of editor content width (max-width: 1400px from CSS)
 */
function calculateSuggestedResolution(
  originalWidth: number,
  originalHeight: number
): { width: number; height: number } {
  // Editor max-width is 1400px, use 80% = 1120px
  const maxEditorWidth = 1400;
  const suggestedWidth = Math.min(Math.round(maxEditorWidth * 0.8), originalWidth);
  const aspectRatio = originalWidth / originalHeight;
  const suggestedHeight = Math.round(suggestedWidth / aspectRatio);

  return { width: suggestedWidth, height: suggestedHeight };
}

/**
 * Format file size for display
 */
function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Show huge image dialog
 * Returns null only for an explicit cancellation. Files that need no dialog
 * (including SVGs and undecodable dimensions) return use-original.
 */
export async function showHugeImageDialog(
  file: File,
  _cursorPosition?: { x: number; y: number }
): Promise<HugeImageOptions | null> {
  // Check file size first (quick check)
  const isHuge = isHugeImage(file);
  if (!isHuge) {
    return { action: 'use-original' }; // No dialog needed.
  }

  // Get image dimensions
  const dimensions = await getImageDimensions(file);
  if (!dimensions) {
    // Can't determine dimensions, proceed with original.
    return { action: 'use-original' };
  }

  // Check pixel threshold: > 2000px width OR > 2000px height
  const pixelThreshold = 2000;
  if (dimensions.width <= pixelThreshold && dimensions.height <= pixelThreshold) {
    return { action: 'use-original' }; // Not huge by pixel count.
  }

  // Calculate suggested resolution
  const suggested = calculateSuggestedResolution(dimensions.width, dimensions.height);

  return new Promise(resolve => {
    // Create modal overlay
    const overlay = document.createElement('div');
    overlay.className = 'huge-image-overlay';
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

    // Create thumbnail preview
    const thumbnailUrl = URL.createObjectURL(file);
    const thumbnail = document.createElement('img');
    thumbnail.src = thumbnailUrl;
    thumbnail.style.cssText = `
      max-width: 200px;
      max-height: 200px;
      object-fit: contain;
      border-radius: 4px;
      margin-bottom: 16px;
    `;

    // Create dialog
    const dialog = document.createElement('div');
    dialog.className = 'huge-image-dialog';
    dialog.style.cssText = `
      background: var(--vscode-editor-background);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 6px;
      padding: 20px;
      min-width: 400px;
      max-width: 500px;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
      display: flex;
      flex-direction: column;
      align-items: center;
    `;

    dialog.innerHTML = `
      <h3 style="margin: 0 0 16px 0; color: var(--vscode-foreground); text-align: center;">
        Large Image Detected
      </h3>
      <div style="margin-bottom: 16px; text-align: center;">
        <p style="margin: 0 0 8px 0; color: var(--vscode-foreground);">
          This image is very large:
        </p>
        <p style="margin: 0 0 8px 0; color: var(--vscode-descriptionForeground); font-size: 0.9em;">
          ${dimensions.width} × ${dimensions.height}px (${formatFileSize(file.size)})
        </p>
        <p style="margin: 0; color: var(--vscode-descriptionForeground); font-size: 0.9em;">
          Suggested size: ${suggested.width} × ${suggested.height}px
        </p>
      </div>
      <div style="display: flex; gap: 8px; justify-content: center; width: 100%;">
        <button id="resize-suggested-btn" style="
          padding: 8px 16px;
          background: var(--vscode-button-background);
          color: var(--vscode-button-foreground);
          border: none;
          border-radius: 3px;
          cursor: pointer;
          font-family: var(--vscode-font-family);
          font-weight: 500;
        ">Resize to Suggested</button>
        <button id="use-original-btn" style="
          padding: 8px 16px;
          background: var(--vscode-button-secondaryBackground);
          color: var(--vscode-button-secondaryForeground);
          border: none;
          border-radius: 3px;
          cursor: pointer;
          font-family: var(--vscode-font-family);
        ">Use Original</button>
      </div>
    `;

    // Insert thumbnail before dialog content
    const contentWrapper = document.createElement('div');
    contentWrapper.style.cssText =
      'display: flex; flex-direction: column; align-items: center; width: 100%;';
    contentWrapper.appendChild(thumbnail);
    contentWrapper.appendChild(dialog);

    overlay.appendChild(contentWrapper);
    document.body.appendChild(overlay);

    // Get buttons
    const resizeSuggestedBtn = dialog.querySelector('#resize-suggested-btn') as HTMLButtonElement;
    const useOriginalBtn = dialog.querySelector('#use-original-btn') as HTMLButtonElement;

    let settled = false;
    const finish = (result: HugeImageOptions | null) => {
      if (settled) return;
      settled = true;
      URL.revokeObjectURL(thumbnailUrl);
      window.removeEventListener('keydown', handleEscape);
      overlay.remove();
      resolve(result);
    };
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        finish(null);
      }
    };

    resizeSuggestedBtn.addEventListener('click', () =>
      finish({
        action: 'resize-suggested',
        customWidth: suggested.width,
        customHeight: suggested.height,
      })
    );
    useOriginalBtn.addEventListener('click', () => finish({ action: 'use-original' }));
    overlay.addEventListener('click', e => {
      if (e.target === overlay) finish(null);
    });
    window.addEventListener('keydown', handleEscape);

    // Focus first button
    resizeSuggestedBtn.focus();
  });
}
