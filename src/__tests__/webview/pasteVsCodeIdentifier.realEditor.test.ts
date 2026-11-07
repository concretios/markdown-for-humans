/** @jest-environment jsdom */

/**
 * Issue 11: "Copy any class name from the editor and try to paste it on a
 * markdown file, you will see that it is pasted as code block."
 *
 * A copy from a VS Code text editor puts three flavors on the clipboard: the
 * text, HTML with one colored span per token, and `vscode-editor-data` with
 * the language. The document-level paste handler leaves such a paste to
 * ProseMirror, and TipTap's stock CodeBlock extension then wrapped anything
 * carrying `vscode-editor-data` in a code block. A single line must land as
 * inline text.
 *
 * Clipboard shapes follow VS Code's `getRichTextToCopy` and
 * `tokenizeLineToHTML` (release 1.141).
 */

import type { Editor } from '@tiptap/core';
import { getSingleLineEditorCopy, processPasteContent } from '../../webview/utils/pasteHandler';
import {
  blocks,
  clipboard,
  createPasteTestEditor,
  dispatchPaste,
  placeCaretAfter,
} from '../helpers/pasteTestEditor';

const WRAPPER_STYLE =
  "color: #cccccc;background-color: #1f1f1f;font-family: Menlo, Monaco, 'Courier New', monospace;font-weight: normal;font-size: 12px;line-height: 18px;white-space: pre;";

function editorData(mode: string, isFromEmptySelection = false): string {
  return JSON.stringify({
    version: 1,
    id: '5f0c5c0e-6c0e-4d53-9d7a-0f6f2f6b8f11',
    isFromEmptySelection,
    isBlock: false,
    multicursorText: null,
    mode,
  });
}

/** What macOS and Linux put on the clipboard for a selected class name. */
const IDENTIFIER = {
  'text/plain': 'MarkdownEditorProvider',
  'text/html': `<meta charset='utf-8'><div style="${WRAPPER_STYLE}"><div><span style="color: #4ec9b0;">MarkdownEditorProvider</span></div></div>`,
  'vscode-editor-data': editorData('typescript'),
};

/**
 * The same copy with the fragment wrapper Chromium can add on Windows. The
 * wrapper was not captured from a Windows machine; it is here so that either
 * shape is covered.
 */
const IDENTIFIER_WINDOWS = {
  ...IDENTIFIER,
  'text/html': `<html>\r\n<body>\r\n<!--StartFragment--><div style="${WRAPPER_STYLE}"><div><span style="color: #4ec9b0;">MarkdownEditorProvider</span></div></div><!--EndFragment-->\r\n</body>\r\n</html>`,
};

/** Ctrl/Cmd+C with no selection copies the whole line, line ending included. */
const WHOLE_LINE = {
  'text/plain': 'export class MarkdownEditorProvider {\r\n',
  'text/html': `<div style="${WRAPPER_STYLE}"><div><span style="color: #c586c0;">export</span><span style="color: #cccccc;"> </span><span style="color: #569cd6;">class</span><span style="color: #cccccc;"> </span><span style="color: #4ec9b0;">MarkdownEditorProvider</span><span style="color: #cccccc;"> {</span></div></div>`,
  'vscode-editor-data': editorData('typescript', true),
};

const TWO_LINES = {
  'text/plain': 'const a = 1;\nconst b = 2;',
  'text/html': `<div style="${WRAPPER_STYLE}"><div><span style="color: #569cd6;">const</span><span style="color: #cccccc;"> a = 1;</span></div><div><span style="color: #569cd6;">const</span><span style="color: #cccccc;"> b = 2;</span></div></div>`,
  'vscode-editor-data': editorData('typescript'),
};

describe('a copy from a VS Code text editor, pasted with Ctrl/Cmd+V', () => {
  let editor: Editor;

  afterEach(() => {
    editor?.destroy();
    document.body.replaceChildren();
  });

  it.each([
    ['macOS and Linux', IDENTIFIER],
    ['Windows', IDENTIFIER_WINDOWS],
  ])('is left to the editor by the document-level handler (%s)', (_platform, data) => {
    const result = processPasteContent(clipboard(data));

    expect(result.wasConverted).toBe(false);
    expect(result.isHtml).toBe(false);
    expect(result.content).toBe('MarkdownEditorProvider');
  });

  it.each([
    ['macOS and Linux', IDENTIFIER],
    ['Windows', IDENTIFIER_WINDOWS],
  ])('inserts a single identifier as inline text, not a code block (%s)', (_platform, data) => {
    editor = createPasteTestEditor('Hello world');
    placeCaretAfter(editor, 'Hello ');

    const event = dispatchPaste(editor, data);

    expect(blocks(editor)).toEqual(['paragraph: Hello MarkdownEditorProviderworld']);
    expect(event.defaultPrevented).toBe(true);
  });

  it('inserts a whole line copied with an empty selection as inline text', () => {
    editor = createPasteTestEditor('Hello world');
    placeCaretAfter(editor, 'Hello ');

    dispatchPaste(editor, WHOLE_LINE);

    expect(blocks(editor)).toEqual(['paragraph: Hello export class MarkdownEditorProvider {world']);
  });

  it('is one undo step', () => {
    editor = createPasteTestEditor('Hello world');
    placeCaretAfter(editor, 'Hello ');
    editor.commands.insertContent('typed ');
    const beforePaste = editor.getJSON();

    dispatchPaste(editor, IDENTIFIER);
    editor.commands.undo();

    expect(editor.getJSON()).toEqual(beforePaste);
  });

  it('still turns several copied lines into a code block with their language', () => {
    editor = createPasteTestEditor('Hello world');
    placeCaretAfter(editor, 'Hello ');

    dispatchPaste(editor, TWO_LINES);

    expect(blocks(editor)).toEqual([
      'paragraph: Hello ',
      'codeBlock: const a = 1;\nconst b = 2;',
      'paragraph: world',
    ]);
    expect(editor.state.doc.child(1).attrs.language).toBe('typescript');
  });

  it('pastes into an existing code block as code', () => {
    editor = createPasteTestEditor('```js\nconst a = \n```');
    placeCaretAfter(editor, 'const a = ');

    dispatchPaste(editor, IDENTIFIER);

    expect(blocks(editor)).toEqual(['codeBlock: const a = MarkdownEditorProvider']);
  });
});

describe('getSingleLineEditorCopy', () => {
  it('returns the text of a single line copied from a VS Code editor', () => {
    expect(getSingleLineEditorCopy(clipboard(IDENTIFIER))).toBe('MarkdownEditorProvider');
  });

  it('drops the line ending of a whole-line copy', () => {
    expect(getSingleLineEditorCopy(clipboard(WHOLE_LINE))).toBe(
      'export class MarkdownEditorProvider {'
    );
  });

  it('returns null for several lines', () => {
    expect(getSingleLineEditorCopy(clipboard(TWO_LINES))).toBeNull();
  });

  it('returns null when the clipboard did not come from a VS Code editor', () => {
    expect(getSingleLineEditorCopy(clipboard({ 'text/plain': 'word' }))).toBeNull();
    expect(getSingleLineEditorCopy(null)).toBeNull();
  });

  it('returns null when there is no text', () => {
    expect(
      getSingleLineEditorCopy(
        clipboard({ 'text/plain': '', 'vscode-editor-data': editorData('typescript') })
      )
    ).toBeNull();
  });
});
