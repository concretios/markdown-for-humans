/**
 * Tests for aiContextReference - Copy current selection as @file#lines reference
 *
 * The mapping function returns the line range (in the saved markdown file) that
 * corresponds to the top-level blocks containing the current TipTap selection.
 */

import type { Editor } from '@tiptap/core';
import {
  countLines,
  formatAiContextRef,
  findContainingBlockIndex,
  getSelectionBlockRange,
  copyAiContextReference,
  type SelectionBlockRange,
} from '../../webview/utils/aiContextReference';

describe('countLines', () => {
  it('returns 0 for empty string', () => {
    expect(countLines('')).toBe(0);
  });

  it('returns 1 for a single line without trailing newline', () => {
    expect(countLines('abc')).toBe(1);
  });

  it('returns 1 for a single line with trailing newline', () => {
    expect(countLines('abc\n')).toBe(1);
  });

  it('returns 2 for two lines without trailing newline', () => {
    expect(countLines('a\nb')).toBe(2);
  });

  it('returns 2 for two lines with trailing newline', () => {
    expect(countLines('a\nb\n')).toBe(2);
  });

  it('returns 3 for three lines', () => {
    expect(countLines('a\nb\nc')).toBe(3);
  });

  it('counts blank lines correctly', () => {
    // "a\n\nb" is "a", "", "b" — 3 lines
    expect(countLines('a\n\nb')).toBe(3);
  });
});

describe('formatAiContextRef', () => {
  it('formats a single-line reference as #N (no range)', () => {
    expect(formatAiContextRef('src/foo.md', 42, 42)).toBe('@src/foo.md#42');
  });

  it('formats a multi-line range as #N-M', () => {
    expect(formatAiContextRef('src/foo.md', 42, 58)).toBe('@src/foo.md#42-58');
  });

  it('preserves nested workspace-relative paths', () => {
    expect(formatAiContextRef('docs/guide/intro.md', 1, 10)).toBe('@docs/guide/intro.md#1-10');
  });

  it('does not collapse a true range when start === end - 0 (sanity)', () => {
    expect(formatAiContextRef('a.md', 5, 6)).toBe('@a.md#5-6');
  });

  it('omits the #N suffix entirely when no line numbers are supplied', () => {
    expect(formatAiContextRef('src/foo.md')).toBe('@src/foo.md');
  });

  it('omits the #N suffix when only startLine is supplied', () => {
    // Partial line info is not a valid reference — fall back to bare path.
    expect(formatAiContextRef('src/foo.md', 42)).toBe('@src/foo.md');
  });
});

describe('findContainingBlockIndex', () => {
  const blocks = [
    { from: 1, to: 6 }, // block 0
    { from: 6, to: 13 }, // block 1
    { from: 13, to: 21 }, // block 2
  ];

  it('finds the first block', () => {
    expect(findContainingBlockIndex(blocks, 3)).toBe(0);
  });

  it('finds the middle block', () => {
    expect(findContainingBlockIndex(blocks, 9)).toBe(1);
  });

  it('finds the last block', () => {
    expect(findContainingBlockIndex(blocks, 18)).toBe(2);
  });

  it('treats a position exactly at a block boundary as the next block', () => {
    // pos == 6 is end-of-block-0 / start-of-block-1; should belong to block 1
    expect(findContainingBlockIndex(blocks, 6)).toBe(1);
  });

  it('clamps a position past the last block to the last block (gap cursor case)', () => {
    expect(findContainingBlockIndex(blocks, 999)).toBe(2);
  });

  it('returns -1 for an empty block list', () => {
    expect(findContainingBlockIndex([], 5)).toBe(-1);
  });
});

// Build a minimal stub editor that mimics the bits getSelectionBlockRange touches.
// We intentionally avoid pulling in real TipTap because:
//   - we are unit-testing the position->line math, not TipTap itself;
//   - the existing repo pattern (see copyMarkdown.test.ts) explicitly skips real-editor
//     integration tests for this layer.
type StubBlockNode = {
  typeName: string;
  nodeSize: number;
  text?: string; // for empty-paragraph detection
};

