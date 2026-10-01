/**
 * Copyright (c) 2025-2026 Concret.io
 * Licensed under the MIT License. See LICENSE in the project root.
 * Worker-only Lowlight adapter. Emits bounded UTF-16 ranges, never HTML.
 */
import { lowlight } from 'lowlight';
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import python from 'highlight.js/lib/languages/python';
import bash from 'highlight.js/lib/languages/bash';
import json from 'highlight.js/lib/languages/json';
import markdown from 'highlight.js/lib/languages/markdown';
import css from 'highlight.js/lib/languages/css';
import xml from 'highlight.js/lib/languages/xml';
import sql from 'highlight.js/lib/languages/sql';
import java from 'highlight.js/lib/languages/java';
import go from 'highlight.js/lib/languages/go';
import rust from 'highlight.js/lib/languages/rust';
import { resolveGrammar } from './languageRegistry';
import {
  HIGHLIGHT_LIMITS,
  approvedTokenClasses,
  serializedSpanBytes,
  validHighlightResult,
  type HighlightResult,
  type TokenSpan,
} from './types';

// Preserve the editor's exact existing registration order: Lowlight's bundled
// common grammars (highlight.js 11.8), then these root-version 11.12 overrides.
lowlight.registerLanguage('javascript', javascript);
lowlight.registerLanguage('typescript', typescript);
lowlight.registerLanguage('python', python);
lowlight.registerLanguage('bash', bash);
lowlight.registerLanguage('json', json);
lowlight.registerLanguage('markdown', markdown);
lowlight.registerLanguage('css', css);
lowlight.registerLanguage('html', xml);
lowlight.registerLanguage('xml', xml);
lowlight.registerLanguage('sql', sql);
lowlight.registerLanguage('java', java);
lowlight.registerLanguage('go', go);
lowlight.registerLanguage('rust', rust);

interface TokenTree {
  type?: unknown;
  value?: unknown;
  children?: unknown;
  properties?: { className?: unknown };
}

/** Convert an AST to adjacent coalesced spans while checking exact source text. */
export function spansFromHighlightTree(tree: unknown, source: string): HighlightResult {
  const spans: TokenSpan[] = [];
  let offset = 0;
  let bytes = 80;
  let visited = 0;
  let reason: string | undefined;
  const visit = (value: unknown, inherited: string[], depth: number): void => {
    if (reason) return;
    if (
      !value ||
      typeof value !== 'object' ||
      depth > 256 ||
      ++visited > HIGHLIGHT_LIMITS.sourceUnits * 4
    ) {
      reason = 'invalid-token-output';
      return;
    }
    const node = value as TokenTree;
    if (node.type === 'text') {
      if (typeof node.value !== 'string' || !source.startsWith(node.value, offset)) {
        reason = 'invalid-token-output';
        return;
      }
      const end = offset + node.value.length;
      const classes = inherited.join(' ');
      if (classes && end > offset) {
        const previous = spans[spans.length - 1];
        if (previous && previous.to === offset && previous.classes === classes) {
          bytes -= serializedSpanBytes(previous);
          previous.to = end;
          bytes += serializedSpanBytes(previous);
        } else {
          if (spans.length >= HIGHLIGHT_LIMITS.resultRanges) {
            reason = 'range-limit';
            return;
          }
          const span = { from: offset, to: end, classes };
          spans.push(span);
          bytes += serializedSpanBytes(span);
        }
        if (bytes > HIGHLIGHT_LIMITS.resultBytes) {
          reason = 'result-limit';
          return;
        }
      }
      offset = end;
      return;
    }
    if (!Array.isArray(node.children)) {
      reason = 'invalid-token-output';
      return;
    }
    const ownClasses = node.properties?.className ?? [];
    if (!Array.isArray(ownClasses) || !ownClasses.every(value => typeof value === 'string')) {
      reason = 'invalid-token-output';
      return;
    }
    // Keep each class once, ordered by its deepest occurrence. In a template
    // string's interpolation, a nested string must follow the outer subst scope
    // so the theme can select its innermost semantic color from the flat span.
    const classes = Array.from(
      new Set([
        ...inherited.filter(name => !ownClasses.includes(name)),
        ...(ownClasses as string[]),
      ])
    );
    if (classes.length && !approvedTokenClasses(classes.join(' '))) {
      reason = 'invalid-token-output';
      return;
    }
    for (const child of node.children) {
      visit(child, classes, depth + 1);
      if (reason) break;
    }
  };
  visit(tree, [], 0);
  if (reason) return { spans: [], reason };
  const result = { spans };
  return offset === source.length && validHighlightResult(result, source)
    ? result
    : { spans: [], reason: 'invalid-token-output' };
}

/** Tokenize an explicit supported grammar, falling back to unchanged plain text. */
export function tokenizeCode(language: string, source: string): HighlightResult {
  if (source.length > HIGHLIGHT_LIMITS.sourceUnits) return { spans: [], reason: 'source-limit' };
  const grammar = resolveGrammar(language);
  if (!grammar || !source) return { spans: [], reason: grammar ? undefined : 'plain' };
  try {
    return spansFromHighlightTree(lowlight.highlight(grammar, source), source);
  } catch {
    return { spans: [], reason: 'tokenizer-error' };
  }
}
