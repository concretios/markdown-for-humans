/** @jest-environment jsdom */

/**
 * TipTap 3.30.5's MarkdownManager#escapeMarkdownSyntax backslash-escapes
 * `\ * _ [ ] ~` on every serialize. Combined with marked's autolink tokenizer
 * (which swallows those escapes back into URL text) and the branch's autolink
 * → plain-text parse path, underscored URLs grow escapes unboundedly on each
 * save. Ordinary prose (`snake_case`, `[WIP]`, footnotes, `~85%`) is also
 * corrupted relative to main. These cases pin the production sync serializer.
 */

import { Editor, type JSONContent } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from '@tiptap/markdown';
import { ListKit } from '@tiptap/extension-list';
import { MarkdownParagraph } from '../../webview/extensions/markdownParagraph';
import { OrderedListMarkdownFix } from '../../webview/extensions/orderedListMarkdownFix';
import { MarkdownListItem } from '../../webview/extensions/markdownListItem';
import { CustomImage } from '../../webview/extensions/customImage';
import { PreservedMarkdownLiteral } from '../../webview/extensions/preservedMarkdownLiteral';
import { MarkdownLink, MarkdownCode } from '../../webview/extensions/markdownCompatibilityMarks';
import { getEditorMarkdownForSync } from '../../webview/utils/markdownSerialization';
import { installBlankLineLexerNormalizer } from '../../webview/utils/markedLexerNormalizer';

function createRealEditor(initialMarkdown: string): Editor {
  const element = document.createElement('div');
  document.body.appendChild(element);
  const editor = new Editor({
    element,
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3, 4, 5, 6] },
        paragraph: false,
        codeBlock: false,
        bulletList: false,
        orderedList: false,
        listItem: false,
        listKeymap: false,
        link: false,
        code: false,
        undoRedo: { depth: 100 },
      }),
      MarkdownParagraph,
      PreservedMarkdownLiteral,
      CustomImage,
      MarkdownLink,
      MarkdownCode,
      Markdown.configure({ markedOptions: { gfm: true, breaks: true } }),
      ListKit.configure({ listItem: false, orderedList: false, taskItem: { nested: true } }),
      MarkdownListItem,
      OrderedListMarkdownFix,
    ],
    content: '',
    contentType: 'markdown',
  });
  const storage = editor as unknown as {
    markdown?: { instance?: unknown };
    storage?: { markdown?: { instance?: unknown } };
  };
  const marked = storage.markdown?.instance ?? storage.storage?.markdown?.instance;
  if (marked) installBlankLineLexerNormalizer(marked);
  if (initialMarkdown) editor.commands.setContent(initialMarkdown, { contentType: 'markdown' });
  return editor;
}

function roundTrip(markdown: string): string {
  const editor = createRealEditor(markdown);
  try {
    return getEditorMarkdownForSync(editor).trim();
  } finally {
    editor.destroy();
  }
}

function text(value: string, marks?: JSONContent['marks']): JSONContent {
  return marks ? { type: 'text', text: value, marks } : { type: 'text', text: value };
}

function paragraph(...content: JSONContent[]): JSONContent {
  return { type: 'paragraph', content };
}

function multiRoundTrip(markdown: string, rounds: number): string[] {
  let current = markdown;
  const results: string[] = [];
  for (let i = 0; i < rounds; i++) {
    current = roundTrip(current);
    results.push(current);
  }
  return results;
}

