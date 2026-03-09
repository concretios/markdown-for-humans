/**
 * Copyright (c) 2025-2026 Concret.io
 *
 * Licensed under the MIT License. See LICENSE file in the project root for details.
 */

import type { Editor, JSONContent } from '@tiptap/core';

type MarkdownManager = {
  serialize?: (json: JSONContent) => string;
  getMarkdown?: () => string;
};

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

export function getEditorMarkdownForSync(editor: Editor): string {
  const editorUnknown = editor as unknown as {
    markdown?: MarkdownManager;
    storage?: {
      markdown?: MarkdownManager;
    };
    getMarkdown?: () => string;
  };

  const markdownManager = editorUnknown.markdown || editorUnknown.storage?.markdown;

  const getFallbackMarkdown = (): string => {
    const directGetMarkdown = editorUnknown.getMarkdown;
    if (typeof directGetMarkdown === 'function') {
      const value = directGetMarkdown.call(editor);
      if (typeof value === 'string' && value.length > 0) {
        return value;
      }
    }

    const managerGetMarkdown = markdownManager?.getMarkdown;
    if (typeof managerGetMarkdown === 'function') {
      const value = managerGetMarkdown.call(markdownManager);
      if (typeof value === 'string' && value.length > 0) {
        return value;
      }
    }

    return '';
  };

  const sanitizeSerialized = (content: string): string => {
    // @tiptap/markdown sometimes serializes hard breaks in tables as \x1F (Unit Separator).
    // Let's replace those with standard markdown <br /> tags so they don't corrupt the file.
    // eslint-disable-next-line no-control-regex
    return content.replace(/\x1F/g, '<br />');
  };

  const trySerialize = (label: string, fn: () => string): string | null => {
    try {
      const value = fn();
      if (typeof value !== 'string') {
        console.error(`[MD4H] ${label} returned non-string output`);
        return null;
      }
      return value;
    } catch (error) {
      console.error(`[MD4H] ${label} failed:`, error);
      return null;
    }
  };

  const hasMeaningfulDocContent = (doc: JSONContent): boolean => {
    return Array.isArray(doc.content) && doc.content.length > 0;
  };

  if (!markdownManager?.serialize || typeof editor.getJSON !== 'function') {
    const fallback = trySerialize(
      'fallback getMarkdown (no serialization manager)',
      getFallbackMarkdown
    );
    if (fallback !== null) {
      console.warn(
        '[MD4H] Serialization manager not found, using fallback. Output len:',
        fallback.length
      );
      return sanitizeSerialized(fallback);
    }
    console.error(
      '[MD4H] Serialization manager missing and fallback failed; returning empty output'
    );
    return '';
  }

  const json = trySerialize('editor.getJSON', () => JSON.stringify(editor.getJSON()));
  if (json === null) {
    const fallback = trySerialize(
      'fallback getMarkdown (after getJSON failure)',
      getFallbackMarkdown
    );
    return fallback ? sanitizeSerialized(fallback) : '';
  }

  const parsedJson = JSON.parse(json) as JSONContent;
  const normalizedJson = stripEmptyDocParagraphsFromJson(parsedJson);
  const nonEmptyDoc = hasMeaningfulDocContent(parsedJson);

  const normalizedSerialized = trySerialize('serialize(normalizedJson)', () =>
    markdownManager.serialize!(normalizedJson)
  );
  if (normalizedSerialized !== null && (normalizedSerialized.length > 0 || !nonEmptyDoc)) {
    console.log(
      '[MD4H] Serialization successful (normalized). JSON nodes:',
      parsedJson.content?.length,
      'Serialized len:',
      normalizedSerialized.length
    );
    return sanitizeSerialized(normalizedSerialized);
  }

  if (normalizedSerialized !== null && normalizedSerialized.length === 0 && nonEmptyDoc) {
    console.error('[MD4H] serialize(normalizedJson) returned empty string for non-empty document');
  }

  const rawSerialized = trySerialize('serialize(rawJson)', () =>
    markdownManager.serialize!(parsedJson)
  );
  if (rawSerialized !== null && (rawSerialized.length > 0 || !nonEmptyDoc)) {
    console.warn(
      '[MD4H] Used raw JSON serializer fallback. JSON nodes:',
      parsedJson.content?.length,
      'Serialized len:',
      rawSerialized.length
    );
    return sanitizeSerialized(rawSerialized);
  }

  if (rawSerialized !== null && rawSerialized.length === 0 && nonEmptyDoc) {
    console.error('[MD4H] serialize(rawJson) returned empty string for non-empty document');
  }

  const fallback = trySerialize('fallback getMarkdown', getFallbackMarkdown);
  if (fallback !== null && (fallback.length > 0 || !nonEmptyDoc)) {
    console.warn(
      '[MD4H] Using getMarkdown fallback after serializer failures. Output len:',
      fallback.length
    );
    return sanitizeSerialized(fallback);
  }

  console.error(
    '[MD4H] All serialization strategies failed for non-empty document; returning empty output'
  );
  return '';
}
