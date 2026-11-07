/**
 * Copyright (c) 2025-2026 Concret.io
 *
 * Licensed under the MIT License. See LICENSE file in the project root for details.
 */

/**
 * @file aiReference.ts - Exact source lines for Copy Reference for AI
 * @description Turns a structural description of the rich-view selection into
 *              1-based lines of the saved Markdown text, and formats the
 *              `@path#L10-14` reference.
 *
 * Key responsibilities:
 * - Read every line number from the source text; the rich view only says which block
 * - Reuse the Feedback anchor map for top-level blocks and its content check for the touched ones
 * - Follow markdown-it line maps below a top-level block (items, rows, quote paragraphs, code lines)
 * - Stop at the smallest verified enclosing block instead of estimating
 */

import MarkdownIt from 'markdown-it';
import type {
  AiReferenceLine,
  AiReferenceNodeKind,
  AiReferencePoint,
  AiReferenceSelection,
} from '../shared/aiReferenceProtocol';
import type { CanonicalFeedbackBlock } from '../shared/feedbackProtocol';
import {
  buildFeedbackAnchorMap,
  type FeedbackAnchorKind,
  type FeedbackAnchorSpan,
} from './feedbackAnchors';
import {
  collectMarkdownReferences,
  isFeedbackBlockContentEquivalent,
  type MarkdownReferenceMap,
} from './feedbackSnapshotService';

/** 1-based, inclusive lines of the saved file. */
export interface AiReferenceLineRange {
  startLine: number;
  endLine: number;
}

/** A parsed source block. Lines are 0-based and relative to its top-level block. */
interface SourceNode {
  kind: AiReferenceNodeKind;
  start: number;
  end: number;
  children: SourceNode[];
  /** Line breaks markdown-it found in a paragraph or heading. */
  breaks: number;
  /** An inline `<br>` renders a break that no source newline produced. */
  htmlBreak: boolean;
  /** First content line and content line count of a code block. */
  code?: { first: number; count: number };
}

type MarkdownToken = ReturnType<MarkdownIt['parse']>[number];

const markdownParser = new MarkdownIt({ html: true, breaks: false, linkify: false });

const TOKEN_KINDS: Record<string, AiReferenceNodeKind> = {
  paragraph_open: 'paragraph',
  heading_open: 'heading',
  bullet_list_open: 'list',
  ordered_list_open: 'list',
  list_item_open: 'item',
  blockquote_open: 'blockquote',
  table_open: 'table',
  tr_open: 'row',
  fence: 'code',
  code_block: 'code',
};

const ANCHOR_KINDS: Record<FeedbackAnchorKind, AiReferenceNodeKind> = {
  frontmatter: 'other',
  paragraph: 'paragraph',
  heading: 'heading',
  list: 'list',
  blockquote: 'blockquote',
  code: 'code',
  table: 'table',
  thematicBreak: 'other',
  html: 'other',
};

/** Blank, or only quote markers: such a line never belongs to the block before it. */
function isBlankLine(line: string | undefined): boolean {
  return /^[\s>]*$/.test(line ?? '');
}

function codeLines(token: MarkdownToken, start: number): { first: number; count: number } {
  const count = token.content === '' ? 0 : token.content.replace(/\n$/, '').split('\n').length;
  return { first: token.type === 'fence' ? start + 1 : start, count };
}

/**
 * Parse one top-level block's own lines into a tree with line spans.
 * markdown-it supplies the spans; table sections and cells are skipped so a
 * table's children are its rows, as in the rich view.
 */
