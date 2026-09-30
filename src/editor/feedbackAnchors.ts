/**
 * Copyright (c) 2025-2026 Concret.io
 *
 * Licensed under the MIT License. See LICENSE file in the project root for details.
 */

/**
 * @file feedbackAnchors.ts - Frozen rich-view block to raw Markdown line mapping
 * @description Builds a strict, host-authoritative map between serialized
 *              ProseMirror blocks and exact line spans in saved source bytes.
 *
 * Key responsibilities:
 * - Parse canonical and source Markdown into comparable top-level block kinds
 * - Honor the rich parser's ordered-list boundary semantics before comparison
 * - Preserve exact raw line spans across source-only formatting differences
 * - Treat leading YAML or explicitly identified JSON frontmatter as one block
 * - Fail closed when block order or structure cannot be proven equivalent
 */

import MarkdownIt from 'markdown-it';

/** Stable error code for every frozen block-map or selection-map failure. */
export const FEEDBACK_ANCHOR_ERROR_CODE = 'MD4H-FB-ANCHOR-002' as const;
export const FEEDBACK_TARGET_ERROR_CODE = 'MD4H-FB-ANCHOR-001' as const;

/**
 * One serializable, non-empty top-level block from the frozen rich editor.
 * Ordinals are the original ProseMirror child indexes and may be non-contiguous
 * when empty top-level paragraphs were omitted from serialization.
 */
export interface CanonicalFeedbackBlock {
  ordinal: number;
  kind: string;
  markdown: string;
}

/** Block kinds whose structural equivalence can be proven by MarkdownIt. */
export type FeedbackAnchorKind =
  | 'frontmatter'
  | 'paragraph'
  | 'heading'
  | 'list'
  | 'blockquote'
  | 'code'
  | 'table'
  | 'thematicBreak'
  | 'html';

/** Exact 1-based, inclusive raw-source lines for one ProseMirror block. */
export interface FeedbackAnchorSpan {
  ordinal: number;
  kind: FeedbackAnchorKind;
  startLine: number;
  endLine: number;
}

/** Serializable frozen source map retained by the extension host. */
export interface FeedbackAnchorMap {
  blocks: FeedbackAnchorSpan[];
}

/** Machine-readable reasons sharing the stable public anchor error code. */
export type FeedbackAnchorFailureReason =
  | 'invalid-canonical-order'
  | 'invalid-canonical-block'
  | 'unsupported-raw-block'
  | 'block-count-mismatch'
  | 'block-kind-mismatch'
  | 'selection-out-of-range';

/** Structured anchor failure safe to pass across the host/webview boundary. */
export interface FeedbackAnchorError {
  code: typeof FEEDBACK_ANCHOR_ERROR_CODE | typeof FEEDBACK_TARGET_ERROR_CODE;
  reason: FeedbackAnchorFailureReason;
  detail: string;
}

/** Result of validating and building a frozen raw-source block map. */
export type FeedbackAnchorMapResult =
  { ok: true; map: FeedbackAnchorMap } | { ok: false; error: FeedbackAnchorError };

/** Exact raw lines covered by inclusive canonical block ordinals. */
export interface FeedbackSelectionLineRange {
  startOrdinal: number;
  endOrdinal: number;
  startLine: number;
  endLine: number;
}

/** Result of resolving a rich-view block selection against the frozen map. */
export type FeedbackSelectionMapResult =
  { ok: true; range: FeedbackSelectionLineRange } | { ok: false; error: FeedbackAnchorError };

/** Ordinal endpoints resolved from exact inclusive source-line endpoints. */
export interface FeedbackOrdinalRange {
  readonly startOrdinal: number;
  readonly endOrdinal: number;
}

type MarkdownToken = ReturnType<MarkdownIt['parse']>[number];

interface ParsedSourceBlock {
  kind: FeedbackAnchorKind;
  startLine: number;
  endLine: number;
}

interface ExtractedFrontmatter {
  endLine: number;
  bodyMarkdown: string;
  bodyLineOffset: number;
}

const markdownParser = new MarkdownIt({
  html: true,
  breaks: false,
  linkify: false,
});

interface OrderedListSpan {
  startLine: number;
  endLineExclusive: number;
}

