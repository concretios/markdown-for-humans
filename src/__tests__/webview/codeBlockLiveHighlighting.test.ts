/** @jest-environment jsdom */

import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { CodeBlockWithCopy } from '../../webview/extensions/codeBlockWithCopy';

describe('the configured live code block', () => {
  let editor: Editor;

  afterEach(() => editor?.destroy());

  function open(language = 'ts title="example.ts"') {
    editor = new Editor({
      element: document.createElement('div'),
      extensions: [
        StarterKit.configure({ codeBlock: false }),
        CodeBlockWithCopy.configure({
          HTMLAttributes: { class: 'code-block-highlighted', 'data-custom': 'retained' },
        }),
      ],
      content: {
        type: 'doc',
        content: [
          {
            type: 'codeBlock',
            attrs: { language },
            content: [{ type: 'text', text: 'const value = 1;' }],
          },
        ],
      },
    });
  }

  it('merges configured attributes into the live NodeView, not only serialized HTML', () => {
    open();
    const pre = editor.view.dom.querySelector('pre');
    expect(pre?.classList.contains('code-block-highlighted')).toBe(true);
    expect(pre?.getAttribute('data-custom')).toBe('retained');
    expect(pre?.querySelector('code')?.textContent).toBe('const value = 1;');
  });

  it('keeps authored metadata out of DOM classes and preserves it in document attributes', () => {
    open();
    expect(editor.view.dom.querySelector('code')?.className).toBe('language-typescript');
    expect(editor.state.doc.firstChild?.attrs.language).toBe('ts title="example.ts"');
  });

  it('registers exactly one syntax-highlighting plugin', () => {
    open();
    const plugins = editor.state.plugins.filter(plugin =>
      /lowlight|codeSyntaxHighlighting/.test(String(plugin.spec.key))
    );
    // PluginKey stringification is not part of ProseMirror's public contract.
    const keyed = editor.state.plugins.filter(plugin => {
      const key = plugin.spec.key as unknown as { key?: string } | undefined;
      return /lowlight|codeSyntaxHighlighting/.test(key?.key ?? '');
    });
    expect(keyed.length || plugins.length).toBe(1);
  });
});
