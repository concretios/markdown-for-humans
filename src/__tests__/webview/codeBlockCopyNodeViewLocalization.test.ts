/** @jest-environment jsdom */

import { Schema } from '@tiptap/pm/model';
import { createCodeBlockCopyNodeView } from '../../webview/extensions/codeBlockCopyNodeView';
import * as l10n from '../../webview/l10n';

const schema = new Schema({
  nodes: {
    doc: { content: 'codeBlock+' },
    text: { group: 'inline' },
    codeBlock: {
      content: 'text*',
      group: 'block',
      code: true,
      attrs: { language: { default: null } },
    },
  },
});

function createNodeView() {
  const node = schema.nodes.codeBlock.create({ language: 'bash' }, schema.text('npm test'));
  const view = createCodeBlockCopyNodeView(node, {});
  const wrapper = view.dom as HTMLElement;
  return {
    view,
    button: wrapper.querySelector('button') as HTMLButtonElement,
    tooltip: wrapper.querySelector('.code-block-copy-tooltip') as HTMLElement,
  };
}

/** Click copy and let the copy promise settle. */
async function clickCopy(button: HTMLButtonElement): Promise<void> {
  button.click();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

const sampleBundle: Record<string, string> = {
  'Copy code block': '复制代码块',
  'Copied!': '已复制！',
  'Code block copied': '代码块已复制',
  'Copy failed': '复制失败',
  'Could not copy code block': '无法复制代码块',
};

describe('Code block copy button localization', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    l10n.resetL10n();
  });

  it('shows English when no bundle is loaded', () => {
    const { button } = createNodeView();

    expect(button.title).toBe('Copy code block');
    expect(button.getAttribute('aria-label')).toBe('Copy code block');
  });

  it('translates the tooltip and the label before and after a successful copy', async () => {
    l10n.configureL10n(sampleBundle);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: jest.fn().mockResolvedValue(undefined) },
    });
    const { view, button, tooltip } = createNodeView();

    expect(button.title).toBe('复制代码块');
    expect(button.getAttribute('aria-label')).toBe('复制代码块');

    await clickCopy(button);
    expect(tooltip.textContent).toBe('已复制！');
    expect(button.getAttribute('aria-label')).toBe('代码块已复制');

    jest.advanceTimersByTime(1600);
    expect(tooltip.textContent).toBe('');
    expect(button.getAttribute('aria-label')).toBe('复制代码块');
    view.destroy?.();
  });

  it('translates the failure message and its announcement', async () => {
    l10n.configureL10n(sampleBundle);
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: jest.fn().mockRejectedValue(new Error('blocked')) },
    });
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: jest.fn().mockReturnValue(false),
    });
    const { view, button, tooltip } = createNodeView();

    await clickCopy(button);

    expect(tooltip.textContent).toBe('复制失败');
    expect(button.getAttribute('aria-label')).toBe('无法复制代码块');
    view.destroy?.();
  });
});
