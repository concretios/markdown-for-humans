/**
 * @jest-environment jsdom
 */

import type { Editor } from '@tiptap/core';
import {
  createFeedbackBlockActionTargetResolver,
  createFeedbackBlockActionView,
  createFeedbackBlockElementIndex,
  resolveFeedbackBlockActionTarget,
} from '../../webview/features/feedbackBlockAction';

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    left,
    right: left + width,
    top,
    bottom: top + height,
    width,
    height,
    x: left,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

function createEditorFixture(): Editor {
  document.body.innerHTML = `
    <div id="editor">
      <div class="tiptap">
        <p>Alpha beta</p>
        <blockquote><p>Nested quote</p></blockquote>
        <div class="tableWrapper"><table><tbody><tr><td>Cell<svg><path></path></svg></td></tr></tbody></table></div>
      </div>
      <aside data-feedback-rail></aside>
    </div>
  `;
  const nodes = [
    {
      type: { name: 'paragraph' },
      content: { size: 10 },
      isAtom: false,
      textBetween: () => 'Alpha beta',
    },
    {
      type: { name: 'blockquote' },
      content: { size: 12 },
      isAtom: false,
      textBetween: () => 'Nested quote',
    },
    {
      type: { name: 'table' },
      content: { size: 6 },
      isAtom: false,
      textBetween: () => 'Cell',
    },
  ];
  return {
    state: {
      doc: {
        maybeChild: (ordinal: number) => nodes[ordinal] ?? null,
        forEach: (
          callback: (node: (typeof nodes)[number], offset: number, ordinal: number) => void
        ) => nodes.forEach((node, ordinal) => callback(node, ordinal, ordinal)),
      },
    },
    view: {
      dom: document.querySelector('.tiptap') as HTMLElement,
      nodeDOM(position: number) {
        return this.dom.children.item(position);
      },
    },
  } as unknown as Editor;
}

