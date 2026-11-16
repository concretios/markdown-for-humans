/** @jest-environment jsdom */

import { readFileSync } from 'fs';
import path from 'path';
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
    const element = document.createElement('div');
    document.body.append(element);
    editor = new Editor({
      element,
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

  beforeAll(() => {
    // Undo scrolls the selection into view, which measures a DOM Range. jsdom
    // implements neither Range measurement method.
    Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
    Range.prototype.getBoundingClientRect = () => new DOMRect(0, 0, 0, 0);
  });

  afterEach(() => {
    editor.destroy();
    document.body.replaceChildren();
  });

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

  it('returns focus to the text after Show properties is clicked, so undo works', async () => {
    open(true);
    await setStyle('properties');
    const button = editor.view.dom.querySelector<HTMLButtonElement>(
      '.md4h-frontmatter-properties button'
    );
    const mouseClick = () =>
      button?.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));

    mouseClick();
    expect(button?.textContent).toBe('Show properties');
    await new Promise(resolve => setTimeout(resolve, 50));
    mouseClick();
    // TipTap focuses on the next animation frame.
    await new Promise(resolve => setTimeout(resolve, 50));

    expect(button?.textContent).toBe('Edit YAML');
    expect(document.activeElement).toBe(editor.view.dom);
    expect(editor.state.selection.$head.parent.textContent).toBe('Body');
  });

  it('keeps focus on the toggle when the keyboard activates Show properties', async () => {
    open(true);
    await setStyle('properties');
    const button = editor.view.dom.querySelector<HTMLButtonElement>(
      '.md4h-frontmatter-properties button'
    );
    button?.click();
    await new Promise(resolve => setTimeout(resolve, 50));
    button?.click();
    await new Promise(resolve => setTimeout(resolve, 50));

    expect(button?.textContent).toBe('Edit YAML');
    expect(document.activeElement).toBe(button);
  });

  it('reveals the YAML at once when undo puts the caret back in it', async () => {
    open(true);
    await setStyle('properties');
    const wrapper = editor.view.dom.querySelector<HTMLElement>('[data-frontmatter-style]');
    const button = wrapper?.querySelector<HTMLButtonElement>('.md4h-frontmatter-properties button');
    const mouseClick = () =>
      button?.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
    const waitForPresentation = async () => {
      await new Promise(resolve => setTimeout(resolve, 10));
      for (let attempt = 0; attempt < 50; attempt++) {
        if (frontmatterKey.getState(editor.state)?.result) return;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    };

    mouseClick();
    await new Promise(resolve => setTimeout(resolve, 50));
    editor.commands.insertContentAt(5, 'X');
    await waitForPresentation();
    mouseClick();
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(wrapper?.hasAttribute('data-frontmatter-editing')).toBe(false);
    expect(document.activeElement).toBe(editor.view.dom);

    editor.commands.undo();
    expect(editor.state.selection.$head.parent).toBe(editor.state.doc.firstChild);
    await waitForPresentation();

    // The caret is in the YAML, so the YAML must be visible without another keystroke.
    expect(wrapper?.hasAttribute('data-frontmatter-ready')).toBe(true);
    expect(wrapper?.hasAttribute('data-frontmatter-editing')).toBe(true);
  });

  it('wraps property keys at word boundaries, not mid-word', () => {
    const css = readFileSync(path.resolve(__dirname, '../../webview/editor.css'), 'utf8');
    const keyRule = css.match(/\.md4h-frontmatter-fields dt \{([^}]*)\}/)?.[1] ?? '';
    const rowRule = css.match(/\.md4h-frontmatter-fields > div \{([^}]*)\}/)?.[1] ?? '';
    expect(keyRule).toContain('overflow-wrap: break-word');
    expect(keyRule).not.toContain('anywhere');
    // The key column keeps room for a typical key before it shrinks with the pane.
    expect(rowRule).toMatch(/grid-template-columns: minmax\(min\(\d+(?:\.\d+)?em, \d+%\), 1fr\)/);
  });
});
