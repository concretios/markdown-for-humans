/**
 * Copyright (c) 2026 Concret.io
 * Licensed under the MIT License. See LICENSE file in the project root for details.
 *
 * Per-occurrence SVG sizing. Only document attributes change; no asset writes,
 * canvas conversion, or independent file-undo history are involved.
 */
import type { Editor } from '@tiptap/core';
import { closeHistory } from '@tiptap/pm/history';
import { isSvgImageSource } from '../../shared/imageSource';
import { imageDimension } from '../extensions/htmlImageSource';

let closeCurrent: (() => void) | null = null;

/** Open a keyboard-accessible size dialog bound to the exact live image node. */
export function showSvgDisplaySize(
  img: HTMLImageElement,
  editor: Editor,
  getPos: () => number | undefined
): void {
  closeCurrent?.();
  if (editor.isDestroyed || !editor.isEditable) return;
  const position = getPos();
  const original = typeof position === 'number' ? editor.state.doc.nodeAt(position) : null;
  if (
    !original ||
    original.type.name !== 'image' ||
    !isSvgImageSource(original.attrs['markdown-src'] || original.attrs.src || '')
  )
    return;

  const focusedElement = document.activeElement;
  const previousFocus =
    focusedElement instanceof HTMLElement && focusedElement.closest('.image-context-menu')
      ? img.closest('.image-wrapper')?.querySelector('.image-menu-button')
      : focusedElement;
  const overlay = document.createElement('div');
  overlay.className = 'svg-display-size-overlay';
  const form = document.createElement('form');
  form.className = 'svg-display-size';
  form.setAttribute('role', 'dialog');
  form.setAttribute('aria-modal', 'true');
  form.setAttribute('aria-label', 'SVG display size');
  form.noValidate = true;
  const heading = document.createElement('h2');
  heading.textContent = 'Display size';
  const explanation = document.createElement('p');
  explanation.textContent = 'Change this image in the document. The SVG file stays unchanged.';
  const label = document.createElement('label');
  label.textContent = 'Width (px)';
  const input = document.createElement('input');
  input.type = 'number';
  input.min = '1';
  input.max = '10000';
  input.step = '1';
  input.required = true;
  input.value = String(
    Math.round(imageDimension(original.attrs.width) || img.width || img.naturalWidth || 300)
  );
  label.appendChild(input);
  const error = document.createElement('p');
  error.className = 'svg-display-size-error';
  error.setAttribute('role', 'alert');
  const actions = document.createElement('div');
  actions.className = 'svg-display-size-actions';
  const reset = document.createElement('button');
  reset.type = 'button';
  reset.dataset.action = 'reset-size';
  reset.textContent = 'Reset size';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.textContent = 'Cancel';
  const apply = document.createElement('button');
  apply.type = 'submit';
  apply.textContent = 'Apply';
  actions.append(reset, cancel, apply);
  form.append(heading, explanation, label, error, actions);
  overlay.appendChild(form);

  const close = (restoreFocus = true) => {
    overlay.remove();
    document.removeEventListener('keydown', onKeyDown, true);
    editor.off('destroy', onDestroy);
    if (closeCurrent === close) closeCurrent = null;
    if (
      restoreFocus &&
      document.hasFocus() &&
      !editor.isDestroyed &&
      previousFocus instanceof HTMLElement &&
      previousFocus.isConnected
    )
      previousFocus.focus();
  };
  const onDestroy = () => close(false);
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (event.key === 'Tab') {
      const controls = [input, reset, cancel, apply];
      const index = controls.findIndex(control => control === document.activeElement);
      const next = (index + (event.shiftKey ? controls.length - 1 : 1)) % controls.length;
      event.preventDefault();
      controls[next].focus();
    }
  };
  const applyWidth = (width: number | null) => {
    if (editor.isDestroyed || !editor.isEditable) {
      error.textContent = 'The document is read-only.';
      return;
    }
    const currentPosition = getPos();
    if (
      typeof currentPosition !== 'number' ||
      editor.state.doc.nodeAt(currentPosition) !== original
    ) {
      error.textContent = 'The image changed. Close and reopen Display size.';
      return;
    }
    const transaction = editor.state.tr.setNodeMarkup(currentPosition, undefined, {
      ...original.attrs,
      width,
      height: null,
    });
    const previousDocument = editor.state.doc;
    editor.view.dispatch(closeHistory(transaction));
    // Feedback owner/peer locks filter document transactions without changing
    // isEditable. Dispatch alone is not proof that the size was accepted.
    if (editor.state.doc === previousDocument) {
      error.textContent =
        'The document is read-only or locked. Close and reopen Display size after unlocking it.';
      return;
    }
    close();
  };
  form.addEventListener('submit', event => {
    event.preventDefault();
    const width = Number(input.value);
    if (!input.value || !Number.isInteger(width) || width < 1 || width > 10000) {
      error.textContent = 'Enter a whole-number width between 1 and 10000 pixels.';
      input.setAttribute('aria-invalid', 'true');
      return;
    }
    applyWidth(width);
  });
  reset.addEventListener('click', () => applyWidth(null));
  cancel.addEventListener('click', () => close());
  overlay.addEventListener('click', event => {
    if (event.target === overlay) close();
  });
  closeCurrent = close;
  editor.on('destroy', onDestroy);
  document.addEventListener('keydown', onKeyDown, true);
  document.body.appendChild(overlay);
  input.focus();
  input.select();
}