describe('Feedback block action', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('indexes every canonical top-level element and resolves nested DOM in constant depth', () => {
    const editor = createEditorFixture();
    const root = editor.view.dom as HTMLElement;
    const index = createFeedbackBlockElementIndex(editor, [
      { ordinal: 0, startLine: 1, endLine: 1 },
      { ordinal: 2, startLine: 4, endLine: 6 },
    ]);

    expect(index.resolve(root.children[0].firstChild)).toEqual({
      ordinal: 0,
      element: root.children[0],
    });
    expect(index.resolve(root.querySelector('td')?.firstChild ?? null)).toEqual({
      ordinal: 2,
      element: root.children[2],
    });
    expect(index.resolve(root.querySelector('path'))).toEqual({
      ordinal: 2,
      element: root.children[2],
    });
    expect(index.resolve(root.querySelector('blockquote p'))).toEqual({
      ordinal: 1,
      element: root.children[1],
    });
    expect(index.resolve(root)).toBeNull();
  });

  it('falls back to canonical nodeDOM lazily when a foreign direct child makes DOM order ambiguous', () => {
    const editor = createEditorFixture();
    const root = editor.view.dom as HTMLElement;
    const canonicalBlocks = Array.from(root.children) as HTMLElement[];
    const foreign = document.createElement('div');
    foreign.dataset.foreign = '';
    root.insertBefore(foreign, root.children[1] ?? null);
    const nodeDOM = jest.fn((position: number) => canonicalBlocks[position] ?? null);
    editor.view.nodeDOM = nodeDOM;
    const index = createFeedbackBlockElementIndex(editor, [
      { ordinal: 0, startLine: 1, endLine: 1 },
      { ordinal: 2, startLine: 4, endLine: 6 },
    ]);

    expect(nodeDOM).toHaveBeenCalledTimes(2);
    expect(index.resolve(canonicalBlocks[0].firstChild)).toEqual({
      ordinal: 0,
      element: canonicalBlocks[0],
    });
    expect(index.resolve(canonicalBlocks[1].firstChild)).toBeNull();
    expect(index.resolve(foreign)).toBeNull();

    expect(index.elementForOrdinal(1)).toBe(canonicalBlocks[1]);
    expect(index.resolve(canonicalBlocks[1].firstChild)).toEqual({
      ordinal: 1,
      element: canonicalBlocks[1],
    });
    expect(index.elementForOrdinal(1)).toBe(canonicalBlocks[1]);
    expect(nodeDOM).toHaveBeenCalledTimes(3);
  });

  it('creates one honest whole-table target without exact-selection metadata', () => {
    const editor = createEditorFixture();

    expect(
      resolveFeedbackBlockActionTarget(editor, [{ ordinal: 2, startLine: 4, endLine: 6 }], 2)
    ).toEqual({
      startOrdinal: 2,
      endOrdinal: 2,
      focus: 'Cell',
      startLine: 4,
      endLine: 6,
      presentationReason: 'whole-block-action',
    });
    expect(
      resolveFeedbackBlockActionTarget(editor, [{ ordinal: 9, startLine: 20, endLine: 21 }], 9)
    ).toBeNull();
  });

  it('indexes anchors once for repeated target resolution', () => {
    const editor = createEditorFixture();
    let ordinalReads = 0;
    const anchors = [0, 1, 2].map(value => ({
      get ordinal() {
        ordinalReads += 1;
        return value;
      },
      startLine: value + 1,
      endLine: value + 1,
    }));
    const resolver = createFeedbackBlockActionTargetResolver(editor, anchors);
    const readsAfterIndex = ordinalReads;

    expect(resolver.resolve(2)?.focus).toBe('Cell');
    expect(resolver.resolve(0)?.focus).toBe('Alpha beta');
    expect(resolver.resolve(2)?.focus).toBe('Cell');
    expect(ordinalReads).toBe(readsAfterIndex);
  });

  it('reuses one native button, labels tables, and reads geometry only when needed', () => {
    const editor = createEditorFixture();
    const container = document.querySelector('#editor') as HTMLElement;
    const rail = document.querySelector('[data-feedback-rail]') as HTMLElement;
    const prose = editor.view.dom.children[0] as HTMLElement;
    const table = editor.view.dom.children[2] as HTMLElement;
    container.getBoundingClientRect = jest.fn(() => rect(20, 10, 800, 600));
    prose.getBoundingClientRect = jest.fn(() => rect(80, 100, 640, 40));
    table.getBoundingClientRect = jest.fn(() => rect(80, 220, 640, 240));
    const onActivate = jest.fn();
    const view = createFeedbackBlockActionView({ container, before: rail, onActivate });
    const proseTarget = {
      startOrdinal: 0,
      endOrdinal: 0,
      focus: 'Alpha beta',
      startLine: 1,
      endLine: 1,
    };
    const tableTarget = {
      startOrdinal: 2,
      endOrdinal: 2,
      focus: 'Cell',
      startLine: 4,
      endLine: 6,
    };

    view.show({ target: proseTarget, element: prose, isTable: false });
    const button = view.element;
    expect(button.parentElement).toBe(container);
    expect(button.nextElementSibling).toBe(rail);
    expect(button.hidden).toBe(false);
    expect(button.getAttribute('aria-label')).toBe('Add feedback to this block');
    expect(button.querySelector('.codicon-comment-discussion-sparkle')).not.toBeNull();
    const preview = container.querySelector<HTMLElement>('[data-feedback-block-target-preview]');
    expect(preview?.hidden).toBe(false);
    expect(preview?.getAttribute('aria-hidden')).toBe('true');
    expect(preview?.style.cssText).toContain('left: 60px');
    expect(preview?.style.cssText).toContain('top: 90px');
    expect(preview?.style.cssText).toContain('width: 640px');
    expect(preview?.style.cssText).toContain('height: 40px');
    expect(prose.classList.contains('feedback-block-target-preview')).toBe(false);
    expect(button.style.left).toBe('16px');
    expect(button.style.top).toBe('92px');

    view.show({ target: proseTarget, element: prose, isTable: false });
    expect(view.element).toBe(button);
    expect(prose.getBoundingClientRect).toHaveBeenCalledTimes(1);

    view.show({ target: tableTarget, element: table, isTable: true });
    expect(view.element).toBe(button);
    expect(button.getAttribute('aria-label')).toBe('Add feedback to this table');
    expect(preview?.style.cssText).toContain('top: 210px');
    expect(preview?.style.cssText).toContain('height: 240px');
    expect(table.classList.contains('feedback-block-target-preview')).toBe(false);
    button.click();
    expect(onActivate).toHaveBeenCalledWith(tableTarget);
    table.remove();
    button.click();
    expect(onActivate).toHaveBeenCalledTimes(1);

    view.hide();
    expect(button.hidden).toBe(true);
    expect(preview?.hidden).toBe(true);
    view.show({ target: proseTarget, element: prose, isTable: false });
    expect(preview?.hidden).toBe(false);
    view.destroy();
    expect(preview?.isConnected).toBe(false);
    expect(button.isConnected).toBe(false);
  });

  it('keeps the 36px action inside the narrow real-editor gutter', () => {
    const editor = createEditorFixture();
    const container = document.querySelector('#editor') as HTMLElement;
    const rail = document.querySelector('[data-feedback-rail]') as HTMLElement;
    const prose = editor.view.dom.children[0] as HTMLElement;
    container.getBoundingClientRect = () => rect(0, 0, 800, 600);
    prose.getBoundingClientRect = () => rect(30, 20, 740, 40);
    const view = createFeedbackBlockActionView({
      container,
      before: rail,
      onActivate: jest.fn(),
    });

    view.show({
      target: {
        startOrdinal: 0,
        endOrdinal: 0,
        focus: 'Alpha beta',
        startLine: 1,
        endLine: 1,
      },
      element: prose,
      isTable: false,
    });

    expect(view.element.style.left).toBe('0px');
  });

  it('hides offscreen targets and clamps an intersecting tall table below the toolbar', () => {
    const editor = createEditorFixture();
    const container = document.querySelector('#editor') as HTMLElement;
    const rail = document.querySelector('[data-feedback-rail]') as HTMLElement;
    const table = editor.view.dom.children[2] as HTMLElement;
    const toolbar = document.createElement('div');
    toolbar.className = 'formatting-toolbar';
    document.body.prepend(toolbar);
    container.getBoundingClientRect = () => rect(0, 0, 800, 1_200);
    toolbar.getBoundingClientRect = () => rect(0, 0, 800, 50);
    let tableRect = rect(30, 900, 740, 240);
    table.getBoundingClientRect = () => tableRect;
    const view = createFeedbackBlockActionView({
      container,
      before: rail,
      onActivate: jest.fn(),
    });
    const target = {
      startOrdinal: 2,
      endOrdinal: 2,
      focus: 'Cell',
      startLine: 4,
      endLine: 6,
    };

    view.show({ target, element: table, isTable: true });
    expect(view.element.hidden).toBe(true);
    const preview = container.querySelector<HTMLElement>('[data-feedback-block-target-preview]');
    expect(preview?.hidden).toBe(true);

    tableRect = rect(30, -100, 740, 400);
    view.reposition();
    expect(view.element.hidden).toBe(false);
    expect(preview?.hidden).toBe(false);
    expect(view.element.style.top).toBe('54px');
  });

  it('keeps repeated offscreen shows inert and positions once the same target is visible', () => {
    const editor = createEditorFixture();
    const container = document.querySelector('#editor') as HTMLElement;
    const rail = document.querySelector('[data-feedback-rail]') as HTMLElement;
    const prose = editor.view.dom.children[0] as HTMLElement;
    container.getBoundingClientRect = () => rect(0, 0, 800, 1_200);
    let proseRect = rect(80, 900, 640, 40);
    prose.getBoundingClientRect = () => proseRect;
    const onActivate = jest.fn();
    const view = createFeedbackBlockActionView({ container, before: rail, onActivate });
    const target = {
      startOrdinal: 0,
      endOrdinal: 0,
      focus: 'Alpha beta',
      startLine: 1,
      endLine: 1,
    };

    view.show({ target, element: prose, isTable: false });
    const hiddenAfterFirstShow = view.element.hidden;
    view.element.click();
    view.show({ target, element: prose, isTable: false });
    const hiddenAfterSecondShow = view.element.hidden;
    const hiddenCoordinates = {
      left: view.element.style.left,
      top: view.element.style.top,
    };

    proseRect = rect(80, 100, 640, 40);
    view.show({ target, element: prose, isTable: false });
    const visibleCoordinates = {
      left: view.element.style.left,
      top: view.element.style.top,
    };
    view.element.click();

    expect({
      hiddenAfterFirstShow,
      hiddenAfterSecondShow,
      hiddenCoordinates,
      visibleAfterGeometryChange: !view.element.hidden,
      visibleCoordinates,
      activationCount: onActivate.mock.calls.length,
    }).toEqual({
      hiddenAfterFirstShow: true,
      hiddenAfterSecondShow: true,
      hiddenCoordinates: { left: '', top: '' },
      visibleAfterGeometryChange: true,
      visibleCoordinates: { left: '36px', top: '102px' },
      activationCount: 1,
    });
  });
});
