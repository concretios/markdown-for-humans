/**
 * Copyright (c) 2025-2026 Concret.io
 *
 * Licensed under the MIT License. See LICENSE file in the project root for details.
 *
 * @fileoverview Explicit read-only state for a rich-view split whose sibling
 * owns a frozen Feedback session, with a route back to that owner. This has no
 * runtime cost outside that state.
 */

import type { Editor } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { createFeedbackNodeViewInteractionGuards } from './feedbackReview';

export interface FeedbackPeerLockController {
  lock(lockId: string, message: string): void;
  unlock(lockId: string): void;
  runHostUpdate<T>(update: () => T): T;
  destroy(): void;
  isLocked(): boolean;
  getLockId(): string | null;
}

export const feedbackPeerReadOnlyPluginKey = new PluginKey('md4hFeedbackPeerReadOnly');

/** Block document changes while continuing to allow selection-only transactions. */
export function createFeedbackPeerReadOnlyPlugin(): Plugin {
  return new Plugin({
    key: feedbackPeerReadOnlyPluginKey,
    filterTransaction: transaction => !transaction.docChanged,
  });
}

/**
 * Lock a non-owning split without creating Feedback chrome in that split.
 * A correlated lock ID prevents a delayed unlock from clearing a newer lock.
 * Navigation stays outside the inert toolbar and never clears read-only state.
 * Plain Tab and Shift+Tab use native focus traversal while the split is locked.
 */
