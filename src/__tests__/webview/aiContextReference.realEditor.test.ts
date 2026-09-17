/** @jest-environment jsdom */

/**
 * Integration test: exercise computeSelectionBlockRange against a real TipTap
 * editor wired up the way the production webview wires it. The standalone unit
 * tests use stubs to verify the line math; this test exists to catch issues
 * that only show up with the actual `@tiptap/markdown` MarkdownManager.
 */

import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from '@tiptap/markdown';
import { ListKit } from '@tiptap/extension-list';
import { MarkdownParagraph } from '../../webview/extensions/markdownParagraph';
import { OrderedListMarkdownFix } from '../../webview/extensions/orderedListMarkdownFix';
import { MarkdownListItem } from '../../webview/extensions/markdownListItem';
import { CustomImage } from '../../webview/extensions/customImage';
import { PreservedMarkdownLiteral } from '../../webview/extensions/preservedMarkdownLiteral';
import {
  computeSelectionBlockRange,
  shouldIncludeLineRange,
} from '../../webview/utils/aiContextReference';
import { getEditorMarkdownForSync } from '../../webview/utils/markdownSerialization';
import { installBlankLineLexerNormalizer } from '../../webview/utils/markedLexerNormalizer';

function createRealEditor(initialMarkdown: string, opts: { codeBlock?: boolean } = {}): Editor {
  const element = document.createElement('div');
  document.body.appendChild(element);
  // We must install the lexer normaliser BEFORE any markdown is parsed,
  // otherwise the first parse uses the un-normalised lexer and constructs
  // like `[]()` get dropped on the way into the editor. Production wires
  // this up the same way (see editor.ts) before setting initial content.
  //
  // `opts.codeBlock` defaults to false (StarterKit's code block disabled),
  // matching every existing caller. Frontmatter tests opt in: production wraps
  // YAML frontmatter in a ```yaml fenced block, which only lands as a real
  // node when a code-block extension is registered. StarterKit's default code
  // block round-trips the fenced form identically to production's
  // CodeBlockLowlight (which cannot load under jsdom), so it faithfully
  // reproduces the frontmatter line-offset for line-counting purposes.
  const editor = new Editor({
    element,
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3, 4, 5, 6] },
        paragraph: false,
        ...(opts.codeBlock ? {} : { codeBlock: false }),
        bulletList: false,
        orderedList: false,
        listItem: false,
        listKeymap: false,
        undoRedo: { depth: 100 },
      }),
      MarkdownParagraph,
      PreservedMarkdownLiteral,
      // CustomImage is part of the production extension set; without it,
      // image tokens emitted by marked have no schema to land in and get
      // silently dropped, which would fail the `![](url)` round-trip cases
      // below now that the lexer normaliser no longer demotes images with a
      // valid src to literal text.
      CustomImage,
      Markdown.configure({
        markedOptions: { gfm: true, breaks: true },
      }),
      ListKit.configure({
        listItem: false,
        orderedList: false,
        taskItem: { nested: true },
      }),
      MarkdownListItem,
      OrderedListMarkdownFix,
    ],
    content: '',
    contentType: 'markdown',
  });
  const markdownStorage = editor as unknown as {
    markdown?: { instance?: unknown };
    storage?: { markdown?: { instance?: unknown } };
  };
  const markedInstance =
    markdownStorage.markdown?.instance ?? markdownStorage.storage?.markdown?.instance;
  if (markedInstance) {
    installBlankLineLexerNormalizer(markedInstance);
  }
  if (initialMarkdown) {
    editor.commands.setContent(initialMarkdown, { contentType: 'markdown' });
  }
  return editor;
}

