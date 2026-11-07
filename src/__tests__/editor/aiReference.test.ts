/**
 * @jest-environment node
 *
 * Host side of Copy Reference for AI: exact source lines for a described
 * selection, and the `@path#L` text. Selections are written by hand here; the
 * real-editor suite covers how the webview produces them.
 */

import {
  aiReferencePath,
  formatAiReference,
  resolveAiReferenceLines,
} from '../../editor/aiReference';
import type {
  AiReferencePoint,
  AiReferenceSelection,
  AiReferenceStep,
} from '../../shared/aiReferenceProtocol';
import type { CanonicalFeedbackBlock } from '../../shared/feedbackProtocol';

function block(ordinal: number, kind: string, markdown: string): CanonicalFeedbackBlock {
  return { ordinal, kind, markdown, contentSize: markdown.length };
}

function point(
  ordinal: number,
  steps: AiReferenceStep[] = [],
  line?: { index: number; count: number }
): AiReferencePoint {
  return { ordinal, steps, ...(line ? { line } : {}) };
}

function caret(at: AiReferencePoint): AiReferenceSelection {
  return { start: at, end: at };
}

function step(kind: AiReferenceStep['kind'], index: number, count: number): AiReferenceStep {
  return { kind, index, count };
}

describe('resolveAiReferenceLines', () => {
  it('returns the single line of a one-line paragraph and of a heading', () => {
    const source = '# Title\n\nFirst paragraph.\n\nSecond paragraph.\n';
    const blocks = [
      block(0, 'heading', '# Title'),
      block(1, 'paragraph', 'First paragraph.'),
      block(2, 'paragraph', 'Second paragraph.'),
    ];

    expect(resolveAiReferenceLines(source, blocks, caret(point(0)))).toEqual({
      startLine: 1,
      endLine: 1,
    });
    expect(
      resolveAiReferenceLines(source, blocks, caret(point(2, [], { index: 0, count: 1 })))
    ).toEqual({ startLine: 5, endLine: 5 });
  });

  it('returns the caret line inside a hard-wrapped paragraph', () => {
    const source = 'Intro.\n\nline one\nline two\nline three\n';
    const blocks = [
      block(0, 'paragraph', 'Intro.'),
      block(1, 'paragraph', 'line one\nline two\nline three'),
    ];

    expect(
      resolveAiReferenceLines(source, blocks, caret(point(1, [], { index: 1, count: 3 })))
    ).toEqual({ startLine: 4, endLine: 4 });
    expect(
      resolveAiReferenceLines(source, blocks, {
        start: point(1, [], { index: 1, count: 3 }),
        end: point(1, [], { index: 2, count: 3 }),
      })
    ).toEqual({ startLine: 4, endLine: 5 });
  });

  it('uses the whole paragraph when a source newline is not a line break', () => {
    // The newline inside the code span renders as a space, so the rendered
    // paragraph has fewer lines than the source and no line can be proven.
    const source = 'before `code\nspan` after\nlast line\n';
    const blocks = [block(0, 'paragraph', 'before `code\nspan` after\nlast line')];

    expect(
      resolveAiReferenceLines(source, blocks, caret(point(0, [], { index: 1, count: 2 })))
    ).toEqual({ startLine: 1, endLine: 3 });
  });

  it('returns the row line for a caret in a table cell', () => {
    const source = 'Intro\n\n| Part | Qty |\n| --- | --- |\n| Bolt | 4 |\n| Nut | 8 |\n';
    const blocks = [
      block(0, 'paragraph', 'Intro'),
      block(1, 'table', '| Part | Qty |\n| --- | --- |\n| Bolt | 4 |\n| Nut | 8 |'),
    ];
    const inCell = (row: number) =>
      point(1, [step('row', row, 3), step('other', 1, 2), step('paragraph', 0, 1)], {
        index: 0,
        count: 1,
      });

    expect(resolveAiReferenceLines(source, blocks, caret(inCell(0)))).toEqual({
      startLine: 3,
      endLine: 3,
    });
    expect(resolveAiReferenceLines(source, blocks, caret(inCell(2)))).toEqual({
      startLine: 6,
      endLine: 6,
    });
    expect(resolveAiReferenceLines(source, blocks, { start: inCell(1), end: inCell(2) })).toEqual({
      startLine: 5,
      endLine: 6,
    });
  });

  it('returns the code line inside a fence, and the fence range for the whole block', () => {
    const source = 'Text\n\n```js\nconst a = 1;\n\nconst b = 2;\n```\n';
    const blocks = [
      block(0, 'paragraph', 'Text'),
      block(1, 'code', '```js\nconst a = 1;\n\nconst b = 2;\n```'),
    ];

    expect(
      resolveAiReferenceLines(source, blocks, caret(point(1, [], { index: 2, count: 3 })))
    ).toEqual({ startLine: 6, endLine: 6 });
    expect(resolveAiReferenceLines(source, blocks, caret(point(1)))).toEqual({
      startLine: 3,
      endLine: 7,
    });
  });

  it('uses the whole fence when the rendered code has a different line count', () => {
    const source = '```\na\nb\n```\n';
    const blocks = [block(0, 'code', '```\na\nb\n```')];

    expect(
      resolveAiReferenceLines(source, blocks, caret(point(0, [], { index: 1, count: 5 })))
    ).toEqual({ startLine: 1, endLine: 4 });
  });

  it('returns the line of a nested list item and of a task item', () => {
    const source = [
      '- one',
      '  - nested a',
      '  - nested b',
      '    wrapped',
      '- two',
      '',
      'Tasks:',
      '',
      '- [ ] open task',
      '- [x] done task',
      '',
    ].join('\n');
    const blocks = [
      block(0, 'list', '- one\n  - nested a\n  - nested b\n    wrapped\n- two'),
      block(1, 'paragraph', 'Tasks:'),
      block(2, 'list', '- [ ] open task\n- [x] done task'),
    ];
    const nestedB = (line: number) =>
      point(
        0,
        [step('item', 0, 2), step('list', 1, 2), step('item', 1, 2), step('paragraph', 0, 1)],
        { index: line, count: 2 }
      );

    expect(resolveAiReferenceLines(source, blocks, caret(nestedB(0)))).toEqual({
      startLine: 3,
      endLine: 3,
    });
    expect(resolveAiReferenceLines(source, blocks, caret(nestedB(1)))).toEqual({
      startLine: 4,
      endLine: 4,
    });
    expect(
      resolveAiReferenceLines(
        source,
        blocks,
        caret(point(2, [step('item', 1, 2), step('paragraph', 0, 1)], { index: 0, count: 1 }))
      )
    ).toEqual({ startLine: 10, endLine: 10 });
  });

  it('falls back to the smallest verified block when the nested shape differs', () => {
    const source = '- one\n- two\n- three\n';
    const blocks = [block(0, 'list', '- one\n- two\n- three')];

    // The view claims four items; the source has three. Nothing below the list is proven.
    expect(
      resolveAiReferenceLines(
        source,
        blocks,
        caret(point(0, [step('item', 1, 4), step('paragraph', 0, 1)], { index: 0, count: 1 }))
      )
    ).toEqual({ startLine: 1, endLine: 3 });

    // The item is proven, its child is not: the item's own line is used.
    expect(
      resolveAiReferenceLines(
        source,
        blocks,
        caret(point(0, [step('item', 2, 3), step('code', 0, 1)], { index: 0, count: 1 }))
      )
    ).toEqual({ startLine: 3, endLine: 3 });
  });

  it('returns lines inside blockquotes and GitHub alerts', () => {
    const source = [
      '> quoted one',
      '> quoted two',
      '>',
      '> second paragraph',
      '',
      '> [!NOTE]',
      '> alert line one',
      '> alert line two',
      '',
    ].join('\n');
    const blocks = [
      block(0, 'blockquote', '> quoted one\n> quoted two\n>\n> second paragraph'),
      block(1, 'alert', '> [!NOTE]\n> alert line one\n> alert line two'),
    ];

    expect(
      resolveAiReferenceLines(
        source,
        blocks,
        caret(point(0, [step('paragraph', 0, 2)], { index: 1, count: 2 }))
      )
    ).toEqual({ startLine: 2, endLine: 2 });
    expect(
      resolveAiReferenceLines(
        source,
        blocks,
        caret(point(0, [step('paragraph', 1, 2)], { index: 0, count: 1 }))
      )
    ).toEqual({ startLine: 4, endLine: 4 });
    expect(
      resolveAiReferenceLines(
        source,
        blocks,
        caret(point(1, [step('paragraph', 0, 1)], { index: 1, count: 2 }))
      )
    ).toEqual({ startLine: 8, endLine: 8 });
  });

  it('returns frontmatter lines from the file, not from the wrapped view', () => {
    const source = '---\ntitle: Doc\ntags: [a]\n---\n\n# Heading\n\nBody\n';
    const blocks = [
      block(0, 'code', '```yaml\n---\ntitle: Doc\ntags: [a]\n---\n```'),
      block(1, 'heading', '# Heading'),
      block(2, 'paragraph', 'Body'),
    ];

    expect(
      resolveAiReferenceLines(source, blocks, caret(point(0, [], { index: 1, count: 4 })))
    ).toEqual({ startLine: 2, endLine: 2 });
    expect(resolveAiReferenceLines(source, blocks, caret(point(1)))).toEqual({
      startLine: 6,
      endLine: 6,
    });
    expect(resolveAiReferenceLines(source, blocks, { start: point(0), end: point(2) })).toEqual({
      startLine: 1,
      endLine: 8,
    });
  });

  it('counts blank-line runs from the file and maps a caret on a blank line', () => {
    const source = 'First\n\n\n\nSecond\n\nThird\n';
    // Ordinals 1 and 2 are the empty paragraphs the editor shows for the two extra blank lines.
    const blocks = [
      block(0, 'paragraph', 'First'),
      block(3, 'paragraph', 'Second'),
      block(4, 'paragraph', 'Third'),
    ];

    expect(resolveAiReferenceLines(source, blocks, caret(point(3)))).toEqual({
      startLine: 5,
      endLine: 5,
    });
    expect(resolveAiReferenceLines(source, blocks, caret(point(4)))).toEqual({
      startLine: 7,
      endLine: 7,
    });
    expect(resolveAiReferenceLines(source, blocks, caret(point(1)))).toEqual({
      startLine: 3,
      endLine: 3,
    });
    expect(resolveAiReferenceLines(source, blocks, caret(point(2)))).toEqual({
      startLine: 4,
      endLine: 4,
    });
  });

  it('gives the blank gap when the empty paragraphs do not match the file layout', () => {
    const source = 'First\n\n\n\n\nSecond\n';
    const blocks = [block(0, 'paragraph', 'First'), block(2, 'paragraph', 'Second')];

    expect(resolveAiReferenceLines(source, blocks, caret(point(1)))).toEqual({
      startLine: 2,
      endLine: 5,
    });
  });

  it('anchors a document that ends with link reference definitions', () => {
    // The editor shows the definitions as a marker block; markdown-it gives
    // them no block at all, which used to leave the whole document unmatched.
    const source = [
      '# Changelog',
      '',
      'See [the release][0.4.3].',
      '',
      '[0.4.3]: https://example.com/0.4.3',
      '[0.4.2]: https://example.com/0.4.2',
      '',
    ].join('\n');
    const definitions = '[0.4.3]: https://example.com/0.4.3\n[0.4.2]: https://example.com/0.4.2';
    const blocks = [
      block(0, 'heading', '# Changelog'),
      block(1, 'paragraph', 'See [the release][0.4.3].'),
      block(2, 'html', definitions),
    ];

    expect(resolveAiReferenceLines(source, blocks, caret(point(1)))).toEqual({
      startLine: 3,
      endLine: 3,
    });
    expect(resolveAiReferenceLines(source, blocks, caret(point(2)))).toEqual({
      startLine: 5,
      endLine: 6,
    });
    expect(
      resolveAiReferenceLines(source, blocks, caret(point(2, [], { index: 1, count: 2 })))
    ).toEqual({ startLine: 6, endLine: 6 });
    // The marker block's text must be exactly what the file has there.
    expect(
      resolveAiReferenceLines(
        source,
        [...blocks.slice(0, 2), block(2, 'html', '[0.4.3]: https://example.com/other')],
        caret(point(2))
      )
    ).toBeNull();
  });

  it('spans from the first to the last block of a multi-block selection', () => {
    const source = '# Title\n\nPara one\nwrapped\n\n- a\n- b\n\nEnd\n';
    const blocks = [
      block(0, 'heading', '# Title'),
      block(1, 'paragraph', 'Para one\nwrapped'),
      block(2, 'list', '- a\n- b'),
      block(3, 'paragraph', 'End'),
    ];

    expect(
      resolveAiReferenceLines(source, blocks, {
        start: point(1, [], { index: 1, count: 2 }),
        end: point(2, [step('item', 0, 2), step('paragraph', 0, 1)], { index: 0, count: 1 }),
      })
    ).toEqual({ startLine: 4, endLine: 6 });
  });

  it('reads the same lines from a CRLF file', () => {
    const source = '# Title\r\n\r\nline one\r\nline two\r\n\r\n| a |\r\n| - |\r\n| 1 |\r\n';
    const blocks = [
      block(0, 'heading', '# Title'),
      block(1, 'paragraph', 'line one\nline two'),
      block(2, 'table', '| a |\n| - |\n| 1 |'),
    ];

    expect(
      resolveAiReferenceLines(source, blocks, caret(point(1, [], { index: 1, count: 2 })))
    ).toEqual({ startLine: 4, endLine: 4 });
    expect(resolveAiReferenceLines(source, blocks, caret(point(2, [step('row', 1, 2)])))).toEqual({
      startLine: 8,
      endLine: 8,
    });
  });

  it('returns null instead of a guess when the view and the file disagree', () => {
    const source = 'One\n\nTwo\n\nThree\n';

    // Block count differs: the document cannot be matched at all.
    expect(
      resolveAiReferenceLines(
        source,
        [block(0, 'paragraph', 'One'), block(1, 'paragraph', 'Two')],
        caret(point(1))
      )
    ).toBeNull();

    // Same shape, different words in the touched block: stale view.
    expect(
      resolveAiReferenceLines(
        source,
        [
          block(0, 'paragraph', 'One'),
          block(1, 'paragraph', 'Something else'),
          block(2, 'paragraph', 'Three'),
        ],
        caret(point(1))
      )
    ).toBeNull();

    // An ordinal past the end of the document.
    expect(
      resolveAiReferenceLines(
        source,
        [
          block(0, 'paragraph', 'One'),
          block(1, 'paragraph', 'Two'),
          block(2, 'paragraph', 'Three'),
        ],
        caret(point(9))
      )
    ).toBeNull();
  });

  it('resolves a table row near the end of a 10,000-line document', () => {
    const lines: string[] = [];
    const blocks: CanonicalFeedbackBlock[] = [];
    let ordinal = 0;
    while (lines.length < 9_990) {
      const text = `Paragraph number ${ordinal} with some ordinary words.`;
      lines.push(text, `It continues on a second line ${ordinal}.`, '');
      blocks.push(
        block(ordinal, 'paragraph', `${text}\nIt continues on a second line ${ordinal}.`)
      );
      ordinal += 1;
    }
    const tableStart = lines.length + 1;
    const table = ['| key | value |', '| --- | --- |', '| a | 1 |', '| b | 2 |'];
    lines.push(...table, '');
    blocks.push(block(ordinal, 'table', table.join('\n')));

    expect(lines.length).toBeGreaterThanOrEqual(9_995);
    expect(
      resolveAiReferenceLines(lines.join('\n'), blocks, caret(point(ordinal, [step('row', 2, 3)])))
    ).toEqual({ startLine: tableStart + 3, endLine: tableStart + 3 });
    expect(
      resolveAiReferenceLines(lines.join('\n'), blocks, {
        start: point(0, [], { index: 1, count: 2 }),
        end: point(ordinal - 1, [], { index: 0, count: 2 }),
      })
    ).toEqual({ startLine: 2, endLine: tableStart - 3 });
  });
});

