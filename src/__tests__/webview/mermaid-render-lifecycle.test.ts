/**
 * @jest-environment jsdom
 */

import mermaid from 'mermaid';
import { Mermaid } from '../../webview/extensions/mermaid';
import * as l10n from '../../webview/l10n';

interface TestMermaidNode {
  textContent: string;
  attrs: Record<string, unknown>;
  nodeSize: number;
  type: {
    name: string;
    create: jest.Mock;
  };
}

interface TestMermaidNodeView {
  dom: HTMLElement;
  destroy(): void;
}

type TestMermaidNodeViewFactory = (args: {
  node: TestMermaidNode;
  getPos: () => number;
  editor: {
    state: { tr: { replaceWith: jest.Mock } };
    schema: { text: jest.Mock };
    view: { dispatch: jest.Mock };
    chain: jest.Mock;
  };
}) => TestMermaidNodeView;

function createMermaidNodeView(code: string): TestMermaidNodeView {
  const addNodeView = (
    Mermaid as unknown as {
      config?: { addNodeView?: () => TestMermaidNodeViewFactory };
    }
  ).config?.addNodeView;
  if (addNodeView === undefined) {
    throw new Error('Mermaid NodeView factory is unavailable.');
  }
  return addNodeView()({
    node: {
      textContent: code,
      attrs: { language: 'mermaid' },
      nodeSize: code.length + 2,
      type: { name: 'mermaid', create: jest.fn() },
    },
    getPos: () => 0,
    editor: {
      state: { tr: { replaceWith: jest.fn() } },
      schema: { text: jest.fn() },
      view: { dispatch: jest.fn() },
      chain: jest.fn(() => ({ setNodeSelection: () => ({ run: jest.fn() }) })),
    },
  });
}

async function flushMermaidRender(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('Mermaid render lifecycle state', () => {
  const renderMock = mermaid.render as jest.MockedFunction<typeof mermaid.render>;

  afterEach(() => {
    jest.restoreAllMocks();
    renderMock.mockReset();
    document.body.innerHTML = '';
  });

  it('exposes pending and ready around the actual asynchronous render lifecycle', async () => {
    let resolveRender!: (value: Awaited<ReturnType<typeof mermaid.render>>) => void;
    renderMock.mockReturnValue(
      new Promise(resolve => {
        resolveRender = resolve;
      })
    );

    const nodeView = createMermaidNodeView('flowchart LR\nA-->B');
    document.body.append(nodeView.dom);
    expect(nodeView.dom.getAttribute('data-md4h-mermaid-state')).toBe('pending');

    resolveRender({ svg: '<svg aria-label="diagram"></svg>', diagramType: 'flowchart-v2' });
    await flushMermaidRender();

    expect(nodeView.dom.getAttribute('data-md4h-mermaid-state')).toBe('ready');
    expect(nodeView.dom.querySelector('.mermaid-render svg')).not.toBeNull();
    nodeView.destroy();
  });

  it('exposes a content-free error state when Mermaid rejects', async () => {
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    renderMock.mockRejectedValue(new Error('private parser detail'));

    const nodeView = createMermaidNodeView('flowchart LR\nA--');
    document.body.append(nodeView.dom);
    expect(nodeView.dom.getAttribute('data-md4h-mermaid-state')).toBe('pending');

    await flushMermaidRender();

    expect(nodeView.dom.getAttribute('data-md4h-mermaid-state')).toBe('error');
    expect(nodeView.dom.getAttribute('data-md4h-mermaid-state')).not.toContain('private');
    expect(consoleError).toHaveBeenCalledTimes(1);
    nodeView.destroy();
  });
});

describe('Mermaid node view localization', () => {
  const renderMock = mermaid.render as jest.MockedFunction<typeof mermaid.render>;
  const sampleBundle: Record<string, string> = {
    'Enter Mermaid diagram code': '输入 Mermaid 图表代码',
    'Diagram Error: {0}': '图表错误：{0}',
    'Double-click to edit': '双击编辑',
  };

  afterEach(() => {
    jest.restoreAllMocks();
    renderMock.mockReset();
    document.body.innerHTML = '';
    l10n.resetL10n();
  });

  it('shows English when no bundle is loaded', async () => {
    const nodeView = createMermaidNodeView('');
    document.body.append(nodeView.dom);
    await flushMermaidRender();

    expect(nodeView.dom.querySelector('.mermaid-placeholder')?.textContent).toBe(
      'Enter Mermaid diagram code'
    );
    expect(nodeView.dom.querySelector('.mermaid-tooltip')?.textContent).toBe(
      'Double-click to edit'
    );
    nodeView.destroy();
  });

  it('translates the empty placeholder and the tooltip', async () => {
    l10n.configureL10n(sampleBundle);

    const nodeView = createMermaidNodeView('');
    document.body.append(nodeView.dom);
    await flushMermaidRender();

    expect(nodeView.dom.querySelector('.mermaid-placeholder')?.textContent).toBe(
      '输入 Mermaid 图表代码'
    );
    expect(nodeView.dom.querySelector('.mermaid-tooltip')?.textContent).toBe('双击编辑');
    nodeView.destroy();
  });

  it('translates the error prefix and keeps the parser message as written', async () => {
    l10n.configureL10n(sampleBundle);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    renderMock.mockRejectedValue(new Error('Parse error on line 2'));

    const nodeView = createMermaidNodeView('flowchart LR\nA--');
    document.body.append(nodeView.dom);
    await flushMermaidRender();

    expect(nodeView.dom.querySelector('.mermaid-error')?.textContent).toBe(
      '图表错误：Parse error on line 2'
    );
    nodeView.destroy();
  });
});
