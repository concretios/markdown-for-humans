/** @jest-environment jsdom */

/**
 * Copying a checklist and pasting it must give back a checklist.
 *
 * The paste handler turns clipboard HTML into Markdown and then back into HTML
 * for TipTap. markdown-it has no task-list support, so `- [x] done` came back as
 * `<li>[x] done</li>` and landed as an ordinary bullet list with literal brackets.
 */

import { Editor } from '@tiptap/core';
import { Markdown } from '@tiptap/markdown';
import StarterKit from '@tiptap/starter-kit';
import { ListKit } from '@tiptap/extension-list';
import { MarkdownParagraph } from '../../webview/extensions/markdownParagraph';
import { MarkdownTaskList } from '../../webview/extensions/markdownTaskList';
import { markdownToHtml, processPasteContent } from '../../webview/utils/pasteHandler';
import { setMarkdownContentPreservingSource } from '../../webview/utils/markdownSerialization';

function createEditor(markdown = ''): Editor {
  const element = document.createElement('div');
  document.body.appendChild(element);
  const editor = new Editor({
    element,
    extensions: [
      StarterKit.configure({
        paragraph: false,
        bulletList: false,
        orderedList: false,
        listItem: false,
        listKeymap: false,
        link: false,
      }),
      MarkdownParagraph,
      ListKit.configure({ taskList: false }),
      MarkdownTaskList,
      Markdown.configure({ markedOptions: { gfm: true, breaks: true } }),
    ],
    content: '',
    contentType: 'markdown',
  });
  if (markdown) setMarkdownContentPreservingSource(editor, markdown);
  return editor;
}

/** Clipboard payload as ProseMirror writes it for the editor's current selection. */
function copyEverything(editor: Editor): { html: string; text: string } {
  editor.commands.selectAll();
  const { dom, text } = editor.view.serializeForClipboard(editor.state.selection.content());
  return { html: dom.innerHTML, text };
}

function clipboard(html: string, text: string): DataTransfer {
  const data: Record<string, string> = { 'text/html': html, 'text/plain': text };
  return {
    getData: (type: string) => data[type] ?? '',
    items: [],
    files: [],
  } as unknown as DataTransfer;
}

function pasteInto(editor: Editor, html: string, text: string): void {
  const result = processPasteContent(clipboard(html, text));
  expect(result.wasConverted).toBe(true);
  editor.commands.insertContent(result.content);
}

interface TaskSummary {
  type: string;
  checked: boolean | null;
  text: string;
}

function listItems(editor: Editor): TaskSummary[] {
  const items: TaskSummary[] = [];
  editor.state.doc.descendants(node => {
    if (node.type.name === 'taskItem' || node.type.name === 'listItem') {
      items.push({
        type: node.type.name,
        checked: node.type.name === 'taskItem' ? Boolean(node.attrs.checked) : null,
        text: node.textContent,
      });
    }
  });
  return items;
}

describe('markdownToHtml task lists', () => {
  it('marks task list items so TipTap parses them as a checklist', () => {
    const html = markdownToHtml('- [ ] open item\n- [x] done item');
    expect(html).toContain('data-type="taskList"');
    expect(html).toContain('data-type="taskItem"');
    expect(html).toContain('data-checked="false"');
    expect(html).toContain('data-checked="true"');
    expect(html).not.toContain('[ ]');
    expect(html).not.toContain('[x]');
  });

  it('leaves ordinary bullet lists alone', () => {
    const html = markdownToHtml('- one\n- two');
    expect(html).not.toContain('data-type');
  });

  it('does not treat brackets in the middle of an item as a checkbox', () => {
    const html = markdownToHtml('- see [ ] later\n- [link](https://example.com)');
    expect(html).not.toContain('data-type');
  });

  it('leaves a list that mixes tasks and plain items as a bullet list', () => {
    // TipTap's TaskList holds only task items, so a partial conversion would
    // drop or reshape the plain ones.
    const html = markdownToHtml('- [x] task\n- plain');
    expect(html).not.toContain('data-type');
  });

  it('marks nested lists independently of their parent', () => {
    const html = markdownToHtml('- parent\n  - [ ] child one\n  - [x] child two');
    expect(html.match(/data-type="taskList"/g)).toHaveLength(1);
    expect(html.match(/data-type="taskItem"/g)).toHaveLength(2);
  });

  it('does not turn numbered lists into checklists', () => {
    const html = markdownToHtml('1. [ ] one\n2. [x] two');
    expect(html).not.toContain('data-type');
  });

  it('reads an uppercase X as checked', () => {
    expect(markdownToHtml('- [X] done')).toContain('data-checked="true"');
  });

  it('keeps inline formatting inside a task item', () => {
    const html = markdownToHtml('- [ ] a **bold** step');
    expect(html).toContain('<strong>bold</strong>');
  });
});

describe('copy a checklist, paste a checklist', () => {
  afterEach(() => document.body.replaceChildren());

  it('pastes a copied checklist as a checklist with the same checked state', () => {
    const source = createEditor('- [ ] first\n- [x] second\n- [ ] third');
    const { html, text } = copyEverything(source);
    source.destroy();

    const target = createEditor();
    pasteInto(target, html, text);

    expect(listItems(target)).toEqual([
      { type: 'taskItem', checked: false, text: 'first' },
      { type: 'taskItem', checked: true, text: 'second' },
      { type: 'taskItem', checked: false, text: 'third' },
    ]);
    expect(target.getMarkdown()).toContain('- [ ] first');
    expect(target.getMarkdown()).toContain('- [x] second');
    target.destroy();
  });

  it('pastes checklist Markdown typed as plain text as a checklist', () => {
    const target = createEditor();
    const result = processPasteContent(clipboard('', '- [ ] one\n- [x] two'));
    expect(result.wasConverted).toBe(true);
    target.commands.insertContent(result.content);

    expect(listItems(target).map(item => item.type)).toEqual(['taskItem', 'taskItem']);
    target.destroy();
  });

  it('keeps a copied checklist with formatted text as a checklist', () => {
    const source = createEditor('- [ ] a **bold** step\n- [x] a `code` step');
    const { html, text } = copyEverything(source);
    source.destroy();

    const target = createEditor();
    pasteInto(target, html, text);

    const markdown = target.getMarkdown();
    expect(markdown).toContain('- [ ] a **bold** step');
    expect(markdown).toContain('- [x] a `code` step');
    target.destroy();
  });

  it('still pastes a copied bullet list as a bullet list', () => {
    const source = createEditor('- alpha\n- beta');
    const { html, text } = copyEverything(source);
    source.destroy();

    const target = createEditor();
    pasteInto(target, html, text);

    expect(listItems(target).map(item => item.type)).toEqual(['listItem', 'listItem']);
    target.destroy();
  });
});