describe('computeSelectionBlockRange with a real TipTap editor', () => {
  it('returns the first paragraph line when the cursor is in paragraph 1 of three', () => {
    const editor = createRealEditor('First paragraph\n\nSecond paragraph\n\nThird');
    // Place cursor inside the first paragraph.
    editor.commands.setTextSelection(3);

    const result = computeSelectionBlockRange(editor);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.range.startLine).toBe(1);
      expect(result.range.endLine).toBe(1);
    }
    editor.destroy();
  });

  it('returns the third paragraph line when the cursor is in paragraph 3 of three', () => {
    const editor = createRealEditor('First paragraph\n\nSecond paragraph\n\nThird');
    // Move to end of doc — selection lands inside the last paragraph.
    const docEnd = editor.state.doc.content.size;
    editor.commands.setTextSelection(docEnd);

    const result = computeSelectionBlockRange(editor);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.range.startLine).toBe(5);
      expect(result.range.endLine).toBe(5);
    }
    editor.destroy();
  });

  it('reports a useful failure reason for an empty document', () => {
    const editor = createRealEditor('');
    const result = computeSelectionBlockRange(editor);
    // Either empty-doc-json or no-blocks is acceptable — the actionable bit is
    // that the result is not `ok`.
    expect(result.ok).toBe(false);
    editor.destroy();
  });

  // Regression coverage for `manual-tests/12-edge-cases.md`: a real-world
  // document that mixes headings, empty headings/bold/italic/links, fenced
  // code blocks (including an empty one), tables, alerts, deeply-nested lists
  // and blockquotes, and standard single-blank-line separators. The contract
  // we verify is intentionally loose: whatever line range we report must
  // round-trip — the lines startLine..endLine in the post-save file must
  // contain the text the user clicked on.
  describe('edge-cases file', () => {
    const edgeCasesMarkdown = [
      '# Edge Cases & Stress Tests',
      '',
      'This file contains edge cases, unusual formatting, and stress tests for the editor.',
      '',
      '## Empty Elements',
      '',
      '### Empty Heading',
      '',
      '#',
      '',
      '### Empty Bold',
      '',
      '**',
      '',
      '### Empty Italic',
      '',
      '*',
      '',
      '## Special Characters',
      '',
      '@#$%^&*()_+-=<>,.:";\'',
      '',
      '### Unicode',
      '',
      'Emojis: 😀 😃 😄 😁',
      '',
      'Accented: café, résumé, naïve',
      '',
      'CJK: 日本語, 中文, 한글',
      '',
      '## Deeply Nested Content',
      '',
      '> Level 1',
      '> > Level 2',
      '> > > Level 3',
      '',
      '- Level 1',
      '  - Level 2',
      '    - Level 3',
      '',
      '## Long Line Test',
      '',
      'This is a very long line that should wrap correctly in the editor.',
      '',
      '## Mixed Block Types',
      '',
      'Paragraph text.',
      '',
      '- List item',
      '',
      '> Blockquote',
      '',
      'Paragraph again.',
    ].join('\n');

    it('every block we report points at non-empty content in the saved file', () => {
      const editor = createRealEditor(edgeCasesMarkdown);
      const saved = getEditorMarkdownForSync(editor);
      const lines = saved.split('\n');

      // Walk every top-level block, place the cursor inside it, and confirm
      // that the saved file actually contains that block's text on the
      // returned [startLine, endLine] window. This catches any drift between
      // computeBlockLineRanges and the saver — exactly the class of bug the
      // edge-cases file exposes.
      const blockStarts: number[] = [];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      editor.state.doc.content.forEach((_node: any, offset: number) => {
        blockStarts.push(offset + 1);
      });

      for (const pos of blockStarts) {
        // Some block types (e.g. fenced code) reject TextSelection; just skip
        // those rather than letting prosemirror log a noisy warning.
        let placed = false;
        try {
          placed = editor.commands.setTextSelection(pos + 1);
        } catch {
          placed = false;
        }
        if (!placed) continue;
        const result = computeSelectionBlockRange(editor);
        if (!result.ok) {
          // empty-paragraph blocks legitimately have no line range; skip.
          continue;
        }
        const { startLine, endLine } = result.range;
        expect(startLine).toBeGreaterThanOrEqual(1);
        expect(endLine).toBeGreaterThanOrEqual(startLine);
        expect(endLine).toBeLessThanOrEqual(lines.length);
        // The returned range should span at least one non-blank line —
        // otherwise we're pointing the user at empty space.
        const slice = lines.slice(startLine - 1, endLine);
        expect(slice.some(l => l.trim().length > 0)).toBe(true);
      }
      editor.destroy();
    });

    it('preserves empty headings on disk and reports the correct line for what follows', () => {
      // An empty heading (`#` with no inline text — what you get if a user
      // deletes the heading text) used to serialize to '' and get dropped on
      // save, shifting the next block's line number up by 1. We now emit a
      // `#` placeholder so the row survives round-trip and stays counted.
      const editor = createRealEditor('#\n\nAfter');
      const saved = getEditorMarkdownForSync(editor);
      expect(saved.split('\n')).toContain('#');

      const docEnd = editor.state.doc.content.size;
      editor.commands.setTextSelection(docEnd);
      const result = computeSelectionBlockRange(editor);
      expect(result.ok).toBe(true);
      if (result.ok) {
        const lines = saved.split('\n');
        // 'After' must be on the line we report.
        expect(lines[result.range.startLine - 1]).toBe('After');
      }
      editor.destroy();
    });

    // Empty-text link variants. Every one of these parses to an "empty"
    // inline through @tiptap/markdown, which the ProseMirror schema then
    // strips — leaving a paragraph node with no content, indistinguishable
    // from a real blank line in the JSON. The lexer normaliser rewrites
    // such paragraphs to carry their raw markdown as literal text so they
    // round-trip losslessly on save.
    const emptyLinkVariants: Array<{ label: string; line: string; expectInSaved: string }> = [
      { label: 'bare empty', line: '[]()', expectInSaved: '[]()' },
      {
        label: 'http url',
        line: '[](http://example.com)',
        expectInSaved: '[](http://example.com)',
      },
      {
        label: 'https url',
        line: '[](https://google.com)',
        expectInSaved: '[](https://google.com)',
      },
      // The reported failure case — `https:` without `//` is an unusual but
      // syntactically valid link target, and it must not get dropped.
      {
        label: 'https no slashes',
        line: '[](https:google.com)',
        expectInSaved: '[](https:google.com)',
      },
      { label: 'mailto', line: '[](mailto:a@b.c)', expectInSaved: '[](mailto:a@b.c)' },
      { label: 'with title', line: '[](url "title")', expectInSaved: '[](url "title")' },
      { label: 'space-only href', line: '[]( )', expectInSaved: '[]( )' },
      { label: 'whitespace text', line: '[ ]()', expectInSaved: '[ ]()' },
      { label: 'whitespace text + url', line: '[ ](url)', expectInSaved: '[ ](url)' },
      { label: 'brackets only', line: '[]', expectInSaved: '[]' },
      {
        label: 'angle-bracketed url',
        line: '[](<http://example.com>)',
        expectInSaved: '[](<http://example.com>)',
      },
      { label: 'image empty alt+src', line: '![]()', expectInSaved: '![]()' },
      {
        label: 'image empty alt with src',
        line: '![](https://x.png)',
        expectInSaved: '![](https://x.png)',
      },
      { label: 'reference style empty', line: '[][]', expectInSaved: '[][]' },
    ];

    for (const v of emptyLinkVariants) {
      it(`preserves empty-text link variant on disk: ${v.label} (${v.line})`, () => {
        const editor = createRealEditor(`${v.line}\n\nAfter`);
        const saved = getEditorMarkdownForSync(editor);
        expect(saved.split('\n')).toContain(v.expectInSaved);

        const docEnd = editor.state.doc.content.size;
        editor.commands.setTextSelection(docEnd);
        const result = computeSelectionBlockRange(editor);
        expect(result.ok).toBe(true);
        if (result.ok) {
          const lines = saved.split('\n');
          // Whatever line we report must contain "After" — the empty-link
          // line above must not be silently dropped from the count.
          expect(lines[result.range.startLine - 1]).toBe('After');
        }
        editor.destroy();
      });
    }

    // Empty links inside paragraphs that ALSO contain real content used to
    // be silently stripped (only the empty inline got dropped, leaving the
    // surrounding text — so the line was lost from the count). The lexer
    // normaliser now rewrites every empty link/image inline as literal text
    // wherever it appears, recursing into list items, blockquotes, and
    // table cells. Each case below uses `\n` (soft-break / mixed inline)
    // rather than `\n\n` so the empty link sits inside a content paragraph.
    const mixedInlineCases: Array<{ label: string; md: string; mustContain: string[] }> = [
      {
        label: 'soft break + bare empty',
        md: 'Even deeper.\n[]()\n\nAfter',
        mustContain: ['[]()'],
      },
      {
        label: 'soft break + empty url (the reported case)',
        md: 'Even deeper.\n[](https:google.com)\n\nAfter',
        mustContain: ['[](https:google.com)'],
      },
      {
        label: 'inline middle',
        md: 'foo []() bar\n\nAfter',
        mustContain: ['foo []() bar'],
      },
      {
        label: 'inline leading',
        md: '[]() bar\n\nAfter',
        mustContain: ['[]() bar'],
      },
      {
        label: 'list item with empty link',
        md: '- [](https:google.com)\n\nAfter',
        mustContain: ['[](https:google.com)'],
      },
      {
        label: 'list item with mixed inline',
        md: '- foo []() bar\n\nAfter',
        mustContain: ['foo []() bar'],
      },
      {
        label: 'blockquote with empty link',
        md: '> [](https:google.com)\n\nAfter',
        mustContain: ['[](https:google.com)'],
      },
      {
        label: 'blockquote with soft-break mixed',
        md: '> Even deeper.\n> [](https:google.com)\n\nAfter',
        mustContain: ['[](https:google.com)'],
      },
      {
        label: 'two soft-break empties around text',
        md: 'a\n[]()\nb\n\nAfter',
        mustContain: ['[]()'],
      },
    ];

    for (const c of mixedInlineCases) {
      it(`preserves empty links in mixed/nested context: ${c.label}`, () => {
        const editor = createRealEditor(c.md);
        const saved = getEditorMarkdownForSync(editor);
        for (const needle of c.mustContain) {
          expect(saved).toContain(needle);
        }

        const docEnd = editor.state.doc.content.size;
        editor.commands.setTextSelection(docEnd);
        const result = computeSelectionBlockRange(editor);
        expect(result.ok).toBe(true);
        if (result.ok) {
          const lines = saved.split('\n');
          // The trailing 'After' paragraph must land on the line our range
          // points to — i.e. the line count was not shifted up by a dropped
          // empty link.
          expect(lines[result.range.startLine - 1]).toBe('After');
        }
        editor.destroy();
      });
    }

    it('preserves empty H3 headings with three #s on disk', () => {
      const editor = createRealEditor('### \n\nAfter');
      const saved = getEditorMarkdownForSync(editor);
      // The level-3 placeholder is `###`, not just `#`.
      expect(saved.split('\n').some(l => l === '###')).toBe(true);
      editor.destroy();
    });

    it('reports the correct line for a paragraph that follows multiple blank lines', () => {
      // Two empty paragraphs between A and B → on disk:
      //   line 1: "A"
      //   line 2: ""
      //   line 3: ""
      //   line 4: ""
      //   line 5: "B"
      // The saver collapses each editor-level empty paragraph into one extra
      // blank line, so cursor in B must report startLine=5.
      const editor = createRealEditor('A\n\n\n\nB');
      const saved = getEditorMarkdownForSync(editor);
      const lines = saved.split('\n');
      const bLineIdx = lines.findIndex(l => l === 'B');
      expect(bLineIdx).toBeGreaterThanOrEqual(0);

      const docEnd = editor.state.doc.content.size;
      editor.commands.setTextSelection(docEnd);
      const result = computeSelectionBlockRange(editor);
      expect(result.ok).toBe(true);
      if (result.ok) {
        // startLine is 1-based; bLineIdx is 0-based.
        expect(result.range.startLine).toBe(bLineIdx + 1);
        expect(lines[result.range.startLine - 1]).toBe('B');
      }
      editor.destroy();
    });
  });
});

