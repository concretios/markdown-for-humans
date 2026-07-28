/**
 * @file auditOverlay.ts - Document Audit result panel (webview side)
 * @description Renders the audit issue overlay and handles user interactions:
 *   - Lists all detected issues with navigation on item click
 *   - Shows fuzzy-matched suggestion pills the user can click to apply
 *   - Shows a "Browse..." button for image/link issues to open the VS Code file picker
 *   - Heading issues display a friendly "Seems these headings were renamed" hint
 *   - Manual text input when no suggestions are available
 */

import { Editor } from '@tiptap/core';
import {
  AuditIssue,
  AuditFileType,
  auditPluginKey,
  requestFilePickerForIssue,
} from './auditDocument';
import { getLevenshteinDistance } from './levenshtein';

// Maximum number of suggestion pills to show per issue (keeps the UI clean).
const MAX_SUGGESTION_PILLS = 5;

// Toast auto-dismiss timeout in milliseconds
const TOAST_AUTO_DISMISS_MS = 3000;
const TOAST_REMOVAL_ANIMATION_MS = 200;

type ToastTimerHandle = ReturnType<typeof setTimeout>;
type ToastFrameHandle = ReturnType<typeof requestAnimationFrame>;

type ToastLifecycle = {
  showFrame?: ToastFrameHandle;
  autoDismiss?: ToastTimerHandle;
  removal?: ToastTimerHandle;
};

const toastLifecycles = new Map<string, ToastLifecycle>();

function getToastLifecycle(toastId: string): ToastLifecycle {
  let lifecycle = toastLifecycles.get(toastId);
  if (!lifecycle) {
    lifecycle = {};
    toastLifecycles.set(toastId, lifecycle);
  }
  return lifecycle;
}

function maybeUnrefTimer(timer: ToastTimerHandle): void {
  const maybeNodeTimer = timer as unknown as { unref?: () => void };
  if (typeof maybeNodeTimer.unref === 'function') {
    maybeNodeTimer.unref();
  }
}

function clearToastTimer(timer: ToastTimerHandle | undefined): void {
  if (typeof timer !== 'undefined') {
    clearTimeout(timer);
  }
}

function clearToastLifecycle(toastId: string): void {
  const lifecycle = toastLifecycles.get(toastId);
  if (!lifecycle) return;

  if (typeof lifecycle.showFrame !== 'undefined' && typeof cancelAnimationFrame === 'function') {
    cancelAnimationFrame(lifecycle.showFrame);
  }
  clearToastTimer(lifecycle.autoDismiss);
  clearToastTimer(lifecycle.removal);
  toastLifecycles.delete(toastId);
}

function scheduleToastFrame(toastId: string, callback: () => void): void {
  if (typeof requestAnimationFrame !== 'function') {
    callback();
    return;
  }

  const lifecycle = getToastLifecycle(toastId);
  lifecycle.showFrame = requestAnimationFrame(() => {
    const activeLifecycle = toastLifecycles.get(toastId);
    if (activeLifecycle) {
      delete activeLifecycle.showFrame;
    }
    callback();
  });
}

function scheduleToastTimer(
  toastId: string,
  key: 'autoDismiss' | 'removal',
  callback: () => void,
  delayMs: number
): void {
  const lifecycle = getToastLifecycle(toastId);
  clearToastTimer(lifecycle[key]);

  const timer = setTimeout(() => {
    const activeLifecycle = toastLifecycles.get(toastId);
    if (activeLifecycle) {
      delete activeLifecycle[key];
    }
    callback();
  }, delayMs);
  maybeUnrefTimer(timer);
  lifecycle[key] = timer;
}

function scheduleToastRemoval(toastId: string, toast: HTMLElement): void {
  scheduleToastTimer(
    toastId,
    'removal',
    () => {
      toast.remove();
      clearToastLifecycle(toastId);
    },
    TOAST_REMOVAL_ANIMATION_MS
  );
}

/**
 * Display a toast notification.
 * Auto-dismisses after TOAST_AUTO_DISMISS_MS unless type is 'loading'.
 *
 * @param message - The message to display
 * @param type - Toast type: 'success' | 'info' | 'loading' (affects styling and auto-dismiss)
 * @returns id for dismissing the toast manually (only used for 'loading' type)
 */
