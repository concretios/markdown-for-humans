/** Native mouse regression fixture for QA-001/QA-002. No synthetic selection APIs. */
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { TableKit } from '@tiptap/extension-table';
import { createFeedbackReviewController } from '../../src/webview/features/feedbackReview';

let dispose: (() => void) | undefined;

const cases = [
  {
    name: 'nested-partial',
    start: 'oak pine maple cedar birch',
    from: 2,
    end: 'oak pine maple cedar birch',
    to: 20,
  },
  {
    name: 'nested-cross-level',
    start: 'red orange yellow green blue',
    from: 12,
    end: 'oak pine maple cedar birch',
    to: 20,
  },
  {
    name: 'table-partial',
    start: 'Select some words in this cell',
    from: 10,
    end: 'Select some words in this cell',
    to: 23,
  },
  {
    name: 'paragraphs',
    start: 'Opening alpha bravo charlie delta.',
    from: 14,
    end: 'Second paragraph amber forest morning light.',
    to: 25,
  },
];

export async function prepareNativeSelection(
  caseIndex: number,
  feedback: boolean,
  reverse: boolean
) {
  dispose?.();
  document.body.classList.remove('feedback-review-active');
  const root = document.querySelector<HTMLElement>('#fixture-root')!;
  root.innerHTML =
    '<main id="fixture-shell"><div class="formatting-toolbar"></div><section id="editor"><article class="markdown-editor"></article></section></main>';
  window.scrollTo(0, 0);
  const editor = new Editor({
    element: root.querySelector<HTMLElement>('article')!,
    extensions: [StarterKit, TableKit],
    content:
      '<h1>Native selection</h1><p>Opening alpha bravo charlie delta.</p><p>Second paragraph amber forest morning light.</p>' +
      '<ul><li><p>Parent alpha bravo</p><ul><li><p>red orange yellow green blue</p><ul><li><p>oak pine maple cedar birch</p></li><li><p>copper silver gold</p></li></ul></li></ul></li></ul>' +
      '<table><tbody><tr><th>Name</th><th>Notes</th></tr><tr><td>Alpha</td><td>Select some words in this cell</td></tr></tbody></table>',
  });
  const controller = createFeedbackReviewController({
    editor,
    host: { postMessage: () => undefined },
  });
  if (feedback) {
    controller.activate({
      sessionId: 'native-selection',
      source: 'selection.md',
      sourceSha256: 'a'.repeat(64),
      round: 'round-1',
      items: [],
      anchors: Array.from({ length: editor.state.doc.childCount }, (_, ordinal) => ({
        ordinal,
        startLine: ordinal + 1,
        endLine: ordinal + 1,
      })),
    });
  }
  dispose = () => {
    controller.deactivate();
    editor.destroy();
  };
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const test = cases[caseIndex];
  // Read character geometry to position real mouse input. Do not set a DOM range as the selection.
  const point = (text: string, offset: number) => {
    const walker = document.createTreeWalker(editor.view.dom, NodeFilter.SHOW_TEXT);
    let node: Node | null;
    while ((node = walker.nextNode())) {
      if (node.textContent !== text) continue;
      const range = document.createRange();
      range.setStart(node, offset);
      range.setEnd(node, offset + 1);
      const rect = range.getBoundingClientRect();
      return { x: Math.round(rect.left), y: Math.round(rect.top + rect.height / 2) };
    }
    throw new Error(`Missing selection fixture text: ${text}`);
  };
  const start = point(test.start, test.from);
  const end = point(test.end, test.to);
  return { name: test.name, start: reverse ? end : start, end: reverse ? start : end };
}

