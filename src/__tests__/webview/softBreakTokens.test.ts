/** @jest-environment node */

/**
 * Copyright (c) 2025-2026 Concret.io
 *
 * Licensed under the MIT License. See LICENSE file in the project root for details.
 *
 * Unit tests for the soft-break token pass used when
 * `markdownForHumans.render.singleLineBreaks` is false.
 */

import {
  emitSoftBreakTokens,
  installBlankLineLexerNormalizer,
} from '../../webview/utils/markedLexerNormalizer';

describe('emitSoftBreakTokens', () => {
  it('splits a bare newline inside an inline text token into a softbreak token', () => {
    const tokens = [
      {
        type: 'paragraph',
        raw: 'alpha beta\ngamma delta',
        text: 'alpha beta\ngamma delta',
        tokens: [{ type: 'text', raw: 'alpha beta\ngamma delta', text: 'alpha beta\ngamma delta' }],
      },
    ];

    const out = emitSoftBreakTokens(tokens);

    expect(out[0].tokens).toEqual([
      { type: 'text', raw: 'alpha beta', text: 'alpha beta' },
      { type: 'softbreak', raw: '\n' },
      { type: 'text', raw: 'gamma delta', text: 'gamma delta' },
    ]);
  });

  it('demotes a br token whose raw is a bare newline to a softbreak', () => {
    const tokens = [
      {
        type: 'paragraph',
        raw: 'a\nb',
        tokens: [
          { type: 'text', raw: 'a', text: 'a' },
          { type: 'br', raw: '\n' },
          { type: 'text', raw: 'b', text: 'b' },
        ],
      },
    ];

    const out = emitSoftBreakTokens(tokens);

    expect(out[0].tokens?.[1]).toEqual({ type: 'softbreak', raw: '\n' });
  });

  it('preserves explicit two-space and backslash hard breaks', () => {
    const tokens = [
      {
        type: 'paragraph',
        raw: 'a  \nb\\\nc',
        tokens: [
          { type: 'text', raw: 'a', text: 'a' },
          { type: 'br', raw: '  \n' },
          { type: 'text', raw: 'b', text: 'b' },
          { type: 'br', raw: '\\\n' },
          { type: 'text', raw: 'c', text: 'c' },
        ],
      },
    ];

    const out = emitSoftBreakTokens(tokens);

    expect(out[0].tokens?.[1]).toEqual({ type: 'br', raw: '  \n' });
    expect(out[0].tokens?.[3]).toEqual({ type: 'br', raw: '\\\n' });
  });

  it('never touches code blocks or code spans', () => {
    const code = { type: 'code', raw: '```\nx\ny\n```', text: 'x\ny', lang: '' };
    const span = { type: 'codespan', raw: '`x\ny`', text: 'x\ny' };
    const paragraph = { type: 'paragraph', raw: '`x\ny`', tokens: [span] };

    const out = emitSoftBreakTokens([code, paragraph]);

    expect(out[0]).toEqual(code);
    expect(out[1]).toEqual(paragraph);
  });

  it('recurses through list items and table cells', () => {
    const tokens = [
      {
        type: 'list',
        raw: '- a\n  b',
        items: [
          {
            type: 'list_item',
            raw: '- a\n  b',
            tokens: [
              {
                type: 'text',
                raw: 'a\nb',
                text: 'a\nb',
                tokens: [{ type: 'text', raw: 'a\nb', text: 'a\nb' }],
              },
            ],
          },
        ],
      },
      {
        type: 'table',
        raw: '| h |\n|---|\n| c |',
        header: [{ text: 'h', tokens: [{ type: 'text', raw: 'h', text: 'h' }] }],
        rows: [[{ text: 'c d', tokens: [{ type: 'text', raw: 'c\nd', text: 'c\nd' }] }]],
      },
    ];

    const out = emitSoftBreakTokens(tokens);

    const itemInline = out[0].items?.[0].tokens?.[0].tokens;
    expect(itemInline?.map(t => t.type)).toEqual(['text', 'softbreak', 'text']);
    const cellInline = out[1].rows?.[0][0].tokens;
    expect(cellInline?.map(t => t.type)).toEqual(['text', 'softbreak', 'text']);
  });

  it('does not mutate the input tokens', () => {
    const inner = { type: 'text', raw: 'a\nb', text: 'a\nb' };
    const tokens = [{ type: 'paragraph', raw: 'a\nb', tokens: [inner] }];
    const snapshot = JSON.stringify(tokens);

    emitSoftBreakTokens(tokens);

    expect(JSON.stringify(tokens)).toBe(snapshot);
  });
});

describe('installBlankLineLexerNormalizer soft-break predicate', () => {
  function fakeMarked(tokens: unknown[]) {
    return { lexer: () => JSON.parse(JSON.stringify(tokens)) };
  }
  function inlineTypes(inst: { lexer: (src: string) => unknown[] }): string[] {
    const first = inst.lexer('a\nb')[0] as { tokens: { type: string }[] };
    return first.tokens.map(t => t.type);
  }
  const wrapped = [
    {
      type: 'paragraph',
      raw: 'a\nb',
      tokens: [{ type: 'text', raw: 'a\nb', text: 'a\nb' }],
    },
  ];

  it('emits softbreak tokens only while the predicate returns true', () => {
    let soft = false;
    const inst = fakeMarked(wrapped);
    installBlankLineLexerNormalizer(inst, () => soft);

    expect(inlineTypes(inst)).toEqual(['text']);
    soft = true;
    expect(inlineTypes(inst)).toEqual(['text', 'softbreak', 'text']);
  });

  it('re-installing swaps the predicate instead of freezing the first one', () => {
    const inst = fakeMarked(wrapped);
    installBlankLineLexerNormalizer(inst, () => false);
    installBlankLineLexerNormalizer(inst, () => true);

    expect(inlineTypes(inst)).toEqual(['text', 'softbreak', 'text']);
  });
});
