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
