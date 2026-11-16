/** @jest-environment jsdom */

import { Editor } from '@tiptap/core';
import { Markdown } from '@tiptap/markdown';
import StarterKit from '@tiptap/starter-kit';
import { CodeBlockWithCopy } from '../../webview/extensions/codeBlockWithCopy';
import { parseFrontmatter } from '../../webview/frontmatter/presentation';
import { frontmatterKey, type FrontmatterStyle } from '../../webview/frontmatter/plugin';
import { collectExportContent } from '../../webview/utils/exportContent';
import {
  getEditorMarkdownForSync,
  setMarkdownContentPreservingSource,
} from '../../webview/utils/markdownSerialization';

const yaml = '---\ntags: [one, two]\nsummary: >-\n  A readable summary.\n---';
const markdown = ['```yaml', yaml, '```', '', '# Body', '', '```yaml', yaml, '```'].join('\n');

describe('frontmatter styles in the live editor', () => {
  let editor: Editor;

  function open(hasFrontmatter: boolean) {
    editor = new Editor({
      element: document.createElement('div'),
      extensions: [
        StarterKit.configure({ codeBlock: false }),
        CodeBlockWithCopy.configure({ readFrontmatter: async source => parseFrontmatter(source) }),
        Markdown,
      ],
    });
    setMarkdownContentPreservingSource(editor, markdown, { addToHistory: false, hasFrontmatter });
  }

  async function setStyle(style: FrontmatterStyle) {
    editor.view.dispatch(editor.state.tr.setMeta(frontmatterKey, { style }));
    // The presentation is computed after the typing debounce.
    for (let attempt = 0; attempt < 50; attempt++) {
      if (frontmatterKey.getState(editor.state)?.result) return;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }

  afterEach(() => editor.destroy());

  it('changes live presentation without changing the document or exported YAML', async () => {
    open(true);
    const before = editor.state.doc;
    expect(editor.view.dom.querySelector('[data-frontmatter-style]')).toBeNull();
    await setStyle('guided');
    expect(editor.view.dom.querySelectorAll('[data-frontmatter-style="guided"]')).toHaveLength(1);
    expect(editor.view.dom.querySelector('.md4h-yaml-punctuation')?.textContent).toBe(':');

    await setStyle('properties');
    const pane = editor.view.dom.querySelector<HTMLElement>('.md4h-frontmatter-properties');
    expect(pane?.hidden).toBe(false);
    expect(pane?.textContent).toContain('A readable summary.');
    const button = pane?.querySelector('button');
    button?.click();
    expect(button?.textContent).toBe('Show properties');
    expect(pane?.parentElement?.hasAttribute('data-frontmatter-editing')).toBe(true);
    await setStyle('guided');
    expect(pane?.hidden).toBe(true);
    await setStyle('properties');
    expect(button?.textContent).toBe('Edit YAML');
    expect(editor.state.doc).toBe(before);
    expect(getEditorMarkdownForSync(editor, 'preserve')).toBe(markdown);
    expect((await collectExportContent(editor)).html).not.toContain('Edit YAML');
  });

  it('never treats an authored first YAML fence as frontmatter', async () => {
    open(false);
    editor.view.dispatch(editor.state.tr.setMeta(frontmatterKey, { style: 'properties' }));
    expect(editor.state.doc.firstChild?.attrs.frontmatter).toBe(false);
    expect(editor.view.dom.querySelector('.md4h-frontmatter-properties')).toBeNull();
  });
});
