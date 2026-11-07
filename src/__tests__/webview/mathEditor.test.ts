/**
 * @jest-environment jsdom
 *
 * Tests for the math (LaTeX/KaTeX) editor modal, starting with its UI text.
 */

import { showMathEditor } from '../../webview/features/mathEditor';
import * as l10n from '../../webview/l10n';

/** Open the editor, hand the test the open dialog, then close it with Cancel. */
async function withEditor(
  options: { initialLatex: string; displayMode: boolean },
  inspect: () => void
): Promise<void> {
  const pending = showMathEditor(options);
  inspect();
  (document.querySelector('#cancel-btn') as HTMLButtonElement).click();
  await pending;
}

const chipLabels = (): string[] =>
  Array.from(document.querySelectorAll('.math-template-chip')).map(chip => chip.textContent ?? '');

describe('Math editor', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('inserts a template at the caret without translating the LaTeX', async () => {
    const pending = showMathEditor({ initialLatex: '', displayMode: false });

    const fraction = Array.from(
      document.querySelectorAll<HTMLButtonElement>('.math-template-chip')
    ).find(chip => chip.textContent === 'Fraction') as HTMLButtonElement;
    fraction.click();

    expect((document.querySelector('.math-editor-textarea') as HTMLTextAreaElement).value).toBe(
      '\\frac{a}{b}'
    );
    (document.querySelector('#save-btn') as HTMLButtonElement).click();
    expect((await pending).latex).toBe('\\frac{a}{b}');
  });
});

describe('Math editor localization', () => {
  const sampleBundle: Record<string, string> = {
    'Edit Display Math': '编辑公式块',
    'Edit Inline Math': '编辑行内公式',
    'KaTeX docs': 'KaTeX 文档',
    'Open KaTeX supported functions reference': '打开 KaTeX 支持的函数参考',
    'Close (Esc)': '关闭 (Esc)',
    Close: '关闭',
    'LaTeX source': 'LaTeX 源码',
    Preview: '预览',
    Templates: '模板',
    Fraction: '分数',
    'Power xⁿ': '幂 xⁿ',
    'Wrap words in {0} so spaces are preserved': '用 {0} 包裹文字以保留空格',
    'e.g. {0}': '例如 {0}',
    'Type LaTeX to see the preview…': '输入 LaTeX 以查看预览…',
    'Cmd/Ctrl+S to save · Esc to cancel': 'Cmd/Ctrl+S 保存 · Esc 取消',
    Cancel: '取消',
    Save: '保存',
  };

  afterEach(() => {
    document.body.innerHTML = '';
    l10n.resetL10n();
  });

  it('shows English when no bundle is loaded', async () => {
    await withEditor({ initialLatex: '', displayMode: false }, () => {
      expect(document.querySelector('h3')?.textContent?.trim()).toBe('Edit Inline Math');
      expect(document.querySelector('#docs-link')?.textContent).toBe('KaTeX docs');
      expect(
        (document.querySelector('.math-editor-textarea') as HTMLTextAreaElement).placeholder
      ).toBe('e.g.   x^{2}        \\frac{a}{b}        \\sqrt{x}        a + b');
      expect(document.querySelector('.math-editor-preview')?.textContent).toBe(
        'Type LaTeX to see the preview…'
      );
      expect(chipLabels()).toContain('Fraction');
      expect(chipLabels()).toContain('Std dev σ');
    });
  });

  it('shows the translated header, labels, buttons and footer hint', async () => {
    l10n.configureL10n(sampleBundle);

    await withEditor({ initialLatex: '', displayMode: true }, () => {
      const closeBtn = document.querySelector('#close-btn') as HTMLButtonElement;
      const docsLink = document.querySelector('#docs-link') as HTMLAnchorElement;
      expect(document.querySelector('h3')?.textContent?.trim()).toBe('编辑公式块');
      expect(docsLink.textContent).toBe('KaTeX 文档');
      expect(docsLink.title).toBe('打开 KaTeX 支持的函数参考');
      expect(closeBtn.title).toBe('关闭 (Esc)');
      expect(closeBtn.getAttribute('aria-label')).toBe('关闭');
      expect(document.body.textContent).toContain('LaTeX 源码');
      expect(document.body.textContent).toContain('预览');
      expect(document.body.textContent).toContain('Cmd/Ctrl+S 保存 · Esc 取消');
      expect(document.querySelector('#cancel-btn')?.textContent).toBe('取消');
      expect(document.querySelector('#save-btn')?.textContent).toBe('保存');
      expect(document.querySelector('.math-editor-preview')?.textContent).toBe(
        '输入 LaTeX 以查看预览…'
      );
      expect(document.querySelector('.math-template-label')?.textContent).toBe('模板');
    });
  });

  it('translates the placeholder lead-in and keeps the LaTeX example as written', async () => {
    l10n.configureL10n(sampleBundle);

    await withEditor({ initialLatex: '', displayMode: false }, () => {
      expect(
        (document.querySelector('.math-editor-textarea') as HTMLTextAreaElement).placeholder
      ).toBe('例如   x^{2}        \\frac{a}{b}        \\sqrt{x}        a + b');
    });
    await withEditor({ initialLatex: '', displayMode: true }, () => {
      expect(
        (document.querySelector('.math-editor-textarea') as HTMLTextAreaElement).placeholder
      ).toBe(
        '例如   \\sum_{i=1}^{n} i        \\int_{a}^{b} f(x)\\,dx        x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}'
      );
    });
  });

  it('translates template labels and tooltips but never the LaTeX they insert', async () => {
    l10n.configureL10n(sampleBundle);
    const pending = showMathEditor({ initialLatex: '', displayMode: false });

    const chips = Array.from(document.querySelectorAll<HTMLButtonElement>('.math-template-chip'));
    expect(chips.map(chip => chip.textContent)).toEqual(
      expect.arrayContaining(['分数', '幂 xⁿ', 'Sum'])
    );
    const textChip = chips[0];
    expect(textChip.title).toBe('用 \\text{ } 包裹文字以保留空格');
    const fraction = chips.find(chip => chip.textContent === '分数') as HTMLButtonElement;
    expect(fraction.title).toBe('\\frac{a}{b}');
    fraction.click();
    expect((document.querySelector('.math-editor-textarea') as HTMLTextAreaElement).value).toBe(
      '\\frac{a}{b}'
    );
    (document.querySelector('#cancel-btn') as HTMLButtonElement).click();
    await pending;
  });
});