const ORDERED_LIST_ITEM_PATTERN = /^(\s*)(\d+)\.\s+(.*)$/;
const INDENTED_LINE_PATTERN = /^\s/;
const THREE_SPACE_ORDERED_LIST_ROOT_PATTERN = /^ {3}\d+\.\s+/;

function findAnchorLineIndex(
  blocks: readonly FeedbackAnchorSpan[],
  line: number,
  key: 'startLine' | 'endLine',
  minimumIndex = 0
): number {
  let lower = minimumIndex;
  let upper = blocks.length;
  while (lower < upper) {
    const middle = lower + Math.floor((upper - lower) / 2);
    if (blocks[middle][key] < line) lower = middle + 1;
    else upper = middle;
  }
  return lower < blocks.length && blocks[lower][key] === line ? lower : -1;
}

/**
 * Resolve exact source-line endpoints without scanning every canonical block.
 *
 * Anchor spans are emitted in document order and never overlap, so their start
 * and end lines are monotonic. Two lower-bound searches keep restored Feedback
 * lookup logarithmic even for a 10,000-line document with many saved items.
 *
 * @param anchorMap - Frozen source map produced by {@link buildFeedbackAnchorMap}
 * @param startLine - Exact inclusive first source line
 * @param endLine - Exact inclusive last source line
 * @returns Matching ordinal range, or `null` when either endpoint is absent or reversed
 */
export function findFeedbackOrdinalsForLines(
  anchorMap: FeedbackAnchorMap,
  startLine: number,
  endLine: number
): FeedbackOrdinalRange | null {
  if (
    !Number.isSafeInteger(startLine) ||
    !Number.isSafeInteger(endLine) ||
    startLine < 1 ||
    endLine < startLine
  ) {
    return null;
  }
  const firstIndex = findAnchorLineIndex(anchorMap.blocks, startLine, 'startLine');
  if (firstIndex < 0) return null;
  const lastIndex = findAnchorLineIndex(anchorMap.blocks, endLine, 'endLine', firstIndex);
  if (lastIndex < firstIndex) return null;
  return {
    startOrdinal: anchorMap.blocks[firstIndex].ordinal,
    endOrdinal: anchorMap.blocks[lastIndex].ordinal,
  };
}

/** Detect only level-zero three-space roots, not nested ordered-list children. */
function hasThreeSpaceOrderedListRoot(markdown: string): boolean {
  let tokens: MarkdownToken[];
  try {
    tokens = markdownParser.parse(markdown, {});
  } catch {
    return false;
  }

  const sourceLines = markdown.split(/\r?\n/);
  return tokens.some(
    token =>
      token.level === 0 &&
      token.type === 'ordered_list_open' &&
      token.map !== null &&
      THREE_SPACE_ORDERED_LIST_ROOT_PATTERN.test(sourceLines[token.map[0]] ?? '')
  );
}

function failure(
  reason: FeedbackAnchorFailureReason,
  detail: string
): { ok: false; error: FeedbackAnchorError } {
  return {
    ok: false,
    error: {
      code: FEEDBACK_ANCHOR_ERROR_CODE,
      reason,
      detail,
    },
  };
}

function normalizeCanonicalKind(kind: string): FeedbackAnchorKind | null {
  const compactKind = kind
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');

  switch (compactKind) {
    case 'frontmatter':
    case 'yamlfrontmatter':
    case 'jsonfrontmatter':
      return 'frontmatter';
    case 'paragraph':
    case 'markdownparagraph':
    case 'textblock':
    case 'image':
    case 'math':
    case 'mathblock':
      return 'paragraph';
    case 'heading':
      return 'heading';
    case 'list':
    case 'bulletlist':
    case 'orderedlist':
    case 'tasklist':
      return 'list';
    case 'blockquote':
    case 'alert':
    case 'githubalert':
      return 'blockquote';
    case 'code':
    case 'codeblock':
    case 'fence':
    case 'fencedcode':
    case 'mermaid':
    case 'preservedcodeblock':
    case 'indentedimagecodeblock':
      return 'code';
    case 'table':
      return 'table';
    case 'horizontalrule':
    case 'thematicbreak':
    case 'hr':
      return 'thematicBreak';
    case 'html':
    case 'htmlblock':
      return 'html';
    default:
      return null;
  }
}

