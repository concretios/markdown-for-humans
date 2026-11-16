/**
 * Copyright (c) 2025-2026 Concret.io
 * Licensed under the MIT License. See LICENSE in the project root.
 */
import { CST, isAlias, isMap, isNode, isScalar, isSeq, parseDocument, type Node } from 'yaml';

import { MAX_FRONTMATTER_LENGTH } from './reader';
const MAX_NODES = 512;
const MAX_DEPTH = 12;

export type FrontmatterTone = 'text' | 'number' | 'literal' | 'date' | 'syntax';
export type FrontmatterValue =
  | { kind: 'scalar'; text: string; tone: FrontmatterTone }
  | { kind: 'map'; fields: FrontmatterField[] }
  | { kind: 'list'; flow: boolean; items: FrontmatterValue[] };
export interface FrontmatterField {
  key: string;
  value: FrontmatterValue;
}

type RangeKind = 'punctuation' | 'key' | 'indent' | 'multiline' | FrontmatterTone;
type SourceRange = { from: number; to: number; kind: RangeKind };
export interface FrontmatterPresentation {
  ranges: SourceRange[];
  properties: FrontmatterField[];
}

const punct = new Set<CST.Token['type']>([
  'seq-item-ind',
  'explicit-key-ind',
  'map-value-ind',
  'flow-map-start',
  'flow-map-end',
  'flow-seq-start',
  'flow-seq-end',
  'comma',
  'block-scalar-header',
]);

/** Parse bounded YAML for display. Alias nodes remain references and no custom tags are executed. */
export function parseFrontmatter(source: string): FrontmatterPresentation | null {
  if (source.length > MAX_FRONTMATTER_LENGTH) return null;
  const opener = /^---[ \t]*\r?\n/.exec(source);
  const closer = /\r?\n---[ \t]*$/.exec(source);
  if (!opener || !closer || closer.index < opener[0].length) return null;

  const offset = opener[0].length;
  const body = source.slice(offset, closer.index) + '\n';
  const ranges: SourceRange[] = [];
  const add = (from: number, to: number, kind: RangeKind): void => {
    if (from >= 0 && to > from && offset + to <= closer.index) {
      ranges.push({ from: offset + from, to: offset + to, kind });
    }
  };
  let remaining = MAX_NODES;

  const decorateToken = (token: CST.Token): void => {
    if ('source' in token && punct.has(token.type)) {
      add(token.offset, token.offset + token.source.length, 'punctuation');
    }
    if (token.type === 'flow-collection') {
      decorateToken(token.start);
      token.end.forEach(decorateToken);
    }
    if (CST.isCollection(token)) {
      for (const item of token.items as CST.CollectionItem[]) {
        item.start.forEach(decorateToken);
        item.sep?.forEach(decorateToken);
      }
    }
    if (token.type === 'block-scalar') {
      token.props.forEach(decorateToken);
      const last = token.props[token.props.length - 1];
      if (last && 'source' in last) {
        const start = last.offset + last.source.length;
        add(
          start,
          Math.min(start + token.source.trimEnd().length, closer.index - offset),
          'multiline'
        );
      }
    }
  };

  const asValue = (input: unknown, depth: number): FrontmatterValue => {
    if (--remaining < 0 || depth > MAX_DEPTH) throw new RangeError('Frontmatter display limit');
    const node: Node | null = isNode(input) ? input : null;
    if (node?.srcToken) decorateToken(node.srcToken);
    if (isMap(node)) {
      const fields = node.items.map(pair => {
        if (!isScalar(pair.key) || !pair.key.range || pair.key.type?.startsWith('BLOCK')) {
          throw new Error('Unsupported frontmatter key');
        }
        const [start, end] = pair.key.range;
        add(start, end, 'key');
        return { key: String(pair.key.value), value: asValue(pair.value, depth + 1) };
      });
      return { kind: 'map', fields };
    }
    if (isSeq(node)) {
      return {
        kind: 'list',
        flow: node.flow === true,
        items: node.items.map(item => asValue(item, depth + 1)),
      };
    }
    if (isAlias(node)) return { kind: 'scalar', text: '*' + node.source, tone: 'syntax' };
    const value: unknown = isScalar(node) ? node.value : null;
    const plain = isScalar(node) && node.type === 'PLAIN';
    const tone =
      typeof value === 'number'
        ? 'number'
        : value === null || typeof value === 'boolean'
          ? 'literal'
          : plain && typeof value === 'string' && /^\d{4}-\d{2}-\d{2}(?:[Tt ].*)?$/.test(value)
            ? 'date'
            : 'text';
    if (node?.range && tone !== 'text') add(node.range[0], node.range[1], tone);
    return { kind: 'scalar', text: String(value), tone };
  };

  try {
    const document = parseDocument(body, { keepSourceTokens: true, schema: 'core' });
    if (document.errors.length || document.warnings.length || !isMap(document.contents))
      return null;
    const root = asValue(document.contents, 0);
    if (root.kind !== 'map') return null;
    for (const match of body.matchAll(/^ +(?=\S)/gm)) {
      const start = match.index;
      add(start, start + match[0].length, 'indent');
    }
    return { ranges, properties: root.fields };
  } catch {
    return null;
  }
}
