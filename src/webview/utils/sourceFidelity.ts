/**
 * Copyright (c) 2025-2026 Concret.io
 *
 * Licensed under the MIT License. See LICENSE file in the project root for details.
 */

/**
 * @file sourceFidelity.ts - Find blocks the editor cannot save back as authored
 * @description A block that is not edited saves its authored source. Once it is
 *              edited, the serializer writes it from the document tree, and
 *              anything the tree does not hold (an HTML tag with no mark, a
 *              backslash escape) is gone. This finds those blocks before the
 *              edit happens.
 */

import type { Editor } from '@tiptap/core';
import { Marked } from 'marked';
import { describeSourceLoss, type SourceLoss } from '../../shared/sourceLoss';
import { listRememberedBlockSources } from './markdownSerialization';

/** A top-level block whose authored source an edit would not reproduce. */
export interface FragileBlock {
  /** Index of the block among the document's top-level nodes. */
  index: number;
  loss: SourceLoss;
}

const LINK_DEFINITION = /^ {0,3}\[[^\]\n]+\]:/;

// A private instance: the editor registers tokenizers on its own instance that
// have no renderer, so rendering through that one throws.
const comparisonMarked = new Marked({ gfm: true, breaks: true, async: false });

/**
 * Render Markdown the way the rich view reads it (GFM, single newlines as
 * breaks), for comparing two texts by what they show.
 *
 * @param markdown - Markdown text
 * @returns HTML with whitespace runs collapsed
 */
export function renderForComparison(markdown: string): string {
  // With single newlines read as breaks, spaces at the end of a line show nothing.
  const withoutLineEndSpaces = markdown.replace(/[ \t]+$/gm, '');
  return String(comparisonMarked.parse(withoutLineEndSpaces)).replace(/\s+/g, ' ').trim();
}

/**
 * Find the top-level blocks that would lose source text if they were edited.
 *
 * Blocks that were already edited are not listed: their authored source is no
 * longer held, so there is nothing left to compare.
 *
 * @param editor - Editor loaded with `setMarkdownContentPreservingSource`
 * @param render - Pass {@link renderForComparison} to also find blocks that
 *                 keep every tag but would render differently
 * @returns The fragile blocks in document order
 */
export function findFragileBlocks(
  editor: Editor,
  render?: (markdown: string) => string
): FragileBlock[] {
  const blocks = listRememberedBlockSources(editor);
  // A reference link (`[docs]`) only renders as a link next to its definition,
  // which is a block of its own. Render every block with all of them.
  const definitions = blocks
    .map(block => block.source)
    .filter(source => LINK_DEFINITION.test(source))
    .join('\n');
  const renderInDocument =
    render && definitions !== ''
      ? (markdown: string): string => render(`${markdown}\n\n${definitions}`)
      : render;

  const fragile: FragileBlock[] = [];
  for (const block of blocks) {
    const loss = describeSourceLoss(block.source, block.serialized, renderInDocument);
    if (loss !== null) fragile.push({ index: block.index, loss });
  }
  return fragile;
}
