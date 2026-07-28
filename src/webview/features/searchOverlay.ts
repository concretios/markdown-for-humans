/**
 * Copyright (c) 2025-2026 Concret.io
 *
 * Licensed under the MIT License. See LICENSE file in the project root for details.
 */

import { Editor } from '@tiptap/core';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { Plugin, PluginKey } from '@tiptap/pm/state';

/**
 * Search Overlay - In-document search for Markdown for Humans
 *
 * Provides a search experience with:
 * - Real-time match highlighting
 * - Navigation between matches (next/previous)
 * - Visual match counter
 * - Keyboard shortcuts (Enter: next, Shift+Enter: previous, Escape: close)
 */

// Plugin key for search decorations
const searchPluginKey = new PluginKey('search-highlight');

// Search state
let searchOverlayElement: HTMLElement | null = null;
let isVisible = false;
let savedSelection: { from: number; to: number } | null = null;
let savedScrollPosition: { x: number; y: number } | null = null;
let currentQuery = '';
let currentMatches: Array<{ from: number; to: number }> = [];
let currentMatchIndex = -1;
let searchPlugin: Plugin | null = null;
let focusRequestId = 0;
const SCROLL_CHANGE_EPSILON = 1;
const isOverlayInDom = () =>
  Boolean(searchOverlayElement && document.body.contains(searchOverlayElement));

function getWindowScrollPosition(): { x: number; y: number } {
  return {
    x: typeof window.scrollX === 'number' ? window.scrollX : window.pageXOffset || 0,
    y: typeof window.scrollY === 'number' ? window.scrollY : window.pageYOffset || 0,
  };
}

function hasScrolledSinceSearchOpened(): boolean {
  if (!savedScrollPosition) {
    return false;
  }

  const currentScrollPosition = getWindowScrollPosition();
  return (
    Math.abs(currentScrollPosition.x - savedScrollPosition.x) > SCROLL_CHANGE_EPSILON ||
    Math.abs(currentScrollPosition.y - savedScrollPosition.y) > SCROLL_CHANGE_EPSILON
  );
}

function focusEditor(editor: Editor, preventScroll: boolean) {
  if (preventScroll) {
    editor.commands.focus(undefined, { scrollIntoView: false });
    return;
  }

  editor.commands.focus();
}

/**
 * Create the search plugin for decorations
 */
function createSearchPlugin(): Plugin {
  return new Plugin({
    key: searchPluginKey,
    state: {
      init() {
        return DecorationSet.empty;
      },
      apply(tr, oldState) {
        // Check for search meta update
        const searchMeta = tr.getMeta(searchPluginKey);
        if (searchMeta !== undefined) {
          return searchMeta;
        }
        // Map decorations through document changes
        return oldState.map(tr.mapping, tr.doc);
      },
    },
    props: {
      decorations(state) {
        return this.getState(state);
      },
    },
  });
}

/**
 * Find all matches in the document
 */
export function findMatches(editor: Editor, query: string): Array<{ from: number; to: number }> {
  if (!query || query.length === 0) {
    return [];
  }

  const matches: Array<{ from: number; to: number }> = [];
  const doc = editor.state.doc;
  const lowerQuery = query.toLowerCase();

  doc.descendants((node, pos) => {
    if (node.isText && node.text) {
      const text = node.text.toLowerCase();
      let index = 0;

      while ((index = text.indexOf(lowerQuery, index)) !== -1) {
        matches.push({
          from: pos + index,
          to: pos + index + query.length,
        });
        index += 1; // Move forward to find overlapping matches
      }
    }
    return true;
  });

  return matches;
}

/**
 * Apply search highlighting decorations
 */
function applySearchDecorations(
  editor: Editor,
  matches: Array<{ from: number; to: number }>,
  activeIndex: number
) {
  try {
    const decorations: Decoration[] = [];

    matches.forEach((match, index) => {
      const isActive = index === activeIndex;
      decorations.push(
        Decoration.inline(match.from, match.to, {
          class: isActive ? 'search-match search-match-active' : 'search-match',
        })
      );
    });

    const decorationSet =
      decorations.length > 0
        ? DecorationSet.create(editor.state.doc, decorations)
        : DecorationSet.empty;

    // Dispatch transaction with search decorations
    const tr = editor.state.tr.setMeta(searchPluginKey, decorationSet);
    editor.view.dispatch(tr);
  } catch (error) {
    console.warn('[MD4H] Skipping search decorations:', error);
  }
}

/**
 * Clear search decorations
 */
