/** @jest-environment jsdom */

import { readFileSync } from 'fs';
import { resolve } from 'path';
import { Editor, type JSONContent } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { closeHistory } from '@tiptap/pm/history';
import { createProductionEditor } from '../helpers/productionEditor';
import {
  auditPluginKey,
  DocumentAuditExtension,
  handleAuditCheckResult,
  handleAuditPickFileResult,
  handleAuditUrlCheckResult,
  runAudit,
} from '../../webview/features/auditDocument';
import { clearToasts, showAuditOverlay } from '../../webview/features/auditOverlay';
import { hideLinkDialog, showLinkDialog } from '../../webview/features/linkDialog';
import {
  buildHeadingAnchors,
  generateHeadingSlug,
  resolveHeadingAnchor,
  type SeenSlugs,
} from '../../webview/utils/headingSlug';
import {
  getEditorMarkdownForSync,
  setMarkdownContentPreservingSource,
} from '../../webview/utils/markdownSerialization';
import { getHeadingsWithAnchorText } from '../../webview/utils/outline';

const open = (markdown: string): Editor => {
  const editor = createProductionEditor();
  setMarkdownContentPreservingSource(editor, markdown);
  return editor;
};
const anchorsOf = (editor: Editor): string[] => {
  const seen: SeenSlugs = new Map();
  return getHeadingsWithAnchorText(editor).map(h => generateHeadingSlug(h.anchorText, seen));
};