describe('markdown syntax escape round-trips (real editor)', () => {
  it('does not grow backslashes in underscored autolink URLs across saves', () => {
    const source = 'See https://en.wikipedia.org/wiki/Foo_bar_baz for details.';
    const [save1, save2, save3] = multiRoundTrip(source, 3);
    expect(save1).toBe(source);
    expect(save2).toBe(source);
    expect(save3).toBe(source);
  });

  it('preserves snake_case prose without escaping underscores', () => {
    expect(roundTrip('A snake_case name here.')).toBe('A snake_case name here.');
  });

  it('preserves bracketed prose that is not a Markdown link', () => {
    expect(roundTrip('Status: [WIP] item.')).toBe('Status: [WIP] item.');
  });

  it('preserves GitHub-flavored footnote markers', () => {
    const source = ['Text[^1].', '', '[^1]: The note.'].join('\n');
    expect(roundTrip(source)).toBe(source);
  });

  it('preserves a single tilde in approximate percentages', () => {
    expect(roundTrip('MVP is ~85% complete.')).toBe('MVP is ~85% complete.');
  });

  it('preserves a Windows path backslash without doubling', () => {
    expect(roundTrip('Path is C:\\Users\\name.')).toBe('Path is C:\\Users\\name.');
  });

  it('still serializes real emphasis marks', () => {
    expect(roundTrip('Say **bold** and *italic* words.')).toBe('Say **bold** and *italic* words.');
  });

  it('preserves loose numbered checklist items without duplicating paragraphs', () => {
    const source = ['1. [x] finished', '', '   continued'].join('\n');
    const out = roundTrip(source);
    expect((out.match(/finished/g) || []).length).toBe(1);
    expect((out.match(/continued/g) || []).length).toBe(1);
    expect(out).toMatch(/^1\. \[x\] finished/);
    expect(out).toContain('continued');
  });
});