function kindForToken(token: MarkdownToken): FeedbackAnchorKind | null {
  switch (token.type) {
    case 'paragraph_open':
      return 'paragraph';
    case 'heading_open':
      return 'heading';
    case 'bullet_list_open':
    case 'ordered_list_open':
      return 'list';
    case 'blockquote_open':
      return 'blockquote';
    case 'fence':
    case 'code_block':
      return 'code';
    case 'table_open':
      return 'table';
    case 'hr':
      return 'thematicBreak';
    case 'html_block':
      // Merged-cell tables use the editor's HTML-preserving serializer, but
      // remain the same top-level table node in the rich document.
      return /^\s*<table(?:\s|>)/i.test(token.content) ? 'table' : 'html';
    default:
      return null;
  }
}

function parseMarkdownItTopLevelBlocks(
  markdown: string,
  lineOffset: number
): ParsedSourceBlock[] | FeedbackAnchorError {
  let tokens: MarkdownToken[];
  try {
    tokens = markdownParser.parse(markdown, {});
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown Markdown parser failure.';
    return {
      code: FEEDBACK_ANCHOR_ERROR_CODE,
      reason: 'unsupported-raw-block',
      detail: `Markdown parsing failed: ${message}`,
    };
  }

  const blocks: ParsedSourceBlock[] = [];
  const sourceLines = markdown.split(/\r?\n/);
  for (const token of tokens) {
    if (token.level !== 0 || token.map === null) {
      continue;
    }

    const kind = kindForToken(token);
    if (kind === null) {
      return {
        code: FEEDBACK_ANCHOR_ERROR_CODE,
        reason: 'unsupported-raw-block',
        detail: `Markdown token ${token.type} cannot be anchored safely.`,
      };
    }

    const [startLine, tokenEndLineExclusive] = token.map;
    let endLineExclusive = tokenEndLineExclusive;
    // MarkdownIt includes the separator blank line in some container maps,
    // notably lists. Feedback should quote only source lines belonging to the
    // rendered block, not the whitespace separating it from the next block.
    while (
      endLineExclusive > startLine + 1 &&
      (sourceLines[endLineExclusive - 1] ?? '').trim() === ''
    ) {
      endLineExclusive -= 1;
    }
    blocks.push({
      kind,
      startLine: startLine + lineOffset + 1,
      endLine: endLineExclusive + lineOffset,
    });
  }

  return blocks;
}

/**
 * Return the line immediately after one ordered-list token according to the
 * tokenizer shipped by `@tiptap/extension-list` 3.30.x. That tokenizer accepts
 * two-space mixed-list children beneath an ordered item, while markdown-it
 * requires indentation based on the ordered marker width. Keeping this small
 * boundary rule aligned with the rich parser prevents one TipTap list from
 * becoming two host-side blocks.
 */
function tipTapOrderedListEnd(sourceLines: readonly string[], startLine: number): number {
  let currentLine = startLine;
  let consumed = startLine;

  while (currentLine < sourceLines.length) {
    if (!ORDERED_LIST_ITEM_PATTERN.test(sourceLines[currentLine] ?? '')) break;

    let nextLine = currentLine + 1;
    while (nextLine < sourceLines.length) {
      const candidate = sourceLines[nextLine] ?? '';
      if (ORDERED_LIST_ITEM_PATTERN.test(candidate)) break;

      if (candidate.trim() === '' || INDENTED_LINE_PATTERN.test(candidate)) {
        nextLine += 1;
        continue;
      }
      break;
    }

    consumed = nextLine;
    currentLine = nextLine;
  }

  return consumed;
}

