/** @jest-environment jsdom */

/**
 * Copyright (c) 2025-2026 Concret.io
 *
 * Licensed under the MIT License. See LICENSE file in the project root for details.
 *
 * Editing a Mermaid diagram through its code dialog must replace exactly that
 * diagram, every time.
 *
 * The node view kept the node it was created with. After the first edit (or
 * any change that reused the view) the next save measured the old node, so it
 * replaced the wrong range: a second edit left a stray Mermaid block with part
 * of the old code, and an edit after the diagram shrank threw a RangeError and
 * was lost.
 */

import type { Editor } from '@tiptap/core';
import mermaid from 'mermaid';
import { getEditorMarkdownForSync } from '../../webview/utils/markdownSerialization';
import { createProductionEditor } from '../helpers/productionEditor';

const settle = () => new Promise(resolve => setTimeout(resolve, 0));

const doc = (code: string) =>
  ['# Diagrams', '', 'Intro.', '', '```mermaid', code, '```', '', 'Outro.', ''].join('\n');

/** Opens the code dialog by double-clicking the diagram, appends a line and saves. */
async function appendLine(line: string): Promise<void> {
  (document.querySelector('.mermaid-wrapper') as HTMLElement).dispatchEvent(
    new MouseEvent('dblclick', { bubbles: true })
  );
  await settle();
  const textarea = document.querySelector('.mermaid-editor-textarea') as HTMLTextAreaElement;
  expect(textarea).not.toBeNull();
  textarea.value = `${textarea.value}\n${line}`;
  (document.querySelector('#save-btn') as HTMLButtonElement).click();
  await settle();
  await settle();
}

const mermaidBlocks = (markdown: string) => markdown.match(/```mermaid\n[\s\S]*?\n```/g) ?? [];

describe('editing a Mermaid diagram through the code dialog', () => {
  let editor: Editor;
  let errors: unknown[];
  const onRejection = (event: PromiseRejectionEvent) => errors.push(event.reason);

  beforeEach(() => {
    errors = [];
    window.addEventListener('unhandledrejection', onRejection);
    (mermaid.render as jest.Mock).mockResolvedValue({
      svg: '<svg width="100" height="100"><g><text>A</text></g></svg>',
    });
    editor = createProductionEditor();
  });

  afterEach(() => {
    window.removeEventListener('unhandledrejection', onRejection);
    editor.destroy();
    document.body.innerHTML = '';
  });

  it('keeps one diagram with both lines after two edits in a row', async () => {
    editor.commands.setContent(doc('graph TD\n    A[Start] --> B[End]'), {
      contentType: 'markdown',
    });
    await settle();

    await appendLine('    B --> C[One]');
    await appendLine('    C --> D[Two]');

    const markdown = getEditorMarkdownForSync(editor);
    expect(mermaidBlocks(markdown)).toEqual([
      '```mermaid\ngraph TD\n    A[Start] --> B[End]\n    B --> C[One]\n    C --> D[Two]\n```',
    ]);
    expect(markdown).toContain('Outro.');
    expect(errors).toEqual([]);
  });

  it('applies an edit after the diagram was replaced by a shorter one in place', async () => {
    editor.commands.setContent(
      doc('graph TD\n    A[Start] --> B[End]\n    B --> C[Next]\n    C --> D[More]'),
      { contentType: 'markdown' }
    );
    await settle();
    // Same block position, shorter code: ProseMirror reuses the node view.
    editor.commands.setContent(doc('graph TD\n    A --> B'), { contentType: 'markdown' });
    await settle();

    await appendLine('    B --> C');

    expect(mermaidBlocks(getEditorMarkdownForSync(editor))).toEqual([
      '```mermaid\ngraph TD\n    A --> B\n    B --> C\n```',
    ]);
    expect(errors).toEqual([]);
  });

  it('saves an emptied diagram as an empty block instead of throwing', async () => {
    editor.commands.setContent(doc('graph TD\n    A --> B'), { contentType: 'markdown' });
    await settle();
    (document.querySelector('.mermaid-wrapper') as HTMLElement).dispatchEvent(
      new MouseEvent('dblclick', { bubbles: true })
    );
    await settle();
    (document.querySelector('.mermaid-editor-textarea') as HTMLTextAreaElement).value = '';
    (document.querySelector('#save-btn') as HTMLButtonElement).click();
    await settle();
    await settle();

    expect(editor.state.doc.toJSON().content.some(
      (n: { type: string; content?: unknown[] }) => n.type === 'mermaid' && !n.content
    )).toBe(true);
    expect(errors).toEqual([]);
  });
});
