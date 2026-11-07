/**
 * Real TipTap editor for paste tests: paragraphs, headings, lists, links, code
 * blocks and tables, with the same Markdown options as the shipped editor.
 */

import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from '@tiptap/markdown';
import { ListKit } from '@tiptap/extension-list';
import { TableCell, TableHeader, TableRow } from '@tiptap/extension-table';
import { MarkdownParagraph } from '../../webview/extensions/markdownParagraph';
import { OrderedListMarkdownFix } from '../../webview/extensions/orderedListMarkdownFix';
import { MarkdownListItem } from '../../webview/extensions/markdownListItem';
import { PreservedMarkdownLiteral } from '../../webview/extensions/preservedMarkdownLiteral';
import { MarkdownLink, MarkdownCode } from '../../webview/extensions/markdownCompatibilityMarks';
import { HtmlPreservingTable } from '../../webview/extensions/htmlPreservingTable';
import { CodeBlockWithCopy } from '../../webview/extensions/codeBlockWithCopy';
import { TableCellEnterHardBreak } from '../../webview/extensions/tableCellEnterHardBreak';
import { setMarkdownContentPreservingSource } from '../../webview/utils/markdownSerialization';

export function createPasteTestEditor(markdown = ''): Editor {
  const element = document.createElement('div');
  document.body.appendChild(element);
  const editor = new Editor({
    element,
    extensions: [
      StarterKit.configure({
        paragraph: false,
        codeBlock: false,
        bulletList: false,
        orderedList: false,
        listItem: false,
        listKeymap: false,
        link: false,
        code: false,
      }),
      MarkdownParagraph,
      PreservedMarkdownLiteral,
      CodeBlockWithCopy.configure({ workerUri: '', defaultLanguage: 'plaintext' }),
      MarkdownLink,
      MarkdownCode,
      Markdown.configure({ markedOptions: { gfm: true, breaks: true } }),
      HtmlPreservingTable.configure({ resizable: false }),
      TableRow,
      TableHeader,
      TableCell,
      TableCellEnterHardBreak,
      ListKit.configure({ listItem: false, orderedList: false, taskItem: { nested: true } }),
      MarkdownListItem,
      OrderedListMarkdownFix,
    ],
    content: '',
    contentType: 'markdown',
  });
  if (markdown) setMarkdownContentPreservingSource(editor, markdown);
  return editor;
}

/** Put the caret right after the first occurrence of `text` in the document. */
export function placeCaretAfter(editor: Editor, text: string): void {
  editor.commands.setTextSelection(endOf(editor, text));
}

/** Select the first occurrence of `text` in the document. */
export function selectText(editor: Editor, text: string): void {
  const to = endOf(editor, text);
  editor.commands.setTextSelection({ from: to - text.length, to });
}

function endOf(editor: Editor, text: string): number {
  let end = -1;
  editor.state.doc.descendants((node, pos) => {
    if (end >= 0 || !node.isText) return;
    const index = (node.text ?? '').indexOf(text);
    if (index >= 0) end = pos + index + text.length;
  });
  if (end < 0) throw new Error(`No text "${text}" in the document`);
  return end;
}

/**
 * Top-level blocks as `type: text`, with `⏎` for a hard break.
 *
 * TipTap keeps an empty paragraph after a final heading, list, code block or
 * table so the caret can leave it. That paragraph is left out.
 */
export function blocks(editor: Editor): string[] {
  const result: string[] = [];
  const { doc } = editor.state;
  doc.forEach((node, _offset, index) => {
    const isTrailingNode =
      index === doc.childCount - 1 &&
      index > 0 &&
      node.type.name === 'paragraph' &&
      !node.childCount;
    if (isTrailingNode) return;
    result.push(`${node.type.name}: ${node.textBetween(0, node.content.size, ' / ', '⏎')}`);
  });
  return result;
}

/** A clipboard as a paste event exposes it. */
export function clipboard(data: Record<string, string>): DataTransfer {
  return {
    getData: (type: string) => data[type] ?? '',
    types: Object.keys(data),
    items: [],
    files: [],
  } as unknown as DataTransfer;
}

/** Dispatch a paste event on the editor, the way the browser delivers Ctrl/Cmd+V. */
export function dispatchPaste(editor: Editor, data: Record<string, string>): Event {
  const event = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', { value: clipboard(data) });
  editor.view.dom.dispatchEvent(event);
  return event;
}
