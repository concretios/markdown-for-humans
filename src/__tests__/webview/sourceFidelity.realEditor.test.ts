/** @jest-environment jsdom */

/**
 * Copyright (c) 2025-2026 Concret.io
 *
 * Licensed under the MIT License. See LICENSE file in the project root for details.
 */

import type { Editor } from '@tiptap/core';
import { describeSourceLoss } from '../../shared/sourceLoss';
import {
  getEditorMarkdownForSync,
  setMarkdownContentPreservingSource,
} from '../../webview/utils/markdownSerialization';
import { findFragileBlocks, renderForComparison } from '../../webview/utils/sourceFidelity';
import { createProductionEditor } from '../helpers/productionEditor';

function load(markdown: string): Editor {
  const editor = createProductionEditor();
  setMarkdownContentPreservingSource(editor, markdown);
  return editor;
}

describe('findFragileBlocks', () => {
  afterEach(() => document.body.replaceChildren());

  it('names the tags an edit of the block would drop', () => {
    const editor = load('# Title\n\nSome <mark>marked</mark> and <u>under</u> text.\n\nTail.');
    expect(findFragileBlocks(editor)).toEqual([
      { index: 1, loss: { lost: ['<mark>', '</mark>', '<u>', '</u>'], rendersDifferently: false } },
    ]);
    editor.destroy();
  });

  it.each([
    ['plain Markdown', 'Some **bold**, a [link](https://x.example) and `code`.'],
    [
      'Markdown the serializer writes differently',
      '* one\n* two\n\nTitle\n=====\n\nA soft\nbreak.',
    ],
    ['tags the editor has a mark for', 'Press <kbd>Ctrl</kbd>, H<sub>2</sub>O, x<sup>2</sup>.'],
    ['a wrapper with blank lines', '<div align="center">\n\n**bold**\n\n</div>'],
    ['comments and definitions', '<!-- note -->\n\nSee [a].\n\n[a]: https://a.example'],
    ['an HTML image', 'Text <img src="a.png" width="20"> more.'],
    ['spaces at the end of a line', '**Label:**   \n\nText after.  '],
  ])('reports nothing for %s', (_name, markdown) => {
    const editor = load(`# Title\n\n${markdown}\n\nTail.`);
    expect(findFragileBlocks(editor, renderForComparison)).toEqual([]);
    editor.destroy();
  });

  it('reports a different rendering only when given a renderer', () => {
    const editor = load('# Title\n\nNot \\*italic\\* here.\n\nTail.');
    expect(findFragileBlocks(editor)).toEqual([]);
    expect(findFragileBlocks(editor, renderForComparison)).toEqual([
      { index: 1, loss: { lost: [], rendersDifferently: true } },
    ]);
    editor.destroy();
  });

  it('reports every fragile block with its document index', () => {
    const editor = load('A <mark>b</mark>.\n\nPlain.\n\n- item <u>c</u>\n\n<center>d</center>');
    expect(findFragileBlocks(editor).map(block => block.index)).toEqual([0, 2, 3]);
    editor.destroy();
  });

  it('stops reporting a block once it was edited, because its source is gone', () => {
    const editor = load('A <mark>b</mark> c.\n\nTail.');
    editor.commands.insertContentAt(2, 'X');
    expect(findFragileBlocks(editor)).toEqual([]);
    editor.destroy();
  });

  it('returns nothing for an empty document', () => {
    const editor = load('');
    expect(findFragileBlocks(editor)).toEqual([]);
    editor.destroy();
  });
});

describe('source no block holds', () => {
  afterEach(() => document.body.replaceChildren());

  it('shows up as a loss of the untouched document', () => {
    const markdown = '# Title\n\n<video src="demo.mp4" controls></video>\n\nTail.';
    const editor = load(markdown);
    expect(findFragileBlocks(editor)).toEqual([]);
    expect(describeSourceLoss(markdown, getEditorMarkdownForSync(editor))).toEqual({
      lost: ['<video src="demo.mp4" controls>', '</video>'],
      rendersDifferently: false,
    });
    editor.destroy();
  });
});