function orderedListSpans(markdown: string, tokens: readonly MarkdownToken[]): OrderedListSpan[] {
  const sourceLines = markdown.split(/\r?\n/);
  const spans: OrderedListSpan[] = [];

  for (const token of tokens) {
    if (token.level !== 0 || token.type !== 'ordered_list_open' || token.map === null) continue;

    const [startLine, markdownItEndLineExclusive] = token.map;
    const rootMatch = sourceLines[startLine]?.match(ORDERED_LIST_ITEM_PATTERN);
    // TipTap's ordered-list tokenizer only applies the mixed-list continuation
    // rule to a true column-zero root. Markdown-it already agrees with TipTap
    // for one- and two-space roots, so adapting those spans would merge two
    // independently rendered blocks and produce incorrect source anchors.
    if (!rootMatch || rootMatch[1] !== '') continue;

    const previous = spans[spans.length - 1];
    if (previous && startLine < previous.endLineExclusive) continue;

    const endLineExclusive = tipTapOrderedListEnd(sourceLines, startLine);
    let contentEndLineExclusive = endLineExclusive;
    while (
      contentEndLineExclusive > startLine + 1 &&
      (sourceLines[contentEndLineExclusive - 1] ?? '').trim() === ''
    ) {
      contentEndLineExclusive -= 1;
    }

    // Trailing separator whitespace alone is not a dialect mismatch. Repair
    // only when TipTap assigns actual continuation content beyond markdown-it's
    // top-level ordered-list token.
    if (contentEndLineExclusive > markdownItEndLineExclusive) {
      spans.push({ startLine, endLineExclusive });
    }
  }

  return spans;
}

function restoreLineEndings(markdown: string, lines: readonly string[]): string {
  const endings = markdown.match(/\r\n|\n/g) ?? [];
  return lines.map((line, index) => `${line}${endings[index] ?? ''}`).join('');
}

/**
 * Adapt only parser-shadow indentation for proven TipTap ordered-list runs.
 * The source bytes remain untouched. Repaired spans must reparse as exactly
 * one level-zero ordered-list block or the original strict parse is retained.
 */
function adaptTipTapOrderedListBoundaries(
  markdown: string,
  tokens: readonly MarkdownToken[]
): string {
  const spans = orderedListSpans(markdown, tokens);
  if (spans.length === 0) return markdown;

  const sourceLines = markdown.split(/\r?\n/);
  const shadowLines = [...sourceLines];

  for (const span of spans) {
    const rootMatch = sourceLines[span.startLine]?.match(/^( *)(\d+)\.\s+(.*)$/);
    if (!rootMatch) return markdown;

    const rootIndent = rootMatch[1].length;
    let contentIndent = rootIndent + rootMatch[2].length + 2;
    for (let lineIndex = span.startLine + 1; lineIndex < span.endLineExclusive; lineIndex += 1) {
      const sourceLine = sourceLines[lineIndex] ?? '';
      if (sourceLine.trim() === '') continue;

      const orderedItem = sourceLine.match(/^( *)(\d+)\.\s+(.*)$/);
      const leadingSpaces = sourceLine.match(/^( *)/)?.[1].length ?? 0;
      if (sourceLine[leadingSpaces] === '\t' || leadingSpaces < rootIndent) return markdown;

      if (orderedItem && leadingSpaces === rootIndent) {
        contentIndent = rootIndent + orderedItem[2].length + 2;
        continue;
      }
      if (leadingSpaces <= rootIndent) return markdown;

      if (leadingSpaces < contentIndent) {
        shadowLines[lineIndex] = `${' '.repeat(contentIndent - leadingSpaces)}${sourceLine}`;
      }
    }
  }

  const shadowMarkdown = restoreLineEndings(markdown, shadowLines);
  let shadowTokens: MarkdownToken[];
  try {
    shadowTokens = markdownParser.parse(shadowMarkdown, {});
  } catch {
    return markdown;
  }

  for (const span of spans) {
    let contentEndLineExclusive = span.endLineExclusive;
    while (
      contentEndLineExclusive > span.startLine + 1 &&
      (sourceLines[contentEndLineExclusive - 1] ?? '').trim() === ''
    ) {
      contentEndLineExclusive -= 1;
    }
    const overlapping = shadowTokens.filter(
      token =>
        token.level === 0 &&
        token.map !== null &&
        token.map[0] < contentEndLineExclusive &&
        token.map[1] > span.startLine
    );
    if (
      overlapping.length !== 1 ||
      overlapping[0].type !== 'ordered_list_open' ||
      overlapping[0].map?.[0] !== span.startLine ||
      (overlapping[0].map?.[1] ?? 0) < contentEndLineExclusive ||
      (overlapping[0].map?.[1] ?? Number.POSITIVE_INFINITY) > span.endLineExclusive
    ) {
      return markdown;
    }
  }

  return shadowMarkdown;
}