/** Semantic rail acceptance in the same real Chromium renderer as native drags. */
export async function prepareSemanticScope() {
  dispose?.();
  window.getSelection()?.removeAllRanges();
  const root = document.querySelector<HTMLElement>('#fixture-root')!;
  root.innerHTML =
    '<main id="fixture-shell"><div class="formatting-toolbar"></div><section id="editor"><article class="markdown-editor"></article></section></main>';
  const editor = new Editor({
    element: root.querySelector<HTMLElement>('article')!,
    extensions: [StarterKit, TableKit],
    content:
      '<h2>Mocks</h2><p>Introduction</p><ul><li><p>Parent item</p><ul><li><p>Nested child</p></li></ul></li><li><p>Excluded sibling</p></li></ul><h3>Examples</h3><p>Section tail</p><h2>Delivery</h2><p>Outside section</p>',
  });
  const messages: unknown[] = [];
  const controller = createFeedbackReviewController({
    editor,
    host: {
      postMessage: message => {
        messages.push(message);
      },
    },
  });
  controller.activate({
    sessionId: 'semantic',
    source: 'semantic.md',
    sourceSha256: 'a'.repeat(64),
    round: 'round-1',
    evidenceVersion: 2,
    items: [],
    anchors: Array.from({ length: editor.state.doc.childCount }, (_, ordinal) => ({
      ordinal,
      startLine: ordinal * 2 + 1,
      endLine: ordinal * 2 + 1,
    })),
  });
  dispose = () => {
    controller.deactivate();
    editor.destroy();
  };
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const paragraph = editor.view.dom.querySelector('li p')!;
  const rect = paragraph.getBoundingClientRect();
  (window as unknown as { inspectSemanticScope: () => unknown }).inspectSemanticScope = () => {
    const form = document.querySelector<HTMLFormElement>('.feedback-composer');
    const label = form?.textContent ?? '';
    const field = form?.querySelector<HTMLTextAreaElement>('textarea');
    if (field) {
      field.value = 'Improve this parent and child';
      field.dispatchEvent(new Event('input', { bubbles: true }));
      form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    }
    const message = messages.find(
      value => (value as { type?: string }).type === 'feedback.text.add'
    ) as { evidence?: { text?: string }; target?: { requestedScope?: string } } | undefined;
    return {
      passed:
        label.includes('Item and children') &&
        message?.target?.requestedScope === 'rendered-text' &&
        message.evidence?.text === 'Parent itemNested child',
      label,
      message,
    };
  };
  return { x: rect.left + 20, y: rect.top + rect.height / 2 };
}

/** A long table and its following prose, driven exclusively by native mouse input. */
export async function prepareNativeRailScroll() {
  dispose?.();
  const root = document.querySelector<HTMLElement>('#fixture-root')!;
  root.innerHTML =
    '<main id="fixture-shell"><div id="fixture-toolbar" class="formatting-toolbar">Feedback rail scroll regression</div><section id="editor"><article class="markdown-editor"></article></section></main>';
  window.scrollTo(0, 0);
  const rows = Array.from(
    { length: 60 },
    (_, index) =>
      `<tr><td>Scope ${index + 1}</td><td>Read the matching guide and check the related behavior.</td></tr>`
  ).join('');
  const editor = new Editor({
    element: root.querySelector<HTMLElement>('article')!,
    extensions: [StarterKit, TableKit.configure({ table: { resizable: true } })],
    content:
      '<h2>Project truth, read on demand</h2>' +
      `<table><tbody><tr><th>Task</th><th>Read</th></tr>${rows}</tbody></table>` +
      '<p>First paragraph after the table. Identify the reader and explain the scope.</p>' +
      '<p>Second paragraph after the table. Keep decisions in their canonical document.</p>' +
      '<p>Third paragraph after the table. Keep host-specific adapters thin.</p>',
  });
  const controller = createFeedbackReviewController({
    editor,
    host: { postMessage: () => undefined },
  });
  controller.activate({
    sessionId: 'native-rail-scroll',
    source: 'rail-scroll.md',
    sourceSha256: 'a'.repeat(64),
    round: 'round-1',
    evidenceVersion: 2,
    items: [],
    anchors: Array.from({ length: editor.state.doc.childCount }, (_, ordinal) => ({
      ordinal,
      startLine: ordinal + 1,
      endLine: ordinal + 1,
    })),
  });
  dispose = () => {
    controller.deactivate();
    editor.destroy();
  };
  const inspect = () => {
    const button = document.querySelector<HTMLButtonElement>('[data-feedback-block-action]');
    const rect = button?.getBoundingClientRect();
    const toolbarBottom = root.querySelector('#fixture-toolbar')!.getBoundingClientRect().bottom;
    const point = (element: Element) => {
      const bounds = element.getBoundingClientRect();
      const top = Math.max(bounds.top, toolbarBottom + 8);
      const bottom = Math.min(bounds.bottom, window.innerHeight - 8);
      return bottom > top
        ? { x: bounds.left + Math.min(70, bounds.width / 2), y: (top + bottom) / 2 }
        : null;
    };
    const table = editor.view.dom.querySelector('table')!;
    return {
      railVisible: Boolean(
        button &&
        !button.hidden &&
        rect &&
        rect.width > 0 &&
        rect.height > 0 &&
        rect.top >= toolbarBottom &&
        rect.bottom <= window.innerHeight &&
        rect.left >= 0 &&
        rect.right <= window.innerWidth
      ),
      railLabel: button?.getAttribute('aria-label') ?? null,
      railTop: rect?.top ?? null,
      railBottom: rect?.bottom ?? null,
      toolbarBottom,
      viewportHeight: window.innerHeight,
      scrollY: window.scrollY,
      tableHeight: table.getBoundingClientRect().height,
      selectionEmpty: editor.state.selection.empty && window.getSelection()?.isCollapsed !== false,
      headingPoint: point(editor.view.dom.querySelector('h2')!),
      tablePoint: point(table),
      paragraphPoints: Array.from(editor.view.dom.querySelectorAll(':scope > p')).map(point),
    };
  };
  (window as unknown as { inspectNativeRailScroll: typeof inspect }).inspectNativeRailScroll =
    inspect;
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  return inspect();
}