export function createFeedbackPeerLockController(options: {
  editor: Editor;
  toolbar: HTMLElement;
  onGoToActiveFeedback: (lockId: string) => void;
}): FeedbackPeerLockController {
  const { editor, toolbar } = options;
  const editorDom = editor.view.dom as HTMLElement;
  const nodeViewGuards = createFeedbackNodeViewInteractionGuards(editorDom);
  let lockId: string | null = null;
  let banner: HTMLElement | null = null;
  let bannerMessage: HTMLElement | null = null;
  let pluginRegistered = false;
  let originalAriaReadonly: string | null = null;
  let originalTabIndex: string | null = null;
  let toolbarHadInert = false;
  let originalToolbarAriaDisabled: string | null = null;

  const guardMutation = (event: Event): void => {
    event.preventDefault();
    event.stopImmediatePropagation();
  };

  const allowFocusTraversal = (event: KeyboardEvent): void => {
    if (event.key !== 'Tab' || event.altKey || event.ctrlKey || event.metaKey) return;
    // Editing keymaps consume Tab even when the read-only plugin rejects their
    // transaction. Skip those keymaps while preserving native browser traversal.
    event.stopImmediatePropagation();
  };

  const registerPlugin = (): void => {
    if (pluginRegistered || editor.isDestroyed) return;
    const dynamicEditor = editor as Editor & { registerPlugin?: Editor['registerPlugin'] };
    if (typeof dynamicEditor.registerPlugin !== 'function') return;
    dynamicEditor.registerPlugin(createFeedbackPeerReadOnlyPlugin());
    pluginRegistered = true;
  };

  const unregisterPlugin = (): void => {
    if (!pluginRegistered) return;
    const dynamicEditor = editor as Editor & { unregisterPlugin?: Editor['unregisterPlugin'] };
    if (!editor.isDestroyed && typeof dynamicEditor.unregisterPlugin === 'function') {
      dynamicEditor.unregisterPlugin(feedbackPeerReadOnlyPluginKey);
    }
    pluginRegistered = false;
  };

  const renderBanner = (message: string): void => {
    if (!banner) {
      banner = document.createElement('section');
      banner.className = 'feedback-peer-lock-banner';
      banner.setAttribute('data-feedback-peer-lock', '');
      banner.setAttribute('role', 'status');
      banner.setAttribute('aria-live', 'polite');
      bannerMessage = document.createElement('span');
      bannerMessage.className = 'feedback-peer-lock-message';
      const navigateButton = document.createElement('button');
      navigateButton.type = 'button';
      navigateButton.className = 'feedback-peer-lock-action feedback-secondary-button';
      navigateButton.textContent = 'Go to active feedback';
      navigateButton.addEventListener('click', () => {
        if (lockId !== null) options.onGoToActiveFeedback(lockId);
      });
      banner.append(bannerMessage, navigateButton);
      const shell = editorDom.closest<HTMLElement>('#editor')?.parentElement;
      if (toolbar.parentElement) toolbar.insertAdjacentElement('afterend', banner);
      else shell?.prepend(banner);
    }
    if (bannerMessage) bannerMessage.textContent = message;
  };

  const activate = (nextLockId: string, message: string): void => {
    if (lockId === null) {
      originalAriaReadonly = editorDom.getAttribute('aria-readonly');
      originalTabIndex = editorDom.getAttribute('tabindex');
      toolbarHadInert = toolbar.hasAttribute('inert');
      originalToolbarAriaDisabled = toolbar.getAttribute('aria-disabled');
      editorDom.addEventListener('beforeinput', guardMutation, true);
      editorDom.addEventListener('cut', guardMutation, true);
      editorDom.addEventListener('paste', guardMutation, true);
      editorDom.addEventListener('drop', guardMutation, true);
      editorDom.addEventListener('keydown', allowFocusTraversal, true);
      nodeViewGuards.setActive(true);
      registerPlugin();
      editorDom.setAttribute('aria-readonly', 'true');
      editorDom.setAttribute('tabindex', '0');
      toolbar.setAttribute('inert', '');
      toolbar.setAttribute('aria-disabled', 'true');
      document.body.classList.add('feedback-peer-locked');
    }
    lockId = nextLockId;
    renderBanner(message);
  };

  const deactivate = (): void => {
    if (lockId === null) return;
    const reviewOwnsReadOnlyState = document.body.classList.contains('feedback-review-active');
    lockId = null;
    editorDom.removeEventListener('beforeinput', guardMutation, true);
    editorDom.removeEventListener('cut', guardMutation, true);
    editorDom.removeEventListener('paste', guardMutation, true);
    editorDom.removeEventListener('drop', guardMutation, true);
    editorDom.removeEventListener('keydown', allowFocusTraversal, true);
    nodeViewGuards.setActive(false);
    unregisterPlugin();
    if (reviewOwnsReadOnlyState) {
      // A transferred session activates the review controller before the old
      // peer token retires. Preserve the new controller's accessibility state
      // instead of restoring values captured before Feedback began.
      editorDom.setAttribute('aria-readonly', 'true');
      editorDom.setAttribute('tabindex', '0');
    } else {
      if (originalAriaReadonly === null) editorDom.removeAttribute('aria-readonly');
      else editorDom.setAttribute('aria-readonly', originalAriaReadonly);
      if (originalTabIndex === null) editorDom.removeAttribute('tabindex');
      else editorDom.setAttribute('tabindex', originalTabIndex);
    }
    if (toolbarHadInert) toolbar.setAttribute('inert', '');
    else toolbar.removeAttribute('inert');
    if (originalToolbarAriaDisabled === null) toolbar.removeAttribute('aria-disabled');
    else toolbar.setAttribute('aria-disabled', originalToolbarAriaDisabled);
    originalAriaReadonly = null;
    originalTabIndex = null;
    originalToolbarAriaDisabled = null;
    toolbarHadInert = false;
    banner?.remove();
    banner = null;
    bannerMessage = null;
    document.body.classList.remove('feedback-peer-locked');
  };

  return {
    lock: activate,
    unlock(candidateLockId) {
      if (candidateLockId !== lockId) return;
      deactivate();
    },
    runHostUpdate(update) {
      if (lockId === null || !pluginRegistered) return update();
      unregisterPlugin();
      try {
        return update();
      } finally {
        if (lockId !== null) registerPlugin();
      }
    },
    destroy: deactivate,
    isLocked: () => lockId !== null,
    getLockId: () => lockId,
  };
}
