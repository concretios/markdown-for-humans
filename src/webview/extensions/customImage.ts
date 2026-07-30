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

import Image, { type ImageOptions } from '@tiptap/extension-image';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import type { JSONContent, MarkdownRendererHelpers, RenderContext } from '@tiptap/core';
import {
  createImageMenuButton,
  createImageMenu,
  showImageMenu,
  hideImageMenu,
  isExternalImage,
  observeNarrowImageLayout,
} from '../features/imageMenu';
import { showImageMetadataFooter, hideImageMetadataFooter } from '../features/imageMetadata';

const INDENT_PIXELS_PER_LEVEL = 30;
const INDENT_SPACES_PER_LEVEL = 4;
const MAX_INDENT_PIXELS = 240;

type CustomImageOptions = ImageOptions & {
  getShowImageHoverOverlay: () => boolean;
};

function getImageCacheBustTimestamp(markdownPath: string): number | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
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

  addOptions(): CustomImageOptions {
    const parentOpts = (this.parent?.() ?? {}) as Partial<ImageOptions>;
    return {
      ...parentOpts,
      inline: parentOpts.inline ?? true,
      allowBase64: parentOpts.allowBase64 ?? true,
      HTMLAttributes: parentOpts.HTMLAttributes ?? {},
      resize: parentOpts.resize ?? false,
      // Define a getter function so it always fetches the freshest dynamic value
      getShowImageHoverOverlay: () => true,
    };
  },

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
    };
  },

  addNodeView() {
    return ({ node, HTMLAttributes, editor, extension }) => {
      const isHoverOverlayEnabled = () =>
        extension?.options?.getShowImageHoverOverlay?.() !== false;

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
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        if ((window as any).resolveImagePath) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
          // Keep the image menu reachable regardless of hover overlay setting.
          wrapper.classList.add('image-menu-active');

          if (isHoverOverlayEnabled()) {
            wrapper.classList.add('image-hover-active');
            // Show metadata footer
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const vscodeApi = (window as any).vscode;
            if (vscodeApi) {
              showImageMetadataFooter(dom, wrapper, vscodeApi);
            }
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
        wrapper.classList.remove('image-menu-active');
        wrapper.classList.remove('image-hover-active');
        // Hide metadata footer
        hideImageMetadataFooter(wrapper);
      };

      wrapper.addEventListener('mouseenter', handleMouseEnter);
      wrapper.addEventListener('mouseleave', handleMouseLeave);

      // For narrow images the button sits beside the picture rather than on it,
      // so the pointer can reach the button without crossing the image. Re-assert
      // the hover state there so the button cannot vanish out from under it.
      menuButton.addEventListener('mouseenter', () => {
        if (isImageLoaded && dom.complete && !isExternal) {
          wrapper.classList.add('image-menu-active');
        }
      });

      // Click menu button to show/hide dropdown
      menuButton.addEventListener('click', e => {
        e.preventDefault();
        e.stopPropagation();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const vscodeApi = (window as any).vscode;
        if (menu.style.display === 'none') {
          showImageMenu(menu, menuButton, dom, editor, vscodeApi);
        } else {
          hideImageMenu(menu);
        }
      });

      // Append menu as sibling of button (not child) for correct positioning
      wrapper.appendChild(dom);
      wrapper.appendChild(menuButton);
      wrapper.appendChild(menu);

      // Small images cannot host the menu button without covering the picture,
      // so track the rendered width and move the button outside when narrow.
      const stopNarrowLayoutObserver = observeNarrowImageLayout(wrapper, dom);

      // No need to setup image click handler - only icon opens modal
      return {
        dom: wrapper,
        destroy: () => {
          stopNarrowLayoutObserver();
        },
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
    const destination = typeof src === 'string' ? src : '';
    const formattedDestination = /\s/.test(destination) ? `<${destination}>` : destination;

    // Use markdown-src if available (preserves original path with dimensions after resize)
    // Fall back to src if markdown-src is not set
    return `${indentPrefix}![${alt}](${formattedDestination})`;
  }) as unknown as (
    node: JSONContent,
    _helpers: MarkdownRendererHelpers,
    ctx: RenderContext
  ) => string,
});
