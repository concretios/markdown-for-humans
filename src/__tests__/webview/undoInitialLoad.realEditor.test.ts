/** @jest-environment jsdom */

/**
 * Opening a file must not become an undo step.
 *
 * The first load replaced the empty starting document, and ProseMirror's history
 * recorded that as one step. Undoing past the user's own edits then undid the
 * load: the editor went blank and the next sync wrote an empty file to VS Code.
 */

import { Editor } from '@tiptap/core';
import { Markdown } from '@tiptap/markdown';
import StarterKit from '@tiptap/starter-kit';
import {
  getEditorMarkdownForSync,
  setMarkdownContentPreservingSource,
} from '../../webview/utils/markdownSerialization';

function createEditor(): Editor {
  const element = document.createElement('div');
  document.body.appendChild(element);
  return new Editor({
    element,
    extensions: [StarterKit.configure({ undoRedo: { depth: 100 } }), Markdown],
    content: '',
    contentType: 'markdown',
  });
}

const ORIGINAL = '# Hello\n\nA probe paragraph.';

describe('undo after the initial load', () => {
  afterEach(() => document.body.replaceChildren());

  it('stops at the loaded document however many times undo is pressed', () => {
    const editor = createEditor();
    try {
      setMarkdownContentPreservingSource(editor, ORIGINAL, { addToHistory: false });
      editor.commands.insertContentAt(editor.state.doc.content.size - 1, ' abc');
      expect(getEditorMarkdownForSync(editor)).toContain('abc');

      for (let i = 0; i < 6; i++) editor.commands.undo();

      expect(getEditorMarkdownForSync(editor)).toBe(ORIGINAL);
      expect(editor.can().undo()).toBe(false);
    } finally {
      editor.destroy();
    }
  });

  it('has nothing to undo straight after the load', () => {
    const editor = createEditor();
    try {
      setMarkdownContentPreservingSource(editor, ORIGINAL, { addToHistory: false });
      expect(editor.can().undo()).toBe(false);
    } finally {
      editor.destroy();
    }
  });

  it('still lets the user redo what they undid', () => {
    const editor = createEditor();
    try {
      setMarkdownContentPreservingSource(editor, ORIGINAL, { addToHistory: false });
      editor.commands.insertContentAt(editor.state.doc.content.size - 1, ' abc');
      editor.commands.undo();
      expect(getEditorMarkdownForSync(editor)).toBe(ORIGINAL);
      editor.commands.redo();
      expect(getEditorMarkdownForSync(editor)).toContain('abc');
    } finally {
      editor.destroy();
    }
  });

  it('keeps recording history by default, so a host update stays undoable as before', () => {
    const editor = createEditor();
    try {
      setMarkdownContentPreservingSource(editor, ORIGINAL);
      expect(editor.can().undo()).toBe(true);
    } finally {
      editor.destroy();
    }
  });
});
