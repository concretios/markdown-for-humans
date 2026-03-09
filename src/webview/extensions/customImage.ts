/**
 * Copyright (c) 2025-2026 Concret.io
 *
 * Licensed under the MIT License. See LICENSE file in the project root for details.
 */

/**
 * Custom Image Extension
 *
 * Extends TipTap's Image extension to support:
 * - data-placeholder-id for tracking images being saved
 * - base64 preview during upload
 * - Automatic URI resolution for relative paths
 * - Resize handles for image resizing
 * - Proper atomic node behavior for reliable selection/deletion
 */

import Image from '@tiptap/extension-image';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import type { JSONContent, MarkdownRendererHelpers, RenderContext } from '@tiptap/core';
import {
  createImageMenuButton,
  createImageMenu,
  showImageMenu,
  hideImageMenu,
  isExternalImage,
} from '../features/imageMenu';
import { createCustomImageMessagePlugin } from './customImageMessagePlugin';
import { showImageMetadataFooter, hideImageMetadataFooter } from '../features/imageMetadata';

const INDENT_PIXELS_PER_LEVEL = 30;
const INDENT_SPACES_PER_LEVEL = 4;
const MAX_INDENT_PIXELS = 240;

function getImageCacheBustTimestamp(markdownPath: string): number | null {
  const maybeMap = (window as any)?._imageCacheBust;
  if (!(maybeMap instanceof Map)) {
    return null;
  }

  const value = maybeMap.get(markdownPath);
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null;
  }

  return value;
}

function applyCacheBust(src: string, timestamp: number | null): string {
  if (timestamp === null) {
    return src;
  }

  try {
    const url = new URL(src);
    url.searchParams.set('t', String(timestamp));
    return url.toString();
  } catch {
    // Fallback: avoid crashing on unexpected/relative URLs.
    const cleaned = src.replace(/[?&]t=\d+/g, '');
    const separator = cleaned.includes('?') ? '&' : '?';
    return `${cleaned}${separator}t=${timestamp}`;
  }
}

function computeIndentPixels(indentPrefix: unknown): number {
  if (typeof indentPrefix !== 'string' || indentPrefix.length === 0) {
    return 0;
  }

  let spacesEquivalent = 0;

  for (const ch of indentPrefix) {
    if (ch === '\t') {
      spacesEquivalent += INDENT_SPACES_PER_LEVEL;
      continue;
    }
    if (ch === ' ') {
      spacesEquivalent += 1;
    }
  }

  if (spacesEquivalent <= 0) {
    return 0;
  }

  const pixels = (spacesEquivalent / INDENT_SPACES_PER_LEVEL) * INDENT_PIXELS_PER_LEVEL;
  return Math.min(pixels, MAX_INDENT_PIXELS);
}

