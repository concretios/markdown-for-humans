/** @jest-environment jsdom */

/**
 * Copy Reference for AI, end to end without VS Code: a real editor selection is
 * described by the webview code and resolved by the host code against the
 * Markdown source, and must name the exact source lines.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Editor } from '@tiptap/core';
import CodeBlock from '@tiptap/extension-code-block';
import { ListKit } from '@tiptap/extension-list';
import { TableCell, TableHeader, TableRow } from '@tiptap/extension-table';
import { Markdown } from '@tiptap/markdown';
import { NodeSelection } from '@tiptap/pm/state';
import StarterKit from '@tiptap/starter-kit';
import { resolveAiReferenceLines } from '../../editor/aiReference';
import { BlankLinePreservation } from '../../webview/extensions/blankLinePreservation';
import { CustomImage } from '../../webview/extensions/customImage';
import { GitHubAlerts } from '../../webview/extensions/githubAlerts';
import { HtmlComment, HtmlCommentInline } from '../../webview/extensions/htmlComment';
import { HtmlPreservingTable } from '../../webview/extensions/htmlPreservingTable';
import { MarkdownCode, MarkdownLink } from '../../webview/extensions/markdownCompatibilityMarks';
import { MarkdownListItem } from '../../webview/extensions/markdownListItem';
import { MarkdownParagraph } from '../../webview/extensions/markdownParagraph';
import { OrderedListMarkdownFix } from '../../webview/extensions/orderedListMarkdownFix';
import {
  parsePreservedCodeBlock,
  renderPreservedCodeBlock,
} from '../../webview/extensions/preservedCodeBlock';
import { PreservedMarkdownLiteral } from '../../webview/extensions/preservedMarkdownLiteral';
import { describeAiReferenceSelection } from '../../webview/features/aiReferenceSelection';
import { enumerateCanonicalFeedbackBlocks } from '../../webview/features/feedbackReview';
import { installBlankLineLexerNormalizer } from '../../webview/utils/markedLexerNormalizer';
import { setMarkdownContentPreservingSource } from '../../webview/utils/markdownSerialization';

const PreservedCodeBlock = CodeBlock.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      'indent-prefix': { default: null },
      'fence-marker': { default: null },
    };
  },
  parseMarkdown: parsePreservedCodeBlock,
  renderMarkdown: renderPreservedCodeBlock,
});

function createEditor(webviewMarkdown: string): Editor {
  const element = document.createElement('div');
  document.body.appendChild(element);
  const editor = new Editor({
    element,
    extensions: [
      GitHubAlerts,
      StarterKit.configure({
        paragraph: false,
        code: false,
        codeBlock: false,
        bulletList: false,
        orderedList: false,
        listItem: false,
        listKeymap: false,
        link: false,
      }),
      MarkdownParagraph,
      HtmlComment,
      HtmlCommentInline,
      MarkdownCode,
      PreservedMarkdownLiteral,
      PreservedCodeBlock,
      BlankLinePreservation,
      Markdown.configure({ markedOptions: { gfm: true, breaks: true } }),
      HtmlPreservingTable,
      TableRow,
      TableHeader,
      TableCell,
      ListKit.configure({ listItem: false, orderedList: false, taskItem: { nested: true } }),
      MarkdownListItem,
      OrderedListMarkdownFix,
      MarkdownLink.configure({ openOnClick: false }),
      CustomImage,
    ],
    content: '',
    contentType: 'markdown',
  });
  const storage = editor as unknown as {
    markdown?: { instance?: unknown };
    storage?: { markdown?: { instance?: unknown } };
  };
  const markedInstance = storage.markdown?.instance ?? storage.storage?.markdown?.instance;
  if (markedInstance) installBlankLineLexerNormalizer(markedInstance);
  setMarkdownContentPreservingSource(editor, webviewMarkdown);
  return editor;
}

/** What the host sends the webview: leading YAML frontmatter inside a yaml fence. */
function wrapFrontmatter(source: string): string {
  const match = source.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n/);
  if (!match) return source;
  const newline = match[0].includes('\r\n') ? '\r\n' : '\n';
  const body = source.slice(match[0].length).replace(/^\r?\n/, '');
  return ['```yaml', match[0].trimEnd(), '```', '', body].join(newline);
}

