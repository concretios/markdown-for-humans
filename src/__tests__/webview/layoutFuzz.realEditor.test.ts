/** @jest-environment jsdom */

/**
 * Property test for saving: whatever mix of tight and blank-line-separated blocks a
 * document has, editing one block must never change what the document means or any
 * of its other lines.
 *
 * Random documents are generated from a seeded generator (failures print the seed),
 * one paragraph or heading is edited in the real editor, and the saved text, with
 * the edit removed, must
 *   1. render to the same HTML as the original (markdown-it), and
 *   2. keep every non-blank line in the same order, and
 *   3. differ in blank-line layout only directly around the edited block.
 */

import MarkdownIt from 'markdown-it';
import { Editor } from '@tiptap/core';
import { Markdown } from '@tiptap/markdown';
import StarterKit from '@tiptap/starter-kit';
import { ListKit } from '@tiptap/extension-list';
import { TableCell, TableHeader, TableRow } from '@tiptap/extension-table';
import { BlankLinePreservation } from '../../webview/extensions/blankLinePreservation';
import { CustomImage } from '../../webview/extensions/customImage';
import { GitHubAlerts } from '../../webview/extensions/githubAlerts';
import { HtmlComment, HtmlCommentInline } from '../../webview/extensions/htmlComment';
import { HtmlPreservingTable } from '../../webview/extensions/htmlPreservingTable';
import { MarkdownListItem } from '../../webview/extensions/markdownListItem';
import { MarkdownParagraph } from '../../webview/extensions/markdownParagraph';
import { MarkdownTaskList } from '../../webview/extensions/markdownTaskList';
import { OrderedListMarkdownFix } from '../../webview/extensions/orderedListMarkdownFix';
import {
  getEditorMarkdownForSync,
  setMarkdownContentPreservingSource,
} from '../../webview/utils/markdownSerialization';
import { installBlankLineLexerNormalizer } from '../../webview/utils/markedLexerNormalizer';

const EDIT = ' EDITZ';
const md = new MarkdownIt({ html: true });
const normalize = (html: string): string => html.replace(/\s+/g, ' ').replace(/> </g, '><').trim();

/** Small deterministic PRNG so a failing seed can be replayed. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Kind =
  | 'heading'
  | 'paragraph'
  | 'bullet'
  | 'ordered'
  | 'task'
  | 'fence'
  | 'quote'
  | 'table'
  | 'hr'
  | 'comment';
const KINDS: Kind[] = [
  'heading',
  'paragraph',
  'bullet',
  'ordered',
  'task',
  'fence',
  'quote',
  'table',
  'hr',
  'comment',
];

function block(kind: Kind, i: number, rand: () => number): string {
  switch (kind) {
    case 'heading':
      return `${'#'.repeat(1 + Math.floor(rand() * 3))} Heading H${i}`;
    case 'paragraph':
      return `Paragraph P${i} with **bold** text.`;
    case 'bullet':
      return `- Bullet B${i}a\n- Bullet B${i}b`;
    case 'ordered':
      return `1. Ordered O${i}a\n2. Ordered O${i}b`;
    case 'task':
      return `- [ ] Task K${i}a\n- [x] Task K${i}b`;
    case 'fence':
      return `\`\`\`\ncode F${i}\n\`\`\``;
    case 'quote':
      return `> Quote Q${i} text`;
    case 'table':
      return `| T${i}a | T${i}b |\n| --- | --- |\n| 1 | 2 |`;
    case 'hr':
      return '---';
    case 'comment':
      return `<!-- note C${i} -->`;
  }
}

/**
 * A tight join (no blank line) is only generated where it still parses as two blocks:
 * a heading, fence, rule or comment can be followed by anything; a paragraph only by a
 * block that interrupts it; and a list, quote or table only by a block that cannot be
 * read as its continuation.
 */
function mayBeTight(prev: Kind, next: Kind): boolean {
  if (prev === 'heading' || prev === 'fence' || prev === 'hr' || prev === 'comment') {
    return !(prev === 'comment' && next === 'paragraph');
  }
  if (prev === 'paragraph') {
    return next === 'bullet' || next === 'ordered' || next === 'fence' || next === 'quote';
  }
  if (
    prev === 'bullet' ||
    prev === 'ordered' ||
    prev === 'task' ||
    prev === 'quote' ||
    prev === 'table'
  ) {
    return (
      next === 'heading' ||
      next === 'fence' ||
      next === 'comment' ||
      (next === 'quote' && prev !== 'quote')
    );
  }
  return false;
}

interface Generated {
  readonly markdown: string;
  readonly editable: string[];
}

