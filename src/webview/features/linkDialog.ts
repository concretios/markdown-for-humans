/**
 * Copyright (c) 2025-2026 Concret.io
 *
 * Licensed under the MIT License. See LICENSE file in the project root for details.
 */

/**
 * @file linkDialog.ts - Link insertion/editing dialog UI
 * @description Provides a modal dialog for inserting and editing hyperlinks.
 */
import { getMarkRange, Editor } from '@tiptap/core';
import { TextSelection } from '@tiptap/pm/state';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { buildOutlineFromEditor } from '../utils/outline';

type Range = { from: number; to: number };
type ParentContext = { parentStart: number; parentText: string };
type LinkMode = 'url' | 'file' | 'headings';

interface FileFilterState {
  all: boolean;
  md: boolean;
  images: boolean;
  code: boolean;
  config: boolean;
}

interface FileSearchResult {
  filename: string;
  path: string;
}

interface HeadingResult {
  text: string;
  level: number;
  slug: string;
}

/**
 * Link Dialog state
 */
let linkDialogElement: HTMLElement | null = null;
let isVisible = false;
let currentEditor: Editor | null = null;
let workingRange: Range | null = null;
let initialLinkRange: Range | null = null;
let previousSelection: Range | null = null;
let shouldRestoreSelectionOnHide = true;

// Enhanced dialog state
let currentMode: LinkMode = 'url';
let filterState: FileFilterState = { all: true, md: true, images: true, code: true, config: true };
let autocompleteDropdown: HTMLElement | null = null;
let selectedAutocompleteIndex: number | null = null;
let fileSearchDebounceTimer: ReturnType<typeof setTimeout> | null = null;
let fileSearchRequestId = 0;
let actualLinkPath: string | null = null; // Store actual path separately from displayed value

const isWhitespace = (char: string) => /\s/.test(char);

/**
 * Generate GFM-style slug from heading text with duplicate handling
 */
function generateHeadingSlug(text: string, existingSlugs: Set<string>): string {
  const slug = text
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^\w-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

  let finalSlug = slug;
  let counter = 1;
  while (existingSlugs.has(finalSlug)) {
    finalSlug = `${slug}-${counter}`;
    counter++;
  }

  existingSlugs.add(finalSlug);
  return finalSlug;
}

/**
 * Load filter state from localStorage
 */
function loadFilterState(): FileFilterState {
  try {
    const stored = localStorage.getItem('markdownForHumans.linkFileFilters');
    if (stored) {
      const parsed = JSON.parse(stored) as Partial<FileFilterState>;
      return {
        all: typeof parsed.all === 'boolean' ? parsed.all : true,
        md: typeof parsed.md === 'boolean' ? parsed.md : true,
        images: typeof parsed.images === 'boolean' ? parsed.images : true,
        code: typeof parsed.code === 'boolean' ? parsed.code : true,
        config: typeof parsed.config === 'boolean' ? parsed.config : true,
      };
    }
  } catch (error) {
    console.warn('[MD4H] Failed to load filter state from localStorage', error);
  }
  return { all: true, md: true, images: true, code: true, config: true };
}

/**
 * Save filter state to localStorage
 */
function saveFilterState(state: FileFilterState): void {
  try {
    localStorage.setItem('markdownForHumans.linkFileFilters', JSON.stringify(state));
  } catch (error) {
    console.warn('[MD4H] Failed to save filter state to localStorage', error);
  }
}

/**
 * Close autocomplete dropdown
 */
function closeAutocomplete(): void {
  if (autocompleteDropdown) {
    autocompleteDropdown.style.display = 'none';
    selectedAutocompleteIndex = null;
  }
}

/**
 * Escape HTML to prevent XSS
 */
function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

const getParentContext = (
  range: Range | null,
  doc: ProseMirrorNode | null
): ParentContext | null => {
  if (!range) return null;
  if (typeof doc?.resolve !== 'function') return null;
  const $from = doc.resolve(range.from);
  const $to = doc.resolve(Math.max(range.to - 1, range.from));
  if ($from.depth !== $to.depth || $from.parent !== $to.parent) return null;
  const parentStart = $from.start($from.depth);
  const parentText = $from.parent.textContent;
  return { parentStart, parentText };
};

const clampOffset = (offset: number, max: number) => Math.max(0, Math.min(offset, max));

const findPrevWordStart = (text: string, offset: number) => {
  let i = clampOffset(offset, text.length) - 1;
  while (i >= 0 && isWhitespace(text[i])) i--;
  while (i >= 0 && !isWhitespace(text[i])) i--;
  return i + 1;
};

const findNextWordStart = (text: string, offset: number) => {
  let i = clampOffset(offset, text.length);
  while (i < text.length && !isWhitespace(text[i])) i++;
  while (i < text.length && isWhitespace(text[i])) i++;
  return i;
};

const findNextWordEnd = (text: string, offset: number) => {
  let i = clampOffset(offset, text.length);
  while (i < text.length && isWhitespace(text[i])) i++;
  while (i < text.length && !isWhitespace(text[i])) i++;
  return i;
};

const trimTrailingWhitespace = (text: string, offset: number) => {
  let i = clampOffset(offset, text.length);
  while (i > 0 && isWhitespace(text[i - 1])) i--;
  return i;
};

