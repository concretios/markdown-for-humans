/**
 * Copyright (c) 2025-2026 Concret.io
 *
 * Licensed under the MIT License. See LICENSE file in the project root for details.
 */

/**
 * Image Metadata Component
 *
 * Provides adaptive metadata footer for images that shows on hover:
 * - Small images (< 200px): Minimal footer or hidden
 * - Medium images (200-600px): Standard footer with essential info
 * - Large images (> 600px): Full footer with all metadata
 */

interface VsCodeApi {
  postMessage(message: unknown): void;
}

export interface ImageMetadata {
  filename: string;
  size: number;
  dimensions: { width: number; height: number };
  lastModified: number;
  path: string;
}

// Cache metadata per image to avoid refetching on every hover
const metadataCache = new Map<string, ImageMetadata>();
const pendingMetadataTimeouts = new Map<string, ReturnType<typeof setTimeout>>();

type MetadataCallback = (metadata: ImageMetadata | null) => void;

function getMetadataCallbacks(): Map<string, MetadataCallback> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const windowWithCallbacks = window as any;
  windowWithCallbacks._metadataCallbacks = windowWithCallbacks._metadataCallbacks || new Map();
  return windowWithCallbacks._metadataCallbacks;
}

function maybeUnrefTimer(timer: ReturnType<typeof setTimeout>): void {
  const maybeNodeTimer = timer as unknown as { unref?: () => void };
  if (typeof maybeNodeTimer.unref === 'function') {
    maybeNodeTimer.unref();
  }
}

/**
 * Get cached metadata for an image path
 * @param imagePath - Path of the image
 * @returns Cached metadata or null if not cached
 */
export function getCachedImageMetadata(imagePath: string): ImageMetadata | null {
  return metadataCache.get(imagePath) || null;
}

/**
 * Clear metadata cache for a specific image path or all paths
 * @param imagePath - Path to clear, or undefined to clear all
 */
export function clearImageMetadataCache(imagePath?: string): void {
  if (imagePath) {
    metadataCache.delete(imagePath);
  } else {
    metadataCache.clear();
  }
}

/**
 * Clear unresolved metadata requests and their timeout handles.
 * This is used when the webview/test DOM is reset before the extension host responds.
 */
export function clearPendingImageMetadataRequests(): void {
  for (const timeout of pendingMetadataTimeouts.values()) {
    clearTimeout(timeout);
  }
  pendingMetadataTimeouts.clear();

  const callbacks = getMetadataCallbacks();
  callbacks.clear();
}

/**
 * Update metadata cache with new dimensions for an image
 * This is used immediately after resize to ensure correct dimensions are shown
 * @param imagePath - Path of the image
 * @param dimensions - New dimensions
 * @param metadata - Optional existing metadata to update, or null to create new
 */
export function updateImageMetadataDimensions(
  imagePath: string,
  dimensions: { width: number; height: number },
  metadata: ImageMetadata | null = null
): void {
  if (metadata) {
    // Update existing metadata
    metadata.dimensions = dimensions;
    metadataCache.set(imagePath, metadata);
  } else {
    // Create minimal metadata entry with just dimensions
    // Other fields will be filled when metadata is fetched
    const existingMetadata = metadataCache.get(imagePath);
    if (existingMetadata) {
      existingMetadata.dimensions = dimensions;
      metadataCache.set(imagePath, existingMetadata);
    } else {
      // Create a temporary entry - will be replaced when full metadata is fetched
      metadataCache.set(imagePath, {
        filename: imagePath.split('/').pop() || '',
        size: 0,
        dimensions,
        lastModified: Date.now(),
        path: imagePath,
      });
    }
  }
}

/**
 * Format file size in human-readable format
 */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Format date in human-readable format
 */
export function formatDate(timestamp: number): string {
  const date = new Date(timestamp);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays === 0) {
    return 'Today';
  }
  if (diffDays === 1) {
    return 'Yesterday';
  }
  if (diffDays < 7) {
    return `${diffDays} days ago`;
  }

  // Format as date
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: date.getFullYear() !== now.getFullYear() ? 'numeric' : undefined,
  });
}

/**
 * Detect image size category for adaptive footer
 */
export function detectImageSize(img: HTMLImageElement): 'small' | 'medium' | 'large' {
  const width = img.naturalWidth || img.width || 0;
  if (width < 200) return 'small';
  if (width < 600) return 'medium';
  return 'large';
}

/**
 * Truncate text to specified length
 */
function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength - 3) + '...';
}

/**
 * Get image metadata from extension
 */
