/** @jest-environment jsdom */

import { Schema } from '@tiptap/pm/model';
import { createCodeBlockCopyNodeView } from '../../webview/extensions/codeBlockCopyNodeView';

const schema = new Schema({
  nodes: {
    doc: { content: 'codeBlock+' },
    text: { group: 'inline' },
    codeBlock: {
      content: 'text*',
      group: 'block',
      code: true,
      defining: true,
      attrs: {
        language: { default: null },
        'indent-prefix': { default: null },
      },
    },
  },
});

function createNodeView(code = 'npm run build\nnpm test', language = 'bash') {
  const node = schema.nodes.codeBlock.create(
    { language, 'indent-prefix': null },
    schema.text(code)
  );

  return createCodeBlockCopyNodeView(node, {
    class: 'code-block-highlighted',
  });
}

describe('CodeBlockWithCopy node view', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('keeps code editable through contentDOM and renders a non-editable copy button', () => {
    const nodeView = createNodeView();
    const wrapper = nodeView.dom as HTMLElement;
    const pre = wrapper.querySelector('pre');
    const button = wrapper.querySelector('button');
    const icon = button?.querySelector('.codicon');
    const tooltip = wrapper.querySelector('[role="status"]');

    expect(wrapper.classList.contains('code-block-wrapper')).toBe(true);
    expect(pre?.classList.contains('code-block-highlighted')).toBe(true);
    expect(nodeView.contentDOM).toBe(wrapper.querySelector('code'));
    expect(icon?.classList.contains('codicon-copy')).toBe(true);
    expect(button?.getAttribute('contenteditable')).toBe('false');
    expect(button?.getAttribute('aria-label')).toBe('Copy code block');
    expect(button?.getAttribute('title')).toBe('Copy code block');
    expect(tooltip?.getAttribute('aria-live')).toBe('polite');
    expect(tooltip?.textContent).toBe('');
  });

  it('copies only raw node text and shows temporary success feedback', async () => {
    const writeText = jest.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    const nodeView = createNodeView('echo "hello"\nexit 0', 'shell');
    const wrapper = nodeView.dom as HTMLElement;
    const button = (nodeView.dom as HTMLElement).querySelector('button') as HTMLButtonElement;
    const icon = button.querySelector('.codicon') as HTMLElement;
    const tooltip = wrapper.querySelector('[role="status"]') as HTMLElement;

    button.click();
    await Promise.resolve();
    await Promise.resolve();

    expect(writeText).toHaveBeenCalledWith('echo "hello"\nexit 0');
    expect(button.classList.contains('is-copied')).toBe(true);
    expect(icon.classList.contains('codicon-check')).toBe(true);
    expect(icon.classList.contains('codicon-copy')).toBe(false);
    expect(button.getAttribute('aria-label')).toBe('Code block copied');
    expect(tooltip.classList.contains('visible')).toBe(true);
    expect(tooltip.textContent).toBe('Copied!');

    jest.advanceTimersByTime(1600);
    expect(button.classList.contains('is-copied')).toBe(false);
    expect(icon.classList.contains('codicon-copy')).toBe(true);
    expect(tooltip.classList.contains('visible')).toBe(false);
    expect(tooltip.textContent).toBe('');
  });

  it('prevents mouse interaction from moving focus into the editor', () => {
    const nodeView = createNodeView();
    const button = (nodeView.dom as HTMLElement).querySelector('button') as HTMLButtonElement;
    const mouseDown = new MouseEvent('mousedown', { bubbles: true, cancelable: true });

    button.dispatchEvent(mouseDown);

    expect(mouseDown.defaultPrevented).toBe(true);
    expect(nodeView.stopEvent?.(mouseDown)).toBe(true);
  });

  it('falls back to execCommand when navigator.clipboard rejects', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const writeText = jest.fn().mockRejectedValue(new Error('clipboard blocked'));
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    const execCommand = jest.fn().mockReturnValue(true);
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: execCommand,
    });
    const nodeView = createNodeView('raw code');
    const button = (nodeView.dom as HTMLElement).querySelector('button') as HTMLButtonElement;
    const previousFocus = document.createElement('input');
    document.body.appendChild(previousFocus);
    previousFocus.focus();

    button.click();
    await Promise.resolve();
    await Promise.resolve();

    expect(execCommand).toHaveBeenCalledWith('copy');
    expect(button.classList.contains('is-copied')).toBe(true);
    expect(document.querySelector('.code-block-copy-fallback')).toBeNull();
    expect(document.activeElement).toBe(previousFocus);
  });
});
