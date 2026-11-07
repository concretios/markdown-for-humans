/** @jest-environment jsdom */

/**
 * Copyright (c) 2025-2026 Concret.io
 *
 * Licensed under the MIT License. See LICENSE file in the project root for details.
 *
 * Typing next to a code-formatted link must keep the link.
 *
 * A browser types by changing the DOM first; ProseMirror then re-reads the
 * changed range and parses it back into marks. While inline code excluded
 * every other mark, re-applying `code` to `[`one`](#foo)` dropped the link,
 * so typing a letter between two code links saved as `` `one`a`two` ``.
 * `tr.insertText` never re-reads the DOM, so these tests change the DOM and
 * flush ProseMirror's DOM observer the way a keystroke does.
 */

import type { Editor } from '@tiptap/core';
import type { AuditIssue } from '../../webview/features/auditDocument';
import { clearToasts, showAuditOverlay } from '../../webview/features/auditOverlay';
import { hideLinkDialog, showLinkDialog } from '../../webview/features/linkDialog';
import { getEditorMarkdownForSync } from '../../webview/utils/markdownSerialization';
import { insertPlainText } from '../../webview/utils/plainTextPaste';
import { dispatchPaste, placeCaretAfter, selectText } from '../helpers/pasteTestEditor';
import { createProductionEditor } from '../helpers/productionEditor';

type DomObserverView = { domObserver: { flush: () => void } };

function load(markdown: string): Editor {
  const editor = createProductionEditor();
  editor.commands.setContent(markdown, { contentType: 'markdown' });
  return editor;
}

/** Inserts `text` into the paragraph DOM before `reference` (or at the end), then lets ProseMirror read it. */
function typeIntoDom(editor: Editor, text: string, reference: ChildNode | null): void {
  const paragraph = editor.view.dom.querySelector('p');
  if (!paragraph) throw new Error('no paragraph');
  paragraph.insertBefore(document.createTextNode(text), reference);
  (editor.view as unknown as DomObserverView).domObserver.flush();
}

function anchors(editor: Editor): HTMLAnchorElement[] {
  return Array.from(editor.view.dom.querySelectorAll('a'));
}

/** Each text run of the first paragraph with its link target and whether it is code. */
function runs(editor: Editor): Array<{ text: string; href: string | null; code: boolean }> {
  const runs: Array<{ text: string; href: string | null; code: boolean }> = [];
  editor.state.doc.firstChild?.forEach(node => {
    const link = node.marks.find(mark => mark.type.name === 'link');
    runs.push({
      text: node.text ?? '',
      href: link ? (link.attrs.href as string) : null,
      code: node.marks.some(mark => mark.type.name === 'code'),
    });
  });
  return runs;
}

/** Loads `markdown`, types `a` before the anchor at `index` (or at the end), and returns the saved Markdown. */
function typeAndSave(markdown: string, index: number | null): string {
  const editor = load(markdown);
  try {
    typeIntoDom(editor, 'a', index === null ? null : anchors(editor)[index]);
    return getEditorMarkdownForSync(editor);
  } finally {
    editor.destroy();
  }
}

describe('typing next to a code link keeps the link (DOM mutation path)', () => {
  let editor: Editor;

  afterEach(() => {
    editor?.destroy();
  });

  it('typing between two code links keeps both links', () => {
    editor = load('[`one`](#foo)[`two`](#bar)');
    typeIntoDom(editor, 'a', anchors(editor)[1]);

    // The letter joins the run before it, as it does for plain links (link and
    // code are inclusive).
    expect(runs(editor)).toEqual([
      { text: 'onea', href: '#foo', code: true },
      { text: 'two', href: '#bar', code: true },
    ]);
    // The serializer keeps neighbouring code runs as separate code spans.
    expect(getEditorMarkdownForSync(editor)).toBe('[`onea`](#foo)[`two`](#bar)');
  });

  it('typing after a code link keeps the link, like a plain link', () => {
    expect(typeAndSave('[one](#foo)', null)).toBe('[onea](#foo)');
    expect(typeAndSave('[`one`](#foo)', null)).toBe('[`onea`](#foo)');
  });

  it('typing before a code link keeps the link, like a plain link', () => {
    expect(typeAndSave('[one](#foo)', 0)).toBe('[aone](#foo)');
    expect(typeAndSave('[`one`](#foo)', 0)).toBe('[`aone`](#foo)');
  });

  it('typing inside a code link still keeps the link', () => {
    editor = load('[`one`](#foo)');
    const text = editor.view.dom.querySelector('code')?.firstChild;
    if (!text) throw new Error('no code text');
    text.textContent = 'oxne';
    (editor.view as unknown as DomObserverView).domObserver.flush();

    expect(getEditorMarkdownForSync(editor)).toBe('[`oxne`](#foo)');
  });
});