export function showToast(message: string, type: 'success' | 'info' | 'loading' = 'info'): string {
  let toastContainer = document.getElementById('toast-container');
  if (!toastContainer) {
    toastContainer = document.createElement('div');
    toastContainer.id = 'toast-container';
    toastContainer.className = 'toast-container';
    document.body.appendChild(toastContainer);
  }

  const toastId = `toast-${Date.now()}-${Math.random()}`;
  const toast = document.createElement('div');
  toast.id = toastId;
  toast.className = `toast toast-${type}`;
  toast.role = 'status';
  toast.setAttribute('aria-live', 'polite');

  const iconMap = {
    success: 'codicon-verified',
    info: 'codicon-info',
    loading: 'codicon-loading codicon-modifier-spin',
  };
  const icon = iconMap[type];

  toast.innerHTML = `
    <span class="toast-icon codicon ${icon}" aria-hidden="true"></span>
    <span class="toast-message">${message}</span>
  `;

  toastContainer.appendChild(toast);

  // Trigger animation
  scheduleToastFrame(toastId, () => {
    toast.classList.add('visible');
  });

  // Auto-dismiss only for non-loading toasts
  if (type !== 'loading') {
    scheduleToastTimer(
      toastId,
      'autoDismiss',
      () => {
        toast.classList.remove('visible');
        scheduleToastRemoval(toastId, toast);
      },
      TOAST_AUTO_DISMISS_MS
    );
  }

  return toastId;
}

/**
 * Dismiss a toast by ID (returned from showToast).
 *
 * @param toastId - The ID returned by showToast()
 */
export function dismissToast(toastId: string): void {
  const toast = document.getElementById(toastId);
  if (toast) {
    const lifecycle = getToastLifecycle(toastId);
    clearToastTimer(lifecycle.autoDismiss);
    delete lifecycle.autoDismiss;

    toast.classList.remove('visible');
    scheduleToastRemoval(toastId, toast);
  } else {
    clearToastLifecycle(toastId);
  }
}

/**
 * Remove all active toasts and clear any scheduled toast timers.
 * Useful when the webview or tests reset the DOM before auto-dismiss timers fire.
 */
export function clearToasts(): void {
  for (const toastId of Array.from(toastLifecycles.keys())) {
    clearToastLifecycle(toastId);
  }

  document.querySelectorAll('.toast').forEach(toast => {
    toast.remove();
  });
  document.getElementById('toast-container')?.remove();
}

/**
 * Show the audit results overlay panel.
 * When no issues are found, displays a toast notification instead.
 * When issues are found, displays a modal panel with the list.
 *
 * @param editor - The active TipTap editor instance.
 * @param issues - Array of audit issues to display.
 */
export function showAuditOverlay(editor: Editor, issues: AuditIssue[]) {
  if (issues.length === 0) {
    // Show toast instead of panel for no issues
    showToast('Your document is healthy — no issues found!', 'success');
    return;
  }

  let overlay = document.getElementById('audit-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'audit-overlay';
    overlay.className = 'audit-overlay';
    document.body.appendChild(overlay);
  }

  overlay.innerHTML = `
    <div class="audit-overlay-backdrop"></div>
    <div class="audit-overlay-panel">
      <div class="audit-overlay-header">
        <h3 class="audit-overlay-title">Document Audit (${issues.length} issues)</h3>
        <button class="audit-overlay-close" aria-label="Close">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
            <path fill-rule="evenodd" clip-rule="evenodd" d="M8 8.707l3.646 3.647.708-.707L8.707 8l3.647-3.646-.707-.708L8 7.293 4.354 3.646l-.708.708L7.293 8l-3.647 3.646.708.707L8 8.707z"/>
          </svg>
        </button>
      </div>
      <div class="audit-overlay-list"></div>
    </div>
  `;

  const listEl = overlay.querySelector('.audit-overlay-list');
  if (listEl) {
    issues.forEach((issue, index) => {
      const item = buildIssueItem(issue);
      listEl.appendChild(item);

      // Add a horizontal line if it's not the very last issue in the array
      if (index < issues.length - 1) {
        const separator = document.createElement('hr');
        separator.className = 'audit-issue-separator';
        listEl.appendChild(separator);
      }
    });
  }

  overlay.classList.add('visible');

  // Close button
  const closeBtn = overlay.querySelector('.audit-overlay-close');
  if (closeBtn) {
    closeBtn.addEventListener('click', () => {
      overlay?.classList.remove('visible');
      auditPreviewPopover.hide();
    });
  }

  // Backdrop click to close
  const backdrop = overlay.querySelector('.audit-overlay-backdrop');
  if (backdrop) {
    backdrop.addEventListener('click', () => {
      overlay?.classList.remove('visible');
      auditPreviewPopover.hide();
    });
  }

  // Wire up interaction handlers on all items
  const itemNodes = overlay.querySelectorAll('.audit-overlay-item');
  itemNodes.forEach(itemNode => {
    wireItemHandlers(itemNode as HTMLElement, editor, issues, overlay!);
  });
}

