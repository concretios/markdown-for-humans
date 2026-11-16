/**
 * Copyright (c) 2025-2026 Concret.io
 * Licensed under the MIT License. See LICENSE in the project root.
 */
import type { Node } from '@tiptap/pm/model';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view';
import type { FrontmatterPresentation } from './presentation';
import { MAX_FRONTMATTER_LENGTH, type ReadFrontmatter } from './reader';

export type FrontmatterStyle = 'current' | 'guided' | 'properties';
type Result = { node: Node; presentation: FrontmatterPresentation | null };
type FrontmatterState = {
  style: FrontmatterStyle;
  node: Node | null;
  result?: Result;
  decorations: DecorationSet;
};
type FrontmatterMeta = { style?: FrontmatterStyle; result?: Result };

export const REVEAL_FRONTMATTER = 'md4h-reveal-frontmatter';

export const frontmatterKey = new PluginKey<FrontmatterState>('frontmatterPresentation');

export function isFrontmatterStyle(value: unknown): value is FrontmatterStyle {
  return value === 'current' || value === 'guided' || value === 'properties';
}

function frontmatterNode(doc: Node): Node | null {
  const node = doc.firstChild;
  return node?.type.name === 'codeBlock' && node.attrs.frontmatter === true ? node : null;
}

function decorationsFor(
  doc: Node,
  style: FrontmatterStyle,
  node: Node | null,
  presentation?: FrontmatterPresentation | null
): DecorationSet {
  if (style === 'current' || !node) return DecorationSet.empty;
  const decorations = [
    Decoration.node(
      0,
      node.nodeSize,
      {
        'data-frontmatter-style': style,
        ...(presentation ? { 'data-frontmatter-ready': '' } : {}),
      },
      {
        frontmatter: presentation,
        style,
      }
    ),
    ...(presentation?.ranges.map(({ from, to, kind }) =>
      Decoration.inline(from + 1, to + 1, { class: 'md4h-yaml-' + kind })
    ) ?? []),
  ];
  return DecorationSet.create(doc, decorations);
}

function revealSelectedYaml(view: EditorView): false {
  const node = frontmatterNode(view.state.doc);
  if (node && view.state.selection.$head.parent === node) {
    const wrapper = view.nodeDOM(0);
    if (
      wrapper instanceof HTMLElement &&
      wrapper.matches(
        '[data-frontmatter-style="properties"][data-frontmatter-ready]:not([data-frontmatter-editing])'
      )
    ) {
      wrapper.dispatchEvent(new Event(REVEAL_FRONTMATTER));
    }
  }
  return false;
}

/** Refresh the first, host-tagged code block after editing pauses. Never edit its content. */
export function createFrontmatterPlugin(
  initialStyle: FrontmatterStyle,
  read: ReadFrontmatter
): Plugin<FrontmatterState> {
  return new Plugin<FrontmatterState>({
    key: frontmatterKey,
    state: {
      init: (_, state) => {
        const node = initialStyle === 'current' ? null : frontmatterNode(state.doc);
        return {
          style: initialStyle,
          node,
          decorations: decorationsFor(state.doc, initialStyle, node),
        };
      },
      apply: (transaction, previous) => {
        const meta = transaction.getMeta(frontmatterKey) as FrontmatterMeta | undefined;
        const style = meta?.style ?? previous.style;
        const node = style === 'current' ? null : frontmatterNode(transaction.doc);
        const result = meta?.result ?? previous.result;
        const accepted = result?.node === node ? result : undefined;
        if (style === previous.style && node === previous.node && accepted === previous.result)
          return previous;

        return {
          style,
          node,
          result: accepted,
          decorations: decorationsFor(transaction.doc, style, node, accepted?.presentation),
        };
      },
    },
    props: {
      decorations: state => frontmatterKey.getState(state)?.decorations,
      handleDOMEvents: {
        beforeinput: revealSelectedYaml,
        paste: revealSelectedYaml,
        cut: revealSelectedYaml,
      },
    },
    view: view => {
      let pending: Node | null = null;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let request: AbortController | undefined;
      const schedule = (): void => {
        const state = frontmatterKey.getState(view.state);
        const node = state?.node ?? null;
        if (pending === node) return;
        clearTimeout(timer);
        request?.abort();
        pending = node;
        if (!node || state?.result?.node === node) return;

        timer = setTimeout(() => {
          const controller = new AbortController();
          request = controller;
          const source = node.content.size > MAX_FRONTMATTER_LENGTH ? null : node.textContent;
          const result = source === null ? Promise.resolve(null) : read(source, controller.signal);
          void result
            .then(presentation => {
              if (
                controller.signal.aborted ||
                pending !== node ||
                frontmatterNode(view.state.doc) !== node
              )
                return;
              view.dispatch(
                view.state.tr.setMeta(frontmatterKey, { result: { node, presentation } })
              );
            })
            .catch(error => console.error('[MD4H] Frontmatter presentation failed:', error));
        }, 120);
      };
      schedule();
      return {
        update: (updated, previous) => {
          if (updated.hasFocus() && !previous.selection.eq(updated.state.selection)) {
            revealSelectedYaml(updated);
          }
          schedule();
        },
        destroy: () => {
          request?.abort();
          clearTimeout(timer);
        },
      };
    },
  });
}