const updateTextInputFromRange = (textInput: HTMLInputElement) => {
  if (!currentEditor || !workingRange) return;
  const { doc } = currentEditor.state;
  textInput.value = doc.textBetween(workingRange.from, workingRange.to, ' ');
};

const adjustLinkBoundary = (
  direction: 'left' | 'right',
  action: 'expand' | 'shrink',
  textInput: HTMLInputElement
) => {
  if (!currentEditor || !workingRange) return;

  const { doc } = currentEditor.state;
  const context = getParentContext(workingRange, doc);
  if (!context) return;

  const { parentStart, parentText } = context;
  const relFrom = clampOffset(workingRange.from - parentStart, parentText.length);
  const relTo = clampOffset(workingRange.to - parentStart, parentText.length);

  let newFrom = workingRange.from;
  let newTo = workingRange.to;

  if (direction === 'left' && action === 'expand') {
    newFrom = parentStart + findPrevWordStart(parentText, relFrom);
  } else if (direction === 'left' && action === 'shrink') {
    const nextStart = parentStart + findNextWordStart(parentText, relFrom);
    if (nextStart < newTo) {
      newFrom = nextStart;
    }
  } else if (direction === 'right' && action === 'expand') {
    newTo = parentStart + findNextWordEnd(parentText, relTo);
  } else if (direction === 'right' && action === 'shrink') {
    const startOfLastWord = findPrevWordStart(parentText, relTo);
    const boundary = parentStart + trimTrailingWhitespace(parentText, startOfLastWord);
    if (boundary > newFrom) {
      newTo = boundary;
    }
  }

  if (newFrom >= newTo) return;
  if (newFrom === workingRange.from && newTo === workingRange.to) return;

  workingRange = { from: newFrom, to: newTo };
  updateTextInputFromRange(textInput);
  setSelectionHighlight(workingRange);
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const findNearestTextRange = (text: string, range: Range, doc: any): Range | null => {
  if (!text) return null;
  const context = getParentContext(range, doc);
  if (!context) return null;

  const { parentStart, parentText } = context;
  const matches: Range[] = [];
  let index = parentText.indexOf(text);

  while (index !== -1) {
    matches.push({ from: parentStart + index, to: parentStart + index + text.length });
    index = parentText.indexOf(text, index + text.length);
  }

  if (!matches.length) return null;

  const distance = (candidate: Range) =>
    Math.abs(candidate.from - range.from) + Math.abs(candidate.to - range.to);

  return matches.sort((a, b) => distance(a) - distance(b))[0] || null;
};

const applyLinkAtRange = (url: string, text: string) => {
  if (!currentEditor) return;

  const { state } = currentEditor;
  const { doc, schema } = state;
  const linkType = schema.marks.link;
  if (!linkType) return;

  const baseRange: Range = workingRange || { from: state.selection.from, to: state.selection.to };
  const trimmedText = text.trim();
  const hasText = Boolean(trimmedText);

  let targetRange: Range = baseRange;
  let shouldReplaceText = false;

  if (hasText) {
    const nearest = findNearestTextRange(trimmedText, baseRange, doc);
    if (nearest) {
      targetRange = nearest;
    } else {
      shouldReplaceText = true;
    }
  }

  if (targetRange.from === targetRange.to && !hasText) {
    return; // Nothing to link
  }

  const tr = state.tr;

  const clearFrom = initialLinkRange
    ? Math.min(initialLinkRange.from, targetRange.from)
    : targetRange.from;
  const clearTo = initialLinkRange ? Math.max(initialLinkRange.to, targetRange.to) : targetRange.to;

  tr.removeMark(clearFrom, clearTo, linkType);

  let finalTo = targetRange.to;
  if (hasText && shouldReplaceText) {
    tr.insertText(trimmedText, targetRange.from, targetRange.to);
    finalTo = targetRange.from + trimmedText.length;
  } else if (hasText) {
    finalTo = targetRange.to;
  }

  tr.addMark(targetRange.from, finalTo, linkType.create({ href: url }));
  tr.setSelection(TextSelection.create(tr.doc, targetRange.from, finalTo));

  workingRange = { from: targetRange.from, to: finalTo };

  currentEditor.view.dispatch(tr);
  currentEditor.view.focus();
};

const clearWorkingRanges = () => {
  workingRange = null;
  initialLinkRange = null;
  previousSelection = null;
  shouldRestoreSelectionOnHide = true;
};

function focusEditor(editor: Editor | null) {
  try {
    const chain = editor?.chain?.();
    const maybeFocused = typeof chain?.focus === 'function' ? chain.focus() : chain;
    if (typeof maybeFocused?.run === 'function') {
      maybeFocused.run();
    }
  } catch (error) {
    console.warn('[MD4H] Failed to restore focus to editor after link dialog', error);
  }
}

const setSelectionHighlight = (range: Range | null) => {
  if (!currentEditor || !range) return;
  try {
    currentEditor.commands.setTextSelection({ from: range.from, to: range.to });
  } catch (error) {
    console.warn('[MD4H] Failed to set selection highlight for link dialog', error);
  }
};

/**
 * Center the modal dialog on screen
 */
const centerModal = (panel: HTMLElement) => {
  panel.style.position = 'fixed';
  panel.style.top = '50%';
  panel.style.left = '50%';
  panel.style.transform = 'translate(-50%, -50%)';
  panel.style.margin = '0';
};

// Note: Resize/scroll listeners removed - modal uses fixed positioning (centerModal)
// which doesn't need repositioning on window resize/scroll

/**
 * Create autocomplete dropdown element
 */
function createAutocompleteDropdown(urlInput: HTMLInputElement): HTMLElement {
  const dropdown = document.createElement('div');
  dropdown.className = 'link-dialog-autocomplete';
  dropdown.style.display = 'none';
  dropdown.setAttribute('role', 'listbox');

  const updatePosition = () => {
    if (!urlInput || !dropdown) return;
    const inputRect = urlInput.getBoundingClientRect();
    const dialogPanel = urlInput.closest('.export-settings-overlay-panel') as HTMLElement;

    if (dialogPanel) {
      // Position relative to dialog panel - ensure dropdown stays within dialog bounds
      const panelRect = dialogPanel.getBoundingClientRect();
      const relativeTop = inputRect.bottom - panelRect.top + 4;
      const relativeLeft = inputRect.left - panelRect.left;

      // Calculate available space from input to bottom of modal
      const availableHeight = panelRect.bottom - inputRect.bottom - 8; // 8px padding from bottom
      const maxDropdownHeight = Math.min(300, Math.max(150, availableHeight)); // At least 150px, max 300px

      dropdown.style.position = 'absolute';
      dropdown.style.top = `${relativeTop}px`;
      dropdown.style.left = `${relativeLeft}px`;
      dropdown.style.maxHeight = `${maxDropdownHeight}px`;

      // Limit width to not exceed dialog panel width
      const maxWidth = Math.min(520, inputRect.width, panelRect.width - relativeLeft - 8);
      dropdown.style.width = `${maxWidth}px`;
      dropdown.style.maxWidth = `${maxWidth}px`;
    } else {
      // Fallback: position relative to viewport
      dropdown.style.position = 'fixed';
      dropdown.style.top = `${inputRect.bottom + 4}px`;
      dropdown.style.left = `${inputRect.left}px`;
      dropdown.style.width = `${Math.min(520, inputRect.width)}px`;
      dropdown.style.maxHeight = '300px';
    }
  };

  // Update position when input is focused or when dropdown is shown
  urlInput.addEventListener('focus', updatePosition);
  window.addEventListener('resize', updatePosition);
  window.addEventListener('scroll', updatePosition, true);

  // Store update function for later use
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (dropdown as any)._updatePosition = updatePosition;

  return dropdown;
}

/**
 * Update autocomplete dropdown with results
 */
function updateAutocompleteDropdown(
  dropdown: HTMLElement,
  results: (FileSearchResult | HeadingResult)[],
  urlInput: HTMLInputElement
): void {
  dropdown.innerHTML = '';
  selectedAutocompleteIndex = null;

  if (results.length === 0) {
    const emptyMsg = document.createElement('div');
    emptyMsg.className = 'link-dialog-autocomplete-empty';
    emptyMsg.textContent =
      currentMode === 'file' ? 'No files found' : 'No headings in this document';
    dropdown.appendChild(emptyMsg);
    dropdown.style.display = 'block';
    return;
  }

  results.forEach((result, index) => {
    const item = document.createElement('div');
    item.className = 'link-dialog-autocomplete-item';
    item.setAttribute('role', 'option');
    item.setAttribute('data-index', index.toString());

    if (currentMode === 'file') {
      const fileResult = result as FileSearchResult;
      item.className = 'link-dialog-autocomplete-item link-dialog-autocomplete-item-file';
      item.innerHTML = `
        <div class="link-dialog-autocomplete-content">
          <div class="link-dialog-autocomplete-filename">${escapeHtml(fileResult.filename)}</div>
          <div class="link-dialog-autocomplete-item-path" title="${escapeHtml(fileResult.path)}">${escapeHtml(fileResult.path)}</div>
        </div>
      `;
      item.onclick = () => {
        // Normalize path: use forward slashes and ensure it starts with ./ for relative paths
        let normalizedPath = fileResult.path.replace(/\\/g, '/');

        // Ensure relative paths start with ./ (unless already starting with ./ or ../ or absolute)
        if (
          !normalizedPath.startsWith('./') &&
          !normalizedPath.startsWith('../') &&
          !normalizedPath.startsWith('/') &&
          !normalizedPath.match(/^[A-Za-z]:/)
        ) {
          // Not Windows absolute path
          normalizedPath = './' + normalizedPath;
        }

        // Store actual path internally
        actualLinkPath = normalizedPath;
        // Show only filename in URL input
        urlInput.value = fileResult.filename;
        closeAutocomplete();
        urlInput.focus();
      };
    } else {
      const headingResult = result as HeadingResult;
      // Truncate long heading text for display
      const maxHeadingLength = 60;
      const displayText =
        headingResult.text.length > maxHeadingLength
          ? headingResult.text.substring(0, maxHeadingLength) + '...'
          : headingResult.text;

      item.className = 'link-dialog-autocomplete-item link-dialog-autocomplete-item-heading';
      item.innerHTML = `
        <div class="link-dialog-autocomplete-content">
          <div class="link-dialog-autocomplete-filename" title="${escapeHtml(headingResult.text)}">
            ${escapeHtml(displayText)}<span class="link-dialog-autocomplete-level"> : H${headingResult.level}</span>
          </div>
        </div>
      `;
      item.onclick = () => {
        // Store actual slug path internally
        actualLinkPath = `#${headingResult.slug}`;
        // Show only heading text (truncated if needed) in URL input
        const displayText =
          headingResult.text.length > 50
            ? headingResult.text.substring(0, 50) + '...'
            : headingResult.text;
        urlInput.value = displayText;
        closeAutocomplete();
        urlInput.focus();
      };
    }

    item.onmouseenter = () => {
      selectedAutocompleteIndex = index;
      updateAutocompleteHighlight(dropdown);
    };

    dropdown.appendChild(item);
  });

  dropdown.style.display = 'block';

  // Update position when showing results
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if ((dropdown as any)._updatePosition) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (dropdown as any)._updatePosition();
  }

  updateAutocompleteHighlight(dropdown);
}

