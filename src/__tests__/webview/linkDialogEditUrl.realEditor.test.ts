/** @jest-environment jsdom */

/**
 * Copyright (c) 2025-2026 Concret.io
 *
 * Licensed under the MIT License. See LICENSE file in the project root for details.
 *
 * Changing the address of an existing link in the link dialog must save the
 * new address.
 *
 * The dialog kept the link's old href as the path picked from a list, and OK
 * preferred that over the URL field, so a typed address was ignored and the
 * link kept its old target.
 */

import type { Editor } from '@tiptap/core';
import { hideLinkDialog, showLinkDialog } from '../../webview/features/linkDialog';
import { getEditorMarkdownForSync } from '../../webview/utils/markdownSerialization';
import { createProductionEditor } from '../helpers/productionEditor';

const urlInput = () => document.querySelector('#link-url-input') as HTMLInputElement;

/** Replaces the field the way typing does: new value, then an input event. */
function typeUrl(value: string): void {
  urlInput().value = value;
  urlInput().dispatchEvent(new Event('input', { bubbles: true }));
}

describe('editing the address of an existing link', () => {
  let editor: Editor;

  beforeEach(() => {
    editor = createProductionEditor();
    editor.commands.setContent('Plain [example](https://example.com) text.\n', {
      contentType: 'markdown',
    });
  });

  afterEach(() => {
    hideLinkDialog();
    // The dialog element is created once per module; keep it in the page.
    editor.destroy();
  });

  /** Puts the caret inside the link text and opens the dialog. */
  function openOnLink(): void {
    let inside = 0;
    editor.state.doc.descendants((node, pos) => {
      if (!inside && node.marks.some(mark => mark.type.name === 'link')) inside = pos + 2;
    });
    editor.commands.setTextSelection(inside);
    showLinkDialog(editor);
    expect(urlInput().value).toBe('https://example.com');
  }

  it('saves a typed URL when OK is clicked', () => {
    openOnLink();
    typeUrl('https://example.org/edited');
    (document.querySelector('#link-ok-btn') as HTMLButtonElement).click();

    expect(getEditorMarkdownForSync(editor).trimEnd()).toBe(
      'Plain [example](https://example.org/edited) text.'
    );
  });

  it('saves a typed URL when Enter is pressed in the URL field', () => {
    openOnLink();
    typeUrl('https://example.org/enter');
    urlInput().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

    expect(getEditorMarkdownForSync(editor).trimEnd()).toBe(
      'Plain [example](https://example.org/enter) text.'
    );
  });

  it('keeps the link unchanged when OK is clicked without typing', () => {
    openOnLink();
    (document.querySelector('#link-ok-btn') as HTMLButtonElement).click();

    expect(getEditorMarkdownForSync(editor).trimEnd()).toBe(
      'Plain [example](https://example.com) text.'
    );
  });
});
