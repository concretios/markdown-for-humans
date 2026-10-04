/// <reference lib="es2021.weakref" />
/**
 * Background code highlighting with occurrence identity and mapped decorations.
 * Only changed document ranges are inspected on typing. Lexical work is owned
 * by the plugin view and never runs in a ProseMirror transaction.
 */
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { Plugin, PluginKey, type Transaction } from '@tiptap/pm/state';
import {
  AttrStep,
  DocAttrStep,
  AddMarkStep,
  RemoveMarkStep,
  AddNodeMarkStep,
  RemoveNodeMarkStep,
  ReplaceAroundStep,
  ReplaceStep,
} from '@tiptap/pm/transform';
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view';
import { parseFenceInfo } from './fenceInfo';
import { resolveGrammar } from './languageRegistry';
import { innermostScope } from './innermostScope';
import { projectTokenSpans, readViewportRange, type ViewportRange } from './projection';
import { explainHighlightFailure, type HighlightResult, type HighlightService } from './types';

interface BlockOccurrence {
  id: number;
  revision: number;
  pos: number;
  node: ProseMirrorNode;
  grammar: string | null;
  pending: boolean;
  projected?: boolean;
  window?: readonly [number, number];
}

interface HighlightState {
  decorations: DecorationSet;
  blocks: DecorationSet;
  nextId: number;
}

interface Publication {
  id: number;
  revision: number;
  node: ProseMirrorNode;
  grammar: string;
  result: HighlightResult;
  projected?: boolean;
  window?: readonly [number, number];
}

interface HighlightMessage {
  publications?: Publication[];
  request?: number[];
}

/** Plugin key also used by deterministic integration tests to inspect ranges. */
export const codeHighlightingKey = new PluginKey<HighlightState>('codeSyntaxHighlighting');

const languageOf = (node: ProseMirrorNode): string | null =>
  resolveGrammar(parseFenceInfo(node.attrs.language).language);

function freshOccurrence(node: ProseMirrorNode, pos: number, id: number): BlockOccurrence {
  const grammar = languageOf(node);
  return { id, revision: 0, pos, node, grammar, pending: grammar !== null };
}

/** Above this count, rebuilding the set is cheaper than DecorationSet.remove(). */
const REMOVE_IN_PLACE_LIMIT = 64;

function withoutDecorations(
  decorations: DecorationSet,
  doc: ProseMirrorNode,
  doomed: Decoration[],
  isDoomed: (item: Decoration) => boolean
): DecorationSet {
  if (doomed.length <= REMOVE_IN_PLACE_LIMIT) return decorations.remove(doomed);
  // remove() scans a textblock's whole local decoration array for each removed
  // item, which is quadratic for a large block (40,000 tokens took ~10 s).
  return DecorationSet.create(
    doc,
    decorations.find().filter(item => !isDoomed(item))
  );
}

function removeBlockDecorations(
  decorations: DecorationSet,
  doc: ProseMirrorNode,
  pos: number,
  size: number
): DecorationSet {
  // find() includes touching endpoints. Do not remove a neighbouring block's
  // status decoration when its opening boundary equals this block's end.
  const inside = (item: Decoration): boolean => item.from < pos + size && item.to > pos;
  return withoutDecorations(
    decorations,
    doc,
    decorations.find(pos, pos + size).filter(inside),
    inside
  );
}

/**
 * Remove only colors touching edited text, plus the block's status explanation.
 * Mapped colors elsewhere in the block stay until its new result replaces them;
 * clearing the whole block flashed it uncolored on every keystroke.
 */
function removeEditedDecorations(
  decorations: DecorationSet,
  doc: ProseMirrorNode,
  pos: number,
  size: number,
  ranges: Array<[number, number]>
): DecorationSet {
  const end = pos + size;
  const edits = ranges.filter(([from, to]) => from <= end && to >= pos);
  const touched = (item: Decoration): boolean =>
    item.from < end &&
    item.to > pos &&
    edits.some(([from, to]) => item.from <= to && item.to >= from);
  return withoutDecorations(decorations, doc, decorations.find(pos, end).filter(touched), touched);
}