/**
 * Update highlight for selected autocomplete item
 */
function updateAutocompleteHighlight(dropdown: HTMLElement): void {
  const items = dropdown.querySelectorAll('.link-dialog-autocomplete-item');
  items.forEach((item, index) => {
    if (index === selectedAutocompleteIndex) {
      item.classList.add('link-dialog-autocomplete-item-highlighted');
      item.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    } else {
      item.classList.remove('link-dialog-autocomplete-item-highlighted');
    }
  });
}

/**
 * Handle keyboard navigation in autocomplete
 */
function handleAutocompleteKeyboard(
  e: KeyboardEvent,
  dropdown: HTMLElement,
  urlInput: HTMLInputElement
): boolean {
  if (!dropdown || dropdown.style.display === 'none') return false;

  const items = dropdown.querySelectorAll('.link-dialog-autocomplete-item');
  if (items.length === 0) return false;

  switch (e.key) {
    case 'ArrowDown':
      e.preventDefault();
      selectedAutocompleteIndex =
        selectedAutocompleteIndex === null ? 0 : (selectedAutocompleteIndex + 1) % items.length;
      updateAutocompleteHighlight(dropdown);
      return true;

    case 'ArrowUp':
      e.preventDefault();
      selectedAutocompleteIndex =
        selectedAutocompleteIndex === null || selectedAutocompleteIndex === 0
          ? items.length - 1
          : selectedAutocompleteIndex - 1;
      updateAutocompleteHighlight(dropdown);
      return true;

    case 'Enter':
      if (selectedAutocompleteIndex !== null && selectedAutocompleteIndex < items.length) {
        e.preventDefault();
        (items[selectedAutocompleteIndex] as HTMLElement).click();
        return true;
      }
      return false;

    case 'Escape':
      e.preventDefault();
      closeAutocomplete();
      urlInput.focus();
      return true;

    default:
      return false;
  }
}

