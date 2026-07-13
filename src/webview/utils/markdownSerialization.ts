/**
 * Copyright (c) 2025-2026 Concret.io
 *
 * Licensed under the MIT License. See LICENSE file in the project root for details.
 */

import type { Editor, JSONContent } from '@tiptap/core';
import type { BlankLineMode } from '../../shared/blankLinePolicy';

type MarkdownManager = {
  serialize?: (json: JSONContent) => string;
};

/**
 * Reorders each text node's `marks` array so `code` always comes first.
 *
 * Why this is needed: `@tiptap/markdown` opens/closes a text node's marks in
 * `marks` array order, with later marks ending up outermost. That array order
 * comes from the schema's mark rank (set when the doc is built via
 * `Node.fromJSON`/`Mark.setFrom`, which sorts by registration order in the
 * extensions list), not from how the marks were originally nested in the
 * source markdown. Every other inline mark here (bold/italic/strike/link) is
 * "transparent" - wrapping one in another still parses fine regardless of
 * order - but `code` is not: a markdown code span's content is always
 * literal, so if `code` ends up outermost, any mark nested inside it (e.g. a
 * link's `[text](url)`) gets swallowed as literal text instead of being
 * parsed. Moving `code` to the front keeps it innermost regardless of the
 * schema's rank order, matching how it was actually written in the source.
 */
export function reorderMarksForSerialization(node: JSONContent): JSONContent {
  if (node.type === 'text') {
    if (!Array.isArray(node.marks) || node.marks.length < 2) return node;
    const codeIndex = node.marks.findIndex(mark => mark.type === 'code');
    if (codeIndex <= 0) return node;
    const marks = [...node.marks];
    const [codeMark] = marks.splice(codeIndex, 1);
    marks.unshift(codeMark);
    return { ...node, marks };
  }

  if (Array.isArray(node.content)) {
    return { ...node, content: node.content.map(reorderMarksForSerialization) };
  }

  return node;
}

function isMeaningfulInlineNode(node: JSONContent): boolean {
  if (!node || typeof node.type !== 'string') return false;

  if (node.type === 'hardBreak' || node.type === 'hard_break') return false;

  if (node.type === 'text') {
    const text = typeof node.text === 'string' ? node.text : '';
    return text.trim().length > 0;
  }

  return true;
}

function isEmptyParagraph(node: JSONContent): boolean {
  if (node.type !== 'paragraph') return false;

  const content = node.content;
  if (!Array.isArray(content) || content.length === 0) return true;

  return !content.some(isMeaningfulInlineNode);
}

/**
 * Strips all empty paragraphs from the doc's top-level content.
 * Exported for backward-compat with existing tests.
 */
export function stripEmptyDocParagraphsFromJson(doc: JSONContent): JSONContent {
  if (doc.type !== 'doc' || !Array.isArray(doc.content)) {
    return doc;
  }

  const nextContent = doc.content.filter(child => !isEmptyParagraph(child));

  return {
    ...doc,
    content: nextContent,
  };
}

function serializeSingleNode(node: JSONContent, serialize: (json: JSONContent) => string): string {
  try {
    return serialize({ type: 'doc', content: [node] }).trim();
  } catch {
    return '';
  }
}

/**
 * Serialize one top-level block to markdown, falling back to a structural
 * placeholder when the markdown serializer produces nothing for a block whose
 * structural identity should still occupy a line on disk.
 *
 * Concretely: an empty heading node (`{type:'heading', attrs:{level:N}}` with
 * no inline content — produced when a user deletes a heading's text) serializes
 * to `''` via the standard pipeline, which causes the saver to drop the row
 * entirely and shifts every following line up by one. Round-tripping it as
 * `'#'.repeat(level)` keeps the row alive on disk and keeps `Copy as AI
 * Context` line numbers aligned with what the user sees in the file.
 *
 * Empty paragraphs are intentionally NOT placeholdered here — they are how the
 * saver represents intentional blank lines, and the inline information needed
 * to recover constructs like `[]()` is already lost in the parser, so any
 * placeholder would corrupt every legitimate blank line in the document.
 */
export function serializeBlockMarkdown(
  node: JSONContent,
  serialize: (json: JSONContent) => string
): string {
  const md = serializeSingleNode(node, serialize);
  if (md !== '') return md;
  if (node && node.type === 'heading') {
    const rawLevel = node.attrs?.level;
    const level = typeof rawLevel === 'number' && rawLevel >= 1 && rawLevel <= 6 ? rawLevel : 1;
    return '#'.repeat(level);
  }
  return '';
}

export function getEditorMarkdownForSync(
  editor: Editor,
  blankLineMode: BlankLineMode = 'preserve'
): string {
  const editorUnknown = editor as unknown as {
    markdown?: MarkdownManager;
    storage?: {
      markdown?: MarkdownManager;
    };
    getMarkdown?: () => string;
  };

  const markdownManager = editorUnknown.markdown || editorUnknown.storage?.markdown;

  const getFallbackMarkdown = (): string => {
    const getMarkdown = editorUnknown.getMarkdown;
    if (typeof getMarkdown === 'function') {
      return getMarkdown.call(editor);
    }
    return '';
  };

  if (!markdownManager?.serialize || typeof editor.getJSON !== 'function') {
    return getFallbackMarkdown();
  }

  const rawSerialize = markdownManager.serialize.bind(markdownManager);
  const serialize = (json: JSONContent): string => rawSerialize(reorderMarksForSerialization(json));

  try {
    const json = editor.getJSON();
    const children = json.content;

    if (!Array.isArray(children) || children.length === 0) {
      return '';
    }

    // Strip trailing empty paragraphs (Tiptap always appends one for cursor positioning)
    let endIdx = children.length;
    while (endIdx > 0 && isEmptyParagraph(children[endIdx - 1])) {
      endIdx--;
    }

    // Strip leading empty paragraphs
    let startIdx = 0;
    while (startIdx < endIdx && isEmptyParagraph(children[startIdx])) {
      startIdx++;
    }

    if (startIdx >= endIdx) {
      return '';
    }

    const trimmed = children.slice(startIdx, endIdx);

    // Serialize each content node individually and rejoin, inserting one extra
    // "\n" per intentional blank line (empty paragraph) between content blocks.
    // The standard paragraph separator is "\n\n" (one blank line); each empty
    // paragraph beyond that adds one more "\n" to the output.
    let result = '';
    let pendingBlanks = 0;

    for (const node of trimmed) {
      if (isEmptyParagraph(node)) {
        if (blankLineMode === 'preserve') {
          pendingBlanks++;
        }
      } else {
        const nodeMarkdown = serializeBlockMarkdown(node, serialize);
        if (nodeMarkdown === '') {
          // Node serialized to nothing (unrecognised type, etc.) – treat it
          // as if it were an empty paragraph so blank-line intent is kept.
          if (blankLineMode === 'preserve') {
            pendingBlanks++;
          }
          continue;
        }
        if (result !== '') {
          result += '\n\n';
          if (blankLineMode === 'preserve') {
            result += '\n'.repeat(pendingBlanks);
          }
        }
        result += nodeMarkdown;
        pendingBlanks = 0;
      }
    }

    return result;
  } catch {
    return getFallbackMarkdown();
  }
}