/** Map step output coordinates through subsequent steps; attribute steps have no map. */
function changedRanges(tr: Transaction): Array<[number, number]> | null {
  const ranges: Array<[number, number]> = [];
  for (let index = 0; index < tr.steps.length; index++) {
    const step = tr.steps[index];
    const remaining = tr.mapping.slice(index + 1);
    if (step instanceof ReplaceAroundStep) {
      // Wrapping/lifting can move a node decoration into a different parent,
      // which drops its index entry even when the preserved gap is unchanged.
      // Inspect that whole structural region, not only the replaced edges.
      const end = step.from + step.slice.size + step.gapTo - step.gapFrom;
      ranges.push([remaining.map(step.from, -1), remaining.map(end, 1)]);
      continue;
    }
    let mapped = false;
    step.getMap().forEach((_oldFrom, _oldTo, from, to) => {
      mapped = true;
      ranges.push([remaining.map(from, -1), remaining.map(to, 1)]);
    });
    if (mapped || step instanceof DocAttrStep) continue;
    if (
      step instanceof AttrStep ||
      step instanceof AddNodeMarkStep ||
      step instanceof RemoveNodeMarkStep
    ) {
      ranges.push([remaining.map(step.pos, -1), remaining.map(step.pos + 1, 1)]);
    } else if (step instanceof AddMarkStep || step instanceof RemoveMarkStep) {
      ranges.push([remaining.map(step.from, -1), remaining.map(step.to, 1)]);
    } else {
      // An unknown empty-map step may affect any node. Its unchanged positions
      // are not evidence that either the indexed node types or colors survived.
      return null;
    }
  }
  return ranges;
}

/** Position lives in the mapped decoration, never in an immutable ID lookup. */
function indexedOccurrence(record: BlockOccurrence): Decoration {
  return Decoration.node(record.pos, record.pos + record.node.nodeSize, {}, { record });
}

function occurrenceAt(decoration: Decoration): BlockOccurrence {
  const record = decoration.spec.record as BlockOccurrence;
  return { ...record, pos: decoration.from };
}

function updateDocument(tr: Transaction, current: HighlightState): HighlightState {
  let decorations = current.decorations.map(tr.mapping, tr.doc);
  let blocks = current.blocks.map(tr.mapping, tr.doc);
  const affected = new Map<number, ProseMirrorNode>();
  const inspect = (node: ProseMirrorNode, pos: number): boolean | void => {
    if (node.type.name === 'codeBlock') {
      affected.set(pos, node);
      return false;
    }
  };
  const ranges = changedRanges(tr);
  if (ranges !== null) {
    const inverse = tr.mapping.invert();
    for (const [from, to] of ranges) {
      const oldFrom = Math.max(0, inverse.map(from, -1));
      const oldTo = Math.max(oldFrom, inverse.map(to, 1));
      for (const item of current.blocks.find(oldFrom, oldTo)) {
        const start = tr.mapping.map(item.from + 1, 1);
        const end = tr.mapping.map(item.to - 1, -1);
        const position = Math.max(0, Math.min(start, tr.doc.content.size));
        if (end > start && tr.doc.resolve(position).parent.type.name !== 'codeBlock') {
          // Node-type changes preserve their text gap. The mapped inline colors
          // must be removed when that gap now belongs to ordinary prose.
          decorations = removeBlockDecorations(decorations, tr.doc, start, end - start);
        }
      }
    }
  }
  if (ranges === null) {
    tr.doc.descendants(inspect);
    blocks = DecorationSet.empty;
    decorations = DecorationSet.empty;
  } else {
    for (const [start, end] of ranges) {
      const from = Math.max(0, Math.min(start, tr.doc.content.size));
      const to = Math.max(from, Math.min(end, tr.doc.content.size));
      for (const boundary of [from, to]) {
        const resolved = tr.doc.resolve(boundary);
        for (let depth = resolved.depth; depth > 0; depth--)
          inspect(resolved.node(depth), resolved.before(depth));
      }
      if (from < tr.doc.content.size) tr.doc.nodesBetween(from, Math.max(from + 1, to), inspect);
    }
  }

  let nextId = current.nextId;
  const inverse = tr.mapping.invert();
  for (const [pos, node] of affected) {
    const mapped = blocks.find(pos, pos + 1).find(item => item.from === pos);
    let old = mapped ? occurrenceAt(mapped) : undefined;
    if (!old) {
      // setNodeMarkup replaces the boundary and may remove the index decoration.
      // Reuse its identity only when the actual immutable content is retained.
      const oldPos = inverse.map(pos + 1, -1) - 1;
      const candidate = current.blocks
        .find(Math.max(0, oldPos), Math.max(0, oldPos + 1))
        .find(item => item.from === oldPos);
      const previous = candidate ? occurrenceAt(candidate) : undefined;
      const onlyBoundaryReplacement =
        tr.steps.some(step => step instanceof ReplaceAroundStep) &&
        !tr.steps.some(step => step instanceof ReplaceStep);
      if (onlyBoundaryReplacement && previous?.node.content === node.content)
        old = { ...previous, pos };
    }
    if (mapped) blocks = blocks.remove([mapped]);
    const grammar = languageOf(node);
    if (old && old.grammar === grammar && old.node.content.eq(node.content)) {
      blocks = blocks.add(tr.doc, [indexedOccurrence({ ...old, node })]);
      continue;
    }
    decorations =
      old && ranges !== null && old.grammar === grammar
        ? removeEditedDecorations(decorations, tr.doc, pos, node.nodeSize, ranges)
        : removeBlockDecorations(decorations, tr.doc, pos, node.nodeSize);
    const record = old
      ? { ...old, node, grammar, revision: old.revision + 1, pending: grammar !== null }
      : freshOccurrence(node, pos, nextId++);
    blocks = blocks.add(tr.doc, [indexedOccurrence(record)]);
  }
  return { decorations, blocks, nextId };
}