/**
 * Handle file search with debouncing
 */
function handleFileSearch(query: string, filters: FileFilterState): void {
  if (fileSearchDebounceTimer) {
    clearTimeout(fileSearchDebounceTimer);
  }

  const trimmedQuery = query.trim();

  // If query is empty, show empty state but don't close dropdown immediately
  if (trimmedQuery.length < 1) {
    if (autocompleteDropdown) {
      const emptyMsg = document.createElement('div');
      emptyMsg.className = 'link-dialog-autocomplete-empty';
      emptyMsg.textContent = 'Start typing to search files...';
      autocompleteDropdown.innerHTML = '';
      autocompleteDropdown.appendChild(emptyMsg);
      autocompleteDropdown.style.display = 'block';
    }
    return;
  }

  fileSearchDebounceTimer = setTimeout(() => {
    const requestId = ++fileSearchRequestId;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const vscode = (window as any).vscode;
    if (vscode && typeof vscode.postMessage === 'function') {
      console.log('[MD4H] Sending file search request:', {
        query: trimmedQuery,
        filters,
        requestId,
      });
      vscode.postMessage({
        type: 'searchFiles',
        query: trimmedQuery,
        filters,
        requestId,
      });
    } else {
      console.warn('[MD4H] vscode API not available for file search');
    }
  }, 300);
}

/**
 * Handle heading extraction and display
 */
function handleHeadingExtraction(editor: Editor, query: string, urlInput: HTMLInputElement): void {
  try {
    const outline = buildOutlineFromEditor(editor);
    const existingSlugs = new Set<string>();
    const headingResults: HeadingResult[] = outline.map(entry => ({
      text: entry.text,
      level: entry.level,
      slug: generateHeadingSlug(entry.text, existingSlugs),
    }));

    const filtered = query.trim()
      ? headingResults.filter(
          h =>
            h.text.toLowerCase().includes(query.toLowerCase()) ||
            h.slug.toLowerCase().includes(query.toLowerCase())
        )
      : headingResults;

    const limited = filtered.slice(0, 20);

    if (autocompleteDropdown) {
      updateAutocompleteDropdown(autocompleteDropdown, limited, urlInput);
    }
  } catch (error) {
    console.error('[MD4H] Failed to extract headings', error);
    closeAutocomplete();
  }
}