// ─── Item builder ─────────────────────────────────────────────────────────────

/**
 * Build the DOM element for a single audit issue.
 * Layout:
 *   [emoji] [message]
 *            [target path in muted style]
 *            [heading-hint (heading issues only)]
 *            [suggestion pills] [Browse button (image/link only)]
 *            [manual input + Fix button (no suggestions)]
 */
function buildIssueItem(issue: AuditIssue): HTMLElement {
  const item = document.createElement('div');
  item.className = 'audit-overlay-item';
  item.setAttribute('data-pos', String(issue.pos));
  item.setAttribute('data-type', issue.type);
  item.tabIndex = 0;

  // Icon column
  const typeEl = document.createElement('div');
  typeEl.className = `audit-issue-type ${issue.type}`;
  typeEl.innerHTML =
    issue.type === 'link'
      ? '<span class="codicon codicon-link" aria-hidden="true"></span>'
      : issue.type === 'image'
        ? '<span class="codicon codicon-file-media" aria-hidden="true"></span>'
        : '<span class="codicon codicon-book" aria-hidden="true"></span>';

  // Text column
  const textEl = document.createElement('div');
  textEl.className = 'audit-issue-text';

  const headerEl = document.createElement('div');
  headerEl.className = 'audit-issue-header';

  const msgEl = document.createElement('div');
  msgEl.className = 'audit-issue-message';
  msgEl.textContent = issue.message;
  headerEl.appendChild(msgEl);

  const navBtn = document.createElement('button');
  navBtn.className = 'audit-issue-nav-btn';
  navBtn.setAttribute('type', 'button');
  navBtn.setAttribute('aria-label', 'Navigate to issue');
  navBtn.title = 'Jump to issue';
  navBtn.textContent = '↗';
  headerEl.appendChild(navBtn);

  textEl.appendChild(headerEl);

  if (issue.target) {
    const targetEl = document.createElement('div');
    targetEl.className = 'audit-issue-target';
    targetEl.textContent = issue.target;
    textEl.appendChild(targetEl);
  }

  // Actions area
  const actionEl = document.createElement('div');
  actionEl.className = 'audit-issue-actions';

  if (issue.type === 'heading' && issue.suggestions && issue.suggestions.length > 0) {
    // Heading: friendly hint + suggestion pills (no Browse button – anchors aren't files)
    const hintEl = document.createElement('div');
    hintEl.className = 'audit-heading-hint';

    // Provide more intelligent messaging based on suggestion quality
    const targetSlug = issue.target;
    const bestMatch = issue.suggestions[0];
    const distance = getLevenshteinDistance(targetSlug, bestMatch);

    if (distance === 1) {
      hintEl.textContent = 'Heading name changed slightly — pick the updated one:';
    } else if (distance <= 3) {
      hintEl.textContent = 'Seems these headings were renamed — pick the updated one:';
    } else if (issue.suggestions.length === 1) {
      hintEl.textContent = 'Found a similar heading — is this what you meant?';
    } else {
      hintEl.textContent = 'Multiple similar headings found — pick the correct one:';
    }

    actionEl.appendChild(hintEl);

    const pillsEl = buildSuggestionPills(issue.suggestions);
    actionEl.appendChild(pillsEl);
  } else if (
    (issue.type === 'image' || issue.type === 'link') &&
    issue.suggestions &&
    issue.suggestions.length > 0
  ) {
    // Image / link with repo matches: pills + Browse fallback
    const pillsEl = buildSuggestionPills(issue.suggestions);
    actionEl.appendChild(pillsEl);

    const browseBtn = buildBrowseButton(issue.type === 'image' ? 'image' : 'any');
    actionEl.appendChild(browseBtn);
  } else if (issue.type === 'image' || issue.type === 'link') {
    // Image / link without suggestions: manual input + Fix + Browse
    const inputRow = document.createElement('div');
    inputRow.className = 'audit-input-row';

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'audit-manual-input';
    input.value = issue.target;
    input.placeholder = `Fix ${issue.type}...`;

    const fixBtn = document.createElement('button');
    fixBtn.className = 'audit-fix-button manual-fix';
    fixBtn.textContent = 'Fix';
    fixBtn.setAttribute('data-pos', String(issue.pos));
    fixBtn.setAttribute('data-type', issue.type);
    const browseBtn = buildBrowseButton(issue.type === 'image' ? 'image' : 'any');

    inputRow.appendChild(input);
    inputRow.appendChild(fixBtn);
    inputRow.appendChild(browseBtn);
    actionEl.appendChild(inputRow);
  }

  textEl.appendChild(actionEl);
  item.appendChild(typeEl);
  item.appendChild(textEl);
  return item;
}

