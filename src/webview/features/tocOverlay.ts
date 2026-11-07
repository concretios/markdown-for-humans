/**
 * Copyright (c) 2025-2026 Concret.io
 *
 * Licensed under the MIT License. See LICENSE file in the project root for details.
 */

import { Editor } from '@tiptap/core';
import { buildOutlineFromEditor } from '../utils/outline';
import { scrollToHeading } from '../utils/scrollToHeading';
import * as l10n from '../l10n';

/**
 * TOC Overlay state
 */
let tocOverlayElement: HTMLElement | null = null;
let isVisible = false;
let savedSelection: { from: number; to: number } | null = null;
let savedScrollTop = 0;

/**
 * Create the TOC overlay element
 */
export function createTocOverlay(editor: Editor): HTMLElement {
  // Create overlay container
  const overlay = document.createElement('div');
  overlay.className = 'toc-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-label', l10n.t('Document outline'));
  overlay.setAttribute('aria-modal', 'true');

  // Create backdrop
  const backdrop = document.createElement('div');
  backdrop.className = 'toc-overlay-backdrop';
  backdrop.onclick = () => hideTocOverlay(editor);

  // Create content panel
  const panel = document.createElement('div');
  panel.className = 'toc-overlay-panel';

  // Create header
  const header = document.createElement('div');
  header.className = 'toc-overlay-header';
  header.innerHTML = `
    <h2 class="toc-overlay-title">${l10n.html('Document Outline')}</h2>
    <button class="toc-overlay-close" aria-label="${l10n.html('Close outline')}" title="${l10n.html('Close (Esc)')}">×</button>
  `;

  const closeBtn = header.querySelector('.toc-overlay-close') as HTMLElement;
  closeBtn.onclick = () => hideTocOverlay(editor);

  // Create list container
  const listContainer = document.createElement('div');
  listContainer.className = 'toc-overlay-list';
  listContainer.setAttribute('role', 'list');

  panel.appendChild(header);
  panel.appendChild(listContainer);
  overlay.appendChild(backdrop);
  overlay.appendChild(panel);

  // Handle keyboard navigation
  overlay.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      hideTocOverlay(editor);
    }
  });

  document.body.appendChild(overlay);
  tocOverlayElement = overlay;

  return overlay;
}

/**
 * Render the TOC list items
 */
function renderTocList(editor: Editor, listContainer: HTMLElement): void {
  const outline = buildOutlineFromEditor(editor);

  listContainer.innerHTML = '';

  if (outline.length === 0) {
    // Show empty state message
    const emptyMessage = document.createElement('div');
    emptyMessage.className = 'toc-overlay-empty';
    const headingSample = '<code># Heading</code>'; // Markdown syntax, not text to translate
    emptyMessage.innerHTML = `
      <p>${l10n.html('No headings yet.')}</p>
      <p class="toc-overlay-empty-hint">${l10n.html('Add {0} to see your document outline.').replace('{0}', headingSample)}</p>
    `;
    listContainer.appendChild(emptyMessage);
    return;
  }

  // Render heading items
  outline.forEach((entry, index) => {
    const item = document.createElement('button');
    item.className = `toc-overlay-item toc-overlay-level-${entry.level}`;
    item.setAttribute('role', 'listitem');
    item.setAttribute('data-pos', String(entry.pos));
    item.setAttribute('tabindex', '0');

    // Create text content
    const textContent = document.createElement('span');
    textContent.className = 'toc-overlay-item-text';
    textContent.textContent = entry.text || l10n.t('(Untitled)');

    // Append text content only (no level indicator)
    item.appendChild(textContent);

    // Handle click to navigate
    item.onclick = () => {
      navigateToHeading(editor, entry.pos);
    };

    // Handle Enter key
    item.onkeydown = (e: KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        navigateToHeading(editor, entry.pos);
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        const nextItem = listContainer.children[index + 1] as HTMLElement;
        if (nextItem) nextItem.focus();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        const prevItem = listContainer.children[index - 1] as HTMLElement;
        if (prevItem) prevItem.focus();
      }
    };

    listContainer.appendChild(item);
  });
}

/**
 * Navigate to a heading position
 */
function navigateToHeading(editor: Editor, pos: number): void {
  hideTocOverlay(editor, false);
  scrollToHeading(editor, pos);
}

/**
 * Show the TOC overlay
 */
export function showTocOverlay(editor: Editor): void {
  if (!tocOverlayElement) {
    createTocOverlay(editor);
  }

  if (!tocOverlayElement) return;

  // Save current selection and scroll position
  const { from, to } = editor.state.selection;
  savedSelection = { from, to };
  savedScrollTop = document.documentElement.scrollTop;

  // Render the list
  const listContainer = tocOverlayElement.querySelector('.toc-overlay-list') as HTMLElement;
  if (listContainer) {
    renderTocList(editor, listContainer);
  }

  // Show overlay
  tocOverlayElement.classList.add('visible');
  isVisible = true;

  // Focus first item or close button
  requestAnimationFrame(() => {
    const firstItem = tocOverlayElement?.querySelector('.toc-overlay-item') as HTMLElement;
    if (firstItem) {
      firstItem.focus();
    } else {
      const closeBtn = tocOverlayElement?.querySelector('.toc-overlay-close') as HTMLElement;
      if (closeBtn) closeBtn.focus();
    }
  });
}

/**
 * Hide the TOC overlay
 */
export function hideTocOverlay(editor: Editor, restorePosition = true): void {
  if (!tocOverlayElement) return;

  tocOverlayElement.classList.remove('visible');
  isVisible = false;

  // Restore previous position if requested
  if (restorePosition && savedSelection) {
    try {
      editor.commands.setTextSelection(savedSelection);
      document.documentElement.scrollTop = savedScrollTop;
    } catch {
      // Ignore errors restoring position
    }
  }

  // Focus editor
  editor.commands.focus();
}

/**
 * Toggle the TOC overlay
 */
export function toggleTocOverlay(editor: Editor): void {
  if (isVisible) {
    hideTocOverlay(editor);
  } else {
    showTocOverlay(editor);
  }
}

/**
 * Check if TOC overlay is visible
 */
export function isTocVisible(): boolean {
  return isVisible;
}