/**
 * Update mode and UI accordingly
 */
function updateMode(
  mode: LinkMode,
  urlInput: HTMLInputElement,
  filtersContainer: HTMLElement | null
): void {
  currentMode = mode;

  // Update URL label text based on mode
  const urlLabelText = linkDialogElement?.querySelector(
    '#link-url-label-text'
  ) as HTMLElement | null;

  switch (mode) {
    case 'url':
      urlInput.placeholder = 'https://example.com';
      if (urlLabelText) {
        urlLabelText.textContent = 'URL';
      }
      break;
    case 'file':
      urlInput.placeholder = 'Start typing to search files...';
      if (urlLabelText) {
        urlLabelText.textContent = 'File';
      }
      break;
    case 'headings':
      urlInput.placeholder = 'Select a heading from the list below';
      if (urlLabelText) {
        urlLabelText.textContent = 'Heading';
      }
      break;
  }

  if (filtersContainer) {
    filtersContainer.style.display = mode === 'file' ? 'block' : 'none';
  }

  urlInput.value = '';
  actualLinkPath = null; // Clear stored path when mode changes
  closeAutocomplete();

  // Don't show headings immediately - wait for input focus
  // Headings will be shown when URL input receives focus
}

/**
 * Create the Link Dialog element
 */
export function createLinkDialog(): HTMLElement {
  // Create overlay container
  const overlay = document.createElement('div');
  overlay.className = 'link-dialog-popover';
  overlay.style.position = 'fixed';
  overlay.style.inset = '0';
  overlay.style.pointerEvents = 'none';
  overlay.style.zIndex = '50';
  overlay.style.display = 'none';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-label', 'Insert/Edit Link');
  overlay.setAttribute('aria-modal', 'true');

  // Create content panel
  const panel = document.createElement('div');
  panel.className = 'export-settings-overlay-panel';
  panel.style.maxWidth = '520px';
  panel.style.pointerEvents = 'auto';
  panel.style.position = 'absolute';
  panel.style.boxShadow = '0 12px 32px rgba(0,0,0,0.24)';

  // Create header
  const header = document.createElement('div');
  header.className = 'export-settings-overlay-header';
  header.innerHTML = `
    <h2 class="export-settings-overlay-title" id="link-dialog-title">Insert Link</h2>
    <button class="export-settings-overlay-close" aria-label="Close dialog" title="Close (Esc)">×</button>
  `;

  const closeBtn = header.querySelector('.export-settings-overlay-close') as HTMLElement;
  closeBtn.onclick = () => hideLinkDialog();

  // Create dialog content
  const content = document.createElement('div');
  content.className = 'export-settings-content';
  content.innerHTML = `
    <div class="export-settings-section" style="margin-bottom: 16px;">
      <label class="export-settings-label" for="link-text-input">Link Text</label>
      <div style="display: flex; align-items: center; gap: 6px; flex-wrap: nowrap;">
        <div style="display: flex; gap: 4px;">
          <button
            id="link-trim-left-btn"
            class="export-settings-select"
            style="padding: 6px 10px; font-size: 12px;"
            title="Trim left boundary by one word"
          >
            -
          </button>
          <button
            id="link-expand-left-btn"
            class="export-settings-select"
            style="padding: 6px 10px; font-size: 12px;"
            title="Expand left boundary to previous word"
          >
            +
          </button>
        </div>
        <input
          type="text"
          id="link-text-input"
          class="export-settings-select"
          style="padding: 8px 12px; flex: 1; min-width: 0;"
          placeholder="Text to display"
        />
        <div style="display: flex; gap: 4px;">
          <button
            id="link-expand-right-btn"
            class="export-settings-select"
            style="padding: 6px 10px; font-size: 12px;"
            title="Expand right boundary to next word"
          >
            +
          </button>
          <button
            id="link-trim-right-btn"
            class="export-settings-select"
            style="padding: 6px 10px; font-size: 12px;"
            title="Trim right boundary by one word"
          >
            -
          </button>
        </div>
      </div>
      <p class="export-settings-hint">The text that will be shown in the document</p>
    </div>
    <div class="export-settings-section" style="margin-bottom: 16px;">
      <label class="export-settings-label">Type</label>
      <div class="link-dialog-mode-group">
        <label class="link-dialog-mode-option">
          <input type="radio" name="link-mode" value="url" id="link-mode-url" checked />
          <span>URL</span>
        </label>
        <label class="link-dialog-mode-option">
          <input type="radio" name="link-mode" value="file" id="link-mode-file" />
          <span>File</span>
        </label>
        <label class="link-dialog-mode-option">
          <input type="radio" name="link-mode" value="headings" id="link-mode-headings" />
          <span>Headings</span>
        </label>
      </div>
    </div>
    <div class="export-settings-section" style="margin-bottom: 16px; position: relative;">
      <label class="export-settings-label" for="link-url-input" id="link-url-label">
        <span id="link-url-label-text">URL</span>
        <input
          type="text"
          id="link-url-input"
          class="export-settings-select"
          style="padding: 8px 12px;"
          placeholder="https://example.com"
        />
      </label>
      <p class="export-settings-hint">The web address or file path</p>
    </div>
    <div class="export-settings-section" id="link-filters-container" style="margin-bottom: 16px; display: none;">
      <label class="export-settings-label">Filter</label>
      <div class="link-dialog-filters">
        <label class="link-dialog-filter-checkbox">
          <input type="checkbox" id="link-filter-all" checked />
          <span>All</span>
        </label>
        <label class="link-dialog-filter-checkbox">
          <input type="checkbox" id="link-filter-md" checked />
          <span>MD</span>
        </label>
        <label class="link-dialog-filter-checkbox">
          <input type="checkbox" id="link-filter-images" checked />
          <span>Images</span>
        </label>
        <label class="link-dialog-filter-checkbox">
          <input type="checkbox" id="link-filter-code" checked />
          <span>Code</span>
        </label>
        <label class="link-dialog-filter-checkbox">
          <input type="checkbox" id="link-filter-config" checked />
          <span>Config</span>
        </label>
      </div>
    </div>
    <div style="display: flex; gap: 12px; justify-content: flex-end; align-items: center;">
      <button
        id="link-remove-btn"
        class="export-settings-select"
        style="padding: 8px 16px; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: none; cursor: pointer; border-radius: 4px; margin-right: auto;"
      >
        Remove Link
      </button>
      <button
        id="link-cancel-btn"
        class="export-settings-select"
        style="padding: 8px 24px; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: none; cursor: pointer; border-radius: 4px;"
      >
        Cancel
      </button>
      <button
        id="link-ok-btn"
        class="export-settings-select"
        style="padding: 8px 24px; background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; cursor: pointer; border-radius: 4px;"
      >
        OK
      </button>
    </div>
  `;

  // Handle button clicks
  const okBtn = content.querySelector('#link-ok-btn') as HTMLButtonElement;
  const cancelBtn = content.querySelector('#link-cancel-btn') as HTMLButtonElement;
  const removeBtn = content.querySelector('#link-remove-btn') as HTMLButtonElement;
  const textInput = content.querySelector('#link-text-input') as HTMLInputElement;
  const urlInput = content.querySelector('#link-url-input') as HTMLInputElement;
  const trimLeftBtn = content.querySelector('#link-trim-left-btn') as HTMLButtonElement | null;
  const expandLeftBtn = content.querySelector('#link-expand-left-btn') as HTMLButtonElement | null;
  const expandRightBtn = content.querySelector(
    '#link-expand-right-btn'
  ) as HTMLButtonElement | null;
  const trimRightBtn = content.querySelector('#link-trim-right-btn') as HTMLButtonElement | null;
  const filtersContainer = content.querySelector('#link-filters-container') as HTMLElement | null;

  // Create autocomplete dropdown
  if (urlInput) {
    autocompleteDropdown = createAutocompleteDropdown(urlInput);
    content.appendChild(autocompleteDropdown);
  }

  // Load filter state
  filterState = loadFilterState();

  // Setup filter checkboxes
  const filterAll = content.querySelector('#link-filter-all') as HTMLInputElement;
  const filterMd = content.querySelector('#link-filter-md') as HTMLInputElement;
  const filterImages = content.querySelector('#link-filter-images') as HTMLInputElement;
  const filterCode = content.querySelector('#link-filter-code') as HTMLInputElement;
  const filterConfig = content.querySelector('#link-filter-config') as HTMLInputElement;

  // Initialize filter checkboxes
  filterAll.checked = filterState.all;
  filterMd.checked = filterState.md;
  filterImages.checked = filterState.images;
  filterCode.checked = filterState.code;
  filterConfig.checked = filterState.config;

  // Update filter checkbox states based on "All" checkbox
  const updateFilterCheckboxes = () => {
    const allChecked = filterAll.checked;
    filterMd.disabled = allChecked;
    filterImages.disabled = allChecked;
    filterCode.disabled = allChecked;
    filterConfig.disabled = allChecked;

    if (allChecked) {
      filterMd.checked = true;
      filterImages.checked = true;
      filterCode.checked = true;
      filterConfig.checked = true;
    }

    filterState = {
      all: filterAll.checked,
      md: filterMd.checked,
      images: filterImages.checked,
      code: filterCode.checked,
      config: filterConfig.checked,
    };
    saveFilterState(filterState);

    if (currentMode === 'file' && urlInput.value.trim()) {
      handleFileSearch(urlInput.value.trim(), filterState);
    }
  };

  filterAll.addEventListener('change', () => {
    updateFilterCheckboxes();
  });

  [filterMd, filterImages, filterCode, filterConfig].forEach(checkbox => {
    checkbox.addEventListener('change', () => {
      if (!checkbox.checked) {
        filterAll.checked = false;
      }
      if (filterMd.checked && filterImages.checked && filterCode.checked && filterConfig.checked) {
        filterAll.checked = true;
      }
      updateFilterCheckboxes();
    });
  });

  // Setup radio buttons for mode switching
  const modeUrl = content.querySelector('#link-mode-url') as HTMLInputElement;
  const modeFile = content.querySelector('#link-mode-file') as HTMLInputElement;
  const modeHeadings = content.querySelector('#link-mode-headings') as HTMLInputElement;

  modeUrl.addEventListener('change', () => {
    if (modeUrl.checked) {
      updateMode('url', urlInput, filtersContainer);
    }
  });

  modeFile.addEventListener('change', () => {
    if (modeFile.checked) {
      updateMode('file', urlInput, filtersContainer);
    }
  });

  modeHeadings.addEventListener('change', () => {
    if (modeHeadings.checked) {
      updateMode('headings', urlInput, filtersContainer);
    }
  });

  // Setup URL input handlers
  urlInput.addEventListener('focus', () => {
    if (currentMode === 'headings' && currentEditor) {
      // Show headings when input is focused in Headings mode
      handleHeadingExtraction(currentEditor, urlInput.value.trim(), urlInput);
    } else if (currentMode === 'file') {
      // Show placeholder for file mode
      if (autocompleteDropdown && !urlInput.value.trim()) {
        const emptyMsg = document.createElement('div');
        emptyMsg.className = 'link-dialog-autocomplete-empty';
        emptyMsg.textContent = 'Start typing to search files...';
        autocompleteDropdown.innerHTML = '';
        autocompleteDropdown.appendChild(emptyMsg);
        autocompleteDropdown.style.display = 'block';
      }
    }
  });

  urlInput.addEventListener('input', () => {
    if (currentMode === 'file') {
      const query = urlInput.value.trim();
      if (query.length >= 1) {
        handleFileSearch(query, filterState);
      } else {
        // Show placeholder message when input is empty
        if (autocompleteDropdown) {
          const emptyMsg = document.createElement('div');
          emptyMsg.className = 'link-dialog-autocomplete-empty';
          emptyMsg.textContent = 'Start typing to search files...';
          autocompleteDropdown.innerHTML = '';
          autocompleteDropdown.appendChild(emptyMsg);
          autocompleteDropdown.style.display = 'block';
        }
      }
    } else if (currentMode === 'headings' && currentEditor) {
      handleHeadingExtraction(currentEditor, urlInput.value.trim(), urlInput);
    } else {
      closeAutocomplete();
    }
  });

  urlInput.addEventListener('keydown', e => {
    if (autocompleteDropdown && handleAutocompleteKeyboard(e, autocompleteDropdown, urlInput)) {
      return;
    }
  });

  // Close autocomplete when clicking outside
  document.addEventListener('click', e => {
    if (
      autocompleteDropdown &&
      !autocompleteDropdown.contains(e.target as Node) &&
      urlInput !== e.target
    ) {
      closeAutocomplete();
    }
  });

  const boundaryButtons = [
    { button: trimLeftBtn, direction: 'left' as const, action: 'shrink' as const },
    { button: expandLeftBtn, direction: 'left' as const, action: 'expand' as const },
    { button: expandRightBtn, direction: 'right' as const, action: 'expand' as const },
    { button: trimRightBtn, direction: 'right' as const, action: 'shrink' as const },
  ];

  boundaryButtons.forEach(({ button, direction, action }) => {
    if (!button) return;
    button.onclick = () => adjustLinkBoundary(direction, action, textInput);
  });

  okBtn.onclick = () => {
    // Use actualLinkPath if available (from file/heading selection), otherwise use urlInput.value
    const url = actualLinkPath || urlInput.value.trim();
    const text = textInput.value;

    if (!url) {
      urlInput.focus();
      return;
    }

    shouldRestoreSelectionOnHide = false;
    applyLinkAtRange(url, text);
    hideLinkDialog();
  };

  cancelBtn.onclick = () => hideLinkDialog();

  removeBtn.onclick = () => {
    if (currentEditor) {
      const { state } = currentEditor;
      const linkType = state.schema.marks.link;
      if (linkType) {
        const baseRange = workingRange ||
          initialLinkRange || { from: state.selection.from, to: state.selection.to };
        const clearFrom = initialLinkRange
          ? Math.min(initialLinkRange.from, baseRange.from)
          : baseRange.from;
        const clearTo = initialLinkRange
          ? Math.max(initialLinkRange.to, baseRange.to)
          : baseRange.to;
        const tr = state.tr.removeMark(clearFrom, clearTo, linkType);
        currentEditor.view.dispatch(tr);
      }
    }
    shouldRestoreSelectionOnHide = false;
    hideLinkDialog();
  };

  // Handle keyboard navigation
  overlay.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      hideLinkDialog();
    } else if (e.key === 'Enter' && (e.target === textInput || e.target === urlInput)) {
      e.preventDefault();
      okBtn.click();
    }
  });

  panel.appendChild(header);
  panel.appendChild(content);
  overlay.appendChild(panel);

  document.body.appendChild(overlay);
  linkDialogElement = overlay;

  return overlay;
}