describe('a heading edited in the editor has the anchor GitHub gives the saved file', () => {
  const t = (text: string, ...marks: string[]): JSONContent => ({
    type: 'text',
    text,
    marks: marks.map(type => ({ type })),
  });
  const image: JSONContent = { type: 'image', attrs: { src: 'i.png', alt: 'i' } };
  const comment: JSONContent = { type: 'htmlCommentInline', attrs: { raw: '<!-- c -->' } };
  const math: JSONContent = { type: 'inlineMath', attrs: { latex: 'x' } };
  const NB = '\u00A0';

  // [children, what is saved, GitHub's id for what is saved]
  it.each<[JSONContent[], string, string]>([
    [[t('Foo '), t(' ', 'bold')], '# Foo', 'foo'],
    [[t('Foo'), t(' ', 'italic'), t(' ', 'bold')], '# Foo', 'foo'],
    [[t('Foo ', 'bold'), t(' ')], '# **Foo**', 'foo'],
    [[t(' '), t(' Foo', 'bold')], '#   **Foo**', 'foo'],
    [[t(' ', 'bold'), t(' ', 'italic'), t('Foo')], '#   Foo', 'foo'],
    [[t('a '), t(' ', 'bold'), t('b')], '# a  b', 'a--b'],
    [[t('Foo '), image], '# Foo ![i](i.png)', 'foo-'],
    [[image, t(' Foo')], '# ![i](i.png) Foo', '-foo'],
    [[t('Foo '), t(' ', 'bold'), image], '# Foo  ![i](i.png)', 'foo--'],
    [[image, t(' '), t(' Foo', 'bold')], '# ![i](i.png)  **Foo**', '--foo'],
    [[t('Foo'), image, t(' '), t(' ', 'bold')], '# Foo![i](i.png)', 'foo'],
    [[t(' ', 'bold'), t(' '), image, t('Foo')], '#   ![i](i.png)Foo', 'foo'],
    [[comment, t(' After')], '# <!-- c --> After', '-after'],
    [[t('Foo '), comment], '# Foo <!-- c -->', 'foo-'],
    [[t('Foo'), comment, t(' ')], '# Foo<!-- c -->', 'foo'],
    [[t('\tFoo')], '# \tFoo', 'foo'],
    [[t('\t Foo')], '# \t Foo', 'foo'],
    [[t('Foo \t')], '# Foo', 'foo'],
    [[t('Foo\t ')], '# Foo', 'foo'],
    [[t(`Foo${NB}`)], '# Foo', 'foo'],
    [[t(`Foo ${NB}`)], '# Foo', 'foo'],
    [[t(`Foo${NB} `)], '# Foo', 'foo'],
    [[t(`${NB}Foo`)], `# ${NB}Foo`, 'foo'],
    [[t(`${NB} Foo`)], `# ${NB} Foo`, '-foo'],
    [[t(` ${NB}Foo`)], `#  ${NB}Foo`, 'foo'],
    [[t('Foo\u3000')], '# Foo', 'foo'],
    [[t(' ')], '#', ''],
    [[t('\t')], '#', ''],
    [[t(NB)], '#', ''],
    [[t(' '), t(' ', 'bold')], '#', ''],
    [[math, t(' '), t(' ', 'bold')], '# $x$', 'x'],
    [[t('Foo '), math, t(' ')], '# Foo $x$', 'foo-x'],
    [[{ type: 'inlineMath', attrs: { latex: 'x ' } }], '# $x $', 'x-'],
    [[t('a ', 'code')], '# `a`', 'a'],
    [[t('a b', 'code')], '# `a b`', 'a-b'],
    [[t('a ', 'code'), t(' ')], '# `a`', 'a'],
    [[t('Foo '), t(' ', 'code')], '# Foo', 'foo'],
    // A # after a space would be a closing sequence, so the serializer escapes it.
    [[t('Foo #')], '# Foo \\#', 'foo-'],
    [[t('Foo ##')], '# Foo \\##', 'foo-'],
    [[t('Foo # ')], '# Foo \\#', 'foo-'],
    [[t(`Foo #${NB}`)], '# Foo \\#', 'foo-'],
    [[t('Foo # #')], '# Foo # \\#', 'foo--'],
    [[t('Foo \t#')], '# Foo \t\\#', 'foo-'],
    [[t('Foo \\#')], '# Foo \\#', 'foo-'],
    [[t('#')], '# \\#', ''],
    [[t('#'), { type: 'hardBreak' }], '# \\#', ''],
    [[t('Foo#')], '# Foo#', 'foo'],
    [[t('Foo # '), t('x', 'bold')], '# Foo # **x**', 'foo--x'],
    [[t('Foo '), t('#', 'bold')], '# Foo **#**', 'foo-'],
    [[t('Foo\t#')], '# Foo\t\\#', 'foo'],
    [[t('Foo ###')], '# Foo \\###', 'foo-'],
    [[t('Foo'), { type: 'hardBreak' }, t('#')], '# Foo  \n\\#', 'foo'],
    // The space that makes a closing sequence can sit in the previous run.
    [[t('Foo ', 'bold'), t('#')], '# **Foo** \\#', 'foo-'],
    [[t('Foo'), t(' ', 'bold'), t('#')], '# Foo \\#', 'foo-'],
    [[t('a ', 'code'), t('#')], '# `a` \\#', 'a-'],
    [[t('Foo\t', 'bold'), t('#')], '# **Foo**\t\\#', 'foo'],
    [[image, t(' #')], '# ![i](i.png) \\#', '-'],
    // No space before it and something before it: plain text, nothing to escape.
    [[t('C#')], '# C#', 'c'],
    [[t('Foo #', 'bold')], '# **Foo #**', 'foo-'],
    [[t('C', 'bold'), t('#')], '# **C**#', 'c'],
    [[t('C', 'code'), t('#')], '# `C`#', 'c'],
    [
      [{ type: 'text', text: 'C', marks: [{ type: 'link', attrs: { href: 'u' } }] }, t('#')],
      '# [C](u)#',
      'c',
    ],
    [[t('K', 'htmlKbd'), t('#')], '# <kbd>K</kbd>#', 'k'],
    [[image, t('#')], '# ![i](i.png)#', ''],
    [[math, t('#')], '# $x$#', 'x'],
    [[t(`Foo${NB}`, 'bold'), t('#')], `# **Foo**${NB}#`, 'foo'],
    // A previous run whose text is # is not the heading's own marker.
    [[t('#', 'bold'), t('#')], '# **#**#', ''],
    [[t('#', 'code'), t('#')], '# `#`#', ''],
    [
      [{ type: 'text', text: '#', marks: [{ type: 'link', attrs: { href: 'u' } }] }, t('#')],
      '# [#](u)#',
      '',
    ],
    [[t('C'), t('#', 'bold'), t('#')], '# C**#**#', 'c'],
    [[t('Foo '), t('#', 'bold'), t('#')], '# Foo **#**#', 'foo-'],
    [[t('#', 'bold'), t(' #')], '# **#** \\#', '-'],
    // Something follows the #, so it does not end the heading.
    [[t('Foo #'), image], '# Foo #![i](i.png)', 'foo-'],
    [[t('Foo #'), math], '# Foo #$x$', 'foo-x'],
    [[t('Foo #'), comment], '# Foo #<!-- c -->', 'foo-'],
    // Saving drops what follows the #, so it still ends the heading.
    [[t('Foo #'), { type: 'hardBreak' }], '# Foo \\#', 'foo-'],
    [[t('Foo #'), t(' ', 'bold')], '# Foo \\#', 'foo-'],
  ])('%j saves as %j with anchor %j', (content, saved, anchor) => {
    const editor = createProductionEditor();
    editor.commands.setContent({
      type: 'doc',
      content: [{ type: 'heading', attrs: { level: 1 }, content }],
    });
    expect(anchorsOf(editor)).toEqual([anchor]);
    expect(getEditorMarkdownForSync(editor)).toBe(saved);
    editor.destroy();
  });

  it.each<[string, string]>([
    ['# Foo \\#', 'foo-'],
    ['Foo #\n===', 'foo-'],
    ['# Foo &nbsp;', 'foo-'],
    ['# Foo&#32;', 'foo-'],
    ['# Foo <br>', 'foo-'],
  ])('a loaded %j keeps the anchor %j', (markdown, anchor) => {
    const editor = open(markdown);
    expect(anchorsOf(editor)).toEqual([anchor]);
    expect(getEditorMarkdownForSync(editor)).toBe(markdown);
    editor.destroy();
  });

  it('keeps a typed closing # through a save and reload', () => {
    const editor = open('# Foo');
    editor.commands.insertContentAt(4, ' #');
    const saved = getEditorMarkdownForSync(editor);
    editor.destroy();

    const reloaded = open(saved);
    expect(reloaded.state.doc.child(0).textContent).toBe('Foo #');
    expect(anchorsOf(reloaded)).toEqual(['foo-']);
    reloaded.destroy();
  });

  it.each(['# **#**#', '# `#`#', '# [#](u)#', '# Foo **#**#', '# &#35;#'])(
    'keeps %j unescaped when it is serialized again',
    markdown => {
      const loaded = open(markdown);
      const editor = createProductionEditor();
      editor.commands.setContent(loaded.getJSON());
      expect(getEditorMarkdownForSync(editor)).toBe(markdown);
      loaded.destroy();
      editor.destroy();
    }
  );

  it.each(['# **XC**#', '# `XC`#', '# [XC](u)#'])('keeps %j unescaped when it is edited', saved => {
    const editor = open(saved.replace('X', ''));
    let start = -1;
    editor.state.doc.descendants((node, pos) => {
      if (start < 0 && node.isText) start = pos;
    });
    editor.commands.insertContentAt(start, 'X');
    expect(getEditorMarkdownForSync(editor)).toBe(saved);
    editor.destroy();
  });

  it('leaves a # at the end of a paragraph alone', () => {
    const editor = createProductionEditor();
    editor.commands.setContent({
      type: 'doc',
      content: [{ type: 'paragraph', content: [t('Issue #')] }],
    });
    expect(getEditorMarkdownForSync(editor)).toBe('Issue #');
    editor.destroy();
  });

  it('escapes a closing # on a nested heading as well', () => {
    const editor = createProductionEditor();
    editor.commands.setContent({
      type: 'doc',
      content: [
        {
          type: 'blockquote',
          content: [{ type: 'heading', attrs: { level: 2 }, content: [t('Foo #')] }],
        },
      ],
    });
    expect(getEditorMarkdownForSync(editor)).toBe('> ## Foo \\#');
    editor.destroy();
  });

  it('does not offer a broken anchor for a link that still works after a typed edge space', async () => {
    const editor = open('# Foo\n\n[x](#foo)');
    editor.commands.insertContentAt(4, ' ', { updateSelection: false });
    editor.commands.setTextSelection(5);
    editor.commands.toggleBold();
    editor.commands.insertContent(' ');
    expect(await runAudit(editor)).toEqual([]);
    editor.destroy();
  });
});

