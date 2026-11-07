/** @jest-environment jsdom */

import type { Editor } from '@tiptap/core';
import katex from 'katex';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { InlineMath } from '../../webview/extensions/inlineMath';
import { MathBlock } from '../../webview/extensions/mathBlock';
import * as l10n from '../../webview/l10n';

jest.mock('katex', () => ({
  __esModule: true,
  default: { renderToString: jest.fn(() => '<span class="katex"></span>') },
}));

type NodeViewFactory = (props: { node: ProseMirrorNode; getPos: () => number; editor: Editor }) => {
  dom: HTMLElement;
};

function renderNodeView(extension: typeof MathBlock | typeof InlineMath, latex: string) {
  const addNodeView = extension.config.addNodeView as unknown as () => NodeViewFactory;
  return addNodeView.call({} as never)({
    node: { attrs: { latex } } as unknown as ProseMirrorNode,
    getPos: () => 0,
    editor: {} as Editor,
  }).dom;
}

const sampleBundle: Record<string, string> = {
  'Double-click to edit': '双击编辑',
  'Empty equation. Double-click to edit.': '公式为空。双击编辑。',
  'LaTeX error: {0}': 'LaTeX 错误：{0}',
  'Empty math (double-click to edit)': '空公式（双击编辑）',
  '{0} (double-click to edit)': '{0}（双击编辑）',
};

describe('Math node view text', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    l10n.resetL10n();
  });

  describe('block math', () => {
    it('shows English when no bundle is loaded', () => {
      const dom = renderNodeView(MathBlock, '');

      expect(dom.querySelector('.md4h-math-block-tooltip')?.textContent).toBe(
        'Double-click to edit'
      );
      expect(dom.querySelector('.md4h-math-block-placeholder')?.textContent).toBe(
        'Empty equation. Double-click to edit.'
      );
    });

    it('translates the tooltip and the empty equation placeholder', () => {
      l10n.configureL10n(sampleBundle);

      const dom = renderNodeView(MathBlock, '');

      expect(dom.querySelector('.md4h-math-block-tooltip')?.textContent).toBe('双击编辑');
      expect(dom.querySelector('.md4h-math-block-placeholder')?.textContent).toBe(
        '公式为空。双击编辑。'
      );
    });

    it('translates the error prefix and keeps the renderer message as written', () => {
      l10n.configureL10n(sampleBundle);
      jest.mocked(katex.renderToString).mockImplementationOnce(() => {
        throw new Error('Undefined control sequence: \\foo');
      });

      const dom = renderNodeView(MathBlock, '\\foo');

      expect(dom.querySelector('.md4h-math-error-message')?.textContent).toBe(
        'LaTeX 错误：Undefined control sequence: \\foo'
      );
      expect(dom.querySelector('.md4h-math-error-source')?.textContent).toBe('\\foo');
    });
  });

  describe('inline math', () => {
    it('shows English when no bundle is loaded', () => {
      expect(renderNodeView(InlineMath, '').title).toBe('Empty math (double-click to edit)');
      expect(renderNodeView(InlineMath, 'x^2').title).toBe('x^2 (double-click to edit)');
    });

    it('translates the tooltip and keeps the LaTeX in it', () => {
      l10n.configureL10n(sampleBundle);

      expect(renderNodeView(InlineMath, '').title).toBe('空公式（双击编辑）');
      expect(renderNodeView(InlineMath, 'x^2').title).toBe('x^2（双击编辑）');
    });

    it('translates the fallback when the renderer throws something that is not an Error', () => {
      l10n.configureL10n({ 'KaTeX render error': 'KaTeX 渲染错误' });
      jest.mocked(katex.renderToString).mockImplementationOnce(() => {
        throw 'boom';
      });

      expect(renderNodeView(InlineMath, 'x').title).toBe('KaTeX 渲染错误');
    });
  });
});
