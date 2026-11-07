/**
 * Copyright (c) 2025-2026 Concret.io
 *
 * Licensed under the MIT License. See LICENSE file in the project root for details.
 */

/**
 * Paste as plain text (Ctrl/Cmd+Shift+V).
 *
 * Inserts clipboard text as written: nothing is read as Markdown or HTML, no
 * code block is created, and the text takes the formatting at the caret.
 *
 * The serializer does not escape prose, so plain text that holds Markdown
 * syntax would be read as Markdown the next time the file loads.
 * `readsAsMarkdown` detects that, and the `code` and `markdown` modes are the
 * two ways to paste such text so that screen and file agree.
 */

import type { Editor, JSONContent } from '@tiptap/core';
import { closeHistory } from '@tiptap/pm/history';
import { Fragment, Slice, type Node as ProseMirrorNode, type ResolvedPos } from '@tiptap/pm/model';
import { PRESERVED_MARKDOWN_LITERAL_TOKEN } from './markedLexerNormalizer';
import { patchMarkdownSerialization } from './markdownSerialization';
import { markdownToHtml } from './pasteHandler';

/** The part of TipTap's Markdown manager the reload check uses. */
type MarkdownRoundTrip = Parameters<typeof patchMarkdownSerialization>[0] & {
  serialize: (doc: JSONContent) => string;
  parse: (markdown: string) => JSONContent;
};

/** How clipboard text is put into the document. */
export type PlainPasteMode = 'plain' | 'code' | 'markdown';

/**
 * Insert clipboard text at the selection as one undo step.
 *
 * `plain` (the default) puts the text in as written:
 * - Code block: the text exactly as it is, newlines included.
 * - Table cell: the text stays in the cell and every newline is a line break,
 *   because a second paragraph or a split would change the table.
 * - Heading: every line is its own block, so the first joins the heading and
 *   the rest follow as paragraphs. A Markdown heading cannot hold a line break.
 * - Anywhere else: a single newline is a line break, one or more blank lines
 *   start a new paragraph.
 *
 * `code` keeps the text literal for good: inline code for one line, a code
 * block for several. `markdown` reads the text as Markdown source.
 *
 * @param editor - The TipTap editor
 * @param text - Clipboard text
 * @param mode - How to insert it
 * @returns true when the document changed
 */
