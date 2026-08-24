/**
 * Copyright (c) 2025-2026 Concret.io
 *
 * Licensed under the MIT License. See LICENSE file in the project root for details.
 *
 * @fileoverview Accessible in-webview confirmation for discarding unfinished
 * Feedback items. VS Code webviews do not grant the iframe permission required
 * by native browser modal dialogs, so this surface must remain DOM-based.
 */

export interface FeedbackDiscardDialogOptions {
  /** Explains exactly which unfinished work will be lost. */
  description: string;
  title?: string;
  keepLabel?: string;
  confirmLabel?: string;
  returnFocus?: HTMLElement;
  /** Temporarily removed from interaction and the accessibility tree. */
  suspendedSurface?: HTMLElement;
  mount?: HTMLElement;
}

export interface FeedbackDiscardDialogController {
  readonly element: HTMLElement;
  readonly result: Promise<boolean>;
  /** Moves focus to the safe default action without scrolling the document. */
  focus(): void;
  /** Closes as a safe cancellation and restores the logical draft focus. */
  keepEditing(): void;
  /** Resolves true without refocusing a draft the caller is about to remove. */
  confirmDiscard(): void;
  /** Tears down during an enclosing lifecycle change without restoring focus. */
  destroy(): void;
}

let discardDialogSequence = 0;

function focusWithoutScroll(element: HTMLElement | undefined): void {
  if (!element?.isConnected) return;
  try {
    element.focus({ preventScroll: true });
  } catch {
    element.focus();
  }
}

/**
 * Opens one labelled, focus-contained discard checkpoint inside the webview.
 * The promise resolves true only from the explicit destructive action.
 */
export function createFeedbackDiscardDialog(
  options: FeedbackDiscardDialogOptions
): FeedbackDiscardDialogController {
  const sequence = ++discardDialogSequence;
  const titleId = `md4h-feedback-discard-title-${sequence}`;
  const descriptionId = `md4h-feedback-discard-description-${sequence}`;
  const mount = options.mount ?? document.body;
  const surface = options.suspendedSurface;
  const surfaceWasInert = surface?.inert ?? false;
  const surfaceAriaHidden = surface?.getAttribute('aria-hidden') ?? null;

  const dialog = document.createElement('section');
  dialog.className = 'feedback-annotation-dialog feedback-discard-dialog';
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-labelledby', titleId);
  dialog.setAttribute('aria-describedby', descriptionId);
  dialog.setAttribute('data-md4h-modal', '');
  dialog.setAttribute('data-feedback-discard-dialog', '');
  dialog.tabIndex = -1;

  const panel = document.createElement('div');
  panel.className = 'feedback-annotation-panel feedback-discard-panel';
  const title = document.createElement('h2');
  title.id = titleId;
  title.className = 'feedback-discard-title';
  title.textContent = options.title ?? 'Discard unfinished feedback?';
  const description = document.createElement('p');
  description.id = descriptionId;
  description.className = 'feedback-discard-description';
  description.textContent = options.description;
  const actions = document.createElement('div');
  actions.className = 'feedback-annotation-actions feedback-discard-actions';
  const keep = document.createElement('button');
  keep.type = 'button';
  keep.className = 'feedback-secondary-button';
  keep.textContent = options.keepLabel ?? 'Keep editing';
  keep.setAttribute('data-feedback-discard-keep', '');
  const confirm = document.createElement('button');
  confirm.type = 'button';
  confirm.className = 'feedback-discard-confirm';
  confirm.textContent = options.confirmLabel ?? 'Discard feedback';
  confirm.setAttribute('data-feedback-discard-confirm', '');
  actions.append(keep, confirm);
  panel.append(title, description, actions);
  dialog.append(panel);

  let settled = false;
  let resolveResult: (discard: boolean) => void = () => undefined;
  const result = new Promise<boolean>(resolve => {
    resolveResult = resolve;
  });
  const priorInertState = new Map<HTMLElement, boolean>();
  const isolate = (element: HTMLElement): void => {
    if (element === dialog || element.contains(dialog) || priorInertState.has(element)) return;
    priorInertState.set(element, element.inert === true);
    element.inert = true;
  };
  const isolateBodyChildren = (): void => {
    for (const child of Array.from(document.body.children)) {
      if (child instanceof HTMLElement) isolate(child);
    }
  };
  const observer =
    typeof MutationObserver === 'function'
      ? new MutationObserver(() => isolateBodyChildren())
      : null;

  const restoreSuspendedSurface = (): void => {
    if (!surface) return;
    surface.inert = surfaceWasInert;
    if (surfaceAriaHidden === null) surface.removeAttribute('aria-hidden');
    else surface.setAttribute('aria-hidden', surfaceAriaHidden);
  };

  const finish = (discard: boolean, restoreFocus: boolean): void => {
    if (settled) return;
    settled = true;
    dialog.removeEventListener('keydown', handleKeyDown);
    dialog.removeEventListener('wheel', containPointerScroll);
    dialog.removeEventListener('touchmove', containPointerScroll);
    observer?.disconnect();
    dialog.remove();
    for (const [element, wasInert] of priorInertState) element.inert = wasInert;
    priorInertState.clear();
    restoreSuspendedSurface();
    if (restoreFocus) focusWithoutScroll(options.returnFocus);
    resolveResult(discard);
  };

  const handleKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      finish(false, true);
      return;
    }
    if (['PageUp', 'PageDown', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      return;
    }
    if (event.key !== 'Tab') return;
    const controls = [keep, confirm].filter(button => !button.disabled);
    const currentIndex = controls.indexOf(document.activeElement as HTMLButtonElement);
    if (event.shiftKey && currentIndex <= 0) {
      event.preventDefault();
      controls[controls.length - 1]?.focus({ preventScroll: true });
    } else if (!event.shiftKey && (currentIndex < 0 || currentIndex === controls.length - 1)) {
      event.preventDefault();
      controls[0]?.focus({ preventScroll: true });
    }
  };

  const containPointerScroll = (event: Event): void => {
    if (event.target instanceof Node && panel.contains(event.target)) return;
    event.preventDefault();
  };

  keep.addEventListener('click', () => finish(false, true));
  confirm.addEventListener('click', () => finish(true, false));
  dialog.addEventListener('keydown', handleKeyDown);
  dialog.addEventListener('wheel', containPointerScroll, { passive: false });
  dialog.addEventListener('touchmove', containPointerScroll, { passive: false });
  mount.append(dialog);
  // Move focus before hiding the previously active draft. Chromium rejects
  // aria-hidden on an ancestor that still contains the active element.
  focusWithoutScroll(keep);
  isolateBodyChildren();
  observer?.observe(document.body, { childList: true });
  if (surface) {
    surface.inert = true;
    surface.setAttribute('aria-hidden', 'true');
  }

  return {
    element: dialog,
    result,
    focus: () => focusWithoutScroll(keep),
    keepEditing: () => finish(false, true),
    confirmDiscard: () => finish(true, false),
    destroy: () => finish(false, false),
  };
}