describe('HTML entity prose round-trips (real editor)', () => {
  it('keeps authored &lt;div&gt;-style entity text from becoming real HTML then vanishing', () => {
    const source = 'Use the &lt;div&gt; element.';
    const [save1, save2, save3] = multiRoundTrip(source, 3);
    expect(save1).toMatch(/&lt;div(&gt;|>)/);
    expect(save1).not.toContain('<div>');
    expect(save2).toBe(save1);
    expect(save3).toBe(save1);
    expect(save2).not.toBe('Use the  element.');
  });

  it('preserves nested HTML entity spellings across saves', () => {
    const source = 'The token is &amp;amp;.';
    const [save1, save2, save3] = multiRoundTrip(source, 3);
    expect(save1).toBe(source);
    expect(save2).toBe(source);
    expect(save3).toBe(source);
  });

  it('preserves common named and numeric HTML entities across saves', () => {
    const cases = ['Copyright &copy; 2026.', 'Text&nbsp;text', 'Spaces &#160; and &#xA0; here.'];
    for (const source of cases) {
      const [save1, save2] = multiRoundTrip(source, 2);
      expect(save1).not.toMatch(/&amp;copy;|&amp;nbsp;|&amp;#160;|&amp;#xA0;/i);
      expect(save2).toBe(save1);
      if (source.includes('&copy;')) expect(save1).toMatch(/©|&copy;/);
      if (source.includes('&nbsp;')) expect(save1).toMatch(/\u00a0|&nbsp;/);
    }
  });

  it('preserves intentionally literal escaped entity spellings across saves', () => {
    const cases = [
      'Keep &amp;copy; literal.',
      'Keep &amp;nbsp; literal.',
      'Keep &amp;#160; and &amp;#xA0; literal.',
      'Keep &amp;#X41; uppercase hex literal.',
    ];
    for (const source of cases) {
      const [save1, save2, save3] = multiRoundTrip(source, 3);
      expect(save1).toBe(source);
      expect(save2).toBe(source);
      expect(save3).toBe(source);
    }
  });

  it('does not turn line-leading greater-than text into a blockquote', () => {
    const source = '&gt; This is literal text.';
    const [save1, save2] = multiRoundTrip(source, 2);
    expect(save1).toMatch(/^(&gt;|>) This is literal text\./);
    // Must remain a paragraph of greater-than text, not a blockquote node.
    const editor = createRealEditor(save1);
    try {
      expect(editor.getHTML()).not.toMatch(/<blockquote\b/i);
      expect(editor.getText()).toMatch(/^>? This is literal text\./);
    } finally {
      editor.destroy();
    }
    expect(save2).toBe(save1);
  });

  it('still allows comparison operators in prose', () => {
    expect(roundTrip('if x < 5 and y > 3 then done')).toBe('if x < 5 and y > 3 then done');
  });
});

describe('link title serialization (real editor)', () => {
  it('preserves hyperlinks whose titles contain double quotes', () => {
    const source = `[spec](https://example.com 'A "quoted" title')`;
    const editor = createRealEditor(source);
    try {
      expect(editor.getHTML()).toContain('href="https://example.com"');
      const saved = getEditorMarkdownForSync(editor).trim();
      expect(saved).toMatch(/\[spec\]\(https:\/\/example\.com/);
      // Reopen must keep a real link mark, not plain Markdown text.
      const reopened = createRealEditor(saved);
      try {
        expect(reopened.getHTML()).toContain('href="https://example.com"');
        expect(reopened.getHTML()).not.toContain('[spec](https://example.com');
      } finally {
        reopened.destroy();
      }
    } finally {
      editor.destroy();
    }
  });
});

describe('ordered-list task checkboxes (real editor)', () => {
  it('preserves [x]/[ ] markers in numbered lists', () => {
    const source = ['1. [x] done', '2. [ ] todo', '3. plain'].join('\n');
    expect(roundTrip(source)).toBe(source);
  });

  it('preserves checkboxes for two-digit numbered items (canonical . marker)', () => {
    // Authoring with `)` is CommonMark-valid; the serializer emits `. `.
    const source = ['10) [ ] pending', '11) [x] shipped'].join('\n');
    expect(roundTrip(source)).toBe(['10. [ ] pending', '11. [x] shipped'].join('\n'));
  });

  it('preserves loose numbered checklist items without duplicating paragraphs', () => {
    const source = ['1. [x] finished', '', '   continued'].join('\n');
    const out = roundTrip(source);
    expect((out.match(/finished/g) || []).length).toBe(1);
    expect((out.match(/continued/g) || []).length).toBe(1);
    expect(out).toContain('[x] finished');
    expect(out).toContain('continued');
  });
});

describe('explicit angle-bracket autolinks (real editor)', () => {
  it('keeps mailto and tel angle-bracket autolinks as links', () => {
    const mailto = 'Email <mailto:help@example.com> please.';
    const tel = 'Call <tel:+12345> now.';
    const mailtoEditor = createRealEditor(mailto);
    const telEditor = createRealEditor(tel);
    try {
      expect(mailtoEditor.getHTML()).toContain('href="mailto:help@example.com"');
      expect(telEditor.getHTML()).toContain('href="tel:+12345"');
      expect(getEditorMarkdownForSync(mailtoEditor).trim()).toContain('mailto:help@example.com');
      expect(getEditorMarkdownForSync(telEditor).trim()).toContain('tel:+12345');
    } finally {
      mailtoEditor.destroy();
      telEditor.destroy();
    }
  });
});

describe('mid-line greater-than after a text node boundary (R1, real editor)', () => {
  // T04 decided "line start" per ProseMirror text node, so a `>` that follows a
  // mark, code span or link was saved as `&gt;` although it is mid-line.
  it.each([
    ['after bold marks', 'Click **File** > **Save**'],
    ['between code spans', '`a` > `b`'],
    ['after a link', '[docs](https://example.com) > more'],
    ['after italic at the end', 'Go *here* >'],
    ['inside a heading', '# > Not a quote'],
    // The mark's opening delimiter precedes `>` on the line.
    ['at the start of bold text', '**> note** rest'],
    ['at the start of italic text', '*> aside*'],
    ['at the start of struck text', '~~> struck~~'],
    ['at the start of link text', '[> Next chapter](ch2.md)'],
    ['at the start of bold text after a hard break', 'First line  \n**> note**'],
  ])('keeps a literal > %s', (_name, source) => {
    const [save1, save2] = multiRoundTrip(source, 2);
    expect(save1).toBe(source);
    expect(save2).toBe(source);
  });

  // An authored `&gt;` keeps its source through the literal mark and never
  // reaches the line-start guard, so these cases use plain-text `>` nodes, as
  // typing or HTML paste produces them (T04).
  it.each<[string, JSONContent[], string]>([
    ['at block start', [paragraph(text('> typed text'))], '&gt; typed text'],
    [
      'after a hard break',
      [paragraph(text('First line'), { type: 'hardBreak' }, text('> second line'))],
      'First line  \n&gt; second line',
    ],
    [
      'after a hard break and up to three spaces',
      [paragraph(text('First line'), { type: 'hardBreak' }, text('   > second line'))],
      'First line  \n   &gt; second line',
    ],
    [
      'inside a list item',
      [{ type: 'bulletList', content: [{ type: 'listItem', content: [paragraph(text('> x'))] }] }],
      '- &gt; x',
    ],
  ])('keeps a plain-text line-leading > escaped %s', (_name, content, saved) => {
    const editor = createRealEditor('');
    try {
      editor.commands.setContent({ type: 'doc', content });
      expect(getEditorMarkdownForSync(editor).trim()).toBe(saved);
    } finally {
      editor.destroy();
    }
    const reopened = createRealEditor(saved);
    try {
      expect(reopened.getHTML()).not.toMatch(/<blockquote\b/i);
      expect(getEditorMarkdownForSync(reopened).trim()).toBe(saved);
    } finally {
      reopened.destroy();
    }
  });

  it('keeps > escaped after a hard break inside a heading', () => {
    const editor = createRealEditor('## Title');
    try {
      // Shift+Enter in a heading runs setHardBreak; the next text starts a line.
      editor.commands.setTextSelection(editor.state.doc.firstChild!.nodeSize - 1);
      expect(editor.commands.setHardBreak()).toBe(true);
      editor.view.dispatch(editor.state.tr.insertText('> quote'));
      expect(getEditorMarkdownForSync(editor).trim()).toBe('## Title  \n&gt; quote');
    } finally {
      editor.destroy();
    }
    const reopened = createRealEditor('## Title  \n&gt; quote');
    try {
      expect(reopened.getHTML()).not.toMatch(/<blockquote\b/i);
    } finally {
      reopened.destroy();
    }
  });

  it('keeps a typed line-leading > escaped', () => {
    const editor = createRealEditor('');
    try {
      editor.view.dispatch(editor.state.tr.insertText('>x', 1));
      expect(getEditorMarkdownForSync(editor).trim()).toBe('&gt;x');
    } finally {
      editor.destroy();
    }
  });

  // A node that is not among its parent's children (TipTap renders a
  // multi-paragraph table cell with the table as parent) keeps `&gt;`, even
  // with a mark or a heading parent that would otherwise look mid-line.
  it.each<[string, JSONContent, JSONContent]>([
    ['plain text', text('> x'), paragraph(text('Before'), { type: 'hardBreak' })],
    [
      'bold text',
      text('> x', [{ type: 'bold' }]),
      paragraph(text('Before'), { type: 'hardBreak' }),
    ],
    ['a heading parent', text('> x'), { type: 'heading', content: [text('Before')] }],
  ])('keeps &gt; for %s it cannot locate in its parent', (_name, node, parent) => {
    const editor = createRealEditor('Other text');
    try {
      getEditorMarkdownForSync(editor);
      const manager = editor.markdown as unknown as {
        encodeTextForMarkdown: (value: string, node: JSONContent, parent?: JSONContent) => string;
      };
      expect(manager.encodeTextForMarkdown('> x', node, parent)).toBe('&gt; x');
    } finally {
      editor.destroy();
    }
  });
});