// Guards the separateAdjacentCodeRuns patch. A @tiptap/markdown upgrade that renames renderNodes
// or drops empty runs turns the patch off without an error, and these rows then fail.
describe('neighbouring code runs keep their own code spans', () => {
  // A second editor, so the block is serialized instead of saving its remembered source.
  const serialized = (markdown: string): string => {
    const loaded = open(markdown);
    const editor = createProductionEditor();
    editor.commands.setContent(loaded.getJSON());
    const saved = getEditorMarkdownForSync(editor);
    loaded.destroy();
    editor.destroy();
    return saved;
  };

  it.each([
    '[`a`](#x)[`b`](#y)',
    '[`a`](#x)[`b`](#y) tail',
    '[`a`](#x)[`b`](#y)![i](i.png)',
    '[`a`](#x)[`b`](#y)**c**',
    '`x`[`a`](#y)',
    '[`a`](#y)`x`',
    '`x`[`a`](#y)`z`',
    '[`a`](#x)`b`[`c`](#y)',
    '[`a`](#x "T")[`b`](#y "U")',
    '**`a`**`b`',
    '`a`**`b`**',
    '*`a`*`b`',
    '~~`a`~~`b`',
    '**`a`***`b`*',
    '**[`a`](#x)[`b`](#y)**',
    '**`a`[`b`](#y)**',
    '*[`a`](#x)[`b`](#y)*',
    '~~[`a`](#x)[`b`](#y)~~',
    // What the two runs share stays open across them, and nesting stays valid.
    '[`a`**`b`**](#x)',
    '[**`a`**`b`](#x)',
    '[`a`~~`b`~~](#x)',
    // Each span gets a fence that fits its own text.
    '[``a`b``](#x)[`c`](#y)',
    '``a`b``[`c`](#y)',
    // Blocks other than a paragraph.
    '# [`a`](#x)[`b`](#y)',
    '- [`a`](#x)[`b`](#y)',
    '> [`a`](#x)[`b`](#y)',
    // Nothing to separate: these saved correctly before and must not change.
    '[`a` b](#x)',
    '[b `a`](#x)',
    '[`a`](#x) [`b`](#y)',
    '`a` `b`',
    '`a``b`',
    'see [`a`](#x) here',
  ])('%j saves unchanged', markdown => {
    expect(serialized(markdown)).toBe(markdown);
  });

  // Code on one side only: a separator here would change how the other marks nest.
  it.each<[string, string[], string[], string[], string]>([
    [
      'the right',
      ['link'],
      ['strike', 'link'],
      ['italic', 'strike', 'code'],
      '[a~~b~~](#x)*~~`c`~~*',
    ],
    [
      'the left',
      ['link'],
      ['strike', 'link', 'code'],
      ['italic', 'strike'],
      '[a~~`b`~~](#x)*~~c~~*',
    ],
  ])('does not separate code on %s from its neighbour', (_side, a, b, c, saved) => {
    const run = (text: string, marks: string[]): JSONContent => ({
      type: 'text',
      text,
      marks: marks.map(type => (type === 'link' ? { type, attrs: { href: '#x' } } : { type })),
    });
    const editor = createProductionEditor();
    editor.commands.setContent({
      type: 'doc',
      content: [{ type: 'paragraph', content: [run('a', a), run('b', b), run('c', c)] }],
    });
    expect(getEditorMarkdownForSync(editor)).toBe(saved);
    editor.destroy();
  });

  // Cmd+E over a selection puts the code mark on a hard break, image or math too. Those close the
  // code span by themselves, so a separator beside them would only move the space out of the code.
  describe('code on an inline node between two code runs', () => {
    const image: JSONContent = { type: 'image', attrs: { src: 'i.png', alt: 'i' } };
    const math: JSONContent = { type: 'inlineMath', attrs: { latex: 'x' } };
    const run = (text: string): JSONContent => ({ type: 'text', text });

    it.each<[string, JSONContent[], string]>([
      ['a hard break', [run('y '), { type: 'hardBreak' }, run('C')], '`y `  \n`C`'],
      ['a hard break, no space', [run('y'), { type: 'hardBreak' }, run('C')], '`y`  \n`C`'],
      ['an image', [run('y '), image, run(' C')], '`y `![i](i.png)` C`'],
      ['math', [run('y '), math, run('C')], '`y `$x$`C`'],
      [
        'an image before a run with a backtick',
        [run('a'), image, run('p`q')],
        '`a`![i](i.png)``p`q``',
      ],
    ])('%s keeps the space inside the code', (_name, content, saved) => {
      const editor = createProductionEditor();
      editor.commands.setContent({ type: 'doc', content: [{ type: 'paragraph', content }] });
      editor.commands.selectAll();
      editor.commands.toggleCode();
      expect(getEditorMarkdownForSync(editor)).toBe(saved);
      const reloaded = open(saved);
      expect(reloaded.state.doc.textContent).toBe(editor.state.doc.textContent);
      reloaded.destroy();
      editor.destroy();
    });

    // Cmd+E on the node alone, after runs that keep their own marks.
    const cmdEOn = (markdown: string, type: string): Editor => {
      const editor = open(markdown);
      let position = -1;
      editor.state.doc.descendants((node, pos) => {
        if (position < 0 && node.type.name === type) position = pos;
      });
      editor.commands.setNodeSelection(position);
      editor.commands.toggleCode();
      return editor;
    };

    it.each<[string, string, string, string]>([
      ['a link, image', '`a`[`e`](#x)![i](i.png)', 'image', '`a[e](#x)`![i](i.png)`'],
      ['a link, math', '`a`[`e`](#x)$x$', 'inlineMath', '`a[e](#x)`$x$`'],
      ['bold, image', '`a`**`g`**![i](i.png)', 'image', '`a**g**`![i](i.png)`'],
      ['three runs', '`a`**`g`**[`e`](#x)$x$', 'inlineMath', '`a**g**[e](#x)`$x$`'],
      ['four runs', '`a`**`g`**`b`[`e`](#x)$x$', 'inlineMath', '`a**g**b[e](#x)`$x$`'],
      [
        'a formatted space, comment',
        '`$`~~` `~~<!-- c -->$x$',
        'htmlCommentInline',
        '`$ `<!-- c -->``$x$',
      ],
      ['a formatted space, image', '`a`~~` `~~![i](i.png)z', 'image', '`a `![i](i.png)`z`'],
      [
        'a code space, comment',
        '[`a`](#x)` `<!-- c -->z',
        'htmlCommentInline',
        '`[a](#x) `<!-- c -->`z`',
      ],
    ])('%s: runs that lead up to the node stay one span', (_name, markdown, type, saved) => {
      const editor = cmdEOn(markdown, type);
      expect(getEditorMarkdownForSync(editor)).toBe(saved);
      editor.destroy();
    });

    it.each<[string, string, string, string]>([
      ['an image', '[`e`](#x)`a`![i](i.png)`z`', 'image', '[`e`](#x)`a`![i](i.png)`z`'],
      ['a hard break', '[`e`](#x)`a`  \n`z`', 'hardBreak', '[`e`](#x)`a`  \n`z`'],
    ])('%s after a plain last run keeps the link before it', (_name, markdown, type, saved) => {
      const editor = cmdEOn(markdown, type);
      expect(getEditorMarkdownForSync(editor)).toBe(saved);
      editor.destroy();
    });
  });

  it('keeps nested marks valid when the runs differ in formatting and link', () => {
    expect(serialized('[**`a`**](#x)[*`b`*](#y)')).toBe('**[`a`](#x)***[`b`](#y)*');
  });

  it('keeps a table cell with two code links', () => {
    expect(serialized('| [`a`](#x)[`b`](#y) |\n| - |\n| 1 |')).toContain('[`a`](#x)[`b`](#y) |');
  });

  it.each<[string, string]>([
    ['[`a`](#fooo)[`b`](#barr)', '[`Qa`](#fooo)[`b`](#barr)'],
    ['`x`[`a`](#fooo)', '`Qx`[`a`](#fooo)'],
  ])('typing into %j saves %j', (markdown, saved) => {
    const editor = open(markdown);
    editor.commands.insertContentAt(1, 'Q');
    expect(getEditorMarkdownForSync(editor)).toBe(saved);
    editor.destroy();
  });
});