function parseBlockTree(lines: readonly string[]): SourceNode[] {
  const roots: SourceNode[] = [];
  const stack: SourceNode[] = [];

  for (const token of markdownParser.parse(lines.join('\n'), {})) {
    const parent = stack[stack.length - 1];
    if (token.type === 'inline') {
      if (parent) {
        const children = token.children ?? [];
        parent.breaks = children.filter(
          child => child.type === 'softbreak' || child.type === 'hardbreak'
        ).length;
        parent.htmlBreak = children.some(
          child => child.type === 'html_inline' && /^<br\b/i.test(child.content)
        );
      }
      continue;
    }
    if (token.nesting === -1) {
      if (TOKEN_KINDS[token.type.replace(/_close$/, '_open')]) stack.pop();
      continue;
    }

    const kind = TOKEN_KINDS[token.type] ?? (token.nesting === 0 ? 'other' : undefined);
    if (kind === undefined) continue;

    // Every block token markdown-it emits here carries a map; fall back to the
    // parent's span so an unmapped one can never unbalance the stack.
    const map = token.map ?? (parent ? [parent.start, parent.end + 1] : [0, lines.length]);
    const start = map[0];
    let end = map[1] - 1;
    // markdown-it counts the separating blank line into some containers.
    while (end > start && isBlankLine(lines[end])) end -= 1;

    const node: SourceNode = { kind, start, end, children: [], breaks: 0, htmlBreak: false };
    if (kind === 'code') node.code = codeLines(token, start);
    (parent ? parent.children : roots).push(node);
    if (token.nesting === 1) stack.push(node);
  }

  return roots;
}

/**
 * Children of a source blockquote as the rich view's alert shows them: the
 * `[!NOTE]` marker line is the alert's type there, not text.
 */
function alertChildren(node: SourceNode, lines: readonly string[]): SourceNode[] | null {
  const first = node.children[0];
  const marker = (lines[first?.start ?? -1] ?? '').replace(/^[\s>]*/, '').trim();
  if (!first || first.kind !== 'paragraph' || !/^\[!\w+\]$/.test(marker)) return null;
  if (first.start === first.end) return node.children.slice(1);
  return [
    { ...first, start: first.start + 1, breaks: first.breaks - 1 },
    ...node.children.slice(1),
  ];
}

/** The line inside a text or code node, or the whole node when it cannot be proven. */
function lineWithin(node: SourceNode, line: AiReferenceLine | undefined): [number, number] {
  const whole: [number, number] = [node.start, node.end];
  if (!line) return whole;

  if (node.code) {
    if (line.count !== node.code.count) return whole;
    return [node.code.first + line.index, node.code.first + line.index];
  }
  if (node.kind !== 'paragraph' && node.kind !== 'heading') return whole;

  const sourceLineCount = node.end - node.start + 1;
  if (sourceLineCount === 1) return whole;
  // Every source newline must be a rendered line break, and every rendered
  // break a source newline. A newline inside a code span, a setext underline
  // or an inline <br> breaks that one-to-one match.
  if (line.count !== sourceLineCount || node.breaks !== sourceLineCount - 1 || node.htmlBreak) {
    return whole;
  }
  return [node.start + line.index, node.start + line.index];
}

/** Whether a rich-view block is source text markdown-it gives no block for (link reference definitions). */
function isRenderless(block: CanonicalFeedbackBlock): boolean {
  return block.kind === 'html' && markdownParser.parse(block.markdown, {}).length === 0;
}

/** Resolves points of one selection against one source text. */
class AiReferenceResolver {
  private readonly sourceLines: string[];
  private readonly spans = new Map<number, FeedbackAnchorSpan>();
  private readonly blocks = new Map<number, CanonicalFeedbackBlock>();
  private references: MarkdownReferenceMap | undefined;
  private referencesCollected = false;

  constructor(
    private readonly sourceText: string,
    private readonly anchors: readonly FeedbackAnchorSpan[],
    canonicalBlocks: readonly CanonicalFeedbackBlock[]
  ) {
    this.sourceLines = sourceText.split(/\r?\n/);
    for (const span of anchors) this.spans.set(span.ordinal, span);
    for (const block of canonicalBlocks) this.blocks.set(block.ordinal, block);
  }

  resolve(point: AiReferencePoint): AiReferenceLineRange | null {
    const span = this.spans.get(point.ordinal);
    const block = this.blocks.get(point.ordinal);
    if (!span || !block) {
      return block ? this.resolveMarkerBlock(block, point) : this.resolveBlankLine(point.ordinal);
    }

    const lines = this.sourceLines.slice(span.startLine - 1, span.endLine);
    if (!this.hasSameContent(span, lines, block)) return null;

    const [first, last] = this.resolveWithin(span, block, lines, point);
    return { startLine: span.startLine + first, endLine: span.startLine + last };
  }