function generate(seed: number): Generated {
  const rand = mulberry32(seed);
  const count = 3 + Math.floor(rand() * 6);
  const kinds: Kind[] = [];
  for (let i = 0; i < count; i++) {
    let kind = KINDS[Math.floor(rand() * KINDS.length)];
    // Two adjacent paragraphs would merge into one, and adjacent lists with the same marker
    // become one list (a bullet list plus a task list is the documented mixed-list case).
    const previous = kinds[i - 1];
    if (previous === 'paragraph' && kind === 'paragraph') kind = 'heading';
    const dashList = (k?: Kind): boolean => k === 'bullet' || k === 'task';
    if (dashList(previous) && dashList(kind)) kind = 'heading';
    if (previous === 'ordered' && kind === 'ordered') kind = 'heading';
    kinds.push(kind);
  }
  if (!kinds.some(k => k === 'paragraph' || k === 'heading')) kinds.push('paragraph');

  const editable: string[] = [];
  let text = '';
  kinds.forEach((kind, i) => {
    if (i > 0) {
      const tight = mayBeTight(kinds[i - 1], kind) && rand() < 0.6;
      text += tight ? '\n' : '\n\n';
    }
    text += block(kind, i, rand);
    if (kind === 'paragraph') editable.push(`P${i}`);
    if (kind === 'heading') editable.push(`H${i}`);
  });
  return { markdown: text, editable };
}

function createEditor(): Editor {
  const element = document.createElement('div');
  document.body.appendChild(element);
  const editor = new Editor({
    element,
    extensions: [
      GitHubAlerts,
      StarterKit.configure({
        paragraph: false,
        bulletList: false,
        orderedList: false,
        listItem: false,
        listKeymap: false,
      }),
      MarkdownParagraph,
      CustomImage,
      HtmlComment,
      HtmlCommentInline,
      BlankLinePreservation,
      Markdown.configure({ markedOptions: { gfm: true, breaks: true } }),
      HtmlPreservingTable.configure({ resizable: false }),
      TableRow,
      TableHeader,
      TableCell,
      ListKit.configure({ listItem: false, orderedList: false, taskList: false }),
      MarkdownTaskList,
      MarkdownListItem,
      OrderedListMarkdownFix,
    ],
    content: '',
    contentType: 'markdown',
  });
  const storage = editor as unknown as { markdown?: { instance?: unknown } };
  if (storage.markdown?.instance) installBlankLineLexerNormalizer(storage.markdown.instance);
  return editor;
}

function appendEditTo(editor: Editor, token: string): void {
  let end = -1;
  editor.state.doc.descendants((node, pos) => {
    if (end !== -1) return false;
    if (node.isTextblock && node.textContent.includes(token)) {
      end = pos + node.nodeSize - 1;
      return false;
    }
    return true;
  });
  if (end === -1) throw new Error(`no text block with ${token}`);
  editor.commands.insertContentAt(end, EDIT);
}

const nonBlank = (text: string): string[] => text.split('\n').filter(line => line.trim() !== '');
/** For each non-blank line, whether a blank line sits directly above it. */
function blankFlags(text: string): boolean[] {
  const flags: boolean[] = [];
  let blank = false;
  for (const line of text.split('\n')) {
    if (line.trim() === '') blank = true;
    else {
      flags.push(blank);
      blank = false;
    }
  }
  return flags;
}

describe('layout property: editing one block never changes anything else', () => {
  afterEach(() => document.body.replaceChildren());

  const SEEDS = Array.from({ length: 500 }, (_, i) => 1000 + i);

  it.each(SEEDS)('seed %d', seed => {
    const { markdown, editable } = generate(seed);
    const rand = mulberry32(seed ^ 0x9e3779b9);
    const token = editable[Math.floor(rand() * editable.length)];
    const editor = createEditor();
    try {
      setMarkdownContentPreservingSource(editor, markdown);
      appendEditTo(editor, token);
      const saved = getEditorMarkdownForSync(editor, 'strip');
      const restored = saved.replace(EDIT, '');
      const context = `\n--- seed ${seed}, edited ${token}\n--- original:\n${markdown}\n--- saved (edit removed):\n${restored}\n`;

      const problems: string[] = [];
      if (JSON.stringify(nonBlank(restored)) !== JSON.stringify(nonBlank(markdown))) {
        problems.push('non-blank lines changed');
      }
      if (normalize(md.render(restored)) !== normalize(md.render(markdown))) {
        problems.push('rendered meaning changed');
      }
      // A blank line may differ only directly before the edited line and before the
      // line after it: those are the two joins that touch the edited block.
      const before = blankFlags(markdown);
      const after = blankFlags(restored);
      const editedIndex = nonBlank(markdown).findIndex(line => line.includes(token));
      const moved = before.flatMap((flag, index) =>
        flag !== after[index] && index !== editedIndex && index !== editedIndex + 1 ? [index] : []
      );
      if (moved.length > 0) {
        problems.push(
          `blank-line layout changed away from the edited block (lines ${moved.join(',')})`
        );
      }
      if (problems.length > 0) throw new Error(`${problems.join(', ')}${context}`);
    } finally {
      editor.destroy();
    }
  });
});