/**
 * Build a container of clickable suggestion pills (one per match).
 * Caps at MAX_SUGGESTION_PILLS to avoid overwhelming the UI.
 */
function buildSuggestionPills(suggestions: string[]): HTMLElement {
  const container = document.createElement('div');
  container.className = 'audit-suggestion-pills';

  const capped = suggestions.slice(0, MAX_SUGGESTION_PILLS);
  for (const sug of capped) {
    const pill = document.createElement('button');
    pill.className = 'audit-suggestion-pill';
    pill.setAttribute('data-suggestion', sug);
    // Show only the basename for conciseness; full path is in the data attribute
    const basename = sug.split('/').pop() ?? sug;
    pill.textContent = basename;
    pill.title = sug; // full path on hover

    pill.addEventListener('mouseover', () => {
      auditPreviewPopover.show(pill, sug);
    });
    pill.addEventListener('mouseout', () => {
      auditPreviewPopover.scheduleHide();
    });

    container.appendChild(pill);
  }

  return container;
}

const IMAGE_EXTENSIONS = /\.(bmp|gif|jpe?g|png|webp|avif|svg)([?#].*)?$/i;
const PREVIEW_HIDE_DELAY_MS = 120;

function isImageSuggestion(path: string): boolean {
  return IMAGE_EXTENSIONS.test(path);
}

function getFileIconName(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  const mapping: Record<string, string> = {
    md: 'markdown',
    markdown: 'markdown',
    json: 'json',
    yml: 'yaml',
    yaml: 'yaml',
    csv: 'csv',
    txt: 'file',
    pdf: 'file-pdf',
    html: 'html',
    htm: 'html',
    js: 'file-code',
    ts: 'file-code',
    css: 'file-code',
    scss: 'file-code',
    xml: 'file-code',
  };
  return mapping[ext] ?? 'file';
}

function getBasename(path: string): string {
  return path.split(/[/]/).pop() ?? path;
}

const auditPreviewPopover = (() => {
  let container: HTMLElement | null = null;
  let activePreviewId = 0;
  let hideTimer: number | null = null;

  function ensureContainer() {
    if (!container) {
      container = document.createElement('div');
      container.className = 'audit-preview-popover';
      document.body.appendChild(container);
    } else if (!container.isConnected) {
      document.body.appendChild(container);
    }
    return container;
  }

  function positionPopover(popover: HTMLElement, targetRect: DOMRect) {
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const margin = 10;
    const maxWidth = 320;
    const left = Math.min(Math.max(targetRect.left, margin), viewportWidth - maxWidth - margin);
    let top = targetRect.bottom + margin;

    popover.style.left = `${left}px`;
    popover.style.maxWidth = `${maxWidth}px`;
    popover.style.width = 'auto';

    requestAnimationFrame(() => {
      const rect = popover.getBoundingClientRect();
      if (rect.bottom > viewportHeight && targetRect.top - rect.height - margin > 0) {
        top = targetRect.top - rect.height - margin;
      }
      popover.style.top = `${top}px`;
    });
  }

  function render(content: HTMLElement, targetRect: DOMRect, previewId?: number) {
    const popover = ensureContainer();
    if (hideTimer) {
      window.clearTimeout(hideTimer);
      hideTimer = null;
    }

    popover.replaceChildren(content);
    positionPopover(popover, targetRect);
    requestAnimationFrame(() => {
      if (typeof previewId === 'number' && previewId !== activePreviewId) {
        return;
      }
      popover.classList.add('visible');
    });
  }

  function hide() {
    if (!container) return;
    if (hideTimer) {
      window.clearTimeout(hideTimer);
      hideTimer = null;
    }
    // Invalidate in-flight async previews so stale completions cannot re-open the popover.
    activePreviewId += 1;
    container.classList.remove('visible');
  }

  function createPreviewCard(header: string, bodyNode: HTMLElement): HTMLElement {
    const card = document.createElement('div');
    card.className = 'audit-preview-card';

    const headerEl = document.createElement('div');
    headerEl.className = 'audit-preview-header';
    headerEl.textContent = header;

    const bodyEl = document.createElement('div');
    bodyEl.className = 'audit-preview-body';
    bodyEl.appendChild(bodyNode);

    card.appendChild(headerEl);
    card.appendChild(bodyEl);
    return card;
  }

  function scheduleHide() {
    if (hideTimer) {
      window.clearTimeout(hideTimer);
    }
    hideTimer = window.setTimeout(() => {
      hide();
    }, PREVIEW_HIDE_DELAY_MS);
  }

  async function showPreview(pill: HTMLElement, suggestion: string) {
    const previewId = ++activePreviewId;
    const targetRect = pill.getBoundingClientRect();
    const basename = getBasename(suggestion);

    const loadingEl = document.createElement('div');
    loadingEl.className = 'audit-preview-loading';
    loadingEl.textContent = 'Loading preview…';
    render(createPreviewCard('Preview', loadingEl), targetRect, previewId);

    if (isImageSuggestion(suggestion)) {
      if (typeof window.resolveImagePath === 'function') {
        try {
          const resolvedUri = await window.resolveImagePath(suggestion);
          if (previewId !== activePreviewId) return;

          const wrapper = document.createElement('div');
          wrapper.className = 'audit-preview-image-wrapper';
          const image = document.createElement('img');
          image.src = resolvedUri;
          image.alt = basename;
          wrapper.appendChild(image);

          const caption = document.createElement('div');
          caption.className = 'audit-preview-caption';
          caption.textContent = basename;

          const body = document.createElement('div');
          body.appendChild(wrapper);
          body.appendChild(caption);
          render(createPreviewCard('Image preview', body), targetRect, previewId);
          return;
        } catch {
          if (previewId !== activePreviewId) return;
        }
      }

      const unavailable = document.createElement('div');
      unavailable.className = 'audit-preview-empty';
      unavailable.textContent = 'Image preview is not available for this path.';
      render(createPreviewCard('Preview unavailable', unavailable), targetRect, previewId);
      return;
    }

    const fileIcon = getFileIconName(suggestion);
    const file = document.createElement('div');
    file.className = 'audit-preview-file';
    const icon = document.createElement('span');
    icon.className = `codicon codicon-${fileIcon} preview-file-icon`;
    const meta = document.createElement('div');
    meta.className = 'preview-file-meta';
    const name = document.createElement('div');
    name.className = 'preview-file-name';
    name.textContent = basename;
    const pathEl = document.createElement('div');
    pathEl.className = 'preview-file-path';
    pathEl.textContent = suggestion;
    meta.appendChild(name);
    meta.appendChild(pathEl);
    file.appendChild(icon);
    file.appendChild(meta);
    render(createPreviewCard('File preview', file), targetRect, previewId);
  }

  return {
    show: showPreview,
    hide,
    scheduleHide,
  };
})();

/**
 * Build the "📁 Browse…" button that opens the VS Code file picker.
 *
 * @param fileType - Filter to pass to the extension ('image' | 'any').
 */
function buildBrowseButton(fileType: AuditFileType): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.className = 'audit-browse-btn';
  btn.setAttribute('data-file-type', fileType);
  btn.innerHTML = '<span class="codicon codicon-folder" aria-hidden="true"></span> Browse…';
  btn.title = 'Open file picker to select the correct file';
  return btn;
}

// ─── Interaction wiring ───────────────────────────────────────────────────────

/**
 * Attach all click/key handlers to a rendered issue item.
 */
function wireItemHandlers(
  item: HTMLElement,
  editor: Editor,
  allIssues: AuditIssue[],
  overlay: HTMLElement
) {
  // Navigate button: jump to issue, keep highlight, close overlay.
  const navBtn = item.querySelector('.audit-issue-nav-btn') as HTMLButtonElement | null;
  if (navBtn) {
    navBtn.addEventListener('click', (e: Event) => {
      e.stopPropagation();
      navigateToIssue(item, editor);
      overlay.classList.remove('visible');
      auditPreviewPopover.hide();
    });
  }

  // Allow keyboard navigation on issue rows
  item.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      navBtn?.click();
    }
  });

  // Suggestion pill → apply immediately
  const pillContainer = item.querySelector('.audit-suggestion-pills');
  if (pillContainer) {
    pillContainer.addEventListener('click', (e: Event) => {
      const pill = (e.target as HTMLElement).closest(
        '.audit-suggestion-pill'
      ) as HTMLElement | null;
      if (!pill) return;
      e.stopPropagation();
      const suggestion = pill.getAttribute('data-suggestion');
      if (suggestion) {
        const pos = parseInt(item.getAttribute('data-pos') ?? '0', 10);
        const typeStr = item.getAttribute('data-type');
        applyFix(pos, typeStr, suggestion, item, allIssues, editor, overlay);
      }
    });
  }

  // Browse button → open VS Code file picker, then apply selected path
  // Browse button → open VS Code file picker, then apply selected path
  const browseBtn = item.querySelector('.audit-browse-btn') as HTMLButtonElement | null;
  if (browseBtn) {
    browseBtn.addEventListener('click', async (e: Event) => {
      e.stopPropagation();
      const fileType = (browseBtn.getAttribute('data-file-type') ?? 'any') as AuditFileType;
      browseBtn.disabled = true;

      // Update wait state
      browseBtn.innerHTML =
        '<span class="codicon codicon-clock" aria-hidden="true"></span> Waiting…';

      try {
        const selected = await requestFilePickerForIssue(fileType);
        if (selected) {
          const pos = parseInt(item.getAttribute('data-pos') ?? '0', 10);
          const typeStr = item.getAttribute('data-type');
          applyFix(pos, typeStr, selected, item, allIssues, editor, overlay);
        } else {
          // User cancelled – restore button with folder icon
          browseBtn.disabled = false;
          browseBtn.innerHTML =
            '<span class="codicon codicon-folder" aria-hidden="true"></span> Browse…';
        }
      } catch {
        // Error – restore button with folder icon
        browseBtn.disabled = false;
        browseBtn.innerHTML =
          '<span class="codicon codicon-folder" aria-hidden="true"></span> Browse…';
      }
    });
  }

  // Manual fix button
  const manualFixBtn = item.querySelector(
    '.audit-fix-button.manual-fix'
  ) as HTMLButtonElement | null;
  if (manualFixBtn) {
    manualFixBtn.addEventListener('click', (e: Event) => {
      e.stopPropagation();
      const input = manualFixBtn.previousElementSibling as HTMLInputElement;
      const posStr = manualFixBtn.getAttribute('data-pos');
      const typeStr = manualFixBtn.getAttribute('data-type');

      if (posStr && input && input.value.trim()) {
        const pos = parseInt(posStr, 10);
        applyFix(pos, typeStr, input.value.trim(), item, allIssues, editor, overlay);
      }
    });
  }
}

