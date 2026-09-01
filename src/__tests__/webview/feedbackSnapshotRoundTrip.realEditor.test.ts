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
});