describe('formatAiReference', () => {
  it('writes a range, a single line, and a bare path', () => {
    expect(formatAiReference('bom/README.md', { startLine: 10, endLine: 14 })).toBe(
      '@bom/README.md#L10-14'
    );
    expect(formatAiReference('bom/README.md', { startLine: 7, endLine: 7 })).toBe(
      '@bom/README.md#L7'
    );
    expect(formatAiReference('bom/README.md', null)).toBe('@bom/README.md');
  });

  it('quotes a path with spaces, the form Claude Code reads as one mention', () => {
    expect(formatAiReference('release notes/v1 draft.md', { startLine: 3, endLine: 5 })).toBe(
      '@"release notes/v1 draft.md#L3-5"'
    );
    expect(formatAiReference('release notes/v1 draft.md', null)).toBe(
      '@"release notes/v1 draft.md"'
    );
  });
});

describe('aiReferencePath', () => {
  it('is relative to the workspace folder with forward slashes', () => {
    expect(aiReferencePath('/home/me/proj/bom/README.md', '/home/me/proj')).toBe('bom/README.md');
    expect(aiReferencePath('/home/me/proj/README.md', '/home/me/proj/')).toBe('README.md');
  });

  it('converts Windows separators and ignores drive letter case', () => {
    expect(aiReferencePath('C:\\Users\\me\\proj\\docs\\Guide.md', 'c:\\Users\\me\\proj')).toBe(
      'docs/Guide.md'
    );
  });

  it('keeps spaces in file and folder names as they are', () => {
    expect(aiReferencePath('/home/me/my proj/release notes/v1 draft.md', '/home/me/my proj')).toBe(
      'release notes/v1 draft.md'
    );
  });

  it('falls back to the absolute path outside any workspace folder', () => {
    expect(aiReferencePath('/home/me/notes/todo.md')).toBe('/home/me/notes/todo.md');
    expect(aiReferencePath('D:\\notes\\todo.md')).toBe('D:/notes/todo.md');
    expect(aiReferencePath('/home/me/project-two/a.md', '/home/me/project')).toBe(
      '/home/me/project-two/a.md'
    );
  });
});
