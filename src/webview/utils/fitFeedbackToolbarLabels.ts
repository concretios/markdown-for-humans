/**
 * Copyright (c) 2025-2026 Concret.io
 *
 * Licensed under the MIT License. See LICENSE file in the project root for details.
 *
 * @fileoverview Shows the Feedback toolbar as icons when its labels do not fit.
 *
 * The labels are translated, so the width the buttons need differs by display
 * language (about 480 px in Chinese, 620 px in English, 730 px in Russian). A
 * fixed breakpoint cannot serve them all, so the toolbar is measured instead.
 * Each button keeps its full label as tooltip and accessible name.
 *
 * @module webview/utils/fitFeedbackToolbarLabels
 */

/** Set on the toolbar while the Feedback buttons show icons only. */
export const FEEDBACK_TOOLBAR_COMPACT_CLASS = 'feedback-toolbar-compact';

/**
 * Show the Feedback button labels when they all fit, icons only when they do not.
 *
 * @param toolbar - The formatting toolbar that holds the Feedback buttons
 */
export function fitFeedbackToolbarLabels(toolbar: HTMLElement): void {
  // Measure with the labels shown. The buttons do not shrink, so a group that
  // needs more room than the toolbar has overflows its own box.
  toolbar.classList.remove(FEEDBACK_TOOLBAR_COMPACT_CLASS);
  const group = toolbar.querySelector<HTMLElement>('[data-feedback-toolbar-group]');
  if (group && group.scrollWidth > group.clientWidth) {
    toolbar.classList.add(FEEDBACK_TOOLBAR_COMPACT_CLASS);
  }
}