export function insertPlainText(
  editor: Editor,
  text: string,
  mode: PlainPasteMode = 'plain'
): boolean {
  if (!editor.isEditable) return false;
  const normalized = text.replace(/\r\n?/g, '\n');
  const { state, view } = editor;
  const { schema, selection } = state;
  const { $from } = selection;
  const tr = state.tr;

  if ($from.parent.type.spec.code) {
    if (!normalized) return false;
    tr.insertText(normalized);
  } else {
    const trimmed = normalized.replace(/^\n+|\n+$/g, '');
    if (!trimmed) return false;

    if (mode === 'markdown') {
      // The same path a normal paste of Markdown source takes.
      return editor.commands.insertContent(markdownToHtml(trimmed));
    }

    const inCell = isInTableCell($from);
    // Inline code cannot hold a backtick or a line break, and a table cell
    // cannot hold a code block.
    if (mode === 'code' && !inCell && /[\n`]/.test(trimmed)) {
      tr.replaceSelectionWith(schema.nodes.codeBlock.create(null, schema.text(trimmed)));
    } else {
      const marks =
        mode === 'code' ? [schema.marks.code.create()] : (state.storedMarks ?? $from.marks());
      const hardBreak = schema.nodes.hardBreak;
      const paragraph = (lines: string[]): ProseMirrorNode => {
        const inline: ProseMirrorNode[] = [];
        lines.forEach((line, index) => {
          if (index > 0) inline.push(hardBreak.create());
          if (line) inline.push(schema.text(line, marks));
        });
        return schema.nodes.paragraph.create(null, inline);
      };

      // A heading, or any other text block that is not a paragraph.
      const inHeading = $from.parent.isTextblock && $from.parent.type !== schema.nodes.paragraph;
      let paragraphs: ProseMirrorNode[];
      if (inCell) {
        paragraphs = [paragraph(trimmed.split('\n'))];
      } else if (inHeading) {
        paragraphs = trimmed.split(/\n+/).map(line => paragraph([line]));
      } else {
        paragraphs = trimmed.split(/\n{2,}/).map(block => paragraph(block.split('\n')));
      }
      // Open on both sides so the first and last paragraph merge into the text
      // around the caret instead of splitting it into separate blocks.
      tr.replaceSelection(new Slice(Fragment.from(paragraphs), 1, 1));
    }
  }

  // ProseMirror merges changes made within 500 ms into one undo step. Without
  // this, undoing a paste made right after typing would remove the typing too.
  view.dispatch(closeHistory(tr).scrollIntoView());
  return true;
}

/**
 * Whether text pasted as plain would be read differently once the file is
 * loaded again: as formatting, a heading, a list, a code block and so on.
 *
 * This asks the editor's own serializer and parser instead of guessing with
 * patterns. The plain paragraphs are written out as the file would hold them
 * and parsed back; any difference means the text holds live Markdown. So
 * `a * b * c` and `<b>x</b>` are not flagged (they survive), while `**bold**`,
 * `__init__` and an indented paragraph are.
 *
 * @param editor - The TipTap editor (its selection decides the context)
 * @param text - Clipboard text
 */
export function readsAsMarkdown(editor: Editor, text: string): boolean {
  const { $from } = editor.state.selection;
  if ($from.parent.type.spec.code) return false;
  const trimmed = text.replace(/\r\n?/g, '\n').replace(/^\n+|\n+$/g, '');
  const manager = (editor as unknown as { markdown?: MarkdownRoundTrip }).markdown;
  if (!trimmed || !manager) return false;

  // `# x` and `- x` only mean something at the start of a line. A single line
  // dropped into the middle of one is probed behind a word.
  const atLineStart = $from.parentOffset === 0 || $from.nodeBefore?.type.name === 'hardBreak';
  const probe = !atLineStart && !trimmed.includes('\n') ? `x ${trimmed}` : trimmed;

  const content: JSONContent[] = probe.split(/\n{2,}/).map(block => ({
    type: 'paragraph',
    content: block.split('\n').flatMap((line, index) => {
      const inline: JSONContent[] = index > 0 ? [{ type: 'hardBreak' }] : [];
      if (line) inline.push({ type: 'text', text: line });
      return inline;
    }),
  }));

  try {
    patchMarkdownSerialization(manager);
    const saved = manager.serialize({ type: 'doc', content });
    return textShape(manager.parse(saved)) !== textShape({ type: 'doc', content });
  } catch {
    // A parser failure must not block the paste; treat the text as inert.
    return false;
  }
}

/**
 * A document reduced to its paragraphs' text. Anything that is not plain text
 * in a paragraph leaves a marker, so two shapes match only when both are
 * plain. Spaces at the outer edges and at line ends are ignored: inside a
 * sentence the text around the paste keeps them. Indentation at the start of
 * a later paragraph is not ignored, because Markdown drops it.
 */
function textShape(doc: JSONContent): string {
  return (doc.content ?? [])
    .map(block => {
      if (block.type !== 'paragraph') return `\u0000${block.type}`;
      return (block.content ?? [])
        .map(inline => {
          if (inline.type === 'hardBreak') return '\n';
          if (inline.type !== 'text') return `\u0000${inline.type}`;
          // The literal mark only records how an entity was spelled.
          const formatted = (inline.marks ?? []).some(
            mark => mark.type !== PRESERVED_MARKDOWN_LITERAL_TOKEN
          );
          return formatted ? `\u0000mark${inline.text}` : (inline.text ?? '');
        })
        .join('');
    })
    .filter(Boolean)
    .join('\n\n')
    .replace(/[ \t]+$/gm, '')
    .trim();
}

function isInTableCell($pos: ResolvedPos): boolean {
  for (let depth = $pos.depth; depth > 0; depth--) {
    const name = $pos.node(depth).type.name;
    if (name === 'tableCell' || name === 'tableHeader') return true;
  }
  return false;
}
