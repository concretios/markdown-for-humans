/**
 * @jest-environment jsdom
 */

/**
 * Regression coverage for toolbar active states that depend on the document
 * rather than only on the selection.
 *
 * Removing a code block with Backspace does not necessarily move the cursor, so
 * a toolbar wired only to 'selectionUpdate' kept rendering the Code button as
 * active until the next keystroke.
 */

import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { createFormattingToolbar } from '../../webview/BubbleMenuView';

/** The Code Block toolbar button is the one whose active state tracks codeBlock. */
function findCodeBlockButton(toolbar: HTMLElement): HTMLButtonElement {
  const button = Array.from(toolbar.querySelectorAll('button')).find(btn =>
    (btn.getAttribute('aria-label') ?? '').toLowerCase().includes('code block')
  );
  if (!button) {
    throw new Error('Code Block toolbar button not found');
  }
  return button as HTMLButtonElement;
}

describe('toolbar active state tracks document changes', () => {
  let editor: Editor;
  let toolbar: HTMLElement;

  beforeEach(() => {
    document.body.innerHTML = '<div id="editor"></div>';

    editor = new Editor({
      element: document.getElementById('editor') as HTMLElement,
      extensions: [StarterKit],
      content: '<p>hello</p>',
    });

    // The toolbar disables buttons until the editor reports focus.
    window.dispatchEvent(new CustomEvent('editorFocusChange', { detail: { focused: true } }));

    toolbar = createFormattingToolbar(editor);
    document.body.appendChild(toolbar);
  });

  afterEach(() => {
    editor.destroy();
    document.body.innerHTML = '';
  });

  it('lights the Code button while the cursor is inside a code block', () => {
    const codeBlockBtn = findCodeBlockButton(toolbar);

    editor.chain().focus().setCodeBlock().run();

    expect(editor.isActive('codeBlock')).toBe(true);
    expect(codeBlockBtn.classList.contains('active')).toBe(true);
  });

  it('clears the Code button as soon as the code block is removed', () => {
    const codeBlockBtn = findCodeBlockButton(toolbar);

    editor.chain().focus().setCodeBlock().run();
    expect(codeBlockBtn.classList.contains('active')).toBe(true);

    // Backspace at the start of an empty code block lifts it back to a paragraph.
    editor.commands.toggleCodeBlock();

    expect(editor.isActive('codeBlock')).toBe(false);
    expect(codeBlockBtn.classList.contains('active')).toBe(false);
    expect(codeBlockBtn.getAttribute('aria-pressed')).toBe('false');
  });

  it('refreshes even when the document changes without moving the cursor', () => {
    const codeBlockBtn = findCodeBlockButton(toolbar);

    editor.chain().focus().setCodeBlock().run();
    expect(codeBlockBtn.classList.contains('active')).toBe(true);

    // A doc-only transaction: replace the code block in place, leaving the
    // selection numerically where it was. No 'selectionUpdate' is emitted.
    const { from } = editor.state.selection;
    editor.commands.setNode('paragraph');

    expect(editor.state.selection.from).toBe(from);
    expect(editor.isActive('codeBlock')).toBe(false);
    expect(codeBlockBtn.classList.contains('active')).toBe(false);
  });

  it('ignores metadata-only transactions', () => {
    const codeBlockBtn = findCodeBlockButton(toolbar);
    const initiallyActive = codeBlockBtn.classList.contains('active');

    const tr = editor.state.tr.setMeta('someDecorationPlugin', { redraw: true });
    expect(tr.docChanged).toBe(false);
    expect(tr.selectionSet).toBe(false);

    editor.view.dispatch(tr);

    expect(codeBlockBtn.classList.contains('active')).toBe(initiallyActive);
  });
});
