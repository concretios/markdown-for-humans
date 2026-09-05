/** @jest-environment jsdom */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Editor } from '@tiptap/core';
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
import { HtmlPreservingTable } from '../../webview/extensions/htmlPreservingTable';
import { IndentedImageCodeBlock } from '../../webview/extensions/indentedImageCodeBlock';
import { MarkdownCode, MarkdownLink } from '../../webview/extensions/markdownCompatibilityMarks';
import { MarkdownParagraph } from '../../webview/extensions/markdownParagraph';
import { InlineMath } from '../../webview/extensions/inlineMath';
import { MathBlock } from '../../webview/extensions/mathBlock';
import { Mermaid } from '../../webview/extensions/mermaid';
import { OrderedListMarkdownFix } from '../../webview/extensions/orderedListMarkdownFix';
import { PreservedMarkdownLiteral } from '../../webview/extensions/preservedMarkdownLiteral';
import {
  parsePreservedCodeBlock,
  renderPreservedCodeBlock,
} from '../../webview/extensions/preservedCodeBlock';
import { SpaceFriendlyImagePaths } from '../../webview/extensions/spaceFriendlyImagePaths';
import { getEditorMarkdownForSync } from '../../webview/utils/markdownSerialization';
import { installBlankLineLexerNormalizer } from '../../webview/utils/markedLexerNormalizer';
import { enumerateCanonicalFeedbackBlocks } from '../../webview/features/feedbackReview';

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
      MarkdownCode,
      PreservedMarkdownLiteral,
      FeedbackSnapshotCodeBlock,
      BlankLinePreservation,
      Markdown.configure({ markedOptions: { gfm: true, breaks: true } }),
      HtmlPreservingTable,
      TableRow,
      TableHeader,
      TableCell,
      ListKit.configure({ orderedList: false, taskItem: { nested: true } }),
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

describe('Feedback snapshot renderer round-trip', () => {
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
});
