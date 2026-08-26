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

interface SerializedTopLevelBlock {
  readonly isEmptyParagraph: boolean;
  readonly markdown: string;
}

interface SerializedBlockResult {
  readonly markdown: string;
  readonly serializerSucceeded: boolean;
}

interface ProseMirrorDocumentLike {
  readonly childCount: number;
  child(index: number): ProseMirrorNodeLike;
}

interface ProseMirrorNodeLike {
  toJSON(): JSONContent;
}

interface EditorBlockSerializationCache {
  readonly serializer: (json: JSONContent) => string;
  readonly blocks: WeakMap<ProseMirrorNodeLike, SerializedTopLevelBlock>;
}

// ProseMirror nodes are immutable and unchanged branches retain object identity
// across transactions. Weak keys let later syncs reuse block Markdown without
// retaining old document trees after ProseMirror releases them.
const editorBlockSerializationCaches = new WeakMap<Editor, EditorBlockSerializationCache>();

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

function serializeSingleNode(
  node: JSONContent,
  serialize: (json: JSONContent) => string
): SerializedBlockResult {
  try {
    return {
      markdown: serialize({ type: 'doc', content: [node] }).trim(),
      serializerSucceeded: true,
    };
  } catch {
    return { markdown: '', serializerSucceeded: false };
  }
}

function getEditorDocument(editor: Editor): ProseMirrorDocumentLike | null {
  const candidate = (editor as unknown as { state?: { doc?: Partial<ProseMirrorDocumentLike> } })
    .state?.doc;
  if (
    candidate === undefined ||
    typeof candidate.childCount !== 'number' ||
    !Number.isInteger(candidate.childCount) ||
    candidate.childCount < 0 ||
    typeof candidate.child !== 'function'
  ) {
    return null;
  }
  return candidate as ProseMirrorDocumentLike;
}

function getEditorBlockCache(
  editor: Editor,
  serializer: (json: JSONContent) => string
): EditorBlockSerializationCache {
  const existing = editorBlockSerializationCaches.get(editor);
  if (existing?.serializer === serializer) {
    return existing;
  }

  const created: EditorBlockSerializationCache = {
    serializer,
    blocks: new WeakMap(),
  };
  editorBlockSerializationCaches.set(editor, created);
  return created;
}

function joinSerializedBlocks(
  blocks: readonly SerializedTopLevelBlock[],
  blankLineMode: BlankLineMode
): string {
  let endIndex = blocks.length;
  while (endIndex > 0 && blocks[endIndex - 1].isEmptyParagraph) {
    endIndex--;
  }

  let startIndex = 0;
  while (startIndex < endIndex && blocks[startIndex].isEmptyParagraph) {
    startIndex++;
  }

  if (startIndex >= endIndex) {
    return '';
  }

  let result = '';
  let pendingBlanks = 0;

  for (let index = startIndex; index < endIndex; index++) {
    const block = blocks[index];
    if (block.isEmptyParagraph) {
      if (blankLineMode === 'preserve') {
        pendingBlanks++;
      }
      continue;
    }

    if (block.markdown === '') {
      // Preserve the existing behavior for unsupported nodes whose renderer
      // returns no Markdown: in preserve mode they occupy one blank line.
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
    result += block.markdown;
    pendingBlanks = 0;
  }

  return result;
}

function serializeJsonBlocks(
  children: readonly JSONContent[],
  serialize: (json: JSONContent) => string,
  blankLineMode: BlankLineMode
): string {
  return joinSerializedBlocks(
    children.map(node => {
      const isEmpty = isEmptyParagraph(node);
      return {
        isEmptyParagraph: isEmpty,
        markdown: isEmpty ? '' : serializeBlockMarkdown(node, serialize),
      };
    }),
    blankLineMode
  );
}

function serializeProseMirrorBlocks(
  editor: Editor,
  documentNode: ProseMirrorDocumentLike,
  serializerIdentity: (json: JSONContent) => string,
  serialize: (json: JSONContent) => string,
  blankLineMode: BlankLineMode
): string {
  const cache = getEditorBlockCache(editor, serializerIdentity);
  const blocks: SerializedTopLevelBlock[] = [];

  for (let index = 0; index < documentNode.childCount; index++) {
    const node = documentNode.child(index);
    const cached = cache.blocks.get(node);
    if (cached !== undefined) {
      blocks.push(cached);
      continue;
    }

    const json = node.toJSON();
    const isEmpty = isEmptyParagraph(json);
    const serialized = serializeBlockMarkdownResult(json, serialize);
    const block: SerializedTopLevelBlock = {
      isEmptyParagraph: isEmpty,
      markdown: isEmpty ? '' : serialized.markdown,
    };
    // An empty result for a non-empty node can mean a transient serializer
    // failure. Structural fallbacks produced after an exception must also be
    // retried, even when the immutable ProseMirror node identity is unchanged.
    if (isEmpty || (serialized.serializerSucceeded && block.markdown !== '')) {
      cache.blocks.set(node, block);
    }
    blocks.push(block);
  }

  return joinSerializedBlocks(blocks, blankLineMode);
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
  return serializeBlockMarkdownResult(node, serialize).markdown;
}

function serializeBlockMarkdownResult(
  node: JSONContent,
  serialize: (json: JSONContent) => string
): SerializedBlockResult {
  const result = serializeSingleNode(node, serialize);
  if (result.markdown !== '') return result;
  if (node && node.type === 'heading') {
    const rawLevel = node.attrs?.level;
    const level = typeof rawLevel === 'number' && rawLevel >= 1 && rawLevel <= 6 ? rawLevel : 1;
    return { ...result, markdown: '#'.repeat(level) };
  }
  return result;
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

  const serializerIdentity = markdownManager.serialize;
  const serialize = serializerIdentity.bind(markdownManager);

  try {
    const documentNode = getEditorDocument(editor);
    if (documentNode !== null) {
      return serializeProseMirrorBlocks(
        editor,
        documentNode,
        serializerIdentity,
        serialize,
        blankLineMode
      );
    }

    const json = editor.getJSON();
    const children = json.content;
    if (!Array.isArray(children) || children.length === 0) {
      return '';
    }
    return serializeJsonBlocks(children, serialize, blankLineMode);
  } catch {
    return getFallbackMarkdown();
  }
}