function parseTopLevelBlocks(
  markdown: string,
  lineOffset: number
): ParsedSourceBlock[] | FeedbackAnchorError {
  let tokens: MarkdownToken[];
  try {
    tokens = markdownParser.parse(markdown, {});
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown Markdown parser failure.';
    return {
      code: FEEDBACK_ANCHOR_ERROR_CODE,
      reason: 'unsupported-raw-block',
      detail: `Markdown parsing failed: ${message}`,
    };
  }

  return parseMarkdownItTopLevelBlocks(
    adaptTipTapOrderedListBoundaries(markdown, tokens),
    lineOffset
  );
}

function lineStarts(markdown: string): number[] {
  const starts = [0];
  const newlinePattern = /\r\n|\n/g;
  let match: RegExpExecArray | null;
  while ((match = newlinePattern.exec(markdown)) !== null) {
    starts.push(match.index + match[0].length);
  }
  return starts;
}

function lineText(markdown: string, starts: number[], index: number): string {
  const nextStart = index + 1 < starts.length ? starts[index + 1] : markdown.length;
  return markdown.slice(starts[index], nextStart).replace(/\r?\n$/, '');
}

function extractLeadingYamlFrontmatter(markdown: string): ExtractedFrontmatter | null {
  const starts = lineStarts(markdown);
  const firstLine = lineText(markdown, starts, 0).replace(/^\uFEFF/, '');
  if (!/^---[ \t]*$/.test(firstLine)) {
    return null;
  }

  for (let index = 1; index < starts.length; index += 1) {
    const currentLine = lineText(markdown, starts, index);
    if (!/^(?:---|\.\.\.)[ \t]*$/.test(currentLine)) {
      continue;
    }

    const bodyStart = index + 1 < starts.length ? starts[index + 1] : markdown.length;
    return {
      endLine: index + 1,
      bodyMarkdown: markdown.slice(bodyStart),
      bodyLineOffset: index + 1,
    };
  }

  return null;
}

function extractLeadingJsonFrontmatter(markdown: string): ExtractedFrontmatter | null {
  const source = markdown.startsWith('\uFEFF') ? markdown.slice(1) : markdown;
  if (!source.startsWith('{')) {
    return null;
  }

  let depth = 0;
  let inString = false;
  let escaped = false;
  let closingIndex = -1;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }

    if (character === '"') {
      inString = true;
    } else if (character === '{') {
      depth += 1;
    } else if (character === '}') {
      depth -= 1;
      if (depth === 0) {
        closingIndex = index;
        break;
      }
      if (depth < 0) {
        return null;
      }
    }
  }

  if (closingIndex === -1 || inString || depth !== 0) {
    return null;
  }

  const jsonText = source.slice(0, closingIndex + 1);
  try {
    const parsed: unknown = JSON.parse(jsonText);
    if (parsed === null || Array.isArray(parsed) || typeof parsed !== 'object') {
      return null;
    }
  } catch {
    return null;
  }

  const afterObject = source.slice(closingIndex + 1);
  const lineEnd = afterObject.match(/^[ \t]*(?:\r\n|\n|$)/);
  if (!lineEnd) {
    return null;
  }

  const sourceBodyStart = closingIndex + 1 + lineEnd[0].length;
  const sourcePrefix = source.slice(0, sourceBodyStart);
  const bodyLineOffset = (sourcePrefix.match(/\n/g) ?? []).length;
  const endLine = (jsonText.match(/\n/g) ?? []).length + 1;
  const originalBodyStart = markdown.startsWith('\uFEFF') ? sourceBodyStart + 1 : sourceBodyStart;

  return {
    endLine,
    bodyMarkdown: markdown.slice(originalBodyStart),
    bodyLineOffset,
  };
}

