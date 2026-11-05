/**
 * Copyright (c) 2025-2026 Concret.io
 *
 * Licensed under the MIT License. See LICENSE file in the project root for details.
 */

/** Lower-case one code point at a time: a whole string would turn a final Σ into ς, which GitHub does not. */
function lowerCaseEachCodePoint(text: string): string {
  return Array.from(text, char => char.toLowerCase()).join('');
}

/**
 * Generate the anchor GitHub gives a heading, with its numbering for repeats.
 * Only a plain space becomes a hyphen, so "Setup & Config" gives "setup--config".
 * Letters, marks, digits and connectors of every script stay, and everything else
 * goes, including other whitespace. The text is not trimmed, because an inline image
 * at the edge of a heading leaves a space that GitHub turns into a hyphen. It is not
 * normalized either. Checked against GitHub's Markdown API, which can still differ
 * on very recent Unicode additions and some historic scripts.
 */
export function generateHeadingSlug(text: string, existingSlugs: Set<string>): string {
  const slug = lowerCaseEachCodePoint(text)
    .replace(/[^\p{Alphabetic}\p{M}\p{Nd}\p{Pc}\p{Join_Control} -]/gu, '')
    .replace(/ /g, '-');

  return withRepeatNumber(slug, existingSlugs);
}

/**
 * The anchor earlier versions of this editor wrote. It dropped non-ASCII letters
 * and collapsed hyphens. Saved documents hold links in this form, so they still resolve.
 */
function generateOlderHeadingSlug(text: string, existingSlugs: Set<string>): string {
  const slug = text
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^\w-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

  return withRepeatNumber(slug, existingSlugs);
}

function withRepeatNumber(slug: string, existingSlugs: Set<string>): string {
  let finalSlug = slug;
  let counter = 1;
  while (existingSlugs.has(finalSlug)) {
    finalSlug = `${slug}-${counter}`;
    counter++;
  }

  existingSlugs.add(finalSlug);
  return finalSlug;
}

/** The form anchors are compared in, so spelling differences in a link still match. */
function toAnchorKey(anchor: string): string {
  return lowerCaseEachCodePoint(anchor.normalize('NFC'));
}

/**
 * Map every anchor that can reach a heading to that heading's index. Current anchors
 * are added first, so an older form never hides another heading's real one. A heading
 * with an empty current anchor has none on GitHub. An empty older anchor still counts,
 * because the link dialog wrote it as a bare # for headings with no ASCII letters.
 */
export function buildHeadingAnchors(headingTexts: string[]): Map<string, number> {
  const anchors = new Map<string, number>();
  const add = (anchor: string, index: number) => {
    const key = toAnchorKey(anchor);
    if (!anchors.has(key)) {
      anchors.set(key, index);
    }
  };

  const currentSlugs = new Set<string>();
  headingTexts.forEach((text, index) => {
    const slug = generateHeadingSlug(text, currentSlugs);
    if (slug) {
      add(slug, index);
    }
  });

  const olderSlugs = new Set<string>();
  headingTexts.forEach((text, index) => {
    add(generateOlderHeadingSlug(text, olderSlugs), index);
  });

  return anchors;
}

/**
 * Find the heading a link fragment (the part after #) points to. The fragment may
 * be percent-encoded, in decomposed Unicode, or in a different case.
 */
export function resolveHeadingAnchor(
  anchors: Map<string, number>,
  fragment: string
): number | undefined {
  let decoded = fragment;
  try {
    decoded = decodeURIComponent(fragment);
  } catch {
    // Not valid percent-encoding: compare it as written.
  }

  return anchors.get(toAnchorKey(decoded));
}
