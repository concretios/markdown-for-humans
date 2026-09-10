/** @jest-environment jsdom */
import { Editor } from '@tiptap/core';
import CodeBlock from '@tiptap/extension-code-block';
import { TableKit } from '@tiptap/extension-table';
import StarterKit from '@tiptap/starter-kit';
import { createFeedbackReviewController } from '../../webview/features/feedbackReview';

describe('Semantic Feedback scopes with a real editor', () => {
  beforeEach(() => window.getSelection()?.removeAllRanges());
  it('recovers section, table and paragraph actions after cancelling a section composer', async () => {
    document.body.innerHTML =
      '<div class="formatting-toolbar"></div><main><div id="editor"></div></main>';
    const editor = new Editor({
      element: document.querySelector('#editor') as HTMLElement,
      extensions: [StarterKit, TableKit],
      content:
        '<h2>Project truth</h2><table><tr><th>Task</th><th>Read</th></tr><tr><td>Architecture</td><td>Design guide</td></tr></table>' +
        '<p>First following paragraph</p><p>Second following paragraph</p><p>Final paragraph</p><h2>Next section</h2>',
    });
    const geometry = jest.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      left: 80,
      top: 100,
      right: 700,
      bottom: 140,
      width: 620,
      height: 40,
    } as DOMRect);
    document.querySelector<HTMLElement>('.formatting-toolbar')!.getBoundingClientRect = () =>
      ({ bottom: 40 }) as DOMRect;
    const controller = createFeedbackReviewController({
      editor,
      host: { postMessage: jest.fn() },
    });
    const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
    const hover = async (ordinal: number) => {
      const block = editor.view.dom.children[ordinal];
      // Establish the caret a real pointer click supplies; native input is
      // separately exercised by the Chromium fixture.
      const text = document.createTreeWalker(block, NodeFilter.SHOW_TEXT).nextNode();
      window.getSelection()?.collapse(text, 0);
      block.dispatchEvent(new MouseEvent('pointerover', { bubbles: true }));
      await frame();
      return document.querySelector<HTMLButtonElement>('[data-feedback-block-action]')!;
    };
    const frozenDocument = editor.state.doc;
    try {
      controller.activate({
        sessionId: 'cancel-section',
        source: 'section.md',
        sourceSha256: 'a'.repeat(64),
        round: 'round-1',
        evidenceVersion: 2,
        anchors: Array.from({ length: 6 }, (_, ordinal) => ({
          ordinal,
          startLine: ordinal + 1,
          endLine: ordinal + 1,
        })),
        items: [],
      });
      for (let cycle = 0; cycle < 2; cycle += 1) {
        const outsideSection = editor.view.dom.children[5];
        const rail = await hover(0);
        expect(rail.hidden).toBe(false);
        rail.click();
        await frame();
        // Let ProseMirror reconcile the pending highlight before cancellation.
        // This replaced the section's DOM objects in the failing baseline.
        expect(editor.view.dom.children[5]).toBe(outsideSection);
        document.querySelector<HTMLButtonElement>('[aria-label="Cancel feedback"]')!.click();
        await frame();
        for (const ordinal of [0, 1, 2, 3, 4, 5]) {
          const action = await hover(ordinal);
          expect(action.hidden).toBe(false);
          expect(action.getAttribute('aria-label')).toContain(
            ordinal === 0 || ordinal === 5 ? 'section' : ordinal === 1 ? 'this table' : 'this block'
          );
        }
        expect(editor.state.doc).toBe(frozenDocument);
      }
    } finally {
      controller.deactivate();
      editor.destroy();
      geometry.mockRestore();
      window.getSelection()?.removeAllRanges();
      document.body.replaceChildren();
    }
  });

  it.each(['section', 'heading'])(
    'submits the %s scope after changing scope without losing the comment',
    async scopeToSave => {
      document.body.innerHTML =
        '<div class="formatting-toolbar"></div><main><div id="editor"></div></main>';
      const editor = new Editor({
        element: document.querySelector('#editor') as HTMLElement,
        extensions: [StarterKit],
        content:
          '<h2>Mocks</h2><p>Body</p><h3>Examples</h3><p>Nested</p><h2>Delivery</h2><p>Outside</p>',
      });
      const host = { postMessage: jest.fn() };
      const controller = createFeedbackReviewController({ editor, host });
      const rect = (y: number) =>
        ({
          top: y,
          bottom: y + 40,
          left: 60,
          right: 760,
          width: 700,
          height: 40,
          x: 60,
          y,
          toJSON: () => ({}),
        }) as DOMRect;
      Array.from(editor.view.dom.children).forEach((el, i) => {
        el.getBoundingClientRect = () => rect(80 + i * 50);
      });
      try {
        controller.activate({
          sessionId: 'test',
          source: 'test.md',
          sourceSha256: 'a'.repeat(64),
          round: 'round-1',
          evidenceVersion: 2,
          anchors: [0, 1, 2, 3, 4, 5].map(ordinal => ({
            ordinal,
            startLine: ordinal * 2 + 1,
            endLine: ordinal * 2 + 1,
          })),
          items: [],
        });
        editor.view.dom.children[0].dispatchEvent(new MouseEvent('pointerover', { bubbles: true }));
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const rail = document.querySelector<HTMLButtonElement>('[data-feedback-block-action]')!;
        expect(rail.getAttribute('aria-label')).toContain('section Mocks');
        expect(
          document.querySelector<HTMLElement>('[data-feedback-block-target-preview]')?.hidden
        ).toBe(true);
        rail.click();
        const form = document.querySelector<HTMLFormElement>('.feedback-composer')!;
        expect(form.textContent).toContain('Section: Mocks');
        expect(form.querySelector('[data-feedback-lines]')?.textContent).toBe('Source lines 1-7');
        const field = form.querySelector<HTMLTextAreaElement>('textarea')!;
        field.value = 'Improve the examples';
        field.dispatchEvent(new Event('input', { bubbles: true }));
        const buttons = () => Array.from(form.querySelectorAll<HTMLButtonElement>('button'));
        buttons()
          .find(button => button.textContent === 'Change scope')!
          .click();
        const options = Array.from(
          form.querySelectorAll<HTMLButtonElement>('.feedback-scope-list button')
        );
        expect(document.activeElement).toBe(options[0]);
        options[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
        expect(document.activeElement).toBe(options[options.length - 1]);
        options[options.length - 1].dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
        );
        expect(form.querySelector<HTMLElement>('.feedback-scope-list')?.hidden).toBe(true);
        expect(field.value).toBe('Improve the examples');
        buttons()
          .find(button => button.textContent === 'Change scope')!
          .click();
        buttons()
          .find(button => button.textContent === 'Whole heading')!
          .click();
        expect(field.value).toBe('Improve the examples');
        if (scopeToSave === 'section') {
          buttons()
            .find(button => button.textContent === 'Change scope')!
            .click();
          buttons()
            .find(button => button.textContent === 'Section: Mocks')!
            .click();
        }
        form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        expect(host.postMessage).toHaveBeenCalledWith(
          expect.objectContaining({
            type: 'feedback.text.add',
            startOrdinal: 0,
            endOrdinal: scopeToSave === 'section' ? 3 : 0,
            feedback: 'Improve the examples',
            target: { version: 2, requestedScope: 'blocks' },
          })
        );
      } finally {
        controller.deactivate();
        editor.destroy();
        document.body.replaceChildren();
      }
    }
  );
  it('submits exactly the parent item text and locator without selecting siblings', async () => {
    document.body.innerHTML = '<main><div id="editor"></div></main>';
    const editor = new Editor({
      element: document.querySelector('#editor') as HTMLElement,
      extensions: [StarterKit],
      content:
        '<ul><li><p>Parent</p><ul><li><p>Child</p></li></ul></li><li><p>Sibling</p></li></ul>',
    });
    const host = { postMessage: jest.fn() };
    const controller = createFeedbackReviewController({ editor, host });
    editor.view.dom.querySelectorAll('*').forEach(element => {
      element.getBoundingClientRect = () =>
        ({ left: 80, top: 100, right: 700, bottom: 300, width: 620, height: 200 }) as DOMRect;
    });
    try {
      controller.activate({
        sessionId: 'nested',
        source: 'test.md',
        sourceSha256: 'a'.repeat(64),
        round: 'round-1',
        evidenceVersion: 2,
        anchors: [{ ordinal: 0, startLine: 1, endLine: 4 }],
        items: [],
      });
      editor.view.dom
        .querySelector('p')!
        .dispatchEvent(new MouseEvent('pointerover', { bubbles: true }));
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const rail = document.querySelector<HTMLButtonElement>('[data-feedback-block-action]')!;
      expect(rail.getAttribute('aria-label')).toContain('Item and children');
      rail.click();
      const form = document.querySelector<HTMLFormElement>('.feedback-composer')!;
      expect(form.textContent).toContain('Item and children');
      expect(form.textContent).toContain('rendered text');
      const field = form.querySelector<HTMLTextAreaElement>('textarea')!;
      field.value = 'Improve this item';
      field.dispatchEvent(new Event('input', { bubbles: true }));
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      expect(host.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'feedback.text.add',
          target: expect.objectContaining({
            requestedScope: 'rendered-text',
            locator: expect.objectContaining({ kind: 'rendered-range' }),
          }),
          evidence: { kind: 'rendered-text', text: 'ParentChild', complete: true },
        })
      );
    } finally {
      controller.deactivate();
      editor.destroy();
      document.body.replaceChildren();
    }
  });
  it('chooses a full row from the command without changing native selection', () => {
    document.body.innerHTML = '<main><div id="editor"></div></main>';
    const editor = new Editor({
      element: document.querySelector('#editor') as HTMLElement,
      extensions: [StarterKit, TableKit],
      content: '<table><tr><th>A</th><th>B</th></tr><tr><td>C</td><td>D</td></tr></table>',
    });
    const host = { postMessage: jest.fn() };
    const controller = createFeedbackReviewController({ editor, host });
    try {
      controller.activate({
        sessionId: 'table',
        source: 'test.md',
        sourceSha256: 'a'.repeat(64),
        round: 'round-1',
        evidenceVersion: 2,
        anchors: [{ ordinal: 0, startLine: 1, endLine: 4 }],
        items: [],
      });
      const selection = editor.state.selection;
      expect(controller.chooseScope()).toBe(true);
      const form = document.querySelector<HTMLFormElement>('.feedback-composer')!;
      const row = Array.from(form.querySelectorAll<HTMLButtonElement>('button')).find(
        button => button.textContent === 'Full row'
      )!;
      expect(row).toBeDefined();
      row.click();
      expect(editor.state.selection).toBe(selection);
      const field = form.querySelector<HTMLTextAreaElement>('textarea')!;
      field.value = 'Clarify the header row';
      field.dispatchEvent(new Event('input', { bubbles: true }));
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      expect(host.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'feedback.text.add',
          target: expect.objectContaining({
            requestedScope: 'table-cells',
            locator: expect.objectContaining({
              value: expect.objectContaining({
                rectangle: { top: 0, left: 0, bottom: 1, right: 2 },
              }),
            }),
          }),
          evidence: {
            kind: 'table-cells',
            complete: true,
            rows: [
              [
                { role: 'header', text: 'A', complete: true },
                { role: 'header', text: 'B', complete: true },
              ],
            ],
          },
        })
      );
    } finally {
      controller.deactivate();
      editor.destroy();
      document.body.replaceChildren();
    }
  });
  it('refuses to report NodeView control text as selected document text', () => {
    document.body.innerHTML = '<main><div id="editor"></div></main>';
    const withControl = CodeBlock.extend({
      addNodeView() {
        return () => {
          const dom = document.createElement('div');
          const control = document.createElement('button');
          control.textContent = 'Copy code';
          control.contentEditable = 'false';
          const contentDOM = document.createElement('pre');
          dom.append(control, contentDOM);
          return { dom, contentDOM };
        };
      },
    });
    const editor = new Editor({
      element: document.querySelector('#editor') as HTMLElement,
      extensions: [StarterKit.configure({ codeBlock: false }), withControl],
      content:
        '<ul><li><p>Parent</p><pre><code>actual source</code></pre></li><li><p>Sibling</p></li></ul>',
    });
    const host = { postMessage: jest.fn() };
    const controller = createFeedbackReviewController({ editor, host });
    try {
      controller.activate({
        sessionId: 'controls',
        source: 'test.md',
        sourceSha256: 'a'.repeat(64),
        round: 'round-1',
        evidenceVersion: 2,
        anchors: [{ ordinal: 0, startLine: 1, endLine: 5 }],
        items: [],
      });
      expect(controller.chooseScope()).toBe(false);
      expect(document.querySelector('.feedback-composer')).toBeNull();
    } finally {
      controller.deactivate();
      editor.destroy();
      document.body.replaceChildren();
    }
  });
});