export const CustomImage = Image.extend({
  name: 'image',

  // Make images inline - allows consecutive images without phantom gaps
  // When inline, images live inside paragraphs like other inline content
  // This provides a clean, natural flow for consecutive images
  inline: true,

  // Make image an atomic node - it should be treated as a single unit
  // This ensures proper selection and deletion behavior
  // See: https://github.com/ueberdosis/tiptap/issues/1908
  atom: true,

  // Ensure images can be selected as node selections
  selectable: true,

  // Since inline is true, images belong to 'inline' group
  group: 'inline',

  addProseMirrorPlugins() {
    return [
      // Disable default image paste handling to prevent double insertion
      // Our custom image drag-drop handler in imageDragDrop.ts handles all image pastes
      new Plugin({
        key: new PluginKey('customImagePaste'),
        props: {
          handlePaste: (_view, event) => {
            const clipboardData = event.clipboardData;
            if (!clipboardData) return false;

            // Check if clipboard contains image files or data
            const hasImageFile = Array.from(clipboardData.files).some(file =>
              file.type.startsWith('image/')
            );
            const hasImageData = Array.from(clipboardData.items).some(item =>
              item.type.startsWith('image/')
            );

            // If there are image files or data, let our custom handler deal with it
            // Return true to prevent TipTap's default image handling
            if (hasImageFile || hasImageData) {
              // Our imageDragDrop.ts handler will handle this
              return true;
            }

            // Not an image paste, let other handlers deal with it
            return false;
          },
        },
      }),
      createCustomImageMessagePlugin(this.editor),
    ];
  },

  addAttributes() {
    return {
      ...this.parent?.(),
      'data-placeholder-id': {
        default: null,
        parseHTML: element => element.getAttribute('data-placeholder-id'),
        renderHTML: attributes => {
          if (!attributes['data-placeholder-id']) {
            return {};
          }
          return {
            'data-placeholder-id': attributes['data-placeholder-id'],
          };
        },
      },
      // Store original markdown src for proper serialization and export
      'markdown-src': {
        default: null,
        parseHTML: element => {
          // When parsing HTML, try to get the original markdown path
          return element.getAttribute('data-markdown-src') || element.getAttribute('src');
        },
        renderHTML: attributes => {
          // Render as data-markdown-src for export
          if (attributes['markdown-src']) {
            return {
              'data-markdown-src': attributes['markdown-src'],
            };
          }
          return {};
        },
      },
      // Preserve leading indentation for images that were originally indented in markdown.
      // This enables round-tripping markdown where images were intentionally aligned/indented.
      'indent-prefix': {
        default: null,
      },
      width: {
        default: null,
        parseHTML: element => element.getAttribute('width'),
        renderHTML: attributes => {
          if (!attributes.width) return {};
          return { width: attributes.width };
        },
      },
      height: {
        default: null,
        parseHTML: element => element.getAttribute('height'),
        renderHTML: attributes => {
          if (!attributes.height) return {};
          return { height: attributes.height };
        },
      },
    };
  },

  addNodeView() {
    return ({ node, HTMLAttributes, editor }) => {
      // Create wrapper to hold image and resize icon
      const wrapper = document.createElement('span');
      wrapper.className = 'image-wrapper';

      const indentPixels = computeIndentPixels(node.attrs?.['indent-prefix']);
      if (indentPixels > 0) {
        wrapper.style.marginLeft = `${indentPixels}px`;
        wrapper.style.maxWidth = `calc(100% - ${indentPixels}px)`;
      }

      const dom = document.createElement('img');
      dom.className = HTMLAttributes.class || 'markdown-image';

      // Set alt text
      if (node.attrs.alt) {
        dom.alt = node.attrs.alt;
      }

      // Set placeholder ID if present
      if (node.attrs['data-placeholder-id']) {
        dom.setAttribute('data-placeholder-id', node.attrs['data-placeholder-id']);
      }

      // Handle src - resolve if relative path
      // Use markdown-src if available (preserves original path), otherwise use src
      // markdown-src is the source of truth for the actual file path in markdown
      const originalSrc = node.attrs['markdown-src'] || node.attrs.src;
      const src = node.attrs.src;
      const cacheBustTimestamp =
        typeof originalSrc === 'string' && originalSrc.length > 0
          ? getImageCacheBustTimestamp(originalSrc)
          : null;

      // Always store the original markdown src for export functionality
      // This is critical for PDF/Word export to resolve local images
      dom.setAttribute('data-markdown-src', originalSrc);

      // Use markdown-src for resolution if available (it's the actual file path)
      // Otherwise fall back to src
      const pathToResolve = originalSrc || src;

      if (
        pathToResolve.startsWith('data:') ||
        pathToResolve.startsWith('http://') ||
        pathToResolve.startsWith('https://') ||
        pathToResolve.startsWith('vscode-webview://')
      ) {
        // Direct URLs, data URIs, or already resolved webview URIs
        dom.src = applyCacheBust(pathToResolve, cacheBustTimestamp);
      } else {
        // Relative path - needs resolution
        // Show loading state
        dom.alt = `Loading: ${pathToResolve}`;

        // Request resolution (needs vscode API access)
        // This will be done via a global function
        if ((window as any).resolveImagePath) {
          (window as any).resolveImagePath(pathToResolve).then((webviewUri: string) => {
            dom.src = applyCacheBust(webviewUri, cacheBustTimestamp);
            if (node.attrs.alt) {
              dom.alt = node.attrs.alt;
            }
          });
        } else {
          // Fallback: try using the relative path as-is
          dom.src = applyCacheBust(pathToResolve, cacheBustTimestamp);
        }
      }

      // Apply dimensions if present
      if (node.attrs.width) {
        dom.style.width = `${node.attrs.width}px`;
      }
      if (node.attrs.height) {
        dom.style.height = `${node.attrs.height}px`;
      }

      // Create three-dots menu button (shown on hover)
      const menuButton = createImageMenuButton();
      menuButton.setAttribute('title', 'Image options');

      // Check if this is an external image (hide menu for external images)
      const imageSrc = node.attrs['markdown-src'] || node.attrs.src;
      const isExternal = isExternalImage(imageSrc);
      const isLocal = !isExternal;

      // Create dropdown menu (pass isLocal to conditionally show file location options)
      const menu = createImageMenu(isLocal);

      // Track if image is loaded
      let isImageLoaded = dom.complete;

      // Update loaded state when image loads
      if (!isImageLoaded) {
        dom.addEventListener(
          'load',
          () => {
            isImageLoaded = true;
            dom.removeAttribute('data-loading');
          },
          { once: true }
        );
        dom.setAttribute('data-loading', 'true');
      }

      // Only show menu button on hover if image is loaded and not external
      const handleMouseEnter = () => {
        if (isImageLoaded && dom.complete && !isExternal) {
          wrapper.classList.add('image-hover-active');
          // Show metadata footer
          const vscodeApi = (window as any).vscode;
          if (vscodeApi) {
            showImageMetadataFooter(dom, wrapper, vscodeApi);
          }
        }
      };

      const handleMouseLeave = (e: MouseEvent) => {
        // Don't hide if menu is open
        if (menu.style.display !== 'none') {
          return;
        }
        // Don't hide if moving to another part of the wrapper
        const relatedTarget = e.relatedTarget as HTMLElement;
        if (relatedTarget && wrapper.contains(relatedTarget)) {
          return;
        }
        wrapper.classList.remove('image-hover-active');
        // Hide metadata footer
        hideImageMetadataFooter(wrapper);
      };

      wrapper.addEventListener('mouseenter', handleMouseEnter);
      wrapper.addEventListener('mouseleave', handleMouseLeave);

      // Append menu as sibling of button (not child) for correct positioning
      wrapper.appendChild(dom);

      // Create three-dots menu button click handler
      menuButton.addEventListener('click', (e: MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        const vscodeApi = (window as any).vscode;
        if (menu.style.display === 'none') {
          showImageMenu(menu, menuButton, dom, editor, vscodeApi);
        } else {
          hideImageMenu(menu);
        }
      });

      // Add resize handle
      const resizeHandle = document.createElement('div');
      resizeHandle.className = 'image-resize-handle';
      wrapper.appendChild(resizeHandle);

      // Resize logic
      let isResizing = false;
      let startX = 0;
      let startWidth = 0;
      let aspectRatio = 0;

      const onMouseDown = (e: MouseEvent) => {
        isResizing = true;
        startX = e.clientX;
        startWidth = dom.clientWidth;
        aspectRatio = dom.naturalWidth / dom.naturalHeight || dom.clientWidth / dom.clientHeight;

        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
        e.preventDefault();
        e.stopPropagation();
      };

      const onMouseMove = (e: MouseEvent) => {
        if (!isResizing) return;

        const deltaX = e.clientX - startX;
        const newWidth = Math.max(20, startWidth + deltaX);
        const newHeight = newWidth / aspectRatio;

        dom.style.width = `${newWidth}px`;
        dom.style.height = `${newHeight}px`;
      };

      const onMouseUp = () => {
        if (!isResizing) return;
        isResizing = false;

        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);

        // Update node attributes
        const width = Math.round(dom.clientWidth);
        const height = Math.round(dom.clientHeight);

        editor.commands.updateAttributes('image', { width, height });
      };

      resizeHandle.addEventListener('mousedown', onMouseDown);

      wrapper.appendChild(menuButton);
      wrapper.appendChild(menu);

      // No need to setup image click handler - only icon opens modal
      return {
        dom: wrapper,
      };
    };
  },

  /**
   * Custom markdown serialization to use markdown-src instead of src
   * This ensures that when images are resized and the filename changes,
   * the markdown serialization uses the correct path with dimensions.
   */
  renderMarkdown: ((
    node: JSONContent,
    _helpers: MarkdownRendererHelpers,
    _context: RenderContext
  ) => {
    const src = node.attrs?.['markdown-src'] || node.attrs?.src || '';
    const alt = node.attrs?.alt || '';
    const indentPrefix =
      typeof node.attrs?.['indent-prefix'] === 'string' ? node.attrs['indent-prefix'] : '';
    const width = node.attrs?.width;
    const height = node.attrs?.height;
    const destination = typeof src === 'string' ? src : '';
    const formattedDestination = /\s/.test(destination) ? `<${destination}>` : destination;

    // Use HTML img tag if width or height is present to preserve dimensions
    if (width || height) {
      const widthAttr = width ? ` width="${width}"` : '';
      const heightAttr = height ? ` height="${height}"` : '';
      return `${indentPrefix}<img src="${destination}" alt="${alt}"${widthAttr}${heightAttr} />`;
    }

    // Use markdown-src if available (preserves original path with dimensions after resize)
    // Fall back to src if markdown-src is not set
    return `${indentPrefix}![${alt}](${formattedDestination})`;
  }) as unknown as (
    node: JSONContent,
    _helpers: MarkdownRendererHelpers,
    ctx: RenderContext
  ) => string,
});