function buildStubEditor(opts: {
  blocks: StubBlockNode[];
  selection: { from: number; to: number; empty: boolean };
  // serialize(json) returns the string the on-disk file would contain
  serialize: (json: { type: string; content: unknown[] }) => string;
  jsonContent?: unknown[]; // if omitted, derived from blocks.text
}) {
  const jsonContent =
    opts.jsonContent ??
    opts.blocks.map(b => {
      if (b.typeName === 'paragraph') {
        const text = b.text ?? '';
        return text.length === 0
          ? { type: 'paragraph' }
          : { type: 'paragraph', content: [{ type: 'text', text }] };
      }
      return { type: b.typeName, content: [{ type: 'text', text: b.text ?? '' }] };
    });

  const fragment = {
    forEach(cb: (node: unknown, offset: number, idx: number) => void) {
      let offset = 0;
      opts.blocks.forEach((b, idx) => {
        const node = {
          type: { name: b.typeName },
          nodeSize: b.nodeSize,
          content: {
            size: (b.text ?? '').length,
            forEach(childCb: (child: unknown) => void) {
              const t = b.text ?? '';
              if (t.length > 0) childCb({ type: { name: 'text' }, text: t });
            },
          },
        };
        cb(node, offset, idx);
        offset += b.nodeSize;
      });
    },
  };

  return {
    state: {
      selection: opts.selection,
      doc: { content: fragment },
    },
    getJSON: () => ({ type: 'doc', content: jsonContent }),
    markdown: { serialize: opts.serialize },
  };
}

