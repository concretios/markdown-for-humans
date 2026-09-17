/**
 * Copyright (c) 2025-2026 Concret.io
 *
 * Licensed under the MIT License. See LICENSE file in the project root for details.
 *
 * @fileoverview Build a Claude-Code-style `@file#startLine-endLine` reference for the
 * current TipTap selection so the user can paste precise context into AI coding tools.
 *
 * The math is block-rounded: a partial selection inside a paragraph reports the
 * paragraph's full line range. This is intentional — AI tools want enough context
 * to understand the surrounding text, not arbitrary half-blocks.
 *
 * Path resolution and the auto-save-before-copy step are handled by the extension
 * host; this module only computes line numbers and formats the final string.
 * It also exposes the focus/selection gate used to retain deliberate selections
 * after blur, and accounts for frontmatter wrapper lines removed on save.
 */

import type { Editor, JSONContent } from '@tiptap/core';
import { copyToClipboard } from './copyMarkdown';
import { serializeBlockMarkdown } from './markdownSerialization';
import type { BlankLineMode } from '../../shared/blankLinePolicy';

export interface AiContextRefResult {
  success: boolean;
  ref?: string;
  error?: string;
}

export interface SelectionBlockRange {
  startLine: number;
  endLine: number;
}

interface BlockPos {
  from: number;
  to: number;
}

type MarkdownManager = {
  serialize?: (json: JSONContent) => string;
};

/**
 * Count the number of lines a string represents.
 *
 * Matches the natural reading: "abc" is 1 line, "a\nb" is 2, "a\nb\n" is also 2
 * (a trailing newline does not add a line). Empty string is 0 lines.
 */
export function countLines(s: string): number {
  if (s.length === 0) return 0;
  let count = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\n') count++;
  }
  if (s[s.length - 1] !== '\n') count++;
  return count;
}

/**
 * Format the final clipboard string.
 * Single-line selections collapse to `#42`; multi-line use `#42-58`.
 * When no line range is supplied (e.g. empty doc, cursor on no content),
 * the suffix is omitted and the bare `@path` is returned.
 */
export function formatAiContextRef(relPath: string, startLine?: number, endLine?: number): string {
  if (typeof startLine !== 'number' || typeof endLine !== 'number') {
    return `@${relPath}`;
  }
  const suffix = startLine === endLine ? `#${startLine}` : `#${startLine}-${endLine}`;
  return `@${relPath}${suffix}`;
}

/**
 * Decide whether a "Copy as AI Context" action should include a line range.
 *
 * The webview entry point (`runCopyAiContextRef`) snapshots `editor.isFocused`
 * and `editor.state.selection.empty` synchronously at command time and passes
 * them here. Extracted as a pure function so the four-case contract is unit
 * testable — the entry point itself depends on the VS Code webview API and
 * cannot be exercised in isolation.
 *
 * | isFocused | selectionEmpty | result | scenario                                   |
 * |-----------|----------------|--------|--------------------------------------------|
 * | true      | true           | true   | focused, cursor only → include block line  |
 * | true      | false          | true   | focused, range selected → include range    |
 * | false     | true           | false  | blurred, stale cursor → bare @file          |
 * | false     | false          | true   | blurred but a real selection survives blur  |
 *
 * The last row is the Bug 2 fix: ProseMirror preserves `state.selection` after
 * the editor blurs, so a non-empty selection is a reliable "the user picked
 * this" signal even when focus has moved to a toolbar or another panel.
 *
 * Note: using `!selectionEmpty` ALONE (ignoring focus) would regress row 1 —
 * the most common action, placing a cursor and clicking the button — back to a
 * bare `@file`. Both inputs are required.
 */
export function shouldIncludeLineRange(isFocused: boolean, selectionEmpty: boolean): boolean {
  return isFocused || !selectionEmpty;
}

/**
 * Find the index of the block that contains a given ProseMirror document position.
 *
 * A position exactly at a block boundary (`pos === block.to`) is treated as
 * belonging to the next block, matching how a cursor at end-of-paragraph behaves.
 * Positions past the last block clamp to the last block (gap-cursor case).
 */
export function findContainingBlockIndex(blocks: BlockPos[], pos: number): number {
  if (blocks.length === 0) return -1;
  for (let i = 0; i < blocks.length; i++) {
    if (pos < blocks[i].to) return i;
  }
  return blocks.length - 1;
}