/** Publish only results still bound to the exact occurrence, revision and content. */
function publish(
  tr: Transaction,
  current: HighlightState,
  publications: Publication[]
): HighlightState {
  let decorations = current.decorations;
  let blocks = current.blocks;
  // This lookup runs only on a deferred color publication, never on typing.
  const byId = new Map(blocks.find().map(item => [(item.spec.record as BlockOccurrence).id, item]));
  for (const publication of publications) {
    const indexed = byId.get(publication.id);
    const record = indexed ? occurrenceAt(indexed) : undefined;
    if (
      !record ||
      !indexed ||
      record.revision !== publication.revision ||
      record.grammar !== publication.grammar ||
      !record.node.content.eq(publication.node.content)
    )
      continue;
    const start = record.pos + 1;
    decorations = removeBlockDecorations(decorations, tr.doc, record.pos, record.node.nodeSize);
    const spans = publication.result.spans;
    const added = publication.result.reason
      ? [
          Decoration.node(record.pos, record.pos + record.node.nodeSize, {
            'data-highlight-status': explainHighlightFailure(publication.result.reason),
          }),
        ]
      : spans.map(span =>
          Decoration.inline(start + span.from, start + span.to, {
            class: span.classes,
            'data-highlight-scope': innermostScope(span.classes),
          })
        );
    decorations = decorations.add(tr.doc, added);
    blocks = blocks.remove([indexed]).add(tr.doc, [
      indexedOccurrence({
        ...record,
        pending: false,
        projected: publication.projected,
        window: publication.window,
      }),
    ]);
  }
  return { ...current, decorations, blocks };
}

/**
 * Build exactly one plugin. The service factory belongs to the view lifetime,
 * enabling independent webviews and deterministic tests without browser globals.
 */
export function createCodeHighlightingPlugin(
  createService: () => HighlightService
): Plugin<HighlightState> {
  return new Plugin<HighlightState>({
    key: codeHighlightingKey,
    state: {
      init: (_config, state) => {
        const blocks: Decoration[] = [];
        let nextId = 1;
        state.doc.descendants((node, pos) => {
          if (node.type.name !== 'codeBlock') return;
          const record = freshOccurrence(node, pos, nextId++);
          blocks.push(indexedOccurrence(record));
          return false;
        });
        return {
          decorations: DecorationSet.empty,
          blocks: DecorationSet.create(state.doc, blocks),
          nextId,
        };
      },
      apply: (tr, current) => {
        const next = tr.docChanged ? updateDocument(tr, current) : current;
        const message = tr.getMeta(codeHighlightingKey) as HighlightMessage | undefined;
        let published = message?.publications ? publish(tr, next, message.publications) : next;
        if (message?.request?.length) {
          const requested = new Set(message.request);
          let blocks = published.blocks;
          for (const item of blocks.find(undefined, undefined, spec =>
            requested.has((spec.record as BlockOccurrence).id)
          )) {
            const record = occurrenceAt(item);
            blocks = blocks
              .remove([item])
              .add(tr.doc, [indexedOccurrence({ ...record, pending: true })]);
          }
          published = { ...published, blocks };
        }
        return published;
      },
    },
    props: { decorations: state => codeHighlightingKey.getState(state)?.decorations },
    view: view => createHighlightView(view, createService()),
  });
}

