/** @jest-environment jsdom */

/**
 * Copyright (c) 2025-2026 Concret.io
 *
 * Licensed under the MIT License. See LICENSE file in the project root for details.
 *
 * Viewing a diagram must never change the document.
 *
 * The zoom and pan viewer keeps its state in a closure. These tests open it
 * from the real production editor, zoom, pan and close it, and check that the
 * ProseMirror document and the Markdown that would be written to disk are the
 * same bytes as before.
 */

import type { Editor } from '@tiptap/core';
import mermaid from 'mermaid';
import { getEditorMarkdownForSync } from '../../webview/utils/markdownSerialization';
import { createProductionEditor } from '../helpers/productionEditor';

const DOCUMENT = [
  '# Flow',
  '',
  'Some prose before the diagram.',
  '',
  '```mermaid',
  'graph TD',
  '  A[Start] --> B{Decision}',
  '  B -->|yes| C[Done]',
  '  B -->|no| A',
  '```',
  '',
  'Some prose after.',
  '',
].join('\n');

const settle = () => new Promise(resolve => setTimeout(resolve, 0));

describe('Mermaid viewer leaves the document untouched', () => {
  let editor: Editor;

  beforeEach(async () => {
    (mermaid.render as jest.Mock).mockResolvedValue({
      svg: '<svg id="diagram" width="300" height="200"><g><text>A</text></g></svg>',
    });
    editor = createProductionEditor();
    editor.commands.setContent(DOCUMENT, { contentType: 'markdown' });
    await settle();
  });

  afterEach(() => {
    editor.destroy();
    document.body.innerHTML = '';
  });

  const zoomButton = () => document.querySelector('.mermaid-zoom-btn') as HTMLButtonElement;
  const overlay = () => document.querySelector('.mermaid-lightbox-overlay');
  const viewport = () => document.querySelector('.mermaid-lightbox-viewport') as HTMLElement;
  const canvas = () => document.querySelector('.mermaid-lightbox-canvas') as HTMLElement;

  it('serializes byte-identical Markdown after opening, zooming, panning and closing', async () => {
    const before = getEditorMarkdownForSync(editor);
    const docBefore = editor.state.doc;
    expect(before).toContain('```mermaid');

    zoomButton().click();
    await settle();
    expect(overlay()).not.toBeNull();

    (document.querySelector('#mlb-zoom-in') as HTMLButtonElement).click();
    canvas().dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true }));
    viewport().dispatchEvent(
      new MouseEvent('mousedown', { clientX: 10, clientY: 10, bubbles: true })
    );
    document.dispatchEvent(
      new MouseEvent('mousemove', { clientX: 60, clientY: 40, bubbles: true })
    );
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: '0', bubbles: true }));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(overlay()).toBeNull();

    expect(editor.state.doc.eq(docBefore)).toBe(true);
    expect(getEditorMarkdownForSync(editor)).toBe(before);
  });

  it('does not mark the diagram as edited or select it when the viewer is used', async () => {
    const selectionBefore = editor.state.selection.toJSON();

    zoomButton().click();
    await settle();
    (document.querySelector('#mlb-close') as HTMLButtonElement).click();

    expect(editor.state.selection.toJSON()).toEqual(selectionBefore);
    expect(document.querySelector('.mermaid-wrapper')?.classList.contains('highlighted')).toBe(
      false
    );
    expect(document.querySelector('.mermaid-editor-overlay')).toBeNull();
  });
});