const SOURCE = [
  '---', // 1
  'title: Demo', // 2
  'owner: docs', // 3
  '---', // 4
  '', // 5
  '# Bill of materials', // 6
  '', // 7
  'First paragraph line one', // 8
  'continues on line two', // 9
  'and ends on line three.', // 10
  '', // 11
  '', // 12
  'After two blank lines.', // 13
  '', // 14
  '- top one', // 15
  '  - nested alpha', // 16
  '  - nested beta', // 17
  '    beta continues', // 18
  '- top two', // 19
  '', // 20
  '1. ordered first', // 21
  '2. ordered second', // 22
  '', // 23
  'Tasks:', // 24
  '', // 25
  '- [ ] open task', // 26
  '- [x] done task', // 27
  '', // 28
  '> quote first line', // 29
  '> quote second line', // 30
  '', // 31
  '> [!NOTE]', // 32
  '> alert first line', // 33
  '> alert second line', // 34
  '', // 35
  '| Part | Qty |', // 36
  '| ---- | --- |', // 37
  '| Bolt | 4 |', // 38
  '| Nut | 8 |', // 39
  '|  | 2 |', // 40
  '', // 41
  '```js', // 42
  'const first = 1;', // 43
  '', // 44
  'const third = 3;', // 45
  '```', // 46
  '', // 47
  'Closing paragraph.', // 48
  '',
].join('\n');

function lineOf(source: string, needle: string): number {
  const index = source.split(/\r?\n/).findIndex(line => line.includes(needle));
  if (index < 0) throw new Error(`No source line contains ${JSON.stringify(needle)}`);
  return index + 1;
}

/** Document position of the first character of `needle` in the rendered text. */
function positionOf(editor: Editor, needle: string): number {
  let found = -1;
  editor.state.doc.descendants((node, pos) => {
    if (found >= 0) return false;
    const index = node.isText ? (node.text ?? '').indexOf(needle) : -1;
    if (index >= 0) found = pos + index;
    return true;
  });
  if (found < 0) throw new Error(`The editor does not render ${JSON.stringify(needle)}`);
  return found;
}

function referenceLines(
  editor: Editor,
  source: string
): { startLine: number; endLine: number } | null {
  return resolveAiReferenceLines(
    source,
    enumerateCanonicalFeedbackBlocks(editor),
    describeAiReferenceSelection(editor.state)
  );
}

function select(editor: Editor, from: number, to = from): void {
  editor.commands.setTextSelection({ from, to });
}

describe('Copy Reference for AI on a real editor', () => {
  let editor: Editor;

  beforeEach(() => {
    editor = createEditor(wrapFrontmatter(SOURCE));
  });

  afterEach(() => {
    editor.destroy();
    document.body.replaceChildren();
  });

  it.each([
    'owner: docs',
    'Bill of materials',
    'First paragraph line one',
    'continues on line two',
    'and ends on line three',
    'After two blank lines',
    'top one',
    'nested alpha',
    'nested beta',
    'beta continues',
    'top two',
    'ordered second',
    'Tasks:',
    'open task',
    'done task',
    'quote first line',
    'quote second line',
    'alert first line',
    'alert second line',
    'Part',
    'Qty',
    'Bolt',
    'Nut',
    'const first',
    'const third',
    'Closing paragraph',
  ])('a caret in "%s" is that source line', needle => {
    select(editor, positionOf(editor, needle) + 2);
    const line = lineOf(SOURCE, needle);
    expect(referenceLines(editor, SOURCE)).toEqual({ startLine: line, endLine: line });
  });

  it('a caret on the empty line of a code block is that source line', () => {
    select(editor, positionOf(editor, 'const first') + 'const first = 1;\n'.length);
    expect(referenceLines(editor, SOURCE)).toEqual({ startLine: 44, endLine: 44 });
  });

  it('a caret in an empty table cell is that row', () => {
    let emptyCellParagraph = -1;
    editor.state.doc.descendants((node, pos) => {
      if (
        emptyCellParagraph < 0 &&
        node.type.name === 'tableCell' &&
        node.textContent === '' &&
        node.firstChild
      ) {
        emptyCellParagraph = pos + 2;
      }
      return true;
    });
    expect(emptyCellParagraph).toBeGreaterThan(0);
    select(editor, emptyCellParagraph);
    expect(referenceLines(editor, SOURCE)).toEqual({ startLine: 40, endLine: 40 });
  });

  it('a selection covers its first through last source line across blocks', () => {
    select(
      editor,
      positionOf(editor, 'continues on line two') + 3,
      positionOf(editor, 'nested alpha') + 4
    );
    expect(referenceLines(editor, SOURCE)).toEqual({ startLine: 9, endLine: 16 });
  });

  it('a selection inside a code block is the selected code lines, not the fences', () => {
    select(
      editor,
      positionOf(editor, 'const first'),
      positionOf(editor, 'const third') + 'const third = 3;'.length
    );
    expect(referenceLines(editor, SOURCE)).toEqual({ startLine: 43, endLine: 45 });
  });

  it('a code block selected as a whole includes its fences', () => {
    const $inside = editor.state.doc.resolve(positionOf(editor, 'const first'));
    editor.view.dispatch(
      editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, $inside.before()))
    );
    expect(referenceLines(editor, SOURCE)).toEqual({ startLine: 42, endLine: 46 });
  });

  it('a selection across table rows is those rows', () => {
    select(editor, positionOf(editor, 'Bolt') + 1, positionOf(editor, 'Nut') + 2);
    expect(referenceLines(editor, SOURCE)).toEqual({ startLine: 38, endLine: 39 });
  });

  it('a selection that ends at the start of the next block does not include it', () => {
    select(editor, positionOf(editor, 'quote first line'), positionOf(editor, 'alert first line'));
    expect(referenceLines(editor, SOURCE)).toEqual({ startLine: 29, endLine: 30 });
  });

  it('a selection that ends at the start of a paragraph line does not include that line', () => {
    select(
      editor,
      positionOf(editor, 'First paragraph line one'),
      positionOf(editor, 'continues on line two')
    );
    expect(referenceLines(editor, SOURCE)).toEqual({ startLine: 8, endLine: 8 });
  });

  it('select all covers the file from its first to its last content line', () => {
    editor.commands.selectAll();
    expect(referenceLines(editor, SOURCE)).toEqual({ startLine: 1, endLine: 48 });
  });
});