function clearSearchDecorations(editor: Editor) {
  try {
    const tr = editor.state.tr.setMeta(searchPluginKey, DecorationSet.empty);
    editor.view.dispatch(tr);
  } catch {
    // Safe no-op in tests or when PM state isn't available
  }
}

/**
 * Ensure search plugin is registered
 */
function ensureSearchPlugin(editor: Editor) {
  // Check if plugin already exists
  const existingPlugin = editor.state.plugins.find(p => p.spec.key === searchPluginKey);
  if (!existingPlugin) {
    searchPlugin = createSearchPlugin();
    editor.registerPlugin(searchPlugin);
  }
}

/**
 * Scroll to a match position
 */
function scrollToMatch(editor: Editor, match: { from: number; to: number }) {
  const shouldRefocusInput = isVisible;

  // Set selection to the match
  editor.commands.setTextSelection({ from: match.from, to: match.to });

  // Ensure the position is scrolled into view (ProseMirror + DOM fallback)
  try {
    editor.view.dispatch(editor.state.tr.scrollIntoView());
  } catch {
    // ignore
  }

  // Scroll match into view - try element.scrollIntoView first, fallback to window.scrollTo
  const coords = editor.view.coordsAtPos(match.from);
  if (coords) {
    const domAtPos = editor.view.domAtPos(match.from);
    const node = domAtPos?.node as Node | null;
    const element =
      (node?.nodeType === Node.TEXT_NODE ? node.parentElement : (node as HTMLElement | null)) ||
      null;

    if (element && typeof element.scrollIntoView === 'function') {
      element.scrollIntoView({ behavior: 'smooth', block: 'center' });
    } else {
      // Fallback when scrollIntoView is unavailable
      const y = coords.top + window.scrollY - window.innerHeight * 0.3;
      window.scrollTo({ top: y, behavior: 'smooth' });
    }
  }

  // Return focus to the search input when the overlay is visible
  if (shouldRefocusInput) {
    focusSearchInput(false);
  }
}

/**
 * Update match counter display
 */
function updateMatchCounter(searchInput: HTMLInputElement) {
  const counter = searchOverlayElement?.querySelector('.search-overlay-counter') as HTMLElement;
  if (!counter) return;

  if (currentMatches.length === 0 && currentQuery.length > 0) {
    counter.textContent = 'No results';
    counter.classList.add('no-results');
    searchInput.classList.add('no-results');
  } else if (currentMatches.length > 0) {
    counter.textContent = `${currentMatchIndex + 1} of ${currentMatches.length}`;
    counter.classList.remove('no-results');
    searchInput.classList.remove('no-results');
  } else {
    counter.textContent = '';
    counter.classList.remove('no-results');
    searchInput.classList.remove('no-results');
  }
}

/**
 * Perform search and update UI
 */
function performSearch(editor: Editor, query: string) {
  currentQuery = query;
  currentMatches = findMatches(editor, query);
  currentMatchIndex = currentMatches.length > 0 ? 0 : -1;

  applySearchDecorations(editor, currentMatches, currentMatchIndex);

  const searchInput = searchOverlayElement?.querySelector(
    '.search-overlay-input'
  ) as HTMLInputElement;
  if (searchInput) {
    updateMatchCounter(searchInput);
  }

  // Scroll to first match
  if (currentMatches.length > 0 && currentMatchIndex >= 0) {
    scrollToMatch(editor, currentMatches[currentMatchIndex]);
  }
}

/**
 * Navigate to next match
 */
function goToNextMatch(editor: Editor) {
  if (currentMatches.length === 0) return;

  currentMatchIndex = (currentMatchIndex + 1) % currentMatches.length;
  applySearchDecorations(editor, currentMatches, currentMatchIndex);
  scrollToMatch(editor, currentMatches[currentMatchIndex]);

  const searchInput = searchOverlayElement?.querySelector(
    '.search-overlay-input'
  ) as HTMLInputElement;
  if (searchInput) {
    updateMatchCounter(searchInput);
  }
}

/**
 * Navigate to previous match
 */
function goToPreviousMatch(editor: Editor) {
  if (currentMatches.length === 0) return;

  currentMatchIndex = (currentMatchIndex - 1 + currentMatches.length) % currentMatches.length;
  applySearchDecorations(editor, currentMatches, currentMatchIndex);
  scrollToMatch(editor, currentMatches[currentMatchIndex]);

  const searchInput = searchOverlayElement?.querySelector(
    '.search-overlay-input'
  ) as HTMLInputElement;
  if (searchInput) {
    updateMatchCounter(searchInput);
  }
}