// ===========================================================================
// Regression coverage imported from fix/copy-ai-context-line-numbers:
//   Bug 2 — selection dropped after the editor blurs (gate logic).
//   Bug 1 — line numbers off by 2 for any file with YAML frontmatter.
// ===========================================================================
describe('Copy as AI Context — bug regression suite', () => {
  // -- Bug 2: the gate contract -------------------------------------------
  // The decision "should this copy include a line range?" lives in
  // runCopyAiContextRef (editor.ts), which depends on the VS Code webview API
  // and is not unit-testable. shouldIncludeLineRange is the extracted pure
  // gate it delegates to; these four rows pin its contract.
  describe('GATE SPEC: shouldIncludeLineRange(isFocused, selectionEmpty)', () => {
    it('GATE SPEC: focused + cursor-only (empty selection) → include (true)', () => {
      // The most common action: place a cursor, click the button. The rejected
      // `!selectionEmpty`-only fix would return false here — a regression.
      expect(shouldIncludeLineRange(true, true)).toBe(true);
    });

    it('GATE SPEC: focused + range selected → include (true)', () => {
      expect(shouldIncludeLineRange(true, false)).toBe(true);
    });

    it('GATE SPEC: blurred + cursor-only → bare @file (false)', () => {
      // A stale cursor position after blur has ambiguous intent.
      expect(shouldIncludeLineRange(false, true)).toBe(false);
    });

    it('BUG-2 CONTRACT: blurred + range selected → include (true)', () => {
      // ProseMirror preserves state.selection after blur. This is the exact
      // case the old `editor.isFocused`-only gate got wrong (returned false,
      // producing a bare @file when the user had a real selection).
      expect(shouldIncludeLineRange(false, false)).toBe(true);
    });
  });

  // -- Bug 2: selection availability after blur ----------------------------
  it('SELECTION AVAILABILITY: a non-empty selection still maps to a range (PM keeps selection post-blur)', () => {
    const editor = createRealEditor('First paragraph\n\nSecond paragraph\n\nThird');
    // Select inside the first paragraph (a real, non-empty range).
    editor.commands.setTextSelection({ from: 1, to: 6 });
    expect(editor.state.selection.empty).toBe(false);
    // computeSelectionBlockRange reads state.selection, not focus — so the
    // data the fix relies on is present regardless of blur.
    const result = computeSelectionBlockRange(editor);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.range.startLine).toBe(1);
      expect(result.range.endLine).toBe(1);
    }
    editor.destroy();
  });

  // -- Bug 1: frontmatter line offset --------------------------------------
  // Production wraps YAML frontmatter in a ```yaml fenced block before the
  // webview parses it (wrapFrontmatterForWebview), then strips the two fence
  // lines on save (unwrapFrontmatterFromWebview). computeBlockLineRanges
  // counts the fenced (webview) form, so every block after the frontmatter is
  // reported 2 lines too high relative to the on-disk file.
  it('BUG-1 REPRODUCTION: heading after frontmatter is reported 2 lines too high', () => {
    // What the host sends the webview: frontmatter wrapped as a ```yaml block.
    const wrapped = [
      '```yaml', // webview-only fence (stripped on save)
      '---',
      'title: "Test Post"',
      'platform: medium',
      'audience: general',
      '---',
      '```', // webview-only fence (stripped on save)
      '',
      '# The Heading',
      '',
      'Paragraph text.',
    ].join('\n');
    // codeBlock:true so the ```yaml block lands as a real node (see factory).
    const editor = createRealEditor(wrapped, { codeBlock: true });

    // Sanity: the frontmatter really parsed as a leading code block.
    const blockTypes: string[] = [];
    editor.state.doc.content.forEach((node: { type: { name: string } }) => {
      blockTypes.push(node.type.name);
    });
    expect(blockTypes[0]).toBe('codeBlock');

    // Place the cursor inside the heading.
    let headingOffset = -1;
    editor.state.doc.content.forEach((node: { type: { name: string } }, offset: number) => {
      if (node.type.name === 'heading' && headingOffset < 0) headingOffset = offset + 2;
    });
    expect(headingOffset).toBeGreaterThan(0);
    editor.commands.setTextSelection(headingOffset);

    const result = computeSelectionBlockRange(editor, 'preserve');
    expect(result.ok).toBe(true);
    if (result.ok) {
      // On disk, after the host strips the two ```yaml fence lines:
      //   1:---  2:title  3:platform  4:audience  5:---  6:(blank)  7:# The Heading
      // The CORRECT on-disk line for the heading is 7.
      //
      // This assertion FAILS before the fix: computeBlockLineRanges counts the
      // fenced webview form (7-line code block + 2 separators) and reports
      // line 9. The Phase 4 fix subtracts the 2 fence lines, so this turns
      // green with NO change to the test — a true red→green reproduction.
      expect(result.range.startLine).toBe(7);
    }
    editor.destroy();
  });
});
