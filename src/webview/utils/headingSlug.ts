/**
 * Copyright (c) 2025-2026 Concret.io
 *
 * Licensed under the MIT License. See LICENSE file in the project root for details.
 */

import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { PRESERVED_MARKDOWN_LITERAL_TOKEN } from './markedLexerNormalizer';

/**
 * Every anchor handed out so far, each with the next repeat number to try for it.
 * Remembering that number keeps a document full of repeated headings linear.
 */
export type SeenSlugs = Map<string, number>;

/** Lower-case one code point at a time: a whole string would turn a final Σ into ς, which GitHub does not. */
function lowerCaseEachCodePoint(text: string): string {
  return Array.from(text, char => char.toLowerCase()).join('');
}

/**
 * The text GitHub builds a heading's anchor from. Unlike node.textContent it includes
 * inline math, which GitHub renders as text, and leaves out the edges that saving drops:
 * spaces and tabs at the start, which Markdown ignores, and any whitespace at the end,
 * which the serializer trims. A non-breaking space at the start survives, so it stays.
 * Only plain text can be an edge: a space next to an image, a comment, math, an entity or
 * a hard break stays. A loaded `# Foo <br>` is `foo-` on GitHub, so the hard break must stop
 * the edge, though the same heading typed in the editor saves as `# Foo`, which is `foo`.
 */
export function headingAnchorText(heading: ProseMirrorNode): string {
  const parts = [''];
  heading.forEach(child => {
    const isLiteral = child.marks.some(mark => mark.type.name === PRESERVED_MARKDOWN_LITERAL_TOKEN);
    if (child.isText && !isLiteral) {
      parts[parts.length - 1] += child.text;
    } else {
      const part = child.type.name === 'inlineMath' ? (child.attrs.latex as string) : child.text;
      parts.push(part ?? '', '');
    }
  });
  parts[0] = parts[0].replace(/^[ \t]+/, '');
  parts[parts.length - 1] = parts[parts.length - 1].replace(/\s+$/, '');
  return parts.join('');
}

/**
 * Generate the anchor GitHub gives a heading, with its numbering for repeats.
 * Only a plain space becomes a hyphen, so "Setup & Config" gives "setup--config".
 * Letters, marks, digits and connectors of every script stay, and everything else
 * goes, including other whitespace. Pass headingAnchorText, not node.textContent: the
 * text is not trimmed here, because a space beside an inline image becomes a hyphen on
 * GitHub. It is not normalized either. Checked against GitHub's Markdown API, which can
 * still differ on very recent Unicode additions and some historic scripts.
 */
export function generateHeadingSlug(text: string, seen: SeenSlugs): string {
  const slug = lowerCaseEachCodePoint(text)
    .replace(/[^\p{Alphabetic}\p{M}\p{Nd}\p{Pc}\p{Join_Control} -]/gu, '')
    .replace(/ /g, '-');

  return withRepeatNumber(slug, seen);
}

/**
 * The anchor earlier versions of this editor wrote. It dropped non-ASCII letters
 * and collapsed hyphens. Saved documents hold links in this form, so they still resolve.
 */
function generateOlderHeadingSlug(text: string, seen: SeenSlugs): string {
  const slug = text
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^\w-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

  return withRepeatNumber(slug, seen);
}

function withRepeatNumber(slug: string, seen: SeenSlugs): string {
  let finalSlug = slug;
  let counter = seen.get(slug) ?? 1;
  while (seen.has(finalSlug)) {
    finalSlug = `${slug}-${counter}`;
    counter++;
  }

  seen.set(finalSlug, 1);
  seen.set(slug, counter);
  return finalSlug;
}

/** The form anchors are compared in, so spelling differences in a link still match. */
function toAnchorKey(anchor: string): string {
  return lowerCaseEachCodePoint(anchor.normalize('NFC'));
}

export interface HeadingTexts {
  /** node.textContent, the text shown to the user. */
  text: string;
  /** headingAnchorText(node), the text the current anchor comes from. */
  anchorText: string;
}

/**
 * Map every anchor that can reach a heading to that heading's index. Current anchors
 * are added first, so an older form never hides another heading's real one. A heading
 * with an empty current anchor cannot be linked to on GitHub. An empty older anchor still
 * counts, because the link dialog wrote it as a bare # for headings with no ASCII letters.
 * Older anchors come from a heading's textContent, which is what earlier versions read.
 */
export function buildHeadingAnchors(headings: HeadingTexts[]): Map<string, number> {
  const anchors = new Map<string, number>();
  const add = (anchor: string, index: number) => {
    const key = toAnchorKey(anchor);
    if (!anchors.has(key)) {
      anchors.set(key, index);
    }
  };

  const currentSlugs: SeenSlugs = new Map();
  headings.forEach(({ anchorText }, index) => {
    const slug = generateHeadingSlug(anchorText, currentSlugs);
    if (slug) {
      add(slug, index);
    }
  });

  const olderSlugs: SeenSlugs = new Map();
  headings.forEach(({ text }, index) => {
    add(generateOlderHeadingSlug(text, olderSlugs), index);
  });

  return anchors;
}

/** A link fragment in the form anchors are compared in. */
export function toFragmentKey(fragment: string): string {
  let decoded = fragment;
  try {
    decoded = decodeURIComponent(fragment);
  } catch {
    // Not valid percent-encoding: compare it as written.
  }

  return toAnchorKey(decoded);
}

/**
 * Find the heading a link fragment (the part after #) points to. The fragment may
 * be percent-encoded, in decomposed Unicode, or in a different case. It may also start
 * with user-content-, the prefix GitHub puts on the ids in its HTML. That prefixed id
 * belongs to the heading with the rest as its anchor, so the rest is tried first.
 */
export function resolveHeadingAnchor(
  anchors: Map<string, number>,
  fragment: string
): number | undefined {
  const key = toFragmentKey(fragment);
  return anchors.get(key.replace(/^user-content-(?=.)/u, '')) ?? anchors.get(key);
}