/**
 * Create the search overlay element
 */
export function createSearchOverlay(editor: Editor): HTMLElement {
  // Create overlay container
  const overlay = document.createElement('div');
  overlay.className = 'search-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-label', 'Find in document');
  overlay.setAttribute('aria-modal', 'false');

  // Create panel (positioned at top)
  const panel = document.createElement('div');
  panel.className = 'search-overlay-panel';

  // Create input wrapper
  const inputWrapper = document.createElement('div');
  inputWrapper.className = 'search-overlay-input-wrapper';

  // Search icon
  const searchIcon = document.createElement('span');
  searchIcon.className = 'search-overlay-icon codicon codicon-search';
  searchIcon.setAttribute('aria-hidden', 'true');

  // Search input
  const searchInput = document.createElement('input');
  searchInput.type = 'text';
  searchInput.className = 'search-overlay-input';
  searchInput.placeholder = 'Find in document...';
  searchInput.setAttribute('aria-label', 'Search query');
  searchInput.spellcheck = false;

  // Match counter
  const counter = document.createElement('span');
  counter.className = 'search-overlay-counter';
  counter.setAttribute('aria-live', 'polite');

  inputWrapper.appendChild(searchIcon);
  inputWrapper.appendChild(searchInput);
  inputWrapper.appendChild(counter);

  // Create button wrapper
  const buttonWrapper = document.createElement('div');
  buttonWrapper.className = 'search-overlay-buttons';

  // Previous button
  const prevBtn = document.createElement('button');
  prevBtn.className = 'search-overlay-btn';
  prevBtn.innerHTML = '<span class="codicon codicon-arrow-up"></span>';
  prevBtn.title = 'Previous match (Shift+Enter)';
  prevBtn.setAttribute('aria-label', 'Previous match');
  prevBtn.onclick = e => {
    e.preventDefault();
    goToPreviousMatch(editor);
    searchInput.focus();
  };

  // Next button
  const nextBtn = document.createElement('button');
  nextBtn.className = 'search-overlay-btn';
  nextBtn.innerHTML = '<span class="codicon codicon-arrow-down"></span>';
  nextBtn.title = 'Next match (Enter)';
  nextBtn.setAttribute('aria-label', 'Next match');
  nextBtn.onclick = e => {
    e.preventDefault();
    goToNextMatch(editor);
    searchInput.focus();
  };

  // Close button
  const closeBtn = document.createElement('button');
  closeBtn.className = 'search-overlay-btn search-overlay-close';
  closeBtn.innerHTML = '<span class="codicon codicon-close"></span>';
  closeBtn.title = 'Close (Escape)';
  closeBtn.setAttribute('aria-label', 'Close search');
  closeBtn.onclick = () => hideSearchOverlay(editor);

  buttonWrapper.appendChild(prevBtn);
  buttonWrapper.appendChild(nextBtn);
  buttonWrapper.appendChild(closeBtn);

  panel.appendChild(inputWrapper);
  panel.appendChild(buttonWrapper);
  overlay.appendChild(panel);

  // Handle input changes
  searchInput.addEventListener('input', () => {
    performSearch(editor, searchInput.value);
  });

  // Handle keyboard navigation
  searchInput.addEventListener('keydown', (e: KeyboardEvent) => {
    const isMod = e.metaKey || e.ctrlKey;

    // Allow Cmd/Ctrl+A to select all text within the input
    if (isMod && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      e.stopPropagation();
      searchInput.select();
      return;
    }

    if (e.key === 'Escape') {
      e.preventDefault();
      hideSearchOverlay(editor);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (e.shiftKey) {
        goToPreviousMatch(editor);
      } else {
        goToNextMatch(editor);
      }
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      goToNextMatch(editor);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      goToPreviousMatch(editor);
    }
  });

  // Prevent keydown events from propagating to editor, but allow standard text shortcuts in the input
  overlay.addEventListener('keydown', (e: KeyboardEvent) => {
    // Let the input handle its own shortcuts (Cmd/Ctrl+A etc.)
    if (document.activeElement === searchInput) {
      return;
    }
    // Allow Tab for accessibility
    if (e.key !== 'Tab') {
      e.stopPropagation();
    }
  });

  document.body.appendChild(overlay);
  searchOverlayElement = overlay;

  return overlay;
}