describe('the link dialog when no heading can be linked to', () => {
  it('does not say the document has no headings', () => {
    (window as unknown as { vscode: unknown }).vscode = { postMessage: jest.fn() };
    Element.prototype.scrollIntoView = () => {};
    const editor = open('# 🚀\n\ngo');
    showLinkDialog(editor);
    const radio = document.querySelector('#link-mode-headings') as HTMLInputElement;
    radio.checked = true;
    radio.dispatchEvent(new Event('change'));
    (document.querySelector('#link-url-input') as HTMLInputElement).dispatchEvent(
      new Event('focus')
    );

    expect(document.querySelector('.link-dialog-autocomplete-empty')?.textContent).toBe(
      'No headings to link to'
    );
    hideLinkDialog();
    editor.destroy();
    delete (window as unknown as { vscode?: unknown }).vscode;
  });
});

describe('the underline of an older-form link', () => {
  it('is the warning colour, and every other row keeps the error colour', () => {
    const editor = new Editor({
      element: document.body.appendChild(document.createElement('div')),
      extensions: [StarterKit, DocumentAuditExtension],
      content: '<p>one two</p>',
    });
    const issue = { type: 'heading' as const, message: 'm', nodeSize: 3, target: 't' };
    editor.view.dispatch(
      editor.state.tr.setMeta(auditPluginKey, [
        { ...issue, pos: 1, olderFormAnchor: true },
        { ...issue, pos: 5 },
      ])
    );

    const spans = Array.from(editor.view.dom.querySelectorAll('.validation-error-highlight'));
    expect(
      spans.map(span => [span.textContent, span.classList.contains('validation-older-anchor')])
    ).toEqual([
      ['one', true],
      ['two', false],
    ]);
    editor.destroy();

    const css = readFileSync(resolve(__dirname, '../../webview/editor.css'), 'utf8');
    expect(css).toMatch(
      /\.validation-error-highlight\.validation-older-anchor\s*\{[^}]*text-decoration-color:\s*var\(--vscode-editorWarning-foreground/
    );
  });
});

describe('the older form and the key form, seen through real behaviour', () => {
  it('still finds the #istanbul an earlier version wrote for # İstanbul', () => {
    const anchors = buildHeadingAnchors([{ text: 'İstanbul', anchorText: 'İstanbul' }]);
    expect(resolveHeadingAnchor(anchors, 'istanbul')).toBe(0);
  });

  it('numbers older links of headings that differ only in case', () => {
    const anchors = buildHeadingAnchors([
      { text: 'Über A', anchorText: 'Über A' },
      { text: 'über a', anchorText: 'über a' },
    ]);
    expect(resolveHeadingAnchor(anchors, 'ber-a-1')).toBe(1);
  });

  it('still finds the #foo an earlier version wrote for # 🚀 Foo 🚀', () => {
    const anchors = buildHeadingAnchors([{ text: '🚀 Foo 🚀', anchorText: '🚀 Foo 🚀' }]);
    expect(resolveHeadingAnchor(anchors, 'foo')).toBe(0);
  });

  it('keeps a decomposed heading with its own decomposed link clean', async () => {
    const editor = open('# Über uns\n\n[l](#über-uns)'.normalize('NFD'));
    expect((await runAudit(editor)).filter(i => i.type === 'heading')).toEqual([]);
    editor.destroy();
  });
});

describe('the audit pill really changes the link', () => {
  let answer: (m: { type: string; requestId: string; relativePath?: string }) => void;
  beforeEach(() => {
    answer = m => {
      if (m.type === 'auditCheckFile') {
        const exists = m.relativePath === 'present.md';
        handleAuditCheckResult(m.requestId, exists, exists ? [] : ['right.md']);
      }
      if (m.type === 'auditCheckUrl') handleAuditUrlCheckResult(m.requestId, false);
    };
    (window as unknown as { vscode: unknown }).vscode = { postMessage: (m: never) => answer(m) };
  });
  afterEach(() => {
    delete (window as unknown as { vscode?: unknown }).vscode;
    document.getElementById('audit-overlay')?.remove();
    clearToasts();
  });

  // Clicks each row's first pill once. A pill that changes nothing keeps its row, so an
  // unbounded loop here would hang the whole suite instead of failing this test.
  const clickAllPills = () => {
    const rows = document.querySelectorAll('.audit-overlay-item').length;
    for (let clicked = 0; clicked < rows; clicked++) {
      document.querySelector<HTMLElement>('.audit-suggestion-pill')?.click();
    }
    const left = document.querySelectorAll('.audit-suggestion-pill').length;
    if (left > 0) throw new Error(`${left} pills left after clicking every row: a fix did nothing`);
  };

  const sc = '# Setup & Config\n\n';
  it.each<[string, string]>([
    [`${sc}[\`setup\`](#setup-config)`, `${sc}[\`setup\`](#setup--config)`],
    [`${sc}[\`setup\` guide](#setup-config)`, `${sc}[\`setup\` guide](#setup--config)`],
    [`${sc}[guide \`setup\`](#setup-config)`, `${sc}[guide \`setup\`](#setup--config)`],
    [`${sc}[\`setup\`](#setup-config "T")`, `${sc}[\`setup\`](#setup--config "T")`],
    [`${sc}[**\`setup\`**](#setup-config)`, `${sc}**[\`setup\`](#setup--config)**`],
    [`${sc}[**a** \`b\` c](#setup-config)`, `${sc}[**a** \`b\` c](#setup--config)`],
    [`${sc}[plain](#setup-config)`, `${sc}[plain](#setup--config)`],
    [`# Foo\n\n[\`a\`](#fooo)`, `# Foo\n\n[\`a\`](#foo)`],
    [`# [\`a\`](#ber-uns)\n\n# Über uns`, `# [\`a\`](#über-uns)\n\n# Über uns`],
    ['[`a`](old.md)', '[`a`](right.md)'],
    ['[`a`](old.md "T")', '[`a`](right.md "T")'],
    ['[**`a`**](old.md)', '**[`a`](right.md)**'],
    ['[`a` b](old.md)', '[`a` b](right.md)'],
    // Neighbouring code runs: the pill must not turn them into one code span.
    ['# Foo\n\n# Bar\n\n[`a`](#fooo)[`b`](#barr)', '# Foo\n\n# Bar\n\n[`a`](#foo)[`b`](#bar)'],
    ['# Foo\n\n`x`[`a`](#fooo)', '# Foo\n\n`x`[`a`](#foo)'],
    ['# Foo\n\n[`a`](#fooo)`x`', '# Foo\n\n[`a`](#foo)`x`'],
    [
      '# Foo\n\n# Bar\n\n**[`a`](#fooo)[`b`](#barr)**',
      '# Foo\n\n# Bar\n\n**[`a`](#foo)[`b`](#bar)**',
    ],
    // Two runs that end up with the same address become one run, as any two equal runs do.
    ['[`a`](old.md)[`b`](old2.md)', '[`ab`](right.md)'],
  ])('%j becomes %j', async (markdown, saved) => {
    const editor = open(markdown);
    showAuditOverlay(editor, await runAudit(editor));

    clickAllPills();

    expect(getEditorMarkdownForSync(editor)).toBe(saved);
    expect(document.querySelector('.audit-overlay-list')?.textContent).toContain('All fixed!');
    const reloaded = open(saved);
    answer = m => {
      if (m.type === 'auditCheckFile') handleAuditCheckResult(m.requestId, true);
    };
    expect(await runAudit(reloaded)).toEqual([]);
    reloaded.destroy();
    editor.destroy();
  });

  it('rewrites a URL link on code text through the manual Fix', async () => {
    const editor = open('[`a`](https://bad.invalid/)');
    showAuditOverlay(editor, await runAudit(editor));

    (document.querySelector('.audit-manual-input') as HTMLInputElement).value =
      'https://good.invalid/';
    (document.querySelector('.audit-fix-button.manual-fix') as HTMLButtonElement).click();

    expect(getEditorMarkdownForSync(editor)).toBe('[`a`](https://good.invalid/)');
    editor.destroy();
  });

  it('keeps the offered anchor resolving after a typed closing #, a save and a reload', async () => {
    const editor = open('# Foo\n\n[x](#foo)');
    editor.commands.insertContentAt(4, ' #');
    showAuditOverlay(editor, await runAudit(editor));

    (document.querySelector('.audit-suggestion-pill') as HTMLElement).click();

    const saved = getEditorMarkdownForSync(editor);
    expect(saved).toBe('# Foo \\#\n\n[x](#foo-)');
    editor.destroy();
    const reloaded = open(saved);
    expect(await runAudit(reloaded)).toEqual([]);
    reloaded.destroy();
  });

  it('fixes one run at a time, and one undo restores it', async () => {
    const editor = open(`${sc}[\`setup\` guide](#setup-config)`);
    showAuditOverlay(editor, await runAudit(editor));
    expect(document.querySelectorAll('.audit-overlay-item')).toHaveLength(2);
    editor.view.dispatch(closeHistory(editor.state.tr));

    (document.querySelector('.audit-suggestion-pill') as HTMLElement).click();

    expect(getEditorMarkdownForSync(editor)).toBe(
      `${sc}[\`setup\`](#setup--config) [guide](#setup-config)`
    );
    expect(document.querySelectorAll('.audit-overlay-item')).toHaveLength(1);
    editor.commands.undo();
    expect(getEditorMarkdownForSync(editor)).toBe(`${sc}[\`setup\` guide](#setup-config)`);
    editor.destroy();
  });

  describe('the selection', () => {
    // present.md gets no row, so the image stays and only the link is fixed.
    const doc = '# Foo\n\n![i](present.md)[`abcdef`](#fooo)';

    it.each<[string, number, number]>([
      ['a caret inside the run', 12, 12],
      ['a caret before the run', 3, 3],
      ['a range inside the run', 11, 13],
      ['a range across the heading and the run', 3, 12],
    ])('stays put: %s', async (_name, from, to) => {
      const editor = open(doc);
      showAuditOverlay(editor, await runAudit(editor));
      editor.commands.setTextSelection({ from, to });

      clickAllPills();

      expect(getEditorMarkdownForSync(editor)).toBe('# Foo\n\n![i](present.md)[`abcdef`](#foo)');
      expect([editor.state.selection.from, editor.state.selection.to]).toEqual([from, to]);
      editor.destroy();
    });

    it('stays on a selected image beside the run', async () => {
      const editor = open(doc);
      showAuditOverlay(editor, await runAudit(editor));
      editor.commands.setNodeSelection(6);

      clickAllPills();

      expect([editor.state.selection.from, editor.state.selection.to]).toEqual([6, 7]);
      expect(editor.state.selection.toJSON().type).toBe('node');
      editor.destroy();
    });

    it('comes back with one undo', async () => {
      const editor = open(doc);
      showAuditOverlay(editor, await runAudit(editor));
      editor.view.dispatch(closeHistory(editor.state.tr));
      editor.commands.setTextSelection(12);

      clickAllPills();
      editor.commands.undo();

      expect(getEditorMarkdownForSync(editor)).toBe(doc);
      expect(editor.state.selection.from).toBe(12);
      editor.destroy();
    });
  });

  describe('when the fix changes nothing', () => {
    const expectRowKept = (editor: Editor, before: string, rows: number) => {
      expect(getEditorMarkdownForSync(editor)).toBe(before);
      expect(document.querySelectorAll('.audit-overlay-item')).toHaveLength(rows);
      expect(document.querySelector('.audit-overlay-list')?.textContent).not.toContain('All fixed');
      expect(document.querySelector('.audit-overlay-title')?.textContent).toContain(
        `${rows} issue`
      );
      expect(document.querySelector('.toast-container')?.textContent).toContain(
        'Could not apply this fix. The document was not changed.'
      );
    };
    const clickFix = (value?: string) => {
      if (value !== undefined)
        (document.querySelector('.audit-manual-input') as HTMLInputElement).value = value;
      (document.querySelector('.audit-fix-button.manual-fix') as HTMLButtonElement).click();
    };

    it('an image row on the literal text ![]() keeps its row', async () => {
      const editor = open('Text ![]() more');
      const before = getEditorMarkdownForSync(editor);
      showAuditOverlay(editor, await runAudit(editor));
      clickFix('x.png');
      expectRowKept(editor, before, 1);
      editor.destroy();
    });

    it('a manual Fix with the same address keeps its row', async () => {
      const editor = open('[`a`](https://bad.invalid/)');
      const before = getEditorMarkdownForSync(editor);
      showAuditOverlay(editor, await runAudit(editor));
      clickFix();
      expectRowKept(editor, before, 1);
      editor.destroy();
    });

    it('a row whose run has no link mark keeps its row and adds no link', async () => {
      const editor = open('plain words');
      showAuditOverlay(editor, [
        {
          type: 'link',
          message: 'Stale',
          target: 'x.md',
          suggestions: ['y.md'],
          pos: 1,
          nodeSize: 5,
        },
      ]);
      (document.querySelector('.audit-suggestion-pill') as HTMLElement).click();
      expectRowKept(editor, 'plain words', 1);
      editor.destroy();
    });

    it('a row left inside a merged run keeps its row and the text intact', async () => {
      const editor = open('[ab](old.md)[cd](other.md)');
      showAuditOverlay(editor, await runAudit(editor));
      expect(document.querySelectorAll('.audit-overlay-item')).toHaveLength(2);

      // The first fix gives the first run the second run's address, so the two merge.
      const pills = document.querySelectorAll<HTMLElement>('.audit-suggestion-pill');
      pills[0].setAttribute('data-suggestion', 'other.md');
      pills[0].click();
      expect(getEditorMarkdownForSync(editor)).toBe('[abcd](other.md)');

      (document.querySelector('.audit-suggestion-pill') as HTMLElement).click();
      expectRowKept(editor, '[abcd](other.md)', 1);
      editor.destroy();
    });

    it('restores the Browse button when the picked file changes nothing', async () => {
      const editor = open('Text ![]() more');
      showAuditOverlay(editor, await runAudit(editor));
      const browse = document.querySelector('.audit-browse-btn') as HTMLButtonElement;
      answer = m => {
        if (m.type === 'auditPickFile') handleAuditPickFileResult(m.requestId, 'x.png');
      };
      browse.click();
      await new Promise(resolve => setTimeout(resolve, 0));
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(browse.disabled).toBe(false);
      expect(browse.textContent).toContain('Browse…');
      editor.destroy();
    });

    // A missing file with no similar name gets the manual Fix instead of a pill.
    const answerNoSuggestions = () => {
      answer = m => {
        if (m.type === 'auditCheckFile') handleAuditCheckResult(m.requestId, false, []);
        if (m.type === 'auditCheckUrl') handleAuditUrlCheckResult(m.requestId, false);
      };
    };

    it.each([
      ['![a](missing.png)'],
      ['![a](https://bad.invalid/x.png)'],
      ['![a](<my pic.png>)'],
      ['<img src="https://bad.invalid/x.png" width="100">'],
    ])('a manual Fix of %j with the same address keeps its row', async markdown => {
      answerNoSuggestions();
      const editor = open(markdown);
      showAuditOverlay(editor, await runAudit(editor));
      clickFix();
      expectRowKept(editor, markdown, 1);
      editor.destroy();
    });

    it('compares with the address the file holds, not the resolved one', async () => {
      answerNoSuggestions();
      const editor = createProductionEditor();
      editor.commands.setContent({
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              {
                type: 'image',
                attrs: { src: 'vscode-resource://x/missing.png', 'markdown-src': 'missing.png' },
              },
            ],
          },
        ],
      });
      showAuditOverlay(editor, await runAudit(editor));
      clickFix('missing.png');
      expectRowKept(editor, '![](missing.png)', 1);
      editor.destroy();
    });

    it('a picked image file with the same address keeps its row', async () => {
      answerNoSuggestions();
      const editor = open('![a](missing.png)');
      showAuditOverlay(editor, await runAudit(editor));
      answer = m => {
        if (m.type === 'auditPickFile') handleAuditPickFileResult(m.requestId, 'missing.png');
      };
      (document.querySelector('.audit-browse-btn') as HTMLButtonElement).click();
      await new Promise(resolve => setTimeout(resolve, 0));
      await new Promise(resolve => setTimeout(resolve, 0));
      expectRowKept(editor, '![a](missing.png)', 1);
      editor.destroy();
    });

    it.each<[string, string]>([
      ['![a](missing.png "T")', '![a](new.png "T")'],
      ['<img src="missing.png" width="100">', '<img src="new.png" alt="" width="100" />'],
    ])('still applies a different address to %j', async (markdown, saved) => {
      answerNoSuggestions();
      const editor = open(markdown);
      showAuditOverlay(editor, await runAudit(editor));
      clickFix('new.png');
      expect(getEditorMarkdownForSync(editor)).toBe(saved);
      expect(document.querySelector('.audit-overlay-list')?.textContent).toContain('All fixed!');
      // The editor shows src, and the file gets markdown-src. A fix has to change both.
      const image = editor.state.doc.firstChild?.firstChild ?? editor.state.doc.firstChild;
      expect(image?.attrs.src).toBe('new.png');
      expect(image?.attrs['markdown-src']).toBe('new.png');
      editor.destroy();
    });

    it('shows one toast however many times the fix is clicked', async () => {
      const editor = open('[`a`](https://bad.invalid/)');
      showAuditOverlay(editor, await runAudit(editor));
      clickFix();
      clickFix();
      clickFix();
      expect(document.querySelectorAll('.toast')).toHaveLength(1);
      editor.destroy();
    });
  });
});
