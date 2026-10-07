/** @jest-environment jsdom */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Editor, type JSONContent } from '@tiptap/core';
import CodeBlock from '@tiptap/extension-code-block';
import { ListKit } from '@tiptap/extension-list';
import { TableCell, TableHeader, TableRow } from '@tiptap/extension-table';
import { Markdown } from '@tiptap/markdown';
import StarterKit from '@tiptap/starter-kit';
import {
  isMarkdownRendererEquivalent,
  isMarkdownStructurallyEquivalent,
} from '../../editor/markdownAstEquivalence';
import { buildFeedbackAnchorMap } from '../../editor/feedbackAnchors';
import { BlankLinePreservation } from '../../webview/extensions/blankLinePreservation';
import { CustomImage } from '../../webview/extensions/customImage';
import { GitHubAlerts } from '../../webview/extensions/githubAlerts';
import { HtmlComment, HtmlCommentInline } from '../../webview/extensions/htmlComment';
import { HtmlPreservingTable } from '../../webview/extensions/htmlPreservingTable';
import { IndentedImageCodeBlock } from '../../webview/extensions/indentedImageCodeBlock';
import { MarkdownCode, MarkdownLink } from '../../webview/extensions/markdownCompatibilityMarks';
import { MarkdownParagraph } from '../../webview/extensions/markdownParagraph';
import { InlineMath } from '../../webview/extensions/inlineMath';
import { MathBlock } from '../../webview/extensions/mathBlock';
import { Mermaid } from '../../webview/extensions/mermaid';
import { OrderedListMarkdownFix } from '../../webview/extensions/orderedListMarkdownFix';
import { MarkdownListItem } from '../../webview/extensions/markdownListItem';
import { PreservedMarkdownLiteral } from '../../webview/extensions/preservedMarkdownLiteral';
import {
  parsePreservedCodeBlock,
  renderPreservedCodeBlock,
} from '../../webview/extensions/preservedCodeBlock';
import { SpaceFriendlyImagePaths } from '../../webview/extensions/spaceFriendlyImagePaths';
import { getEditorMarkdownForSync } from '../../webview/utils/markdownSerialization';
import { installBlankLineLexerNormalizer } from '../../webview/utils/markedLexerNormalizer';
import { enumerateCanonicalFeedbackBlocks } from '../../webview/features/feedbackReview';
import { showSvgDisplaySize } from '../../webview/features/svgDisplaySize';