describe('Copy Reference for AI on other documents', () => {
  afterEach(() => document.body.replaceChildren());

  it('reads the same lines from a CRLF file', () => {
    const source = SOURCE.replace(/\n/g, '\r\n');
    const editor = createEditor(wrapFrontmatter(source));
    try {
      for (const needle of ['owner: docs', 'beta continues', 'Nut', 'const third']) {
        select(editor, positionOf(editor, needle) + 1);
        const line = lineOf(SOURCE, needle);
        expect(referenceLines(editor, source)).toEqual({ startLine: line, endLine: line });
      }
    } finally {
      editor.destroy();
    }
  });

  it('a caret on an extra blank line is the blank gap it belongs to', () => {
    // Three blank lines load as one empty paragraph, so the paragraph cannot be
    // pinned to one of them. The gap itself is exact.
    const source = 'First\n\n\n\nSecond\n';
    const editor = createEditor(source);
    try {
      let emptyParagraph = -1;
      editor.state.doc.forEach((node, offset) => {
        if (node.type.name === 'paragraph' && node.content.size === 0) emptyParagraph = offset + 1;
      });
      expect(emptyParagraph).toBeGreaterThan(0);
      select(editor, emptyParagraph);
      expect(referenceLines(editor, source)).toEqual({ startLine: 2, endLine: 4 });

      select(editor, positionOf(editor, 'Second') + 1);
      expect(referenceLines(editor, source)).toEqual({ startLine: 5, endLine: 5 });
    } finally {
      editor.destroy();
    }
  });

  it('gives no line numbers for a document that cannot be matched to its source', () => {
    // A list mixing plain and task items renders as two lists but is one list
    // in the source, a shape the anchor map refuses.
    const source = 'Intro\n\n- plain item\n- [ ] task item\n';
    const editor = createEditor(source);
    try {
      select(editor, positionOf(editor, 'Intro') + 1);
      expect(referenceLines(editor, source)).toBeNull();
    } finally {
      editor.destroy();
    }
  });

  it('finds a table row at the end of a 10,000-line document', () => {
    const lines: string[] = [];
    for (let index = 0; lines.length < 9_990; index += 1) {
      lines.push(
        `## Section ${index}`,
        '',
        `Paragraph ${index} first line`,
        `second line ${index}`,
        ''
      );
    }
    const firstTableLine = lines.length + 1;
    lines.push('| key | value |', '| --- | --- |', '| alpha | 1 |', '| omega | 2 |', '');
    const source = lines.join('\n');
    const editor = createEditor(source);
    try {
      select(editor, positionOf(editor, 'omega') + 1);
      const started = Date.now();
      const result = referenceLines(editor, source);
      console.log(`[MD4H] 10,000-line reference resolved in ${Date.now() - started} ms`);
      expect(result).toEqual({ startLine: firstTableLine + 3, endLine: firstTableLine + 3 });

      select(editor, positionOf(editor, 'second line 1000') + 3);
      const line = lineOf(source, 'second line 1000');
      expect(referenceLines(editor, source)).toEqual({ startLine: line, endLine: line });
    } finally {
      editor.destroy();
    }
  }, 120_000);
});

