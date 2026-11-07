/** @jest-environment jsdom */
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from '@tiptap/markdown';
import { CustomImage } from '../../webview/extensions/customImage';
import { MarkdownParagraph } from '../../webview/extensions/markdownParagraph';
import { showSvgDisplaySize } from '../../webview/features/svgDisplaySize';
import { createFeedbackReadOnlyPlugin } from '../../webview/features/feedbackReview';
import { createFeedbackPeerReadOnlyPlugin } from '../../webview/features/feedbackPeerLock';

describe('SVG display size is an ordinary document edit', () => {
  let editor: Editor;
  beforeEach(() => {
    editor = new Editor({
      extensions: [
        StarterKit.configure({ paragraph: false }),
        MarkdownParagraph,
        Markdown,
        CustomImage,
      ],
      content: '',
      contentType: 'markdown',
    });
    // Match production: apply authoritative Markdown after schema/plugin setup.
    editor.commands.setContent('![Diagram](diagram.svg)', { contentType: 'markdown' });
    document.body.appendChild(editor.view.dom);
  });
  afterEach(() => {
    editor.destroy();
    document.body.replaceChildren();
  });
  const open = () => {
    let pos = 0;
    editor.state.doc.descendants((node, position) => {
      if (node.type.name === 'image') pos = position;
    });
    showSvgDisplaySize(editor.view.dom.querySelector('img')!, editor, () => pos);
  };
  const submit = (value: string) => {
    const input = document.querySelector<HTMLInputElement>('.svg-display-size input')!;
    input.value = value;
    document
      .querySelector('form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  };
  it('applies width, survives reload, and supports document undo and redo', () => {
    open();
    submit('480');
    const sized = editor.getMarkdown();
    expect(sized).toContain('width="480"');
    expect(document.querySelector('.svg-display-size')).toBeNull();
    expect(editor.commands.undo()).toBe(true);
    expect(editor.getMarkdown()).toBe('![Diagram](diagram.svg)');
    editor.commands.redo();
    expect(editor.getMarkdown()).toBe(sized);
    editor.commands.setContent(sized, { contentType: 'markdown' });
    expect(editor.getMarkdown()).toBe(sized);
  });
  it.each(['0', '-10', '10001', 'NaN', ''])(
    'rejects invalid width %s without changing the document',
    value => {
      open();
      submit(value);
      expect(editor.getMarkdown()).toBe('![Diagram](diagram.svg)');
      expect(document.querySelector('[role="alert"]')?.textContent).toContain('1');
    }
  );
  it('cancels on Escape and resets only explicit dimensions', () => {
    open();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(document.querySelector('.svg-display-size')).toBeNull();
    expect(editor.getMarkdown()).toBe('![Diagram](diagram.svg)');
    open();
    submit('480');
    open();
    document.querySelector<HTMLButtonElement>('[data-action="reset-size"]')!.click();
    expect(editor.getMarkdown()).toBe('![Diagram](diagram.svg)');
  });
  it('refuses changes when Feedback makes the editor read-only', () => {
    open();
    editor.setEditable(false);
    submit('480');
    expect(editor.getMarkdown()).toBe('![Diagram](diagram.svg)');
  });
  it('does not resize a different image after authoritative replacement', () => {
    open();
    editor.commands.setContent('![Other](other.svg)', { contentType: 'markdown' });
    submit('480');
    expect(editor.getMarkdown()).toBe('![Other](other.svg)');
  });

  it.each([createFeedbackReadOnlyPlugin, createFeedbackPeerReadOnlyPlugin])(
    'keeps the dialog open when the production Feedback transaction filter rejects sizing',
    makePlugin => {
      open();
      editor.registerPlugin(makePlugin());
      expect(editor.isEditable).toBe(true);
      submit('480');
      expect(editor.getMarkdown()).toBe('![Diagram](diagram.svg)');
      expect(document.querySelector('.svg-display-size')).not.toBeNull();
      expect(document.querySelector('[role="alert"]')?.textContent).toMatch(/read-only|locked/i);
    }
  );

  it('does not restore focus to a background webview when closing the dialog', () => {
    const previous = document.createElement('button');
    document.body.append(previous);
    previous.focus();
    const focus = jest.spyOn(previous, 'focus');
    open();
    const hasFocus = jest.spyOn(document, 'hasFocus').mockReturnValue(false);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(focus).not.toHaveBeenCalled();
    hasFocus.mockRestore();
  });

  it('does not restore focus while the editor is being destroyed', () => {
    const previous = document.createElement('button');
    document.body.append(previous);
    previous.focus();
    const focus = jest.spyOn(previous, 'focus');
    open();
    const hasFocus = jest.spyOn(document, 'hasFocus').mockReturnValue(true);
    editor.destroy();
    expect(focus).not.toHaveBeenCalled();
    expect(document.querySelector('.svg-display-size')).toBeNull();
    hasFocus.mockRestore();
  });

  it('returns keyboard focus to Image options rather than its now-hidden menu item', () => {
    const menu = editor.view.dom.querySelector<HTMLElement>('.image-context-menu')!;
    const button = editor.view.dom.querySelector<HTMLButtonElement>('.image-menu-button')!;
    menu.style.display = 'block';
    menu.querySelector<HTMLElement>('[data-action="displaySize"]')!.focus();
    menu.style.display = 'none';
    open();
    const hasFocus = jest.spyOn(document, 'hasFocus').mockReturnValue(true);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(document.activeElement).toBe(button);
    hasFocus.mockRestore();
  });
});