describe('inline code excludes every mark except link', () => {
  let editor: Editor;

  afterEach(() => {
    editor?.destroy();
  });

  it('lets a link and code share text, and keeps the other marks out', () => {
    editor = createProductionEditor();
    const code = editor.schema.marks.code;
    const excluded = Object.values(editor.schema.marks)
      .filter(type => code.excludes(type))
      .map(type => type.name)
      .sort();
    const expected = Object.keys(editor.schema.marks)
      .filter(name => name !== 'link')
      .sort();

    expect(code.excludes(editor.schema.marks.link)).toBe(false);
    expect(excluded).toEqual(expected);
    expect(excluded).toEqual(expect.arrayContaining(['bold', 'italic', 'strike', 'code']));
  });

  it('an Audit pill re-targets a code link', () => {
    editor = load('See [`run()`](#old) now.');
    let pos = 0;
    let nodeSize = 0;
    editor.state.doc.descendants((node, nodePos) => {
      if (node.isText && node.text === 'run()') {
        pos = nodePos;
        nodeSize = node.nodeSize;
      }
    });
    const issue: AuditIssue = {
      type: 'heading',
      message: 'Heading anchor not found: #old',
      target: 'old',
      suggestions: ['new'],
      pos,
      nodeSize,
    };
    showAuditOverlay(editor, [issue]);
    try {
      (document.querySelector('.audit-suggestion-pill') as HTMLButtonElement).click();
    } finally {
      document.getElementById('audit-overlay')?.remove();
      clearToasts();
    }

    expect(getEditorMarkdownForSync(editor)).toBe('See [`run()`](#new) now.');
  });

  it('the link dialog links selected code text', () => {
    editor = load('Call `run()` now.');
    selectText(editor, 'run()');
    showLinkDialog(editor);
    try {
      (document.querySelector('#link-url-input') as HTMLInputElement).value = '#run';
      (document.querySelector('#link-ok-btn') as HTMLButtonElement).click();
    } finally {
      hideLinkDialog();
    }

    expect(getEditorMarkdownForSync(editor)).toBe('Call [`run()`](#run) now.');
  });

  it('applying code to linked text keeps the link', () => {
    editor = load('See [docs](#docs).');
    editor.chain().setTextSelection({ from: 5, to: 9 }).toggleCode().run();

    expect(getEditorMarkdownForSync(editor)).toBe('See [`docs`](#docs).');
  });

  it('applying code to bold text still drops the bold, as before', () => {
    editor = load('See **docs**.');
    editor.chain().setTextSelection({ from: 5, to: 9 }).toggleCode().run();

    expect(getEditorMarkdownForSync(editor)).toBe('See `docs`.');
  });
});

describe('pasting a code link keeps the link', () => {
  let editor: Editor;

  afterEach(() => {
    editor?.destroy();
  });

  it('keeps the link when pasting rich HTML', () => {
    editor = load('See now.');
    placeCaretAfter(editor, 'See ');
    dispatchPaste(editor, {
      'text/html': '<a href="#run"><code>run()</code></a>',
      'text/plain': 'run()',
    });

    expect(getEditorMarkdownForSync(editor)).toBe('See [`run()`](#run)now.');
  });

  it('keeps the link when pasting Markdown source', () => {
    editor = load('See now.');
    placeCaretAfter(editor, 'See ');
    insertPlainText(editor, '[`run()`](#run)', 'markdown');

    // Markdown mode inserts a block here; only the link matters to this test.
    expect(getEditorMarkdownForSync(editor)).toContain('[`run()`](#run)');
  });
});