/**
 * Show the Link Dialog
 */
export function showLinkDialog(editor: Editor): void {
  currentEditor = editor;
  shouldRestoreSelectionOnHide = true;

  if (!linkDialogElement) {
    createLinkDialog();
  }

  if (!linkDialogElement) return;

  // Get current selection and link state
  const { state } = editor;
  const { selection, doc, schema } = state;
  previousSelection = { from: selection.from, to: selection.to };
  const linkType = schema.marks.link;
  const linkMark = editor.getAttributes('link');
  const currentUrl = linkMark.href || '';

  // If we're inside a link, expand to full mark range so we capture the whole link text
  const linkRange = getMarkRange(selection.$from, linkType, linkMark);
  const selectionRange: Range = linkRange
    ? { from: linkRange.from, to: linkRange.to }
    : { from: selection.from, to: selection.to };
  workingRange = selectionRange;
  initialLinkRange = linkRange ? { from: linkRange.from, to: linkRange.to } : null;
  const selectedText = doc.textBetween(selectionRange.from, selectionRange.to, ' ');
  setSelectionHighlight(workingRange);

  // Update dialog title and button visibility
  const title = linkDialogElement.querySelector('#link-dialog-title') as HTMLElement;
  const removeBtn = linkDialogElement.querySelector('#link-remove-btn') as HTMLButtonElement;
  const textInput = linkDialogElement.querySelector('#link-text-input') as HTMLInputElement;
  const urlInput = linkDialogElement.querySelector('#link-url-input') as HTMLInputElement;

  if (currentUrl) {
    title.textContent = 'Edit Link';
    removeBtn.style.display = 'block';
  } else {
    title.textContent = 'Insert Link';
    removeBtn.style.display = 'none';
  }

  // Pre-fill inputs
  textInput.value = selectedText || '';
  urlInput.value = currentUrl || '';
  actualLinkPath = currentUrl || null; // Set actualLinkPath if editing existing link

  // Initialize mode (default to URL)
  currentMode = 'url';
  const modeUrl = linkDialogElement.querySelector('#link-mode-url') as HTMLInputElement;
  const modeFile = linkDialogElement.querySelector('#link-mode-file') as HTMLInputElement;
  const modeHeadings = linkDialogElement.querySelector('#link-mode-headings') as HTMLInputElement;
  const filtersContainer = linkDialogElement.querySelector(
    '#link-filters-container'
  ) as HTMLElement | null;

  if (modeUrl) modeUrl.checked = true;
  if (modeFile) modeFile.checked = false;
  if (modeHeadings) modeHeadings.checked = false;

  updateMode('url', urlInput, filtersContainer);

  // Restore URL values if editing existing link (updateMode clears them)
  if (currentUrl) {
    urlInput.value = currentUrl;
    actualLinkPath = currentUrl;
  }

  // Close autocomplete initially
  closeAutocomplete();

  // Show overlay
  linkDialogElement.classList.add('visible');
  linkDialogElement.style.display = 'block';
  isVisible = true;
  const panelElement = linkDialogElement.querySelector(
    '.export-settings-overlay-panel'
  ) as HTMLElement | null;

  // Focus appropriate input
  requestAnimationFrame(() => {
    if (!currentUrl && !selectedText) {
      // New link with no selection: focus text input
      textInput.focus();
    } else {
      // Editing or has selection: focus URL input
      urlInput.select();
      urlInput.focus();
    }

    if (panelElement) {
      centerModal(panelElement);
    }
  });
}