function isFencedFrontmatter(markdown: string): boolean {
  const lines = markdown.split(/\r?\n/);
  const opening = lines[0]?.match(/^([`~]{3,})[ \t]*(yaml|yml|json)[ \t]*$/i);
  if (!opening) {
    return false;
  }

  const fenceCharacter = opening[1][0];
  const minimumLength = opening[1].length;
  for (let index = 1; index < lines.length; index += 1) {
    const closing = lines[index].trim();
    if (
      closing.length >= minimumLength &&
      closing.split('').every(character => character === fenceCharacter)
    ) {
      return lines.slice(index + 1).every(line => line.trim() === '');
    }
  }
  return false;
}

function isDirectFrontmatter(markdown: string): boolean {
  const yaml = extractLeadingYamlFrontmatter(markdown);
  if (yaml && yaml.bodyMarkdown.trim() === '') {
    return true;
  }
  const json = extractLeadingJsonFrontmatter(markdown);
  return json !== null && json.bodyMarkdown.trim() === '';
}

function canonicalBlockRepresentsFrontmatter(block: CanonicalFeedbackBlock): boolean {
  return (
    normalizeCanonicalKind(block.kind) === 'frontmatter' ||
    isFencedFrontmatter(block.markdown) ||
    isDirectFrontmatter(block.markdown)
  );
}

function canonicalKindForBlock(
  block: CanonicalFeedbackBlock,
  isLeadingRawFrontmatter: boolean
): FeedbackAnchorKind | FeedbackAnchorError {
  if (isLeadingRawFrontmatter && canonicalBlockRepresentsFrontmatter(block)) {
    return 'frontmatter';
  }

  const requestedKind = normalizeCanonicalKind(block.kind);
  if (requestedKind === null) {
    return {
      code: FEEDBACK_ANCHOR_ERROR_CODE,
      reason: 'invalid-canonical-block',
      detail: `Block ordinal ${block.ordinal} has unsupported kind ${JSON.stringify(block.kind)}.`,
    };
  }

  const parsedBlocks = parseTopLevelBlocks(block.markdown, 0);
  if (!Array.isArray(parsedBlocks)) {
    return {
      ...parsedBlocks,
      reason: 'invalid-canonical-block',
      detail: `Block ordinal ${block.ordinal} could not be parsed: ${parsedBlocks.detail}`,
    };
  }
  if (parsedBlocks.length !== 1) {
    return {
      code: FEEDBACK_ANCHOR_ERROR_CODE,
      reason: 'invalid-canonical-block',
      detail: `Block ordinal ${block.ordinal} produced ${parsedBlocks.length} top-level Markdown blocks.`,
    };
  }

  const parsedKind = parsedBlocks[0].kind;
  if (requestedKind !== parsedKind) {
    return {
      code: FEEDBACK_ANCHOR_ERROR_CODE,
      reason: 'invalid-canonical-block',
      detail: `Block ordinal ${block.ordinal} declares ${requestedKind} but serializes as ${parsedKind}.`,
    };
  }

  return parsedKind;
}

function canonicalRequestsJsonFrontmatter(block: CanonicalFeedbackBlock | undefined): boolean {
  if (!block) {
    return false;
  }
  if (normalizeCanonicalKind(block.kind) === 'frontmatter') {
    return true;
  }
  return /^([`~]{3,})[ \t]*json[ \t]*(?:\r?\n)/i.test(block.markdown);
}

/**
 * Build a frozen mapping from top-level rich-view ordinals to exact saved-file
 * lines. The function fails closed unless canonical and raw block count, order,
 * and normalized kinds all agree.
 *
 * @param rawMarkdown - Exact Markdown bytes decoded as text after saving
 * @param canonicalBlocks - Non-empty top-level rich blocks in document order
 * @returns A validated raw-source map, or `MD4H-FB-ANCHOR-002`
 */
export function buildFeedbackAnchorMap(
  rawMarkdown: string,
  canonicalBlocks: readonly CanonicalFeedbackBlock[]
): FeedbackAnchorMapResult {
  // A three-space ordered-list root sits on a parser-dialect boundary: TipTap
  // releases have alternated between representing it as one list and splitting
  // its mixed child into another block. Kind/count agreement alone therefore
  // cannot prove a stable byte-to-rich-view mapping. Keep Feedback fail-closed
  // for this ambiguous source shape across editor upgrades.
  if (hasThreeSpaceOrderedListRoot(rawMarkdown)) {
    return failure(
      'invalid-canonical-block',
      'Three-space ordered-list roots cannot be anchored safely across parser dialects.'
    );
  }

  for (let index = 0; index < canonicalBlocks.length; index += 1) {
    const current = canonicalBlocks[index];
    const previous = canonicalBlocks[index - 1];
    if (
      !Number.isInteger(current.ordinal) ||
      current.ordinal < 0 ||
      (previous !== undefined && current.ordinal <= previous.ordinal)
    ) {
      return failure(
        'invalid-canonical-order',
        'Canonical block ordinals must be unique, non-negative integers in document order.'
      );
    }
  }

  const yamlFrontmatter = extractLeadingYamlFrontmatter(rawMarkdown);
  const jsonFrontmatter = canonicalRequestsJsonFrontmatter(canonicalBlocks[0])
    ? extractLeadingJsonFrontmatter(rawMarkdown)
    : null;
  const frontmatter = yamlFrontmatter ?? jsonFrontmatter;

  const rawBlocks: ParsedSourceBlock[] = [];
  if (frontmatter) {
    rawBlocks.push({ kind: 'frontmatter', startLine: 1, endLine: frontmatter.endLine });
  }

  const parsedBody = parseTopLevelBlocks(
    frontmatter?.bodyMarkdown ?? rawMarkdown,
    frontmatter?.bodyLineOffset ?? 0
  );
  if (!Array.isArray(parsedBody)) {
    return { ok: false, error: parsedBody };
  }
  rawBlocks.push(...parsedBody);

  const canonicalKinds: FeedbackAnchorKind[] = [];
  for (let index = 0; index < canonicalBlocks.length; index += 1) {
    const kind = canonicalKindForBlock(canonicalBlocks[index], frontmatter !== null && index === 0);
    if (typeof kind !== 'string') {
      return { ok: false, error: kind };
    }
    canonicalKinds.push(kind);
  }

  if (canonicalKinds.length !== rawBlocks.length) {
    return failure(
      'block-count-mismatch',
      `Canonical block count ${canonicalKinds.length} does not match raw block count ${rawBlocks.length}.`
    );
  }

  const blocks: FeedbackAnchorSpan[] = [];
  for (let index = 0; index < canonicalKinds.length; index += 1) {
    const canonicalKind = canonicalKinds[index];
    const canonicalBlock = canonicalBlocks[index];
    const rawBlock = rawBlocks[index];
    if (canonicalKind !== rawBlock.kind) {
      return failure(
        'block-kind-mismatch',
        `Block ordinal ${canonicalBlock.ordinal} is ${canonicalKind} in the canonical snapshot but ${rawBlock.kind} in the raw source.`
      );
    }

    blocks.push({
      ordinal: canonicalBlock.ordinal,
      kind: canonicalKind,
      startLine: rawBlock.startLine,
      endLine: rawBlock.endLine,
    });
  }

  return { ok: true, map: { blocks } };
}

/**
 * Resolve an inclusive rich-view ordinal selection to its containing exact raw
 * source lines. Reverse-direction inputs are normalized for pointer selections.
 *
 * @param anchorMap - Frozen map returned by `buildFeedbackAnchorMap`
 * @param startOrdinal - One selected top-level ProseMirror child ordinal
 * @param endOrdinal - Other selected top-level ProseMirror child ordinal
 * @returns Exact first-to-last raw line range, or a stable anchor error
 */
export function mapFeedbackSelection(
  anchorMap: FeedbackAnchorMap,
  startOrdinal: number,
  endOrdinal: number
): FeedbackSelectionMapResult {
  const normalizedStart = Math.min(startOrdinal, endOrdinal);
  const normalizedEnd = Math.max(startOrdinal, endOrdinal);
  const first = anchorMap.blocks.find(block => block.ordinal === normalizedStart);
  const last = anchorMap.blocks.find(block => block.ordinal === normalizedEnd);

  if (!first || !last || !Number.isInteger(startOrdinal) || !Number.isInteger(endOrdinal)) {
    return {
      ok: false,
      error: {
        code: FEEDBACK_TARGET_ERROR_CODE,
        reason: 'selection-out-of-range',
        detail: `Selection ordinals ${normalizedStart}-${normalizedEnd} do not both exist in the frozen anchor map.`,
      },
    };
  }

  return {
    ok: true,
    range: {
      startOrdinal: normalizedStart,
      endOrdinal: normalizedEnd,
      startLine: first.startLine,
      endLine: last.endLine,
    },
  };
}
