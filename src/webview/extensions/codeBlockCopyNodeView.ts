/**
 * Copyright (c) 2025-2026 Concret.io
 *
 * Licensed under the MIT License. See LICENSE file in the project root for details.
 */

import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import type { NodeView } from '@tiptap/pm/view';

const COPY_FEEDBACK_MS = 1500;

type CodeBlockHtmlAttributes = Record<string, unknown>;

function applyHtmlAttributes(element: HTMLElement, attributes: CodeBlockHtmlAttributes): void {
  Object.entries(attributes).forEach(([name, value]) => {
    if (value === null || value === undefined || value === false) {
      return;
    }
    element.setAttribute(name, String(value));
  });
}

function copyWithExecCommand(text: string): boolean {
  if (typeof document.execCommand !== 'function') {
    return false;
  }

  const previousFocus = document.activeElement;
  const selection = window.getSelection();
  const previousRanges =
    selection === null
      ? []
      : Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index));
  const textarea = document.createElement('textarea');
  textarea.className = 'code-block-copy-fallback';
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();

  try {
    return document.execCommand('copy');
  } finally {
    textarea.remove();
    selection?.removeAllRanges();
    previousRanges.forEach(range => selection?.addRange(range));
    if (previousFocus instanceof HTMLElement) {
      previousFocus.focus({ preventScroll: true });
    }
  }
}

async function copyCodeText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (error) {
    console.warn('[MD4H] Clipboard API unavailable, using copy fallback:', error);
  }

  return copyWithExecCommand(text);
}

/**
 * Creates a ProseMirror node view that keeps code editable while placing the
 * copy control outside the managed content DOM.
 */
export function createCodeBlockCopyNodeView(
  initialNode: ProseMirrorNode,
  htmlAttributes: CodeBlockHtmlAttributes,
  languageClassPrefix = 'language-'
): NodeView {
  let currentNode = initialNode;
  let feedbackTimer: number | null = null;

  const wrapper = document.createElement('div');
  wrapper.className = 'code-block-wrapper';

  const pre = document.createElement('pre');
  applyHtmlAttributes(pre, htmlAttributes);

  const code = document.createElement('code');
  const updateLanguageClass = (node: ProseMirrorNode): void => {
    const language = typeof node.attrs.language === 'string' ? node.attrs.language : '';
    code.className = language ? `${languageClassPrefix}${language}` : '';
  };
  updateLanguageClass(currentNode);

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'code-block-copy-button';
  button.contentEditable = 'false';
  button.setAttribute('contenteditable', 'false');
  button.title = 'Copy code block';
  button.setAttribute('aria-label', 'Copy code block');

  const icon = document.createElement('span');
  icon.className = 'codicon codicon-copy';
  icon.setAttribute('aria-hidden', 'true');
  button.appendChild(icon);

  const tooltip = document.createElement('span');
  tooltip.className = 'code-block-copy-tooltip';
  tooltip.contentEditable = 'false';
  tooltip.setAttribute('contenteditable', 'false');
  tooltip.setAttribute('role', 'status');
  tooltip.setAttribute('aria-live', 'polite');

  const setCopyState = (copied: boolean): void => {
    button.classList.toggle('is-copied', copied);
    icon.classList.toggle('codicon-copy', !copied);
    icon.classList.toggle('codicon-check', copied);
    tooltip.classList.toggle('visible', copied);
    tooltip.textContent = copied ? 'Copied!' : '';
    button.setAttribute('aria-label', copied ? 'Code block copied' : 'Copy code block');
  };

  button.addEventListener('mousedown', event => {
    // Keep the current editor selection and focus unchanged for mouse users.
    event.preventDefault();
    event.stopPropagation();
  });

  button.addEventListener('click', event => {
    event.preventDefault();
    event.stopPropagation();

    void copyCodeText(currentNode.textContent)
      .then(copied => {
        if (copied) {
          setCopyState(true);
        } else {
          button.classList.remove('is-copied');
          icon.className = 'codicon codicon-copy';
          tooltip.classList.add('visible', 'is-error');
          tooltip.textContent = 'Copy failed';
          button.setAttribute('aria-label', 'Could not copy code block');
        }

        if (feedbackTimer !== null) {
          window.clearTimeout(feedbackTimer);
        }
        feedbackTimer = window.setTimeout(() => {
          setCopyState(false);
          tooltip.classList.remove('is-error');
          feedbackTimer = null;
        }, COPY_FEEDBACK_MS);
      })
      .catch(error => {
        console.error('[MD4H] Failed to copy code block:', error);
      });
  });

  pre.appendChild(code);
  wrapper.appendChild(pre);
  wrapper.appendChild(tooltip);
  wrapper.appendChild(button);

  return {
    dom: wrapper,
    contentDOM: code,
    update: updatedNode => {
      if (updatedNode.type !== currentNode.type) {
        return false;
      }

      currentNode = updatedNode;
      updateLanguageClass(currentNode);
      return true;
    },
    stopEvent: event =>
      button.contains(event.target as globalThis.Node) ||
      tooltip.contains(event.target as globalThis.Node),
    ignoreMutation: mutation => !code.contains(mutation.target) && mutation.target !== code,
    destroy: () => {
      if (feedbackTimer !== null) {
        window.clearTimeout(feedbackTimer);
      }
    },
  };
}
