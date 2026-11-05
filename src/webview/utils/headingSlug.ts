/**
 * Copyright (c) 2025-2026 Concret.io
 *
 * Licensed under the MIT License. See LICENSE file in the project root for details.
 */

/**
 * Generate the anchor GitHub gives a heading, with its numbering for repeats.
 * Letters of every script stay, punctuation and symbols go, and each space
 * becomes one hyphen, so "Setup & Config" gives "setup--config".
 */
export function generateHeadingSlug(text: string, existingSlugs: Set<string>): string {
  const slug = text
    .normalize('NFC')
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc}\s-]/gu, '')
    .replace(/\s/g, '-');

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

/**
 * Map every anchor that can reach a heading to that heading's index. Current
 * anchors are added first, so an older form never hides another heading's real one.
 */
export function buildHeadingAnchors(headingTexts: string[]): Map<string, number> {
  const anchors = new Map<string, number>();
  const generators = [generateHeadingSlug, generateOlderHeadingSlug];

  generators.forEach(generate => {
    const existingSlugs = new Set<string>();
    headingTexts.forEach((text, index) => {
      const slug = generate(text, existingSlugs);
      if (slug && !anchors.has(slug)) {
        anchors.set(slug, index);
      }
    });
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

  return anchors.get(decoded.normalize('NFC').toLowerCase());
}