/** Remove listeners and the frozen editor before unrelated annotation scenarios. */
export function finishNativeRailScroll() {
  dispose?.();
  dispose = undefined;
}

/** Section decoration must not strand the rail on ProseMirror's replaced DOM nodes. */
export async function prepareNativeRailRecovery() {
  dispose?.();
  const root = document.querySelector<HTMLElement>('#fixture-root')!;
  root.innerHTML =
    '<main id="fixture-shell"><div id="fixture-toolbar" class="formatting-toolbar">Feedback section recovery regression</div><section id="editor"><article class="markdown-editor"></article></section></main>';
  window.scrollTo(0, 0);
  const editor = new Editor({
    element: root.querySelector<HTMLElement>('article')!,
    extensions: [StarterKit, TableKit.configure({ table: { resizable: true } })],
    content:
      '<h2>Project truth, read on demand</h2>' +
      '<table><tbody><tr><th>Task</th><th>Read</th></tr><tr><td>Product judgment</td><td>Architecture and decisions</td></tr><tr><td>Implementation</td><td>Code and tests</td></tr></tbody></table>' +
      '<p>First paragraph after the table.</p><p>Second paragraph keeps decisions nearby.</p>' +
      '<p>Third paragraph keeps host adapters thin.</p>' +
      '<h2>Outside section</h2><p>Unaffected paragraph belongs to the next section.</p>',
  });
  const controller = createFeedbackReviewController({
    editor,
    host: { postMessage: () => undefined },
  });
  controller.activate({
    sessionId: 'native-rail-recovery',
    source: 'rail-recovery.md',
    sourceSha256: 'a'.repeat(64),
    round: 'round-1',
    evidenceVersion: 2,
    items: [],
    anchors: Array.from({ length: editor.state.doc.childCount }, (_, ordinal) => ({
      ordinal,
      startLine: ordinal + 1,
      endLine: ordinal + 1,
    })),
  });
  const initialBlocks = Array.from(editor.view.dom.children);
  const originalDocument = editor.state.doc.toJSON();
  dispose = () => {
    controller.deactivate();
    editor.destroy();
  };
  const inspect = () => {
    const toolbarBottom = root.querySelector('#fixture-toolbar')!.getBoundingClientRect().bottom;
    const point = (element: Element | null) => {
      if (!element) return null;
      const bounds = element.getBoundingClientRect();
      return bounds.top >= toolbarBottom && bounds.bottom <= window.innerHeight
        ? { x: bounds.left + Math.min(60, bounds.width / 2), y: bounds.top + bounds.height / 2 }
        : null;
    };
    const button = document.querySelector<HTMLButtonElement>('[data-feedback-block-action]');
    const paragraphs = Array.from(editor.view.dom.querySelectorAll(':scope > p'));
    const text = paragraphs[0].firstChild!;
    const characterPoint = (offset: number) => {
      // Measure text only. Native mouse input below performs the actual selection.
      const range = document.createRange();
      range.setStart(text, offset);
      range.setEnd(text, offset + 1);
      const bounds = range.getBoundingClientRect();
      return { x: Math.round(bounds.left), y: Math.round(bounds.top + bounds.height / 2) };
    };
    return {
      railVisible: Boolean(button && !button.hidden && point(button)),
      railLabel: button?.getAttribute('aria-label') ?? null,
      railPoint: button && !button.hidden ? point(button) : null,
      composerOpen: Boolean(document.querySelector('.feedback-composer')),
      cancelPoint: point(document.querySelector('button[aria-label="Cancel feedback"]')),
      headingPoint: point(editor.view.dom.querySelector('h2')),
      tablePoint: point(editor.view.dom.querySelector('td p')),
      paragraphPoints: paragraphs.map(point),
      outsideHeadingPoint: point(editor.view.dom.querySelectorAll('h2')[1]),
      replacedOrdinals: initialBlocks.flatMap((element, ordinal) =>
        element === editor.view.dom.children[ordinal] ? [] : [ordinal]
      ),
      selectionEmpty: editor.state.selection.empty && window.getSelection()?.isCollapsed !== false,
      selectionText: window.getSelection()?.toString() ?? '',
      documentUnchanged:
        JSON.stringify(editor.state.doc.toJSON()) === JSON.stringify(originalDocument),
      drag: {
        start: characterPoint(6),
        end: characterPoint(21),
        expected: text.textContent!.slice(6, 21),
      },
    };
  };
  (window as unknown as { inspectNativeRailRecovery: typeof inspect }).inspectNativeRailRecovery =
    inspect;
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  return inspect();
}