describe('getSelectionBlockRange', () => {
  it.each([
    ['standard wrapper', '```yaml\n---\ntitle: Test\n---\n```', 5],
    ['long wrapper with embedded fence', '````yaml\n---\nexample: |\n  ```\n---\n````', 6],
    ['uppercase CRLF wrapper', '````YML\r\n---\r\ntitle: Test\r\n---\r\n````', 5],
    ['ordinary YAML code', '```yaml\ntitle: Test\n```', 5],
    ['mismatched closing fence', '````yaml\n---\ntitle: Test\n---\n```', 7],
  ])('maps the following heading for %s using the host unwrap contract', (_name, wrapped, line) => {
    const editor = buildStubEditor({
      blocks: [
        { typeName: 'codeBlock', text: 'frontmatter', nodeSize: 12 },
        { typeName: 'heading', text: 'Heading', nodeSize: 9 },
      ],
      selection: { from: 14, to: 14, empty: true },
      serialize: json => {
        const node = json.content[0] as { type: string };
        return node.type === 'codeBlock' ? wrapped : '# Heading';
      },
    });
    expect(getSelectionBlockRange(editor as unknown as Editor)).toEqual({
      startLine: line,
      endLine: line,
    });
  });

  it('returns null for an empty document', () => {
    const editor = buildStubEditor({
      blocks: [],
      selection: { from: 0, to: 0, empty: true },
      serialize: () => '',
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(getSelectionBlockRange(editor as any)).toBeNull();
  });

  it('returns null when the markdown serializer is unavailable', () => {
    const editor = {
      state: {
        selection: { from: 1, to: 1, empty: true },
        doc: { content: { forEach: () => {} } },
      },
      getJSON: () => ({ type: 'doc', content: [{ type: 'paragraph' }] }),
      // no markdown manager
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(getSelectionBlockRange(editor as any)).toBeNull();
  });

  it('returns #1 for a cursor inside the first paragraph of a single-paragraph doc', () => {
    // Doc serializes to "Hello world\n" — 1 line.
    const editor = buildStubEditor({
      blocks: [{ typeName: 'paragraph', text: 'Hello world', nodeSize: 13 }],
      selection: { from: 4, to: 4, empty: true },
      serialize: json => (json.content.length === 0 ? '' : 'Hello world\n'),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(getSelectionBlockRange(editor as any)).toEqual({ startLine: 1, endLine: 1 });
  });

  it('returns the line range for a selection spanning paragraph 1 to paragraph 2', () => {
    // Three paragraphs. Markdown form (paragraph + blank + paragraph + blank + paragraph + final \n):
    //   line 1: "First paragraph"
    //   line 2: ""
    //   line 3: "Second paragraph"
    //   line 4: ""
    //   line 5: "Third"
    //   (trailing newline)
    // Selection covers blocks 0 and 1 -> startLine 1, endLine 3.
    const blocks = [
      { typeName: 'paragraph', text: 'First paragraph', nodeSize: 17 },
      { typeName: 'paragraph', text: 'Second paragraph', nodeSize: 18 },
      { typeName: 'paragraph', text: 'Third', nodeSize: 7 },
    ];
    const editor = buildStubEditor({
      blocks,
      // selection starts mid-block-0, ends mid-block-1
      selection: { from: 5, to: 25, empty: false },
      serialize: json => {
        // Render each paragraph as text, separated by blank lines, with trailing \n.
        const texts = (json.content as Array<{ content?: Array<{ text: string }> }>).map(
          p => p.content?.[0]?.text ?? ''
        );
        return texts.length === 0 ? '' : texts.join('\n\n') + '\n';
      },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(getSelectionBlockRange(editor as any)).toEqual({ startLine: 1, endLine: 3 });
  });

  it('returns the correct range when the selection is entirely inside the third block', () => {
    // Same three paragraphs as above.
    // Block 2 spans lines 5..5.
    const blocks = [
      { typeName: 'paragraph', text: 'First paragraph', nodeSize: 17 },
      { typeName: 'paragraph', text: 'Second paragraph', nodeSize: 18 },
      { typeName: 'paragraph', text: 'Third', nodeSize: 7 },
    ];
    const editor = buildStubEditor({
      blocks,
      selection: { from: 36, to: 38, empty: false }, // inside block 2
      serialize: json => {
        const texts = (json.content as Array<{ content?: Array<{ text: string }> }>).map(
          p => p.content?.[0]?.text ?? ''
        );
        return texts.length === 0 ? '' : texts.join('\n\n') + '\n';
      },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(getSelectionBlockRange(editor as any)).toEqual({ startLine: 5, endLine: 5 });
  });

  it('returns the full block range when the cursor (empty selection) sits on a multi-line code block', () => {
    // Doc is a single fenced code block of three content lines:
    //   line 1: "```js"
    //   line 2: "const x = 1;"
    //   line 3: "const y = 2;"
    //   line 4: "```"
    //   (trailing newline)
    const blocks = [{ typeName: 'codeBlock', text: 'const x = 1;\nconst y = 2;', nodeSize: 27 }];
    const editor = buildStubEditor({
      blocks,
      selection: { from: 5, to: 5, empty: true },
      serialize: json =>
        json.content.length === 0 ? '' : '```js\nconst x = 1;\nconst y = 2;\n```\n',
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(getSelectionBlockRange(editor as any)).toEqual({ startLine: 1, endLine: 4 });
  });

  it('counts empty paragraphs between content blocks as blank lines', () => {
    // Reproduces the "Copy as AI Context" off-by-N bug: with two empty
    // paragraphs sitting between paragraphs A and B, the saved file has
    //   line 1: "A"
    //   line 2: ""
    //   line 3: ""
    //   line 4: ""
    //   line 5: "B"
    // because getEditorMarkdownForSync turns each middle empty paragraph
    // into one extra `\n` on top of the standard `\n\n` block separator.
    // Cursor inside B should report line 5, not line 3.
    const blocks = [
      { typeName: 'paragraph', text: 'A', nodeSize: 3 }, // PM positions 1..4
      { typeName: 'paragraph', text: '', nodeSize: 2 }, // 4..6
      { typeName: 'paragraph', text: '', nodeSize: 2 }, // 6..8
      { typeName: 'paragraph', text: 'B', nodeSize: 3 }, // 8..11
    ];
    // Mimic getEditorMarkdownForSync: drop leading/trailing empty paragraphs,
    // keep middle ones as one extra `\n` per empty paragraph.
    const serialize = (json: { type: string; content: unknown[] }) => {
      const items = json.content as Array<{ type: string; content?: Array<{ text: string }> }>;
      const isEmpty = (n: { type: string; content?: Array<{ text: string }> }) =>
        n.type === 'paragraph' &&
        (!n.content || n.content.length === 0 || (n.content[0]?.text ?? '').trim() === '');
      let s = 0;
      while (s < items.length && isEmpty(items[s])) s++;
      let e = items.length;
      while (e > s && isEmpty(items[e - 1])) e--;
      if (s >= e) return '';
      let result = '';
      let pendingBlanks = 0;
      for (let i = s; i < e; i++) {
        const n = items[i];
        if (isEmpty(n)) {
          pendingBlanks++;
          continue;
        }
        const text = n.content?.[0]?.text ?? '';
        if (result !== '') result += '\n\n' + '\n'.repeat(pendingBlanks);
        result += text;
        pendingBlanks = 0;
      }
      return result + '\n';
    };
    const editor = buildStubEditor({
      blocks,
      selection: { from: 9, to: 9, empty: true }, // inside block 3 ("B")
      serialize,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(getSelectionBlockRange(editor as any)).toEqual({ startLine: 5, endLine: 5 });
  });

  it('ignores extra blank paragraphs in strip mode', () => {
    const blocks = [
      { typeName: 'paragraph', text: 'A', nodeSize: 3 },
      { typeName: 'paragraph', text: '', nodeSize: 2 },
      { typeName: 'paragraph', text: '', nodeSize: 2 },
      { typeName: 'paragraph', text: 'B', nodeSize: 3 },
    ];
    const serialize = (json: { type: string; content: unknown[] }) => {
      const items = json.content as Array<{ type: string; content?: Array<{ text: string }> }>;
      const isEmpty = (n: { type: string; content?: Array<{ text: string }> }) =>
        n.type === 'paragraph' &&
        (!n.content || n.content.length === 0 || (n.content[0]?.text ?? '').trim() === '');
      let s = 0;
      while (s < items.length && isEmpty(items[s])) s++;
      let e = items.length;
      while (e > s && isEmpty(items[e - 1])) e--;
      if (s >= e) return '';
      let result = '';
      for (let i = s; i < e; i++) {
        const n = items[i];
        if (isEmpty(n)) continue;
        const text = n.content?.[0]?.text ?? '';
        if (result !== '') result += '\n\n';
        result += text;
      }
      return result + '\n';
    };
    const editor = buildStubEditor({
      blocks,
      selection: { from: 9, to: 9, empty: true },
      serialize,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(getSelectionBlockRange(editor as any, 'strip')).toEqual({ startLine: 3, endLine: 3 });
  });

  it('skips empty leading paragraphs when computing the start line', () => {
    // The editor has an empty paragraph at the top that the save pipeline will strip
    // (stripEmptyDocParagraphsFromJson). The serialized file therefore starts at the
    // second editor block, which should map to line 1, not line 3.
    const blocks = [
      { typeName: 'paragraph', text: '', nodeSize: 2 }, // will be stripped
      { typeName: 'paragraph', text: 'Real first paragraph', nodeSize: 22 },
      { typeName: 'paragraph', text: 'Second', nodeSize: 8 },
    ];
    const editor = buildStubEditor({
      blocks,
      selection: { from: 5, to: 5, empty: true }, // inside the "Real first paragraph"
      serialize: json => {
        const texts = (json.content as Array<{ content?: Array<{ text: string }> }>)
          .filter(p => p.content && p.content.length > 0)
          .map(p => p.content?.[0]?.text ?? '');
        return texts.length === 0 ? '' : texts.join('\n\n') + '\n';
      },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(getSelectionBlockRange(editor as any)).toEqual({ startLine: 1, endLine: 1 });
  });
});

// Orchestration-level tests: when the cursor/selection can't be mapped to a
// concrete line range (empty doc, all-blank paragraphs, out-of-range cursor),
// the high-level `copyAiContextReference` should still succeed by falling back
// to a filename-only `@path` reference rather than refusing the copy.
describe('copyAiContextReference filename-only fallback', () => {
  const mockWriteText = jest.fn();

  beforeAll(() => {
    Object.defineProperty(global, 'navigator', {
      value: { clipboard: { writeText: mockWriteText } },
      writable: true,
      configurable: true,
    });
  });

  beforeEach(() => {
    mockWriteText.mockReset();
    mockWriteText.mockResolvedValue(undefined);
  });

  function buildEmptyDocEditor() {
    // Editor that returns no JSON content — exercises the `empty-doc-json`
    // failure path inside computeSelectionBlockRange.
    return {
      state: {
        selection: { from: 0, to: 0, empty: true },
        doc: { content: { forEach: () => {} } },
      },
      getJSON: () => ({ type: 'doc', content: [] }),
      markdown: { serialize: () => '' },
    };
  }

  it('passes a null range to the host and copies @path when the doc is empty', async () => {
    const editor = buildEmptyDocEditor();
    let receivedRange: SelectionBlockRange | null | 'unset' = 'unset';

    const result = await copyAiContextReference(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      editor as any,
      'preserve',
      async range => {
        receivedRange = range;
        return { ref: '@docs/empty.md', relPath: 'docs/empty.md' };
      }
    );

    expect(receivedRange).toBeNull();
    expect(result.success).toBe(true);
    expect(result.ref).toBe('@docs/empty.md');
    expect(mockWriteText).toHaveBeenCalledWith('@docs/empty.md');
  });

  it('builds @path from relPath alone when the host omits a pre-built ref', async () => {
    const editor = buildEmptyDocEditor();
    const result = await copyAiContextReference(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      editor as any,
      'preserve',
      async () => ({ relPath: 'docs/empty.md' })
    );
    expect(result.success).toBe(true);
    expect(result.ref).toBe('@docs/empty.md');
  });

  it('still reports host errors verbatim in the fallback path', async () => {
    const editor = buildEmptyDocEditor();
    const result = await copyAiContextReference(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      editor as any,
      'preserve',
      async () => ({ error: 'No active document' })
    );
    expect(result.success).toBe(false);
    expect(result.error).toBe('No active document');
  });

  // A stub editor that LOOKS valid to `computeSelectionBlockRange` — it would
  // happily report a line range — but the caller indicates the cursor isn't
  // really active. This mirrors the real production scenario where ProseMirror
  // keeps a stale selection after the editor blurs.
  function buildValidLookingEditor() {
    return {
      state: {
        selection: { from: 4, to: 4, empty: true },
        doc: {
          content: {
            forEach(cb: (node: unknown, offset: number, idx: number) => void) {
              const node = { type: { name: 'paragraph' }, nodeSize: 13 };
              cb(node, 0, 0);
            },
          },
        },
      },
      getJSON: () => ({
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hello world' }] }],
      }),
      markdown: { serialize: () => 'Hello world\n' },
    };
  }

  it('passes the resolved range when the selection maps to a real block', async () => {
    // Sanity check that the happy path still sends the line numbers — the
    // fallback should only trigger on failure, not for every selection.
    const editor = buildValidLookingEditor();
    let receivedRange: SelectionBlockRange | null | 'unset' = 'unset';
    const result = await copyAiContextReference(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      editor as any,
      'preserve',
      async range => {
        receivedRange = range;
        return { relPath: 'docs/hello.md' };
      }
    );

    expect(receivedRange).toEqual({ startLine: 1, endLine: 1 });
    expect(result.success).toBe(true);
    expect(result.ref).toBe('@docs/hello.md#1');
  });

  it('skips line numbers when the caller says the selection is not active', async () => {
    // Even though the editor has a perfectly valid selection (ProseMirror's
    // stale post-blur state), the caller telling us `selectionIsActive: false`
    // should produce `@path` only — exactly the case the user reported where
    // a blurred editor was still copying `#N` of the last-touched line.
    const editor = buildValidLookingEditor();
    let receivedRange: SelectionBlockRange | null | 'unset' = 'unset';
    const result = await copyAiContextReference(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      editor as any,
      'preserve',
      async range => {
        receivedRange = range;
        return { relPath: 'docs/hello.md' };
      },
      { selectionIsActive: false }
    );

    expect(receivedRange).toBeNull();
    expect(result.success).toBe(true);
    expect(result.ref).toBe('@docs/hello.md');
  });

  it('uses the line range when selectionIsActive is true and the selection maps cleanly', async () => {
    const editor = buildValidLookingEditor();
    const result = await copyAiContextReference(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      editor as any,
      'preserve',
      async () => ({ relPath: 'docs/hello.md' }),
      { selectionIsActive: true }
    );

    expect(result.success).toBe(true);
    expect(result.ref).toBe('@docs/hello.md#1');
  });
});
