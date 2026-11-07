/**
 * Copyright (c) 2025-2026 Concret.io
 *
 * Licensed under the MIT License. See LICENSE file in the project root for details.
 *
 * @jest-environment jsdom
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';
import {
  FEEDBACK_TOOLBAR_COMPACT_CLASS,
  fitFeedbackToolbarLabels,
} from '../../webview/utils/fitFeedbackToolbarLabels';

function toolbarWith(needed: number, available: number): HTMLElement {
  const toolbar = document.createElement('div');
  const group = document.createElement('div');
  group.setAttribute('data-feedback-toolbar-group', '');
  // jsdom has no layout, so the two widths the function compares are given here.
  Object.defineProperty(group, 'scrollWidth', { value: needed });
  Object.defineProperty(group, 'clientWidth', { value: available });
  toolbar.append(group);
  return toolbar;
}

describe('fitFeedbackToolbarLabels', () => {
  it('keeps the labels when the buttons fit', () => {
    const toolbar = toolbarWith(623, 770);
    fitFeedbackToolbarLabels(toolbar);
    expect(toolbar.classList.contains(FEEDBACK_TOOLBAR_COMPACT_CLASS)).toBe(false);
  });

  it('hides the labels when the buttons need more room than the toolbar has', () => {
    // Russian labels need about 734 px; a split editor offers less.
    const toolbar = toolbarWith(734, 684);
    fitFeedbackToolbarLabels(toolbar);
    expect(toolbar.classList.contains(FEEDBACK_TOOLBAR_COMPACT_CLASS)).toBe(true);
  });

  it('shows the labels again once there is room', () => {
    const toolbar = toolbarWith(623, 770);
    toolbar.classList.add(FEEDBACK_TOOLBAR_COMPACT_CLASS);
    fitFeedbackToolbarLabels(toolbar);
    expect(toolbar.classList.contains(FEEDBACK_TOOLBAR_COMPACT_CLASS)).toBe(false);
  });

  it('clears the class when the Feedback buttons are gone', () => {
    const toolbar = document.createElement('div');
    toolbar.classList.add(FEEDBACK_TOOLBAR_COMPACT_CLASS);
    fitFeedbackToolbarLabels(toolbar);
    expect(toolbar.classList.contains(FEEDBACK_TOOLBAR_COMPACT_CLASS)).toBe(false);
  });
});

describe('Feedback toolbar label fitting CSS', () => {
  const css = readFileSync(resolve(__dirname, '../../webview/editor.css'), 'utf8');

  it('never squeezes a button below its label, so the needed width can be measured', () => {
    const rule = css.match(/\.feedback-toolbar-group \.feedback-toolbar-button\s*\{[^}]*\}/)?.[0];
    expect(rule).toMatch(/flex-shrink:\s*0/);
  });

  it('shows icons only in the compact state', () => {
    expect(css).toMatch(
      /\.feedback-toolbar-compact \.feedback-toolbar-button \.toolbar-button-label\s*\{[^}]*display:\s*none/
    );
    expect(css).toMatch(
      /\.feedback-toolbar-compact \.feedback-toolbar-button\s*\{[^}]*width:\s*28px;[^}]*min-width:\s*28px/
    );
  });
});