/**
 * Hide the Link Dialog
 */
export function hideLinkDialog(): void {
  const editorRef = currentEditor;
  const restoreSelection = shouldRestoreSelectionOnHide;
  const originalSelection = previousSelection;

  if (!linkDialogElement) return;

  // Clean up
  if (fileSearchDebounceTimer) {
    clearTimeout(fileSearchDebounceTimer);
    fileSearchDebounceTimer = null;
  }
  closeAutocomplete();
  currentMode = 'url';
  actualLinkPath = null; // Clear stored path when dialog is hidden

  linkDialogElement.classList.remove('visible');
  linkDialogElement.style.display = 'none';
  isVisible = false;

  if (restoreSelection && editorRef && originalSelection) {
    try {
      editorRef.commands.setTextSelection({
        from: originalSelection.from,
        to: originalSelection.to,
      });
    } catch (error) {
      console.warn('[MD4H] Failed to restore selection after link dialog', error);
    }
  }

  currentEditor = null;
  clearWorkingRanges();

  if (editorRef) {
    focusEditor(editorRef);
  }
}

/**
 * Check if Link Dialog is visible
 */
export function isLinkDialogVisible(): boolean {
  return isVisible;
}

/**
 * Handle file search results from extension
 */
export function handleFileSearchResults(results: FileSearchResult[], requestId: number): void {
  console.log('[MD4H] Received file search results:', {
    resultsCount: results.length,
    requestId,
    currentRequestId: fileSearchRequestId,
  });

  if (requestId !== fileSearchRequestId) {
    console.log('[MD4H] Ignoring outdated search results (requestId mismatch)');
    return;
  }

  if (!autocompleteDropdown || !linkDialogElement) {
    console.warn('[MD4H] Autocomplete dropdown or dialog element not available');
    return;
  }

  const urlInput = linkDialogElement.querySelector('#link-url-input') as HTMLInputElement;
  if (!urlInput) {
    console.warn('[MD4H] URL input not found');
    return;
  }

  console.log('[MD4H] Updating autocomplete dropdown with', results.length, 'results');
  updateAutocompleteDropdown(autocompleteDropdown, results, urlInput);
}
