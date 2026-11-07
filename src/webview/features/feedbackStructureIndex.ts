/**
 * Frozen structural scopes. Parent pointers and section endpoints take linear
 * space. Nested scopes represent rendered text, never invented source slices.
 */
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import * as l10n from '../l10n';

export interface FeedbackStructureScope {
  readonly from: number;
  readonly to: number;
  readonly ordinal: number;
  readonly label: string;
  readonly wholeBlock: boolean;
  readonly section: boolean;
}
interface Entry {
  node: ProseMirrorNode;
  from: number;
  to: number;
  ordinal: number;
  parent: Entry | null;
  sectionEnd?: number;
  sectionOpaque?: number;
  sectionOwner?: Entry;
  opaque: number;
}
export interface FeedbackStructureIndex {
  atPosition(position: number): FeedbackStructureScope | null;
  choices(position: number): readonly FeedbackStructureScope[];
}
const textContainers = new Set([
  'paragraph',
  'heading',
  'bulletList',
  'orderedList',
  'taskList',
  'listItem',
  'taskItem',
  'blockquote',
  'githubAlert',
  'codeBlock',
  'text',
  'hardBreak',
]);
// Looked up on each use so the label follows the loaded translations.
const labels: Record<string, () => string> = {
  paragraph: () => l10n.t('Whole paragraph'),
  heading: () => l10n.t('Whole heading'),
  listItem: () => l10n.t('Item and children'),
  taskItem: () => l10n.t('Task and children'),
  bulletList: () => l10n.t('Whole bullet list'),
  orderedList: () => l10n.t('Whole numbered list'),
  taskList: () => l10n.t('Whole task list'),
  blockquote: () => l10n.t('Whole block quote'),
  githubAlert: () => l10n.t('Whole alert'),
  codeBlock: () => l10n.t('Whole code block'),
  table: () => l10n.t('Whole table'),
};

/** Build once per immutable ProseMirror document, with no per-hit subtree walks. */
export function createFeedbackStructureIndex(doc: ProseMirrorNode): FeedbackStructureIndex {
  const entries = new Map<number, Entry>();
  // Index block nodes only. Inline atoms still contribute to the opaque count.
  const visit = (
    node: ProseMirrorNode,
    from: number,
    ordinal: number,
    parent: Entry | null,
    depth: number
  ): Entry => {
    const entry: Entry = { node, from, to: from + node.nodeSize, ordinal, parent, opaque: 0 };
    entries.set(from, entry);
    if (depth >= 64 || !textContainers.has(node.type.name)) {
      entry.opaque = 1;
      return entry;
    }
    const headings: Entry[] = [];
    node.forEach((child, offset) => {
      if (!child.isBlock) {
        if (!textContainers.has(child.type.name)) entry.opaque++;
        return;
      }
      const nested = visit(child, from + 1 + offset, ordinal, entry, depth + 1);
      const opaqueBefore = entry.opaque;
      entry.opaque += nested.opaque;
      if (child.type.name === 'heading') {
        while (
          headings.length &&
          headings[headings.length - 1].node.attrs.level >= child.attrs.level
        ) {
          const completed = headings.pop()!;
          completed.sectionEnd = nested.from;
          completed.sectionOpaque! += opaqueBefore;
        }
        nested.sectionOwner = headings[headings.length - 1];
        nested.sectionOpaque = -opaqueBefore;
        headings.push(nested);
      } else nested.sectionOwner = headings[headings.length - 1];
    });
    while (headings.length) {
      const completed = headings.pop()!;
      completed.sectionEnd = entry.to - 1;
      completed.sectionOpaque! += entry.opaque;
    }
    return entry;
  };
  doc.forEach((node, offset, ordinal) => visit(node, offset, ordinal, null, 0));

  const scope = (entry: Entry, section = false): FeedbackStructureScope | null => {
    const to = section ? entry.sectionEnd : entry.to;
    if (to === undefined) return null;
    // Whole top-level blocks use host-derived source evidence. For nested text,
    // refuse opaque content and oversized traversals before allocating DOM text.
    const wholeBlock = entry.parent === null && !section;
    if (!wholeBlock && (entry.opaque || to - entry.from > 64 * 1024)) return null;
    if (section && entry.sectionOpaque !== 0) return null;
    return {
      from: entry.from,
      to,
      ordinal: entry.ordinal,
      wholeBlock,
      section,
      label: section
        ? l10n.t(
            'Section: {0}',
            entry.node.textBetween(0, Math.min(entry.node.content.size, 120)).trim() ||
              l10n.t('Untitled section')
          )
        : (labels[entry.node.type.name]?.() ?? l10n.t('Whole block')),
    };
  };
  const entryAt = (position: number): Entry | null => {
    if (!Number.isInteger(position) || position < 0 || position > doc.content.size) return null;
    const resolved = doc.resolve(position);
    for (let depth = resolved.depth; depth > 0; depth--) {
      const found = entries.get(resolved.before(depth));
      if (found) return found;
    }
    return entries.get(position) ?? null;
  };
  const choices = (position: number): FeedbackStructureScope[] => {
    const result: FeedbackStructureScope[] = [];
    const seen = new Set<string>();
    const add = (candidate: FeedbackStructureScope | null) => {
      if (!candidate) return;
      const key = `${candidate.from}:${candidate.to}:${candidate.section}`;
      if (!seen.has(key)) {
        result.push(candidate);
        seen.add(key);
      }
    };
    let current = entryAt(position);
    while (current) {
      add(scope(current));
      if (current.sectionEnd !== undefined) add(scope(current, true));
      let heading = current.sectionOwner;
      while (heading) {
        add(scope(heading, true));
        heading = heading.sectionOwner;
      }
      current = current.parent;
    }
    return result;
  };
  return {
    choices,
    atPosition(position) {
      const candidates = choices(position);
      const entry = entryAt(position);
      if (entry?.node.type.name === 'heading')
        return candidates.find(candidate => candidate.section) ?? candidates[0] ?? null;
      // Clicking prose in a list targets its item, including descendants.
      // The label is translated, so the item scope is found by its node type.
      return (
        candidates.find(
          candidate =>
            !candidate.section &&
            ['listItem', 'taskItem'].includes(entries.get(candidate.from)?.node.type.name ?? '')
        ) ??
        candidates[0] ??
        null
      );
    },
  };
}