const FeedbackSnapshotCodeBlock = CodeBlock.extend({
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

function createFeedbackSnapshotEditor(source: string): Editor {
  const element = document.createElement('div');
  document.body.appendChild(element);
  const editor = new Editor({
    element,
    extensions: [
      Mermaid,
      MathBlock,
      InlineMath,
      IndentedImageCodeBlock,
      SpaceFriendlyImagePaths,
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
      FeedbackSnapshotCodeBlock,
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
  editor.commands.setContent(source, { contentType: 'markdown' });
  return editor;
}

// Source-preservation bookkeeping is allowed to appear after the first save.
// Every visible node, mark, break, image destination, and display dimension must remain identical.
function imageParagraphSemantics(node: JSONContent): JSONContent {
  return {
    ...node,
    ...(node.type === 'image'
      ? {
          attrs: {
            src: node.attrs?.['markdown-src'] || node.attrs?.src,
            alt: node.attrs?.alt || '',
            title: node.attrs?.title || null,
            width: node.attrs?.width || null,
            height: node.attrs?.height || null,
            indent: node.attrs?.['indent-prefix'] || '',
          },
        }
      : {}),
    ...(node.content ? { content: node.content.map(imageParagraphSemantics) } : {}),
  };
}

function openFirstImageDisplaySize(editor: Editor): HTMLFormElement {
  let position = -1;
  editor.state.doc.descendants((node, pos) => {
    if (position < 0 && node.type.name === 'image') position = pos;
  });
  expect(position).toBeGreaterThanOrEqual(0);
  showSvgDisplaySize(editor.view.dom.querySelector('img.markdown-image')!, editor, () => position);
  const form = document.querySelector<HTMLFormElement>('form[aria-label="SVG display size"]');
  expect(form).not.toBeNull();
  return form!;
}

const inlineSizingCases = [
  ['image on same line', '![first](first.svg) ![second](second.png)'],
  ['adjacent image', '![first](first.svg)![second](second.png)'],
  [
    'blockquote continuation',
    '> ![first](first.svg)\n> **bold** [link](https://example.com) `code`',
  ],
  ['image on soft-break line', '![first](first.svg)\n![second](second.svg)'],
  ['image on hard-break line', '![first](first.svg)  \n![second](second.png)'],
  ['marks on same line', '![first](first.svg) **bold** [link](https://example.com) `code`'],
  [
    'marks on hard-break line',
    '![first](first.svg)  \n**bold** [link](https://example.com) `code`',
  ],
  ['multiple lines', '![first](first.svg)\n![second](second.png)\n**bold** and `code`'],
  ['bullet continuation', '- ![first](first.svg)\n  ![second](second.png) **bold**'],
  [
    'ordered continuation',
    '1. ![first](first.svg)\n   **bold** [link](https://example.com) `code`',
  ],
  ['nested list', '- Parent\n  - ![first](first.svg)\n    ![second](second.png) **bold**'],
  [
    'table cell',
    '| Images |\n| --- |\n| ![first](first.svg) ![second](second.png) **bold** [link](https://example.com) `code` |',
  ],
  ['indented images', '    ![first](first.svg)\n    ![second](second.svg)'],
  ['tab-indented images', '\t![first](first.svg)\n\t![second](second.svg)'],
] as const;

describe('Feedback snapshot renderer round-trip', () => {
  afterEach(() => document.body.replaceChildren());

  it('keeps the unchanged contribution guide equivalent with exact source anchors', () => {
    const source = readFileSync(resolve(__dirname, '../../../CONTRIBUTING.md'), 'utf8');
    const editor = createFeedbackSnapshotEditor(source);
    try {
      const serialized = `${getEditorMarkdownForSync(editor, 'strip')}\n`;
      expect(isMarkdownRendererEquivalent(serialized, source)).toBe(true);
      expect(buildFeedbackAnchorMap(source, enumerateCanonicalFeedbackBlocks(editor))).toEqual(
        expect.objectContaining({ ok: true })
      );
    } finally {
      editor.destroy();
    }
  });

  it('keeps HTML comments with exact source anchors', () => {
    const source = [
      '# Comments',
      '',
      '<!-- medium: export as image -->',
      '| A | B |',
      '|---|---|',
      '| 1 | 2 |',
      '',
      'Between.',
      '',
      '<!--',
      'multi-line note',
      '-->',
      '',
      'After.',
      '',
    ].join('\n');
    const editor = createFeedbackSnapshotEditor(source);
    try {
      const serialized = `${getEditorMarkdownForSync(editor, 'strip')}\n`;
      expect(isMarkdownRendererEquivalent(serialized, source)).toBe(true);
      expect(buildFeedbackAnchorMap(source, enumerateCanonicalFeedbackBlocks(editor))).toEqual(
        expect.objectContaining({ ok: true })
      );
    } finally {
      editor.destroy();
    }
  });

  it('keeps nested and inline HTML comments with exact source anchors', () => {
    const source = [
      '# Title <!-- heading note -->',
      '',
      'Text <!-- inline --> more.',
      '',
      '- item',
      '  <!-- in list -->',
      '- next <!-- trailing -->',
      '',
      'Tasks:',
      '',
      '- [ ] task <!-- task inline -->',
      '  <!-- in task -->',
      '',
      '> quoted',
      '>',
      '> <!-- in quote -->',
      '',
      'After.',
      '',
    ].join('\n');
    const editor = createFeedbackSnapshotEditor(source);
    try {
      const serialized = `${getEditorMarkdownForSync(editor, 'strip')}\n`;
      expect(serialized).toContain('<!-- in list -->');
      expect(serialized).toContain('<!-- in quote -->');
      expect(serialized).toContain('Text <!-- inline --> more.');
      expect(isMarkdownRendererEquivalent(serialized, source)).toBe(true);
      expect(buildFeedbackAnchorMap(source, enumerateCanonicalFeedbackBlocks(editor))).toEqual(
        expect.objectContaining({ ok: true })
      );
    } finally {
      editor.destroy();
    }
  });

  it.each([
    ['bullet child', '1. Parent\n   - Child\n'],
    ['numbered child', '1. Parent\n   1. Child\n'],
    ['non-default start', '4. Parent\n   - Child\n'],
    ['zero start', '0. Parent\n   - Child\n'],
    ['two-digit start', '10. Parent\n    - Child\n'],
    ['digit-width transition', '9. Parent\n   - First\n10. Next\n    - Second\n'],
    ['deep mixed nesting', '1. Parent\n   - Child\n     1. Grandchild\n        - Leaf\n'],
    ['continuation paragraph', '10. First paragraph\n\n    Second paragraph\n'],
    ['nested fenced code', '10. Example\n\n    ```js\n    const value = "a  b";\n    ```\n'],
    ['bullet-list control', '- Parent\n  - Child\n'],
    ['task-list child', '1. Parent\n   - [ ] Pending\n   - [x] Done\n'],
  ])('preserves %s across repeated Markdown round trips', (_name, source) => {
    const editor = createFeedbackSnapshotEditor(source);
    try {
      const originalTree = editor.getJSON();
      const serialized = `${getEditorMarkdownForSync(editor, 'strip')}\n`;
      expect(isMarkdownRendererEquivalent(serialized, source)).toBe(true);
      editor.commands.setContent(serialized, { contentType: 'markdown' });
      expect(editor.getJSON()).toEqual(originalTree);
      expect(`${getEditorMarkdownForSync(editor, 'strip')}\n`).toBe(serialized);
    } finally {
      editor.destroy();
    }
  });

  it('keeps mixed local image formats renderer-equivalent after an authoritative apply', () => {
    const source = [
      '# Feedback image matrix',
      '',
      '## PNG with spaces and Unicode',
      '',
      '![PNG with a spaced Unicode path](assets/icon space ünicode.png)',
      '',
      '## Large PNG',
      '',
      '![Large PNG](assets/large.png)',
      '',
      '## JPEG',
      '',
      '![JPEG](assets/photo.jpg)',
      '',
      '## Animated GIF',
      '',
      '![Animated GIF](assets/animated.gif)',
      '',
      '## SVG',
      '',
      '![SVG](local-image.svg)',
      '',
      '## Table',
      '',
      '| Format | Expected |',
      '| --- | --- |',
      '| PNG | visible |',
      '| JPEG | visible |',
      '| GIF | visible |',
      '| SVG | visible |',
      '',
      '## Formula',
      '',
      '$$',
      'E = mc^2 + \\frac{a}{b}',
      '$$',
      '',
      '## Mermaid',
      '',
      '```mermaid',
      'flowchart LR',
      '  Image --> Capture',
      '```',
      '',
    ].join('\n');
    const editor = createFeedbackSnapshotEditor(source);

    const serialized = `${getEditorMarkdownForSync(editor, 'strip')}\n`;

    expect(isMarkdownRendererEquivalent(serialized, source)).toBe(true);
    editor.destroy();
  });

  it.each([
    ['standalone', '<img src="diagram.svg#view" alt="Résumé &amp; diagram" width="480" />\n'],
    [
      'authored quotes and dimensions',
      "<img height='210' src='diagram.svg?revision=2#view' width='480' alt='A > B' />\n",
    ],
    ['multiline tag', '<img\n src="diagram.svg"\n alt="diagram" width="480" />\n'],
    ['adjacent HTML image lines', "<img src='a.svg' width='320'>\n<img src='b.svg' width='240'>\n"],
    ['inline prose', 'Before <img src="diagram.svg" alt="diagram" width="480" /> after.\n'],
    ['bullet item', '- Before <img src="diagram.svg" alt="diagram" width="480" /> after.\n'],
    ['nested list', '1. Parent\n   - <img src="diagram.svg" alt="diagram" width="480" />\n'],
    [
      'table cell',
      '| Image | Description |\n| --- | --- |\n| <img src="diagram.svg" alt="A &amp; B" width="480" /> | SVG |\n',
    ],
    [
      'neighboring images',
      '<img src="diagram.svg" width="480" />\n\n![PNG](raster.png)\n\n<img src="second.svg" width="240" />\n',
    ],
  ])(
    'keeps sized SVG HTML in %s exact and Feedback-anchorable after repeated round trips',
    (_name, source) => {
      const editor = createFeedbackSnapshotEditor(source);
      try {
        const originalTree = editor.getJSON();
        let serialized = `${getEditorMarkdownForSync(editor, 'strip')}\n`;
        if (
          _name === 'neighboring images' ||
          _name === 'multiline tag' ||
          _name === 'adjacent HTML image lines'
        )
          expect(serialized).toBe(source);
        expect(isMarkdownRendererEquivalent(serialized, source)).toBe(true);
        expect(buildFeedbackAnchorMap(source, enumerateCanonicalFeedbackBlocks(editor))).toEqual(
          expect.objectContaining({ ok: true })
        );
        for (let iteration = 0; iteration < 3; iteration++) {
          editor.commands.setContent(serialized, { contentType: 'markdown' });
          expect(editor.getJSON()).toEqual(originalTree);
          const next = `${getEditorMarkdownForSync(editor, 'strip')}\n`;
          expect(next).toBe(serialized);
          expect(isMarkdownRendererEquivalent(next, source)).toBe(true);
          expect(buildFeedbackAnchorMap(source, enumerateCanonicalFeedbackBlocks(editor))).toEqual(
            expect.objectContaining({ ok: true })
          );
          serialized = next;
        }
      } finally {
        editor.destroy();
      }
    }
  );

  describe.each(['preserve', 'strip'] as const)('inline SVG sizing with %s blank lines', mode => {
    it.each(inlineSizingCases)(
      'keeps %s through Display size, undo/redo, two saves and reset',
      (_name, source) => {
        const editor = createFeedbackSnapshotEditor(source);
        try {
          const original = imageParagraphSemantics(editor.getJSON());
          // Feedback already rejects unchanged indented image paragraphs as code.
          // Keep that boundary explicit while requiring their image semantics to
          // survive sizing. All supported ordinary/list/table paragraphs map normally.
          const expectedAnchors = /^(?: {4}|\t)/.test(source)
            ? expect.objectContaining({
                ok: false,
                error: expect.objectContaining({ reason: 'invalid-canonical-block' }),
              })
            : expect.objectContaining({ ok: true });
          expect(buildFeedbackAnchorMap(source, enumerateCanonicalFeedbackBlocks(editor))).toEqual(
            expectedAnchors
          );
          const form = openFirstImageDisplaySize(editor);
          form.querySelector('input')!.value = '480';
          form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
          expect(form.isConnected).toBe(false);
          const sizedTree = imageParagraphSemantics(editor.getJSON());
          const sized = getEditorMarkdownForSync(editor, mode);
          expect(sized).toContain('width="480"');
          expect(editor.commands.undo()).toBe(true);
          expect(imageParagraphSemantics(editor.getJSON())).toEqual(original);
          expect(editor.commands.redo()).toBe(true);
          expect(imageParagraphSemantics(editor.getJSON())).toEqual(sizedTree);
          for (let iteration = 0; iteration < 2; iteration++) {
            editor.commands.setContent(sized, { contentType: 'markdown' });
            expect(imageParagraphSemantics(editor.getJSON())).toEqual(sizedTree);
            expect(getEditorMarkdownForSync(editor, mode)).toBe(sized);
            expect(buildFeedbackAnchorMap(sized, enumerateCanonicalFeedbackBlocks(editor))).toEqual(
              expectedAnchors
            );
          }
          openFirstImageDisplaySize(editor)
            .querySelector<HTMLButtonElement>('[data-action="reset-size"]')!
            .click();
          expect(imageParagraphSemantics(editor.getJSON())).toEqual(original);
          const reset = getEditorMarkdownForSync(editor, mode);
          editor.commands.setContent(reset, { contentType: 'markdown' });
          expect(imageParagraphSemantics(editor.getJSON())).toEqual(original);
        } finally {
          editor.destroy();
        }
      }
    );
  });

  it('preserves an unsized indented image paragraph through the sync serializer', () => {
    const editor = createFeedbackSnapshotEditor(
      '    ![first](first.svg)\n    ![second](second.svg)'
    );
    try {
      const original = imageParagraphSemantics(editor.getJSON());
      const source = getEditorMarkdownForSync(editor, 'strip');
      expect(source).toMatch(/^ {4}!\[first\]/);
      editor.commands.setContent(source, { contentType: 'markdown' });
      expect(editor.view.dom.querySelectorAll('img.markdown-image')).toHaveLength(2);
      expect(editor.state.doc.textContent).toBe('');
      expect(imageParagraphSemantics(editor.getJSON())).toEqual(original);
    } finally {
      editor.destroy();
    }
  });

  it('keeps authored HTML block Markdown literal rather than reinterpreting it as inline Markdown', () => {
    const editor = createFeedbackSnapshotEditor(
      '<img src="first.svg" width="320">\n**literal** ![literal](second.svg)'
    );
    try {
      expect(editor.state.doc.textContent).toContain('**literal** ![literal](second.svg)');
      expect(editor.view.dom.querySelectorAll('img.markdown-image')).toHaveLength(1);
      expect(editor.view.dom.querySelector('strong')).toBeNull();
    } finally {
      editor.destroy();
    }
  });

  it('changes one adjacent HTML image size while retaining the other image and source separator', () => {
    const source = "<img src='a.svg' width='320'>\n<img src='b.svg' width='240'>\n";
    const editor = createFeedbackSnapshotEditor(source);
    try {
      let position = -1;
      editor.state.doc.descendants((node, pos) => {
        if (node.type.name === 'image' && node.attrs.src === 'b.svg') position = pos;
      });
      const node = editor.state.doc.nodeAt(position)!;
      editor.view.dispatch(
        editor.state.tr.setNodeMarkup(position, undefined, { ...node.attrs, width: 480 })
      );
      const resized = `${getEditorMarkdownForSync(editor, 'strip')}\n`;
      expect(resized).toBe(
        '<img src=\'a.svg\' width=\'320\'>\n<img src="b.svg" alt="" width="480" />\n'
      );
      expect(isMarkdownRendererEquivalent(resized, source)).toBe(false);
      editor.commands.setContent(resized, { contentType: 'markdown' });
      expect(`${getEditorMarkdownForSync(editor, 'strip')}\n`).toBe(resized);
      expect(buildFeedbackAnchorMap(resized, enumerateCanonicalFeedbackBlocks(editor))).toEqual(
        expect.objectContaining({ ok: true })
      );
    } finally {
      editor.destroy();
    }
  });

  it('keeps consecutive Markdown SVG and raster images in separate paragraphs', () => {
    const source = '![SVG](diagram.svg)\n\n![Raster](photo.png)\n\n![Icon](icon.svg)\n';
    const editor = createFeedbackSnapshotEditor(source);
    try {
      expect(editor.state.doc.childCount).toBe(3);
      expect(`${getEditorMarkdownForSync(editor, 'strip')}\n`).toBe(source);
      expect(buildFeedbackAnchorMap(source, enumerateCanonicalFeedbackBlocks(editor))).toEqual(
        expect.objectContaining({ ok: true })
      );
    } finally {
      editor.destroy();
    }
  });

  it('accepts the complete Extension Host SVG regression fixture', () => {
    const source = [
      '# SVG host regression',
      '',
      '![viewBox-only SVG](assets/viewbox.svg)',
      '',
      '![Marp text remains alt text w:1000](assets/viewbox.svg)',
      '',
      '![Encoded filename and SVG view](assets/diagram%20%23%20view.svg#detail)',
      '',
      '<img src="assets/viewbox.svg" alt="Sized diagram" width="480" height="210" />',
      '',
      '<img',
      ' src="assets/viewbox.svg"',
      ' alt="Multiline source" width="320" />',
      '',
      '- Inline SVG <img src="assets/icon.svg" alt="Icon" width="24" /> in a list.',
      '',
      '| Image | Description |',
      '| --- | --- |',
      '| <img src="assets/viewbox.svg" alt="Table diagram" width="240" /> | Vector |',
      '',
      'A final paragraph keeps the document boundary explicit.',
      '',
    ].join('\n');
    const editor = createFeedbackSnapshotEditor(source);
    try {
      const serialized = `${getEditorMarkdownForSync(editor, 'strip')}\n`;
      expect(isMarkdownRendererEquivalent(serialized, source)).toBe(true);
      expect(buildFeedbackAnchorMap(source, enumerateCanonicalFeedbackBlocks(editor))).toEqual(
        expect.objectContaining({ ok: true })
      );
    } finally {
      editor.destroy();
    }
  });

  it('treats an SVG display-size edit as a semantic source change', () => {
    const source = '<img src="diagram.svg" alt="diagram" width="480" />\n';
    const editor = createFeedbackSnapshotEditor(source);
    try {
      let imagePosition: number | undefined;
      editor.state.doc.descendants((node, pos) => {
        if (node.type.name === 'image') imagePosition = pos;
      });
      expect(imagePosition).toBeDefined();
      const image = editor.state.doc.nodeAt(imagePosition!);
      editor.view.dispatch(
        editor.state.tr.setNodeMarkup(imagePosition!, undefined, { ...image?.attrs, width: 640 })
      );
      const resized = `${getEditorMarkdownForSync(editor, 'strip')}\n`;
      expect(resized).toContain('width="640"');
      expect(isMarkdownRendererEquivalent(resized, source)).toBe(false);
      expect(isMarkdownStructurallyEquivalent(resized, source)).toBe(false);
    } finally {
      editor.destroy();
    }
  });

  it('accepts TipTap hard-break serialization for a source soft wrap', () => {
    const source = [
      'Requires VS Code 1.98.0 or newer in a trusted workspace. Compatible',
      'VS Code derivatives must provide the same webview APIs.',
      '',
    ].join('\n');
    const editor = createFeedbackSnapshotEditor(source);

    const serialized = `${getEditorMarkdownForSync(editor, 'strip')}\n`;

    expect(serialized).toContain('Compatible  \nVS Code derivatives');
    expect(isMarkdownStructurallyEquivalent(serialized, source)).toBe(false);
    expect(isMarkdownRendererEquivalent(serialized, source)).toBe(true);
    editor.destroy();
  });

  it.each([
    ['italic soft wrap', '*A marked first line\ncontinues on the next line.*\n'],
    ['bold soft wrap', '**A marked first line\ncontinues on the next line.**\n'],
    ['italic hard break', '*A marked first line  \ncontinues on the next line.*\n'],
    ['bold hard break', '**A marked first line  \ncontinues on the next line.**\n'],
    ['nested marks', '***A marked first line\ncontinues on the next line.***\n'],
    [
      'partially nested marks',
      '*An italic lead with **bold text\ncontinuing in bold** and an italic tail.*\n',
    ],
    ['italic list continuation', '- *A marked list item\n  continues on the next line.*\n'],
    [
      'bold numbered-list hard break',
      '1. **A marked list item  \n   continues on the next line.**\n',
    ],
  ])('accepts unchanged %s with exact source anchors', (_name, source) => {
    const editor = createFeedbackSnapshotEditor(source);
    try {
      const originalTree = editor.getJSON();
      const serialized = `${getEditorMarkdownForSync(editor, 'strip')}\n`;

      expect(serialized).not.toBe(source);
      expect(isMarkdownRendererEquivalent(serialized, source)).toBe(true);
      expect(buildFeedbackAnchorMap(source, enumerateCanonicalFeedbackBlocks(editor))).toEqual(
        expect.objectContaining({ ok: true })
      );

      editor.commands.setContent(serialized, { contentType: 'markdown' });
      expect(editor.getJSON()).toEqual(originalTree);
      expect(`${getEditorMarkdownForSync(editor, 'strip')}\n`).toBe(serialized);
    } finally {
      editor.destroy();
    }
  });

  it('keeps the long README renderer-equivalent after an authoritative apply', () => {
    const source = readFileSync(resolve(__dirname, '../../../README.md'), 'utf8');
    const editor = createFeedbackSnapshotEditor(source);

    const serialized = `${getEditorMarkdownForSync(editor, 'strip')}\n`;
    const blocks = enumerateCanonicalFeedbackBlocks(editor);

    expect(isMarkdownRendererEquivalent(serialized, source)).toBe(true);
    expect(buildFeedbackAnchorMap(source, blocks)).toEqual(expect.objectContaining({ ok: true }));
    editor.destroy();
  });

  it('does not HTML-escape a literal ampersand in prose text', () => {
    const source = [
      '# AGENTS.md',
      '',
      '## Personality & Communication Protocol',
      '',
      'Terms & Conditions apply to Q&A sessions for R&D and AT&T alike.',
      '',
    ].join('\n');
    const editor = createFeedbackSnapshotEditor(source);

    const serialized = `${getEditorMarkdownForSync(editor, 'strip')}\n`;

    expect(serialized).toContain('## Personality & Communication Protocol');
    expect(serialized).toContain(
      'Terms & Conditions apply to Q&A sessions for R&D and AT&T alike.'
    );
    expect(serialized).not.toContain('&amp;');
    editor.destroy();
  });

  it('leaves a literal "&amp;" written inside a code span untouched', () => {
    const source = ['Use `&amp;` for a literal ampersand entity.', ''].join('\n');
    const editor = createFeedbackSnapshotEditor(source);

    const serialized = `${getEditorMarkdownForSync(editor, 'strip')}\n`;

    expect(serialized).toContain('`&amp;`');
    editor.destroy();
  });

  it('does not turn a bare GFM autolink into an explicit Markdown link', () => {
    const source = [
      'Instances may be reported to the community leaders responsible for',
      'enforcement at support@concret.io. All complaints will be reviewed.',
      '',
      'See https://example.com or www.example.com for details.',
      '',
    ].join('\n');
    const editor = createFeedbackSnapshotEditor(source);

    const serialized = `${getEditorMarkdownForSync(editor, 'strip')}\n`;

    expect(serialized).toContain('enforcement at support@concret.io. All complaints');
    expect(serialized).toContain('See https://example.com or www.example.com for details.');
    expect(serialized).not.toContain('[support@concret.io]');
    expect(serialized).not.toContain('[https://example.com]');
    expect(serialized).not.toContain('[www.example.com]');
    editor.destroy();
  });

  it('still renders an explicit Markdown link with its bracketed syntax', () => {
    const source = ['Contact us via [support](mailto:support@concret.io) for help.', ''].join('\n');
    const editor = createFeedbackSnapshotEditor(source);

    const serialized = `${getEditorMarkdownForSync(editor, 'strip')}\n`;

    expect(serialized).toContain('[support](mailto:support@concret.io)');
    editor.destroy();
  });

  // A four-space indented code block stopped Feedback from starting, with a
  // message that blamed mixed task lists.
  it.each([
    ['alone', '    code line one\n    code line two\n'],
    ['after a paragraph', 'Para.\n\n    code line\n'],
    ['after a fenced block', '```\nfenced\n```\n\n    indented\n'],
    ['inside the feature tour', readManualFeatureTourCodeSection()],
  ])('anchors an indented code block %s', (_label, source) => {
    const editor = createFeedbackSnapshotEditor(source);
    try {
      expect(buildFeedbackAnchorMap(source, enumerateCanonicalFeedbackBlocks(editor))).toEqual(
        expect.objectContaining({ ok: true })
      );
    } finally {
      editor.destroy();
    }
  });
});

describe('Indented code block save', () => {
  afterEach(() => document.body.replaceChildren());

  // The per-block serializer trimmed leading whitespace, so the first line lost
  // its four-space indent and the edited code block saved as a paragraph.
  it('keeps an edited indented code block indented on save', () => {
    const editor = createFeedbackSnapshotEditor('Para.\n\n    code line\n    second\n');
    try {
      let codePosition = -1;
      editor.state.doc.descendants((node, position) => {
        if (codePosition < 0 && node.type.name === 'codeBlock') codePosition = position;
      });
      editor
        .chain()
        .insertContentAt(codePosition + 1, 'X')
        .run();

      expect(getEditorMarkdownForSync(editor, 'strip')).toBe('Para.\n\n    Xcode line\n    second');
    } finally {
      editor.destroy();
    }
  });
});

describe('Linked image', () => {
  afterEach(() => document.body.replaceChildren());

  // TipTap applies a link mark to text only, so an image inside a link lost the
  // link when its paragraph was edited and saved.
  it.each([
    ['plain', '[![Icon](icon.png)](https://example.com)'],
    ['with a link title', '[![Icon](icon.png)](https://example.com "Home page")'],
    ['with an image title', '[![Icon](icon.png "Logo")](https://example.com)'],
  ])('keeps the link on an edited paragraph (%s)', (_label, linkedImage) => {
    const editor = createFeedbackSnapshotEditor(`Intro ${linkedImage} tail.\n`);
    try {
      editor.chain().insertContentAt(1, 'X').run();

      expect(getEditorMarkdownForSync(editor, 'strip')).toBe(`XIntro ${linkedImage} tail.`);
    } finally {
      editor.destroy();
    }
  });

  it('lets Feedback match a paragraph that holds a linked image', () => {
    const source = 'Intro.\n\n[![Icon](icon.png)](https://example.com)\n';
    const editor = createFeedbackSnapshotEditor(source);
    try {
      const blocks = enumerateCanonicalFeedbackBlocks(editor);
      expect(buildFeedbackAnchorMap(source, blocks)).toEqual(expect.objectContaining({ ok: true }));
      expect(blocks[1].markdown).toBe('[![Icon](icon.png)](https://example.com)');
    } finally {
      editor.destroy();
    }
  });

  it('leaves an unlinked image without link syntax', () => {
    const editor = createFeedbackSnapshotEditor('Intro ![Icon](icon.png) tail.\n');
    try {
      editor.chain().insertContentAt(1, 'X').run();

      expect(getEditorMarkdownForSync(editor, 'strip')).toBe('XIntro ![Icon](icon.png) tail.');
    } finally {
      editor.destroy();
    }
  });
});

function readManualFeatureTourCodeSection(): string {
  const tour = readFileSync(resolve(__dirname, '../../../test/manual/feature-tour.md'), 'utf8');
  const start = tour.indexOf('## 6. Code blocks');
  const end = tour.indexOf('## 7. Diagrams');
  return tour.slice(start, end);
}
