/** @jest-environment jsdom */

import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { closeHistory } from '@tiptap/pm/history';
import { createFormattingToolbar } from '../../webview/BubbleMenuView';
import { parseFenceInfo } from '../../webview/highlighting/fenceInfo';
import { resolveGrammar } from '../../webview/highlighting/languageRegistry';

describe('code language menu', () => {
  let editor: Editor;
  let toolbar: HTMLElement;

  function menuItem(label: string): HTMLButtonElement {
    const item = toolbar.querySelector<HTMLButtonElement>(
      `.toolbar-dropdown-item[aria-label="${label}"]`
    );
    if (!item) throw new Error(`Missing language menu item: ${label}`);
    return item;
  }

  beforeEach(() => {
    document.body.innerHTML = '<div id="editor"></div>';
    editor = new Editor({
      element: document.getElementById('editor') as HTMLElement,
      extensions: [StarterKit],
      content: {
        type: 'doc',
        content: [
          {
            type: 'codeBlock',
            attrs: { language: 'TS\t title="A B.ts"  {1,3} ' },
            content: [{ type: 'text', text: 'const greeting = "hello";' }],
          },
        ],
      },
    });
    editor.commands.setTextSelection(1);
    toolbar = createFormattingToolbar(editor);
    document.body.appendChild(toolbar);
    window.dispatchEvent(new CustomEvent('editorFocusChange', { detail: { focused: true } }));
  });

  afterEach(() => {
    editor.destroy();
    document.body.innerHTML = '';
  });

  it('recognizes an authored alias and updates the active item after a language change', () => {
    expect(menuItem('TypeScript').getAttribute('aria-pressed')).toBe('true');
    expect(menuItem('JavaScript').getAttribute('aria-pressed')).toBe('false');

    menuItem('JavaScript').click();

    expect(menuItem('JavaScript').getAttribute('aria-pressed')).toBe('true');
    expect(menuItem('TypeScript').getAttribute('aria-pressed')).toBe('false');
  });

  it('preserves authored metadata and code when choosing a different language', () => {
    menuItem('JavaScript').click();

    expect(editor.getAttributes('codeBlock').language).toBe('javascript\t title="A B.ts"  {1,3} ');
    expect(editor.state.doc.firstChild?.textContent).toBe('const greeting = "hello";');
  });

  it('compares HTML and XML as the same grammar and clears state outside a code block', () => {
    editor.commands.updateAttributes('codeBlock', { language: 'XML title="page.xml"' });
    expect(menuItem('HTML').getAttribute('aria-pressed')).toBe('true');

    editor.commands.setNode('paragraph');
    expect(menuItem('HTML').getAttribute('aria-pressed')).toBe('false');
    expect(menuItem('Plain Text').getAttribute('aria-pressed')).toBe('false');
  });

  it('keeps metadata when explicitly changing an unknown language to plain text', () => {
    editor.commands.updateAttributes('codeBlock', { language: 'unavailable title="sample"' });
    menuItem('Plain Text').click();
    expect(editor.getAttributes('codeBlock').language).toBe('plaintext title="sample"');
  });

  it('offers ABAP and recognizes its sap-abap alias as the same grammar', () => {
    editor.commands.updateAttributes('codeBlock', { language: 'sap-abap title="report"' });
    expect(menuItem('ABAP').getAttribute('aria-pressed')).toBe('true');

    menuItem('ABAP').click();

    expect(editor.getAttributes('codeBlock').language).toBe('abap title="report"');
    expect(menuItem('ABAP').getAttribute('aria-pressed')).toBe('true');
  });

  it('offers C# and recognizes its cs alias as the same grammar (issue #81)', () => {
    editor.commands.updateAttributes('codeBlock', { language: 'cs title="Program.cs"' });
    expect(menuItem('C#').getAttribute('aria-pressed')).toBe('true');

    menuItem('C#').click();

    expect(editor.getAttributes('codeBlock').language).toBe('csharp title="Program.cs"');
    expect(menuItem('C#').getAttribute('aria-pressed')).toBe('true');
  });

  it('only offers languages the highlighter has a grammar for', () => {
    const menu = menuItem('Plain Text').parentElement as HTMLElement;
    const labels = Array.from(menu.querySelectorAll<HTMLButtonElement>('.toolbar-dropdown-item'))
      .map(item => item.getAttribute('aria-label') ?? '')
      .filter(label => label !== 'Plain Text');
    expect(labels.length).toBeGreaterThan(10);

    for (const label of labels) {
      menuItem(label).click();
      const chosen = parseFenceInfo(editor.getAttributes('codeBlock').language).language;
      expect([label, resolveGrammar(chosen)]).toEqual([label, expect.any(String)]);
    }
  });

  it('preserves each fence suffix when changing several selected code blocks', () => {
    editor.commands.setContent({
      type: 'doc',
      content: [
        {
          type: 'codeBlock',
          attrs: { language: 'ts title="first"' },
          content: [{ type: 'text', text: 'one' }],
        },
        {
          type: 'codeBlock',
          attrs: { language: 'js\t title="second"' },
          content: [{ type: 'text', text: 'two' }],
        },
      ],
    });
    editor.commands.setTextSelection({ from: 1, to: 9 });
    editor.view.dispatch(closeHistory(editor.state.tr));

    menuItem('Python').click();

    expect(editor.state.doc.child(0).attrs.language).toBe('python title="first"');
    expect(editor.state.doc.child(1).attrs.language).toBe('python\t title="second"');
    expect(editor.state.doc.child(0).textContent).toBe('one');
    expect(editor.state.doc.child(1).textContent).toBe('two');
    editor.commands.undo();
    expect(editor.state.doc.child(0).attrs.language).toBe('ts title="first"');
    expect(editor.state.doc.child(1).attrs.language).toBe('js\t title="second"');
  });
});
