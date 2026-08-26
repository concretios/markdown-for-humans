/**
 * Copyright (c) 2025-2026 Concret.io
 *
 * Licensed under the MIT License. See LICENSE file in the project root for details.
 */

/**
 * Copy Selection as Markdown
 *
 * Utilities for copying TipTap editor selection to clipboard as clean markdown.
 */

import { Editor } from '@tiptap/core';

/**
 * Result of a copy operation
 */
export interface CopyResult {
  success: boolean;
  markdown?: string;
  error?: string;
}

/**
 * Get the current selection as markdown
 *
 * @param editor - TipTap editor instance
 * @returns Markdown string or null if no selection
 */
export function getSelectionAsMarkdown(editor: Editor): string | null {
  const { from, to, empty } = editor.state.selection;

  if (empty) {
    return null;
  }

  try {
    // Get the selected slice
    const slice = editor.state.doc.slice(from, to);

    // Create a temporary document with just the selection content
    const tempDoc = editor.schema.topNodeType.create(null, slice.content);

    // Try to use the markdown manager from @tiptap/markdown
    // The official package exposes editor.markdown.serialize(json)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const markdownManager = (editor as any).markdown;
    if (markdownManager?.serialize) {
      // Convert temp doc to JSON and serialize
      const json = tempDoc.toJSON();
      return markdownManager.serialize(json);
    }

    // Fallback: Convert to basic markdown by analyzing node types
    return sliceToBasicMarkdown(editor, from, to);
  } catch (error) {
    console.error('[MD4H] Error getting selection as markdown:', error);
    // Fallback to plain text
    return editor.state.doc.textBetween(from, to, '\n\n', '\n');
  }
}

/**
 * Convert a selection to basic markdown by analyzing node types
 * This is a fallback when the serializer isn't available
 */
function sliceToBasicMarkdown(editor: Editor, from: number, to: number): string {
  const lines: string[] = [];

  editor.state.doc.nodesBetween(from, to, (node, pos) => {
    // Skip if position is outside selection
    if (pos < from || pos > to) return;

    const nodeType = node.type.name;
    const text = node.textContent;

    switch (nodeType) {
      case 'heading': {
        const level = node.attrs.level || 1;
        lines.push(`${'#'.repeat(level)} ${text}`);
        return false; // Don't descend into children
      }
      case 'paragraph':
        if (text) lines.push(text);
        return false;
      case 'bulletList':
      case 'orderedList':
        // Let children handle themselves
        return true;
      case 'listItem': {
        const parent = editor.state.doc.resolve(pos).parent;
        const isOrdered = parent?.type.name === 'orderedList';
        const prefix = isOrdered ? '1.' : '-';
        lines.push(`${prefix} ${text}`);
        return false;
      }
      case 'codeBlock': {
        const lang = node.attrs.language || '';
        lines.push(`\`\`\`${lang}\n${text}\n\`\`\``);
        return false;
      }
      case 'blockquote':
        lines.push(`> ${text}`);
        return false;
      case 'horizontalRule':
        lines.push('---');
        return false;
      case 'image': {
        const src = node.attrs['markdown-src'] || node.attrs.src || '';
        const alt = node.attrs.alt || '';
        lines.push(`![${alt}](${src})`);
        return false;
      }
      case 'taskList':
        return true;
      case 'taskItem': {
        const checked = node.attrs.checked ? 'x' : ' ';
        lines.push(`- [${checked}] ${text}`);
        return false;
      }
    }
    return true;
  });

  return lines.join('\n\n');
}

/**
 * Copy markdown to clipboard with fallback support
 *
 * @param markdown - Markdown string to copy
 * @returns Promise with copy result
 */
export async function copyToClipboard(markdown: string): Promise<CopyResult> {
  // Try modern Clipboard API first
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(markdown);
      return { success: true, markdown };
    } catch (err) {
      console.warn('[MD4H] Clipboard API failed, trying fallback:', err);
    }
  }

  // Fallback: Use textarea + execCommand
  try {
    const textarea = document.createElement('textarea');
    textarea.value = markdown;
    textarea.style.position = 'fixed';
    textarea.style.left = '-9999px';
    textarea.style.top = '-9999px';
    document.body.appendChild(textarea);
    textarea.select();
    const success = document.execCommand('copy');
    document.body.removeChild(textarea);

    if (success) {
      return { success: true, markdown };
    }
    return { success: false, error: 'execCommand failed' };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

/**
 * Show visual feedback after copy
 *
 * @param success - Whether copy succeeded
 */
export function showCopyFeedback(success: boolean): void {
  const copyButton = document.querySelector('.copy-button');
  if (!copyButton) return;

  if (success) {
    copyButton.classList.add('copied');
    setTimeout(() => copyButton.classList.remove('copied'), 1500);
  } else {
    copyButton.classList.add('copy-failed');
    setTimeout(() => copyButton.classList.remove('copy-failed'), 1500);
  }
}

/**
 * Show "nothing selected" feedback
 */
export function showNoSelectionFeedback(): void {
  const copyButton = document.querySelector('.copy-button');
  if (!copyButton) return;

  // Briefly shake or pulse the button to indicate nothing to copy
  copyButton.classList.add('no-selection');
  setTimeout(() => copyButton.classList.remove('no-selection'), 500);
}

/**
 * Main copy function - gets selection as markdown and copies to clipboard
 *
 * @param editor - TipTap editor instance
 * @returns Promise with copy result
 */
export async function copySelectionAsMarkdown(editor: Editor): Promise<CopyResult> {
  const markdown = getSelectionAsMarkdown(editor);

  if (!markdown) {
    showNoSelectionFeedback();
    return { success: false, error: 'No selection' };
  }

  const result = await copyToClipboard(markdown);
  showCopyFeedback(result.success);

  if (result.success) {
    console.log('[MD4H] Copied to clipboard:', markdown.substring(0, 100) + '...');
  } else {
    console.error('[MD4H] Copy failed:', result.error);
  }

  return result;
}