// ─── Editor actions ───────────────────────────────────────────────────────────

/**
 * Scroll the editor to the issue position and select the node/text.
 */
function navigateToIssue(item: HTMLElement, editor: Editor): void {
  const posStr = item.getAttribute('data-pos');
  const typeStr = item.getAttribute('data-type');
  if (!posStr) return;

  const pos = parseInt(posStr, 10);
  const node = editor.state.doc.nodeAt(pos);
  const nodeSize = node ? node.nodeSize : 1;

  if (
    typeStr === 'image' &&
    node &&
    (node.type.name === 'image' || node.type.name === 'customImage')
  ) {
    editor.commands.setNodeSelection(pos);
  } else {
    editor.commands.setTextSelection({ from: pos, to: pos + nodeSize });
  }

  editor.commands.focus();

  // Center the selected issue in the viewport for consistent navigation feedback.
  requestAnimationFrame(() => {
    try {
      const resolved = editor.view.domAtPos(pos).node as Node;
      const element =
        resolved instanceof Element ? resolved : (resolved.parentElement ?? editor.view.dom);
      element.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
    } catch {
      try {
        editor.view.dispatch(editor.state.tr.scrollIntoView());
      } catch {
        editor.commands.focus();
      }
    }
  });
}

/**
 * Apply a path fix to the document, then remove the issue from the overlay.
 * Dispatcher: routes to image attribute update or link mark update.
 */
