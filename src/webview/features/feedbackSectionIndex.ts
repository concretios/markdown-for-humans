/** Frozen, top-level heading intervals. Never traverse the document during hover. */
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import type { FeedbackBlockActionAnchor } from './feedbackBlockAction';

export interface FeedbackSection {
  readonly startOrdinal: number;
  readonly endOrdinal: number;
  readonly label: string;
}
export interface FeedbackSectionIndex {
  section(ordinal: number): FeedbackSection | null;
  ancestors(ordinal: number): readonly FeedbackSection[];
}

/**
 * Index section bounds in one pass, retaining parent pointers instead of copied
 * ancestor arrays. Missing nonempty source anchors make a section unavailable.
 * Nested headings are scoped to their container and cannot end a top-level section.
 */
export function createFeedbackSectionIndex(
  doc: ProseMirrorNode,
  anchors: readonly FeedbackBlockActionAnchor[]
): FeedbackSectionIndex {
  const anchored = new Set(anchors.map(anchor => anchor.ordinal));
  const sections = new Map<number, FeedbackSection>();
  const parent = new Map<number, number | null>();
  const owner: Array<number | null> = [];
  const stack: Array<{ ordinal: number; level: number; label: string; invalidBefore: number }> = [];
  let invalid = 0;
  let lastAnchored = -1;
  const finish = (): void => {
    const heading = stack.pop()!;
    if (invalid !== heading.invalidBefore || !anchored.has(heading.ordinal)) return;
    sections.set(heading.ordinal, {
      startOrdinal: heading.ordinal,
      endOrdinal: Math.max(heading.ordinal, lastAnchored),
      label: heading.label,
    });
  };
  doc.forEach((node, _offset, ordinal) => {
    const level = node.type.name === 'heading' ? node.attrs.level : null;
    if (Number.isInteger(level) && level >= 1 && level <= 6) {
      while (stack.length && stack[stack.length - 1].level >= level) finish();
      parent.set(ordinal, stack[stack.length - 1]?.ordinal ?? null);
      stack.push({
        ordinal,
        level,
        label: node.textContent.trim().slice(0, 120) || 'Untitled section',
        invalidBefore: invalid,
      });
    }
    owner[ordinal] = stack[stack.length - 1]?.ordinal ?? null;
    if (anchored.has(ordinal)) lastAnchored = ordinal;
    else if (!(node.isTextblock && node.content.size === 0)) invalid += 1;
  });
  while (stack.length) finish();
  return {
    section: ordinal => sections.get(ordinal) ?? null,
    ancestors(ordinal) {
      const result: FeedbackSection[] = [];
      let current = owner[ordinal] ?? null;
      while (current !== null) {
        const section = sections.get(current);
        if (section) result.push(section);
        current = parent.get(current) ?? null;
      }
      return result;
    },
  };
}
