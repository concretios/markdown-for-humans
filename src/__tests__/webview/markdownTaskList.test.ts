/** @jest-environment jsdom */

/**
 * The stock TaskList Markdown tokenizer runs at every block position and calls
 * parseIndentedBlocks, which splits the entire remaining document into lines
 * before checking the first one. That made loading O(n^2) in block count.
 * MarkdownTaskList checks the first non-blank line first and must otherwise
 * parse exactly like the stock tokenizer.
 */

import { Editor, type AnyExtension } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from '@tiptap/markdown';
import { ListKit, TaskList } from '@tiptap/extension-list';
import { MarkdownParagraph } from '../../webview/extensions/markdownParagraph';
import { MarkdownListItem } from '../../webview/extensions/markdownListItem';
import { OrderedListMarkdownFix } from '../../webview/extensions/orderedListMarkdownFix';
import { MarkdownTaskList } from '../../webview/extensions/markdownTaskList';

function parse(markdown: string, guarded: boolean): string {
  const extensions: AnyExtension[] = [
    StarterKit.configure({
      paragraph: false,
      bulletList: false,
      orderedList: false,
      listItem: false,
      listKeymap: false,
    }),
    MarkdownParagraph,
    Markdown.configure({ markedOptions: { gfm: true, breaks: true } }),
    ListKit.configure({
      listItem: false,
      orderedList: false,
      taskList: guarded ? false : {},
      taskItem: { nested: true },
    }),
    MarkdownListItem,
    OrderedListMarkdownFix,
  ];
  if (guarded) extensions.push(MarkdownTaskList);
  const editor = new Editor({
    element: document.createElement('div'),
    extensions,
    content: markdown,
    contentType: 'markdown',
  });
  try {
    return JSON.stringify(editor.getJSON());
  } finally {
    editor.destroy();
  }
}

const taskListSources: Record<string, string> = {
  'simple list': '- [ ] open\n- [x] done',
  'uppercase X and other markers': '* [X] star\n+ [ ] plus',
  'nested tasks': '- [ ] parent\n  - [x] child\n    - [ ] grandchild\n- [ ] sibling',
  'after a paragraph': 'Intro text.\n\n- [ ] task',
  'leading blank lines': '\n\n- [ ] task after blanks',
  'followed by a plain list': '- [ ] task\n\n- plain bullet',
  'plain list then tasks': '- plain\n- [ ] task in a plain list',
  'task with continuation': '- [ ] first line\n  continued line\n- [x] next',
  'not a task (no space after box)': '- [ ]no space',
  'heading and table neighbours': '## Head\n\n- [ ] t\n\n| A |\n| --- |\n| x |',
};

describe('MarkdownTaskList', () => {
  it.each(Object.entries(taskListSources))(
    'parses %s exactly like the stock TaskList tokenizer',
    (_name, markdown) => {
      expect(parse(markdown, true)).toBe(parse(markdown, false));
    }
  );

  it('does not run the stock tokenizer for blocks that cannot start a task list', () => {
    const stock = TaskList.config.markdownTokenizer;
    if (!stock) throw new Error('TaskList has no markdownTokenizer');
    const spy = jest.spyOn(stock, 'tokenize');
    try {
      parse('## Heading\n\nParagraph text.\n\n- plain bullet\n\n1. one', true);
      expect(spy).not.toHaveBeenCalled();

      parse('Intro.\n\n- [ ] task', true);
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});
