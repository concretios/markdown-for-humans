/**
 * Copyright (c) 2025-2026 Concret.io
 *
 * Licensed under the MIT License. See LICENSE file in the project root for details.
 */

import { Editor } from '@tiptap/core';
import { buildHeadingAnchors, headingAnchorText, resolveHeadingAnchor } from './headingSlug';

export interface OutlineEntry {
  level: number;
  text: string;
  pos: number;
  sectionStart: number;
  sectionEnd: number;
}

export interface SimpleHeading {
  level: number;
  text: string;
  pos: number;
  nodeSize?: number;
}

export function computeOutline(headings: SimpleHeading[], docSize: number): OutlineEntry[] {
  const outline = headings.map(h => ({
    level: h.level,
    text: h.text,
    pos: h.pos,
    sectionStart: h.pos,
    sectionEnd: (h.pos || 0) + (h.nodeSize || 0),
  }));

  for (let i = 0; i < outline.length; i++) {
    const current = outline[i];
    let sectionEnd = docSize;

    for (let j = i + 1; j < outline.length; j++) {
      const next = outline[j];
      if (next.level <= current.level) {
        sectionEnd = next.sectionStart;
        break;
      }
    }

    current.sectionEnd = sectionEnd;
  }

  return outline;
}

export function buildOutlineFromEditor(editor: Editor): OutlineEntry[] {
  const doc = editor.state.doc;
  const headings: SimpleHeading[] = [];

  doc.descendants((node, pos) => {
    if (node.type.name === 'heading') {
      const level = node.attrs.level as number;
      const text = node.textContent;
      headings.push({
        level,
        text,
        pos,
        nodeSize: node.nodeSize,
      });
    }
    return true;
  });

  return computeOutline(headings, doc.content.size);
}

export interface HeadingWithAnchorText {
  level: number;
  text: string;
  anchorText: string;
  pos: number;
}

/** Every heading with what a link to it needs. Display text stays in `text`. */
export function getHeadingsWithAnchorText(editor: Editor): HeadingWithAnchorText[] {
  const headings: HeadingWithAnchorText[] = [];

  editor.state.doc.descendants((node, pos) => {
    if (node.type.name === 'heading') {
      headings.push({
        level: node.attrs.level as number,
        text: node.textContent,
        anchorText: headingAnchorText(node),
        pos,
      });
    }
    return true;
  });

  return headings;
}

/** Position of the heading a link fragment (the part after #) points to, if any. */
export function findHeadingPos(editor: Editor, fragment: string): number | undefined {
  const headings = getHeadingsWithAnchorText(editor);
  const index = resolveHeadingAnchor(buildHeadingAnchors(headings), fragment);
  return index === undefined ? undefined : headings[index].pos;
}