function applyFix(
  pos: number,
  typeStr: string | null,
  suggestion: string,
  item: HTMLElement,
  allIssues: AuditIssue[],
  editor: Editor,
  overlay: HTMLElement
): void {
  const node = editor.state.doc.nodeAt(pos);
  const nodeSize = node ? node.nodeSize : 1;

  // Recompute remaining issues AND map their positions
  const remainingIssues = allIssues.filter(
    (i: AuditIssue) => !(i.pos === pos && i.nodeSize === nodeSize)
  );

  // Refactor the fix application to use a single transaction so we can map positions accurately

  const fixTr = editor.state.tr;
  if (typeStr === 'image') {
    const node = editor.state.doc.nodeAt(pos);
    if (node && (node.type.name === 'image' || node.type.name === 'customImage')) {
      fixTr.setNodeMarkup(pos, undefined, {
        ...node.attrs,
        src: suggestion,
        'markdown-src': suggestion,
      });
    }
  } else if (typeStr === 'link' || typeStr === 'heading') {
    const href =
      typeStr === 'heading'
        ? suggestion.startsWith('#')
          ? suggestion
          : `#${suggestion}`
        : suggestion;

    // Use a custom link mark update that works with the transaction
    const linkMark = editor.schema.marks.link.create({ href });
    fixTr.addMark(pos, pos + nodeSize, linkMark);
  }

  // Now map all remaining issues to their new positions
  const mappedIssues = remainingIssues.map(issue => ({
    ...issue,
    pos: fixTr.mapping.map(issue.pos),
  }));

  // Update the decorations via metadata
  fixTr.setMeta(auditPluginKey, mappedIssues);

  // Dispatch the fix transaction
  editor.view.dispatch(fixTr);

  // Update the shared issues array in-place so other closures see the update
  allIssues.length = 0;
  allIssues.push(...mappedIssues);

  // Update DOM attributes of remaining items in the overlay to stay in sync
  const otherItems = overlay.querySelectorAll('.audit-overlay-item');
  otherItems.forEach(otherItem => {
    const otherItemPos = parseInt(otherItem.getAttribute('data-pos') ?? '0', 10);
    // Find the issue in our mapped set that corresponds to this item
    // Actually, mapping should be consistent.
    const newPos = fixTr.mapping.map(otherItemPos);
    otherItem.setAttribute('data-pos', String(newPos));
  });

  // Remove item from list and hide any active preview immediately
  item.remove();
  auditPreviewPopover.hide();

  // Show "all fixed" message if last issue resolved
  if (overlay.querySelectorAll('.audit-overlay-item').length === 0) {
    const list = overlay.querySelector('.audit-overlay-list');
    if (list) {
      list.innerHTML = `<div style="padding:20px;text-align:center;">All fixed! 🎉</div>`;
    }
  }
}