describe("Copy Reference for AI on this repository's documents", () => {
  afterEach(() => document.body.replaceChildren());

  // Tables, nested lists, alerts, code, images, HTML and link reference
  // definitions as people really write them. A caret placed inside a word must
  // resolve to a source line containing that word, or to no line at all.
  it.each(['README.md', 'CHANGELOG.md', 'docs/FEEDBACK.md', 'docs/QA_MANUAL.md'])(
    'never names a wrong line in %s',
    file => {
      const source = readFileSync(resolve(__dirname, '../../..', file), 'utf8');
      const sourceLines = source.split(/\r?\n/);
      const editor = createEditor(wrapFrontmatter(source));
      try {
        const blocks = enumerateCanonicalFeedbackBlocks(editor);
        const probes: Array<{ word: string; position: number }> = [];
        editor.state.doc.descendants((node, pos) => {
          const words = node.isText ? (node.text ?? '').matchAll(/[A-Za-z0-9]{7,}/g) : [];
          for (const match of [...words].slice(0, 3)) {
            probes.push({ word: match[0], position: pos + (match.index ?? 0) + 3 });
          }
          return true;
        });

        const wrong: string[] = [];
        let exact = 0;
        for (const { word, position } of probes) {
          select(editor, position);
          const range = resolveAiReferenceLines(
            source,
            blocks,
            describeAiReferenceSelection(editor.state)
          );
          if (!range) continue;
          const named = sourceLines.slice(range.startLine - 1, range.endLine);
          if (!named.some(line => line.includes(word))) {
            wrong.push(`${word} -> L${range.startLine}-${range.endLine}`);
          } else if (range.startLine === range.endLine) {
            exact += 1;
          }
        }

        expect(probes.length).toBeGreaterThan(100);
        expect(wrong).toEqual([]);
        expect(exact / probes.length).toBeGreaterThan(0.95);
      } finally {
        editor.destroy();
      }
    },
    120_000
  );
});

describe('Copy Reference for AI on a complex self-numbering document', () => {
  afterEach(() => document.body.replaceChildren());

  // Every text line of the fixture carries its own source line as "(L<n>)" at
  // both ends, so the expected line of any caret is read from the rendered
  // text itself. Nested lists three deep, loose lists, code and quotes inside
  // list items, alerts, tables with formatting, fences of every kind, breaks,
  // blank-line runs and link definitions are all in it.
  const source = readFileSync(resolve(__dirname, '../fixtures/aiReferenceComplex.md'), 'utf8');

  it('keeps the fixture honest: each (L<n>) token sits on line n', () => {
    source.split('\n').forEach((line, index) => {
      for (const token of line.matchAll(/\(L(\d+)\)/g)) expect(Number(token[1])).toBe(index + 1);
    });
  });

  /** The line the rendered text at a position says it is on, or null when it does not say. */
  function statedLine(editor: Editor, position: number): number | null {
    const $position = editor.state.doc.resolve(position);
    const parent = $position.parent;
    if (!parent.isTextblock) return null;

    let text = '';
    for (let depth = $position.depth; depth > 0; depth -= 1) {
      if ($position.node(depth).type.name === 'tableRow') text = $position.node(depth).textContent;
    }
    if (text === '') {
      // The rendered line around the caret: text between hard breaks or newlines.
      const lines = [''];
      let caretLine = 0;
      parent.forEach((child, offset) => {
        const pieces = child.type.name === 'hardBreak' ? ['', ''] : (child.text ?? '').split('\n');
        let at = offset;
        pieces.forEach((piece, index) => {
          if (index > 0) {
            lines.push('');
            at += 1;
          }
          lines[lines.length - 1] += piece;
          if (at <= $position.parentOffset) caretLine = lines.length - 1;
          at += piece.length;
        });
      });
      text = lines[caretLine];
    }

    const stated = new Set([...text.matchAll(/\(L(\d+)\)/g)].map(match => Number(match[1])));
    return stated.size === 1 ? [...stated][0] : null;
  }

  it('names the stated line at every caret position, or a range that contains it', () => {
    const editor = createEditor(wrapFrontmatter(source));
    try {
      const blocks = enumerateCanonicalFeedbackBlocks(editor);
      const wrong: string[] = [];
      let checked = 0;
      let exact = 0;

      for (let position = 1; position < editor.state.doc.content.size; position += 1) {
        const expected = statedLine(editor, position);
        if (expected === null) continue;
        checked += 1;
        select(editor, position);
        const range = resolveAiReferenceLines(
          source,
          blocks,
          describeAiReferenceSelection(editor.state)
        );
        if (!range) continue;
        if (range.startLine === expected && range.endLine === expected) exact += 1;
        else if (expected < range.startLine || expected > range.endLine) {
          wrong.push(`L${expected} -> L${range.startLine}-${range.endLine}`);
        }
      }

      expect(checked).toBeGreaterThan(3000);
      expect([...new Set(wrong)]).toEqual([]);
      // The one line this harness cannot verify has inline HTML, whose editor
      // extension is not loaded here; it resolves to no line, never a wrong one.
      expect(exact / checked).toBeGreaterThan(0.95);
    } finally {
      editor.destroy();
    }
  }, 180_000);
});
