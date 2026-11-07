/**
 * Copyright (c) 2025-2026 Concret.io
 *
 * Licensed under the MIT License. See LICENSE file in the project root for details.
 */

/**
 * @file productionEditor.ts - A test editor that parses and saves like the product
 * @description Real-editor tests that hand-copy the extension list drift away
 *              from `src/webview/editor.ts`. Tests about what is loaded or saved
 *              should build their editor here instead.
 */

import { Editor } from '@tiptap/core';
import { ListKit } from '@tiptap/extension-list';
import { TableCell, TableHeader, TableRow } from '@tiptap/extension-table';
import { Markdown } from '@tiptap/markdown';
import StarterKit from '@tiptap/starter-kit';
import { BlankLinePreservation } from '../../webview/extensions/blankLinePreservation';
import { CodeBlockWithCopy } from '../../webview/extensions/codeBlockWithCopy';
import { CustomImage } from '../../webview/extensions/customImage';
import { GitHubAlerts } from '../../webview/extensions/githubAlerts';
import { HtmlComment, HtmlCommentInline } from '../../webview/extensions/htmlComment';
import { HtmlPreservingTable } from '../../webview/extensions/htmlPreservingTable';
import { IndentedImageCodeBlock } from '../../webview/extensions/indentedImageCodeBlock';
import { HtmlKbd, HtmlSub, HtmlSup } from '../../webview/extensions/inlineHtmlMarks';
import { InlineMath } from '../../webview/extensions/inlineMath';
import { MarkdownCode, MarkdownLink } from '../../webview/extensions/markdownCompatibilityMarks';
import { MarkdownListItem } from '../../webview/extensions/markdownListItem';
import { MarkdownParagraph } from '../../webview/extensions/markdownParagraph';
import { MarkdownTaskList } from '../../webview/extensions/markdownTaskList';
import { MathBlock } from '../../webview/extensions/mathBlock';
import { Mermaid } from '../../webview/extensions/mermaid';
import { OrderedListMarkdownFix } from '../../webview/extensions/orderedListMarkdownFix';
import { PreservedMarkdownLiteral } from '../../webview/extensions/preservedMarkdownLiteral';
import { SpaceFriendlyImagePaths } from '../../webview/extensions/spaceFriendlyImagePaths';
import { TableCellEnterHardBreak } from '../../webview/extensions/tableCellEnterHardBreak';
import { shouldAutoLink } from '../../webview/utils/linkValidation';
import { installBlankLineLexerNormalizer } from '../../webview/utils/markedLexerNormalizer';

/**
 * The parse and serialize extensions of `src/webview/editor.ts`, in its order.
 * Keyboard, drag and audit extensions are left out: they do not parse or save.
 */
export function createProductionEditor(): Editor {
  const element = document.createElement('div');
  document.body.appendChild(element);
  const editor = new Editor({
    element,
    extensions: [
      InlineMath,
      MathBlock,
      Mermaid,
      IndentedImageCodeBlock,
      SpaceFriendlyImagePaths,
      GitHubAlerts,
      StarterKit.configure({
        heading: { levels: [1, 2, 3, 4, 5, 6] },
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
      HtmlKbd,
      HtmlSub,
      HtmlSup,
      MarkdownCode,
      PreservedMarkdownLiteral,
      CodeBlockWithCopy.configure({ workerUri: '', defaultLanguage: 'plaintext' }),
      BlankLinePreservation,
      Markdown.configure({ markedOptions: { gfm: true, breaks: true } }),
      HtmlPreservingTable.configure({ resizable: false }),
      TableRow,
      TableHeader,
      TableCell,
      TableCellEnterHardBreak,
      ListKit.configure({
        listItem: false,
        orderedList: false,
        taskList: false,
        taskItem: { nested: true },
      }),
      MarkdownTaskList,
      MarkdownListItem,
      OrderedListMarkdownFix,
      MarkdownLink.configure({ openOnClick: false, shouldAutoLink }),
      CustomImage,
    ],
    content: '',
    contentType: 'markdown',
  });
  const storage = editor as unknown as {
    markdown?: { instance?: unknown };
    storage?: { markdown?: { instance?: unknown } };
  };
  const instance = storage.markdown?.instance ?? storage.storage?.markdown?.instance;
  if (instance) installBlankLineLexerNormalizer(instance);
  return editor;
}