/**
 * One active worker job per view. Large blocks keep complete canonical tokens in
 * the service's bounded cache and publish only a viewport projection. Weak refs
 * avoid a second strong token cache; eviction/GC requeues visible blocks normally.
 */
function createHighlightView(view: EditorView, service: HighlightService) {
  let destroyed = false;
  let running = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let frame: number | undefined;
  let viewportFrame: number | undefined;
  let publications: Publication[] = [];
  let viewport: ViewportRange = { from: 0, to: 0 };
  const awaiting = new Set<string>();
  const canonical = new Map<number, { revision: number; result: WeakRef<HighlightResult> }>();
  const LARGE_RESULT_RANGES = 2000;

  const windowFor = (record: BlockOccurrence): readonly [number, number] => {
    const start = record.pos + 1;
    const size = record.node.content.size;
    const from = Math.max(0, Math.min(size, viewport.from - start));
    const to = Math.max(from, Math.min(size, viewport.to - start));
    return [from, to];
  };

  /**
   * Scrolling inside the overscan keeps the current projection. Republishing on
   * every scroll frame rebuilt every projected span and produced long frames.
   */
  const stillCovers = (record: BlockOccurrence, target: readonly [number, number]): boolean => {
    const current = record.window;
    if (!current || current[0] === current[1] || target[0] === target[1]) return false;
    const start = record.pos + 1;
    const size = record.node.content.size;
    const [visibleFrom, visibleTo] = viewport.visible ?? [viewport.from, viewport.to];
    const from = Math.max(0, Math.min(size, visibleFrom - start));
    const to = Math.max(from, Math.min(size, visibleTo - start));
    // A block visible only through overscan keeps its colors until it leaves it.
    return from === to || (from >= current[0] && to <= current[1]);
  };

  const project = (publication: Publication, record: BlockOccurrence): Publication => {
    if (publication.result.reason || publication.result.spans.length <= LARGE_RESULT_RANGES)
      return publication;
    canonical.delete(record.id);
    canonical.set(record.id, {
      revision: record.revision,
      result: new WeakRef(publication.result),
    });
    if (canonical.size > 128) canonical.delete(canonical.keys().next().value!);
    const window = windowFor(record);
    return {
      ...publication,
      projected: true,
      window,
      result: { spans: projectTokenSpans(publication.result.spans, window[0], window[1]) },
    };
  };

  const flush = (): void => {
    frame = undefined;
    if (destroyed || view.isDestroyed) return;
    viewport = readViewportRange(view);
    const indexed = codeHighlightingKey.getState(view.state)!.blocks.find();
    const records = new Map(
      indexed.map(item => {
        const record = occurrenceAt(item);
        return [record.id, record] as const;
      })
    );
    const batch: Publication[] = [];
    for (const publication of publications) {
      awaiting.delete(`${publication.id}:${publication.revision}`);
      const record = records.get(publication.id);
      if (
        record &&
        record.revision === publication.revision &&
        record.grammar === publication.grammar &&
        record.node.content.eq(publication.node.content)
      )
        batch.push(project(publication, record));
    }
    publications = [];
    // apply() rechecks against the current mapped document; colors never enter history.
    if (batch.length)
      view.dispatch(
        view.state.tr
          .setMeta(codeHighlightingKey, { publications: batch })
          .setMeta('addToHistory', false)
      );
    schedule();
  };

  const refreshViewport = (): void => {
    viewportFrame = undefined;
    if (destroyed || view.isDestroyed) return;
    viewport = readViewportRange(view);
    const batch: Publication[] = [];
    const request: number[] = [];
    const blocks = codeHighlightingKey.getState(view.state)!.blocks;
    for (const indexed of blocks.find()) {
      const record = occurrenceAt(indexed);
      if (!record.projected || record.pending || !record.grammar) continue;
      const window = windowFor(record);
      if (record.window?.[0] === window[0] && record.window[1] === window[1]) continue;
      if (stillCovers(record, window)) continue;
      const cached = canonical.get(record.id);
      const result = cached?.revision === record.revision ? cached.result.deref() : undefined;
      if (window[0] !== window[1] && !result) {
        request.push(record.id);
        continue;
      }
      batch.push({
        id: record.id,
        revision: record.revision,
        grammar: record.grammar,
        node: record.node,
        projected: true,
        window,
        result: { spans: result ? projectTokenSpans(result.spans, window[0], window[1]) : [] },
      });
    }
    if (batch.length || request.length)
      view.dispatch(
        view.state.tr
          .setMeta(codeHighlightingKey, { publications: batch, request })
          .setMeta('addToHistory', false)
      );
  };
  const scheduleViewport = (): void => {
    if (!destroyed && viewportFrame === undefined)
      viewportFrame = requestAnimationFrame(refreshViewport);
  };

  const choose = (): BlockOccurrence | undefined => {
    const blocks = codeHighlightingKey.getState(view.state)?.blocks;
    if (!blocks) return undefined;
    let first: BlockOccurrence | undefined;
    let visible: BlockOccurrence | undefined;
    const cursor = view.state.selection.from;
    for (const indexed of blocks.find()) {
      const record = occurrenceAt(indexed);
      if (!record.pending || !record.grammar || awaiting.has(`${record.id}:${record.revision}`))
        continue;
      if (cursor > record.pos && cursor < record.pos + record.node.nodeSize) return record;
      if (record.pos < viewport.to && record.pos + record.node.nodeSize > viewport.from)
        visible ??= record;
      first ??= record;
    }
    return visible ?? first;
  };

  const pump = async (): Promise<void> => {
    timer = undefined;
    if (
      destroyed ||
      running ||
      publications.length >= 64 ||
      publications.reduce((count, item) => count + item.result.spans.length, 0) >= 4000
    )
      return;
    const record = choose();
    if (!record?.grammar) return;
    running = true;
    const identity = `${record.id}:${record.revision}`;
    awaiting.add(identity);
    try {
      const result = await service.highlight(record.grammar, record.node.textContent);
      if (destroyed || view.isDestroyed) return;
      publications.push({
        id: record.id,
        revision: record.revision,
        node: record.node,
        grammar: record.grammar,
        result,
      });
    } catch (error) {
      if (destroyed || view.isDestroyed) return;
      console.error('[MD4H] Syntax highlighting unavailable:', error);
      publications.push({
        id: record.id,
        revision: record.revision,
        node: record.node,
        grammar: record.grammar,
        result: { spans: [], reason: 'worker-error' },
      });
    } finally {
      running = false;
      if (!destroyed) {
        if (publications.length && frame === undefined) frame = requestAnimationFrame(flush);
        schedule();
      }
    }
  };

  function schedule(): void {
    if (destroyed || running || timer !== undefined) return;
    timer = setTimeout(() => {
      void pump();
    }, 0);
  }

  const resizeObserver =
    typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(scheduleViewport);
  resizeObserver?.observe(view.dom);
  const destroy = (): void => {
    if (destroyed) return;
    destroyed = true;
    if (timer !== undefined) clearTimeout(timer);
    if (frame !== undefined) cancelAnimationFrame(frame);
    if (viewportFrame !== undefined) cancelAnimationFrame(viewportFrame);
    publications = [];
    awaiting.clear();
    canonical.clear();
    resizeObserver?.disconnect();
    window.removeEventListener('pagehide', destroy);
    window.removeEventListener('scroll', scheduleViewport, true);
    window.removeEventListener('resize', scheduleViewport);
    view.dom.ownerDocument.fonts?.removeEventListener('loadingdone', scheduleViewport);
    service.dispose();
  };
  window.addEventListener('pagehide', destroy);
  window.addEventListener('scroll', scheduleViewport, true);
  window.addEventListener('resize', scheduleViewport);
  view.dom.ownerDocument.fonts?.addEventListener('loadingdone', scheduleViewport);
  scheduleViewport();
  schedule();
  return {
    update: (nextView: EditorView, previousState: EditorView['state']): void => {
      // Selection and unrelated metadata do not even scan the occurrence index.
      if (
        codeHighlightingKey.getState(nextView.state) !== codeHighlightingKey.getState(previousState)
      )
        schedule();
      if (nextView.state.doc !== previousState.doc) scheduleViewport();
    },
    destroy,
  };
}
