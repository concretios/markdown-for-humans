/** @jest-environment jsdom */

/**
 * Copyright (c) 2025-2026 Concret.io
 *
 * Licensed under the MIT License. See LICENSE file in the project root for details.
 */

/**
 * A paragraph that opens with a one or two letter word and a period
 * ("No. That is the answer.") is plain text in CommonMark. TipTap's ordered
 * list tokenizer, reached through OrderedListMarkdownFix for every
 * non-numeric line, reads that word as an alphabetic or roman list marker.
 *
 * The editor then shows a numbered list, Feedback refuses to start
 * (block-kind-mismatch: list in the editor, paragraph in the saved file), and
 * an edit to the paragraph saves "1." in place of the word.
 */

import type { Editor } from '@tiptap/core';
import { buildFeedbackAnchorMap } from '../../editor/feedbackAnchors';
import { enumerateCanonicalFeedbackBlocks } from '../../webview/features/feedbackReview';
import {
  getEditorMarkdownForSync,
  setMarkdownContentPreservingSource,
} from '../../webview/utils/markdownSerialization';
import { createProductionEditor } from '../helpers/productionEditor';

const PARAGRAPHS = [
  'No. That is the answer.',
  'Ok. Fine by me.',
  'I. Think so.',
  'Mr. Smith arrived.',
  'A. Lincoln wrote it.',
];

/** Top-level node types, without the empty paragraph the editor keeps after a list. */
function blockTypes(editor: Editor): string[] {
  return (editor.getJSON().content ?? [])
    .filter(node => node.type !== 'paragraph' || (node.content?.length ?? 0) > 0)
    .map(node => node.type ?? '');
}

function load(source: string): Editor {
  const editor = createProductionEditor();
  setMarkdownContentPreservingSource(editor, source);
  return editor;
}

describe('paragraph opening with a short word and a period', () => {
  it.each(PARAGRAPHS)('loads %j as a paragraph, not a list', text => {
    const editor = load(`Intro.\n\n${text}\n`);
    expect(blockTypes(editor)).toEqual(['paragraph', 'paragraph']);
  });

  it.each(PARAGRAPHS)('lets Feedback anchor %j to the saved file', text => {
    const source = `Intro.\n\n${text}\n`;
    const editor = load(source);
    const result = buildFeedbackAnchorMap(source, enumerateCanonicalFeedbackBlocks(editor));
    expect(result.ok ? 'ok' : result.error.reason).toBe('ok');
  });

  it.each(PARAGRAPHS)('keeps the first word of %j after an edit', text => {
    const editor = load(`Intro.\n\n${text}\n`);
    let end = -1;
    editor.state.doc.descendants((node, pos) => {
      if (node.isTextblock && node.textContent.endsWith(text.slice(text.indexOf(' ') + 1))) {
        end = pos + node.nodeSize - 1;
      }
    });
    expect(end).toBeGreaterThan(0);
    editor.commands.insertContentAt(end, ' Edited.');
    expect(getEditorMarkdownForSync(editor)).toContain(`${text} Edited.`);
  });

  it('still loads a numeric ordered list as a list', () => {
    const editor = load('Intro.\n\n1. First\n2. Second\n');
    expect(blockTypes(editor)).toEqual(['paragraph', 'orderedList']);
  });
});