function isEmptyParagraphJsonNode(node: JSONContent | undefined): boolean {
  if (!node || node.type !== 'paragraph') return false;
  const content = node.content;
  if (!Array.isArray(content) || content.length === 0) return true;
  return !content.some(child => {
    if (!child || typeof child.type !== 'string') return false;
    if (child.type === 'hardBreak' || child.type === 'hard_break') return false;
    if (child.type === 'text') {
      const text = typeof child.text === 'string' ? child.text : '';
      return text.trim().length > 0;
    }
    return true;
  });
}

interface BlockLineRange {
  jsonIdx: number;
  startLine: number;
  endLine: number;
}

/**
 * True when a serialized first block is a YAML/JSON frontmatter code block —
 * i.e. the host's `wrapFrontmatterForWebview` wrapped the document's leading
 * `---...---` frontmatter in a ```yaml fence so it renders as a code block in
 * the editor instead of being parsed as document structure.
 *
 * Match `unwrapFrontmatterFromWebview`: YAML/YML/JSON, three or more backticks,
 * an equally long closing fence, and an initial `---` inside the block.
 * Longer fences protect embedded backticks in YAML values. Only the first
 * content block can be frontmatter. Ordinary code blocks retain their fences.
 */
function isFrontmatterSerializedBlock(md: string): boolean {
  if (!md.startsWith('```')) return false;
  const lines = md.split('\n');
  if (lines.length < 3) return false;
  const fenceMatch = lines[0]
    .trim()
    .toLowerCase()
    .match(/^(`{3,})(yaml|yml|json)$/);
  if (!fenceMatch) return false;
  const closingIdx = lines.findIndex((line, idx) => idx > 0 && line.trim() === fenceMatch[1]);
  if (closingIdx === -1) return false;
  const inside = lines.slice(1, closingIdx);
  return inside.length > 0 && inside[0].trim() === '---';
}

/**
 * Walks the live JSON content and returns the saved-file line range for each
 * non-empty top-level block, mirroring `getEditorMarkdownForSync`:
 *   - leading and trailing empty paragraphs are dropped,
 *   - each empty paragraph between content blocks contributes one extra blank line
 *     beyond the standard `\n\n` block separator.
 *
 * The math: between two consecutive content blocks separated by N empty
 * paragraphs, the next block's first line is `prevLastLine + 2 + N`
 * (one separator newline, N extra blank-line newlines, then the block's text).
 */
function computeBlockLineRanges(
  content: JSONContent[],
  serialize: (json: JSONContent) => string,
  blankLineMode: BlankLineMode
): BlockLineRange[] {
  let firstIdx = 0;
  while (firstIdx < content.length && isEmptyParagraphJsonNode(content[firstIdx])) firstIdx++;
  let lastIdxExclusive = content.length;
  while (lastIdxExclusive > firstIdx && isEmptyParagraphJsonNode(content[lastIdxExclusive - 1])) {
    lastIdxExclusive--;
  }

  const ranges: BlockLineRange[] = [];
  let cursorLine = 0;
  let pendingBlanks = 0;
  let seenContent = false;

  for (let i = firstIdx; i < lastIdxExclusive; i++) {
    const node = content[i];
    if (isEmptyParagraphJsonNode(node)) {
      if (blankLineMode === 'preserve') {
        pendingBlanks++;
      }
      continue;
    }

    // Route through the same per-block serializer the saver uses so empty
    // structural blocks (e.g. an empty heading) get the same `#` placeholder
    // here that they get on disk — otherwise the saved file would have one
    // more line than we counted, shifting every following line range.
    const nodeMarkdown = serializeBlockMarkdown(node, serialize);
    if (nodeMarkdown === '') {
      // A node that serialises to nothing (and has no structural placeholder)
      // is treated like an empty paragraph, matching the saver's fallback.
      if (blankLineMode === 'preserve') {
        pendingBlanks++;
      }
      continue;
    }

    // The host wraps leading YAML frontmatter in a ```yaml fence for editing
    // and strips those two fence lines back off on save. The serializer re-emits
    // the fenced form, so for the first block we subtract the two fence lines to
    // match the on-disk file — otherwise every block after the frontmatter is
    // reported two lines too high. The predicate mirrors the host's unwrap guard
    // exactly, so we only subtract when the host will actually strip.
    const frontmatterFenceLines =
      !seenContent && isFrontmatterSerializedBlock(nodeMarkdown) ? 2 : 0;
    const blockLines = countLines(nodeMarkdown) - frontmatterFenceLines;
    if (!seenContent) {
      cursorLine = 1;
      seenContent = true;
    } else {
      cursorLine += 2 + (blankLineMode === 'preserve' ? pendingBlanks : 0);
    }
    const startLine = cursorLine;
    const endLine = startLine + blockLines - 1;
    ranges.push({ jsonIdx: i, startLine, endLine });
    cursorLine = endLine;
    pendingBlanks = 0;
  }

  return ranges;
}

function findRangeForJsonIdx(
  ranges: BlockLineRange[],
  jsonIdx: number,
  snap: 'forward' | 'backward'
): BlockLineRange | null {
  if (ranges.length === 0) return null;
  for (const r of ranges) {
    if (r.jsonIdx === jsonIdx) return r;
  }
  if (snap === 'forward') {
    for (const r of ranges) {
      if (r.jsonIdx > jsonIdx) return r;
    }
    return ranges[ranges.length - 1];
  }
  let last: BlockLineRange | null = null;
  for (const r of ranges) {
    if (r.jsonIdx <= jsonIdx) last = r;
  }
  return last ?? ranges[0];
}

/**
 * Compute the line range (in the saved markdown file) that the current selection
 * covers, rounded out to whole top-level blocks.
 *
 * Returns null when:
 *   - the doc has no content,
 *   - the markdown serializer is unavailable,
 *   - the selection cannot be mapped to any non-empty block.
 *
 * The caller is expected to have just auto-saved the document, so the file on
 * disk is exactly what `getEditorMarkdownForSync` produces. We mirror that
 * pipeline (drop leading/trailing empty paragraphs; preserve middle empty
 * paragraphs as one extra blank line each) so the returned line numbers point
 * at the same content the user will see in the saved file.
 */
export type SelectionBlockRangeFailure =
  | 'no-serializer'
  | 'no-getJSON'
  | 'empty-doc-json'
  | 'no-blocks'
  | 'selection-out-of-range'
  | 'index-mismatch'
  | 'serializer-threw';

export type SelectionBlockRangeResult =
  | { ok: true; range: SelectionBlockRange }
  | { ok: false; reason: SelectionBlockRangeFailure; detail?: string };

/**
 * Internal variant that returns a structured failure reason. Useful for surfacing
 * actionable error messages and console diagnostics; the public wrapper below
 * reduces this to `SelectionBlockRange | null` for backwards-compat with tests.
 */
export function computeSelectionBlockRange(
  editor: Editor,
  blankLineMode: BlankLineMode = 'preserve'
): SelectionBlockRangeResult {
  const { from, to, empty } = editor.state.selection;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const editorAny = editor as any;
  const direct: MarkdownManager | undefined = editorAny.markdown;
  // editor.storage.markdown is `{ manager: MarkdownManager }` in @tiptap/markdown >=3,
  // not a manager itself, so unwrap `.manager` when falling back.
  const fromStorage: MarkdownManager | undefined = editorAny.storage?.markdown?.manager;
  const markdownManager: MarkdownManager | undefined = direct ?? fromStorage;
  const serialize = markdownManager?.serialize?.bind(markdownManager);
  if (typeof serialize !== 'function') {
    return { ok: false, reason: 'no-serializer' };
  }
  if (typeof editor.getJSON !== 'function') {
    return { ok: false, reason: 'no-getJSON' };
  }

  const liveJson = editor.getJSON();
  if (!Array.isArray(liveJson.content) || liveJson.content.length === 0) {
    return { ok: false, reason: 'empty-doc-json' };
  }

  // Walk the live editor doc to learn each top-level block's PM position range.
  // Include empty paragraphs here so a selection inside one still has somewhere
  // to land — we'll snap to the nearest content block when computing lines.
  const allBlocks: BlockPos[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  editor.state.doc.content.forEach((node: any, offset: number) => {
    allBlocks.push({ from: offset + 1, to: offset + 1 + node.nodeSize });
  });
  if (allBlocks.length === 0) {
    return { ok: false, reason: 'no-blocks', detail: 'blockCount=0' };
  }

  // The live JSON children should align 1:1 with the live doc's top-level
  // blocks. If they don't (extension shape mismatch), bail rather than guess.
  if (allBlocks.length !== liveJson.content.length) {
    return {
      ok: false,
      reason: 'index-mismatch',
      detail: `blocks=${allBlocks.length} jsonLen=${liveJson.content.length}`,
    };
  }

  let ranges: BlockLineRange[];
  try {
    ranges = computeBlockLineRanges(liveJson.content, serialize, blankLineMode);
  } catch (err) {
    return {
      ok: false,
      reason: 'serializer-threw',
      detail: err instanceof Error ? err.message : String(err),
    };
  }
  if (ranges.length === 0) {
    return { ok: false, reason: 'no-blocks', detail: 'no content blocks survived save trim' };
  }

  const fromBlockIdx = findContainingBlockIndex(allBlocks, from);
  const toBlockIdx = empty ? fromBlockIdx : findContainingBlockIndex(allBlocks, to);
  if (fromBlockIdx < 0 || toBlockIdx < 0) {
    return {
      ok: false,
      reason: 'selection-out-of-range',
      detail: `from=${from} to=${to} blocks=${allBlocks.length}`,
    };
  }

  const startRange = findRangeForJsonIdx(ranges, fromBlockIdx, 'forward');
  const endRange = findRangeForJsonIdx(ranges, toBlockIdx, 'backward');
  if (!startRange || !endRange) {
    return {
      ok: false,
      reason: 'selection-out-of-range',
      detail: `fromIdx=${fromBlockIdx} toIdx=${toBlockIdx} ranges=${ranges.length}`,
    };
  }

  const startLine = startRange.startLine;
  const endLine = Math.max(startLine, endRange.endLine);
  return { ok: true, range: { startLine, endLine } };
}

export function getSelectionBlockRange(
  editor: Editor,
  blankLineMode: BlankLineMode = 'preserve'
): SelectionBlockRange | null {
  const result = computeSelectionBlockRange(editor, blankLineMode);
  return result.ok ? result.range : null;
}

/**
 * High-level orchestration used by both the toolbar button and the keybinding:
 *   1. Compute the selection's block-rounded line range.
 *   2. Ask the extension host to save the document and return a workspace-relative
 *      path (so the file on disk matches the line numbers we just computed).
 *   3. Format `@path#startLine-endLine` and write it to the clipboard.
 *
 * The host round-trip is abstracted behind `requestPathFromHost` so the function
 * can be exercised without a real `vscode` webview API in tests if needed later.
 */
export interface CopyAiContextReferenceOptions {
  /**
   * Whether the caller believes the editor has an active cursor/selection.
   * ProseMirror keeps a stale selection in place after the editor blurs, so
   * `editor.state.selection` alone can't tell us whether the user is engaged.
   * The caller (the webview shell) is in a better position to know — typically
   * by snapshotting focus and selection emptiness synchronously and consulting
   * `shouldIncludeLineRange` so a deliberate selection survives focus changes.
   *
   * When `false`, the line-range computation is skipped entirely and the copy
   * produces a bare `@path` reference. Defaults to `true` for backwards compat.
   */
  selectionIsActive?: boolean;
}

export async function copyAiContextReference(
  editor: Editor,
  blankLineMode: BlankLineMode,
  requestPathFromHost: (
    range: SelectionBlockRange | null
  ) => Promise<{ ref?: string; relPath?: string; error?: string }>,
  options: CopyAiContextReferenceOptions = {}
): Promise<AiContextRefResult> {
  // When the caller tells us the selection isn't active, skip the block-range
  // math entirely — ProseMirror's stale post-blur selection would otherwise
  // produce a misleading `#N` pointing at the last-touched line.
  // When it IS active and the math can't map to a concrete range (empty doc,
  // all-blank paragraphs, out-of-range cursor, setup-level failures), we also
  // fall back to a filename-only reference rather than refusing the copy.
  let range: SelectionBlockRange | null;
  if (options.selectionIsActive === false) {
    range = null;
  } else {
    const result = computeSelectionBlockRange(editor, blankLineMode);
    if (result.ok) {
      range = result.range;
    } else {
      console.warn('[MD4H][aiContextRef]', result);
      range = null;
    }
  }

  let response: { ref?: string; relPath?: string; error?: string };
  try {
    response = await requestPathFromHost(range);
  } catch (err) {
    return { success: false, error: String(err) };
  }
  if (response.error) {
    return { success: false, error: response.error };
  }

  const ref =
    response.ref ??
    (response.relPath
      ? formatAiContextRef(response.relPath, range?.startLine, range?.endLine)
      : undefined);
  if (!ref) {
    return { success: false, error: 'Host did not return a path' };
  }

  const copyResult = await copyToClipboard(ref);
  if (!copyResult.success) {
    return { success: false, error: copyResult.error };
  }
  return { success: true, ref };
}