  /** The touched block must still say what the rich view shows, or the view is stale. */
  private hasSameContent(
    span: FeedbackAnchorSpan,
    lines: readonly string[],
    block: CanonicalFeedbackBlock
  ): boolean {
    if (!this.referencesCollected) {
      this.references = collectMarkdownReferences(this.sourceText);
      this.referencesCollected = true;
    }
    return isFeedbackBlockContentEquivalent(
      span.kind,
      lines.join('\n'),
      block.markdown,
      this.references
    );
  }

  /** 0-based first and last line inside one verified top-level block. */
  private resolveWithin(
    span: FeedbackAnchorSpan,
    block: CanonicalFeedbackBlock,
    lines: readonly string[],
    point: AiReferencePoint
  ): [number, number] {
    const whole: [number, number] = [0, lines.length - 1];
    if (point.steps.length === 0 && !point.line) return whole;

    if (span.kind === 'frontmatter') {
      // The rich view shows frontmatter as a code block holding these same lines.
      return point.steps.length === 0 && point.line?.count === lines.length
        ? [point.line.index, point.line.index]
        : whole;
    }

    const roots = parseBlockTree(lines);
    if (
      roots.length !== 1 ||
      roots[0].start !== 0 ||
      roots[0].end !== lines.length - 1 ||
      roots[0].kind !== ANCHOR_KINDS[span.kind]
    ) {
      return whole;
    }

    let node = roots[0];
    let viewKind: AiReferenceNodeKind = block.kind === 'alert' ? 'alert' : node.kind;
    for (const step of point.steps) {
      // Everything in a table row is on the row's one source line.
      if (node.kind === 'row') return [node.start, node.end];

      const children = viewKind === 'alert' ? alertChildren(node, lines) : node.children;
      const child = children?.[step.index];
      const sourceKind = step.kind === 'alert' ? 'blockquote' : step.kind;
      if (!children || children.length !== step.count || !child || child.kind !== sourceKind) {
        return [node.start, node.end];
      }
      node = child;
      viewKind = step.kind;
    }
    return lineWithin(node, point.line);
  }

  /** The anchored blocks on either side of a top-level node that has no anchor. */
  private neighbors(ordinal: number): {
    previous?: FeedbackAnchorSpan;
    next?: FeedbackAnchorSpan;
  } {
    let previous: FeedbackAnchorSpan | undefined;
    for (const span of this.anchors) {
      if (span.ordinal > ordinal) return { previous, next: span };
      previous = span;
    }
    return { previous };
  }

  /**
   * A block that renders nothing, such as link reference definitions. The
   * rich view shows its source text, so it is exact when that text is all
   * there is between the neighboring blocks.
   */
  private resolveMarkerBlock(
    block: CanonicalFeedbackBlock,
    point: AiReferencePoint
  ): AiReferenceLineRange | null {
    const { previous, next } = this.neighbors(block.ordinal);
    let startLine = (previous?.endLine ?? 0) + 1;
    let endLine = (next?.startLine ?? this.sourceLines.length + 1) - 1;
    while (startLine <= endLine && (this.sourceLines[startLine - 1] ?? '').trim() === '') {
      startLine += 1;
    }
    while (endLine >= startLine && (this.sourceLines[endLine - 1] ?? '').trim() === '') {
      endLine -= 1;
    }
    if (this.sourceLines.slice(startLine - 1, endLine).join('\n') !== block.markdown) return null;

    if (point.steps.length === 0 && point.line?.count === endLine - startLine + 1) {
      return { startLine: startLine + point.line.index, endLine: startLine + point.line.index };
    }
    return { startLine, endLine };
  }