export function getImageMetadata(
  imagePath: string,
  vscodeApi: VsCodeApi
): Promise<ImageMetadata | null> {
  // Check cache first
  if (metadataCache.has(imagePath)) {
    return Promise.resolve(metadataCache.get(imagePath)!);
  }

  return new Promise(resolve => {
    const requestId = `metadata-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

    // Store callback
    const callbacks = getMetadataCallbacks();
    callbacks.set(requestId, (metadata: ImageMetadata | null) => {
      callbacks.delete(requestId);
      const timeout = pendingMetadataTimeouts.get(requestId);
      if (timeout) {
        clearTimeout(timeout);
        pendingMetadataTimeouts.delete(requestId);
      }

      if (metadata) {
        // Preserve existing dimensions if they were set (e.g., from resize)
        // This ensures correct dimensions are shown even if image hasn't fully loaded yet
        const existingMetadata = metadataCache.get(imagePath);
        if (
          existingMetadata &&
          existingMetadata.dimensions.width > 0 &&
          existingMetadata.dimensions.height > 0
        ) {
          metadata.dimensions = existingMetadata.dimensions;
        }
        metadataCache.set(imagePath, metadata);
      }
      resolve(metadata);
    });

    vscodeApi.postMessage({
      type: 'getImageMetadata',
      imagePath,
      requestId,
    });

    // Timeout after 5 seconds
    const timeout = setTimeout(() => {
      pendingMetadataTimeouts.delete(requestId);
      if (callbacks && callbacks.has(requestId)) {
        callbacks.delete(requestId);
        resolve(null);
      }
    }, 5000);
    maybeUnrefTimer(timeout);
    pendingMetadataTimeouts.set(requestId, timeout);
  });
}

/**
 * Create metadata footer element with adaptive content
 */
export function createMetadataFooter(
  img: HTMLImageElement,
  metadata: ImageMetadata | null
): HTMLElement {
  const footer = document.createElement('div');
  footer.className = 'image-metadata-footer';

  if (!metadata) {
    // Show loading state
    footer.innerHTML = `
      <div class="metadata-row metadata-minimal">
        <span class="metadata-loading">Loading metadata...</span>
      </div>
    `;
    footer.setAttribute('data-image-size', 'medium');
    return footer;
  }

  // Detect image size for adaptive content
  const imageSize = detectImageSize(img);
  footer.setAttribute('data-image-size', imageSize);

  // Build content based on size
  if (imageSize === 'small') {
    // Minimal footer - just filename
    footer.innerHTML = `
      <div class="metadata-row metadata-minimal">
        <span class="metadata-filename">${truncate(metadata.filename, 20)}</span>
      </div>
    `;
  } else if (imageSize === 'medium') {
    // Standard footer - two lines
    footer.innerHTML = `
      <div class="metadata-row metadata-primary">
        <span class="metadata-filename">${truncate(metadata.filename, 30)}</span>
        <span class="metadata-dimensions">${metadata.dimensions.width}×${metadata.dimensions.height}</span>
        <span class="metadata-size">${formatFileSize(metadata.size)}</span>
      </div>
      <div class="metadata-row metadata-secondary">
        <span class="metadata-path">${truncate(metadata.path, 40)}</span>
        <span class="metadata-date">${formatDate(metadata.lastModified)}</span>
      </div>
    `;
  } else {
    // Large - full content with better spacing
    footer.innerHTML = `
      <div class="metadata-row">
        <span class="metadata-filename">${metadata.filename}</span>
      </div>
      <div class="metadata-row">
        <span class="metadata-dimensions">${metadata.dimensions.width}×${metadata.dimensions.height}</span>
        <span class="metadata-separator">•</span>
        <span class="metadata-size">${formatFileSize(metadata.size)}</span>
      </div>
      <div class="metadata-row">
        <span class="metadata-path">${metadata.path}</span>
      </div>
      <div class="metadata-row">
        <span class="metadata-date">Modified: ${formatDate(metadata.lastModified)}</span>
      </div>
    `;
  }

  return footer;
}

/**
 * Show metadata footer on hover
 */
export function showImageMetadataFooter(
  img: HTMLImageElement,
  wrapper: HTMLElement,
  vscodeApi: VsCodeApi
): void {
  // Check if hover overlay is disabled
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if (!(window as any).showImageHoverOverlay) {
    return;
  }

  // Check if footer already exists
  let footer = wrapper.querySelector('.image-metadata-footer') as HTMLElement;
  if (!footer) {
    // Create footer (initially empty/loading)
    footer = createMetadataFooter(img, null);
    wrapper.appendChild(footer);
  }

  // Get image path
  const imagePath = img.getAttribute('data-markdown-src') || img.getAttribute('src') || '';

  // Don't show metadata for external images
  if (
    imagePath.startsWith('http://') ||
    imagePath.startsWith('https://') ||
    imagePath.startsWith('data:')
  ) {
    if (footer) {
      footer.style.display = 'none';
    }
    return;
  }

  // Don't show for very small images
  const imageSize = detectImageSize(img);
  if (imageSize === 'small' && (img.naturalWidth || img.width || 0) < 100) {
    if (footer) {
      footer.style.display = 'none';
    }
    return;
  }

  // Show footer
  footer.style.display = 'block';

  // Fetch metadata if not cached
  if (!metadataCache.has(imagePath)) {
    getImageMetadata(imagePath, vscodeApi).then(metadata => {
      if (metadata && footer.parentElement) {
        // Update footer with metadata
        const newFooter = createMetadataFooter(img, metadata);
        footer.replaceWith(newFooter);
      }
    });
  } else {
    // Use cached metadata
    const metadata = metadataCache.get(imagePath)!;
    const newFooter = createMetadataFooter(img, metadata);
    footer.replaceWith(newFooter);
  }
}

/**
 * Hide metadata footer
 */
export function hideImageMetadataFooter(wrapper: HTMLElement): void {
  const footer = wrapper.querySelector('.image-metadata-footer') as HTMLElement;
  if (footer) {
    footer.style.display = 'none';
  }
}