function focusSearchInput(selectText = true) {
  const requestId = ++focusRequestId;
  let attempts = 0;
  let initialValue: string | null = null;
  const maxAttempts = 6;

  const scheduleNextAttempt = () => {
    if (typeof window.requestAnimationFrame === 'function') {
      window.requestAnimationFrame(applyFocus);
    } else {
      window.setTimeout(applyFocus, 16);
    }
  };

  const applyFocus = () => {
    if (!isVisible || !isOverlayInDom()) return;
    if (requestId !== focusRequestId) return;

    const searchInput = searchOverlayElement?.querySelector(
      '.search-overlay-input'
    ) as HTMLInputElement | null;
    if (!searchInput) return;
    if (initialValue === null) {
      initialValue = searchInput.value;
    }

    if (document.activeElement !== searchInput) {
      searchInput.focus({ preventScroll: true });
    }
    if (
      selectText &&
      searchInput.value === initialValue &&
      document.activeElement === searchInput
    ) {
      searchInput.select();
    }

    attempts += 1;
    if (document.activeElement !== searchInput && attempts < maxAttempts) {
      scheduleNextAttempt();
    }
  };

  applyFocus();
  // TipTap and Chromium can both settle focus after the keyboard event that opens find.
  // Verify on the next frame even when immediate focus initially succeeds.
  scheduleNextAttempt();
}

/**
 * Show the search overlay
 */
export function showSearchOverlay(editor: Editor): void {
  // Ensure search plugin is registered
  ensureSearchPlugin(editor);
  const wasVisible = isVisible && isOverlayInDom();

  if (!isOverlayInDom()) {
    searchOverlayElement = null;
    createSearchOverlay(editor);
  }

  if (!searchOverlayElement) return;

  // Save current selection
  const { from, to } = editor.state.selection;
  savedSelection = { from, to };
  savedScrollPosition = getWindowScrollPosition();

  // Get selected text as initial query
  const selectedText = editor.state.doc.textBetween(from, to, ' ');

  // Show overlay
  searchOverlayElement.classList.add('visible');
  isVisible = true;

  if (wasVisible) {
    focusSearchInput();
    return;
  }

  // Focus input and set selected text
  const searchInput = searchOverlayElement.querySelector(
    '.search-overlay-input'
  ) as HTMLInputElement;
  if (searchInput) {
    if (selectedText && selectedText.length > 0 && selectedText.length < 100) {
      searchInput.value = selectedText;
      performSearch(editor, selectedText);
    }
  }

  // Always focus the input when opening (even if already visible)
  focusSearchInput();
}

/**
 * Hide the search overlay
 */
export function hideSearchOverlay(editor: Editor, restorePosition = true): void {
  if (!searchOverlayElement) return;

  const hadActiveMatch = currentMatches.length > 0 && currentMatchIndex >= 0;
  const shouldPreventFocusScroll = restorePosition && hasScrolledSinceSearchOpened();

  searchOverlayElement.classList.remove('visible');
  isVisible = false;

  // Clear search state
  currentQuery = '';
  currentMatches = [];
  currentMatchIndex = -1;

  // Clear decorations
  clearSearchDecorations(editor);

  // Clear input
  const searchInput = searchOverlayElement.querySelector(
    '.search-overlay-input'
  ) as HTMLInputElement;
  if (searchInput) {
    searchInput.value = '';
  }

  // Clear counter
  const counter = searchOverlayElement.querySelector('.search-overlay-counter') as HTMLElement;
  if (counter) {
    counter.textContent = '';
    counter.classList.remove('no-results');
  }
  if (searchInput) {
    searchInput.classList.remove('no-results');
  }

  // Restore previous position only when search did not navigate to a match.
  // When a match is active, leaving the match selected avoids snapping scroll
  // back to the stale cursor location from before find opened.
  if (restorePosition && !hadActiveMatch && !shouldPreventFocusScroll && savedSelection) {
    try {
      editor.commands.setTextSelection(savedSelection);
    } catch {
      // Ignore errors restoring position
    }
  }

  focusEditor(editor, shouldPreventFocusScroll);
  savedSelection = null;
  savedScrollPosition = null;
}

/**
 * Toggle the search overlay
 */
export function toggleSearchOverlay(editor: Editor): void {
  if (isVisible) {
    hideSearchOverlay(editor);
  } else {
    showSearchOverlay(editor);
  }
}

/**
 * Check if search overlay is visible
 */
export function isSearchVisible(): boolean {
  return isVisible;
}

/**
 * Get current search matches (for testing)
 */
export function getCurrentMatches(): Array<{ from: number; to: number }> {
  return currentMatches;
}

/**
 * Get current match index (for testing)
 */
export function getCurrentMatchIndex(): number {
  return currentMatchIndex;
}