  /**
   * A caret in an empty top-level paragraph, which the rich view shows for an
   * extra blank line. Empty paragraphs have no anchor, so use the blank lines
   * between the nearest anchored blocks.
   */
  private resolveBlankLine(ordinal: number): AiReferenceLineRange | null {
    const { previous, next } = this.neighbors(ordinal);
    if (!previous || !next) return null;

    const startLine = previous.endLine + 1;
    const endLine = next.startLine - 1;
    for (let line = startLine; line <= endLine; line += 1) {
      if ((this.sourceLines[line - 1] ?? '').trim() !== '') return null;
    }
    if (endLine < startLine) return null;

    // The editor writes one separating blank line, then one more per empty
    // paragraph. When the file has exactly that layout, the paragraph is one line.
    const emptyParagraphs = next.ordinal - previous.ordinal - 1;
    if (endLine - startLine === emptyParagraphs) {
      const line = startLine + (ordinal - previous.ordinal);
      return { startLine: line, endLine: line };
    }
    return { startLine, endLine };
  }
}

/**
 * Resolve a rich-view selection to exact lines of the saved Markdown text.
 *
 * @param sourceText - The document text the agent will read
 * @param canonicalBlocks - The rich view's top-level blocks, as Feedback enumerates them
 * @param selection - Structural description of the caret or selection
 * @returns The first through last source line, or null when the view cannot be
 *          matched to the text. Never an estimate.
 */
export function resolveAiReferenceLines(
  sourceText: string,
  canonicalBlocks: readonly CanonicalFeedbackBlock[],
  selection: AiReferenceSelection
): AiReferenceLineRange | null {
  // A block that renders nothing has no source block for the anchor map to
  // pair it with; it is resolved from the lines between its neighbors instead.
  const anchors = buildFeedbackAnchorMap(
    sourceText,
    canonicalBlocks.filter(block => !isRenderless(block))
  );
  if (!anchors.ok) return null;

  const resolver = new AiReferenceResolver(sourceText, anchors.map.blocks, canonicalBlocks);
  const start = resolver.resolve(selection.start);
  const end = selection.end === selection.start ? start : resolver.resolve(selection.end);
  if (!start || !end) return null;

  return { startLine: start.startLine, endLine: Math.max(start.startLine, end.endLine) };
}

/**
 * Path to write after `@`: relative to the workspace folder when the file is
 * inside it, else the absolute path. Always forward slashes.
 *
 * @param filePath - Absolute file system path of the document
 * @param workspaceFolderPath - Absolute path of the file's workspace folder, when it has one
 */
export function aiReferencePath(filePath: string, workspaceFolderPath?: string): string {
  // A backslash is a separator only in a Windows path; elsewhere it is a legal file name character.
  const normalize = (value: string): string =>
    /^[A-Za-z]:[\\/]|^\\\\/.test(value) ? value.replace(/\\/g, '/') : value;

  const file = normalize(filePath);
  if (!workspaceFolderPath) return file;

  const folder = normalize(workspaceFolderPath).replace(/\/+$/, '');
  const inside =
    file.length > folder.length + 1 &&
    file[folder.length] === '/' &&
    file.slice(0, folder.length).toLowerCase() === folder.toLowerCase();
  return inside ? file.slice(folder.length + 1) : file;
}

/**
 * Format the reference an agent reads, for example `@bom/README.md#L10-14`.
 *
 * The shape follows what Claude Code parses. Its CLI reads a line range only
 * in the `#L` form (`#L10` or `#L10-14`); a bare `#10-14` attaches the whole
 * file there. A path with spaces is one mention only inside quotes, with the
 * line suffix inside them too: `@"my notes/plan.md#L3-5"`.
 *
 * @param path - Result of {@link aiReferencePath}
 * @param range - Exact lines, or null to reference the file alone
 */
export function formatAiReference(path: string, range: AiReferenceLineRange | null): string {
  let target = path;
  if (range) {
    target +=
      range.startLine === range.endLine
        ? `#L${range.startLine}`
        : `#L${range.startLine}-${range.endLine}`;
  }
  return /\s/.test(path) ? `@"${target}"` : `@${target}`;
}
