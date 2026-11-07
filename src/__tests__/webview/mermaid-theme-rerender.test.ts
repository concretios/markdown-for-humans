/**
 * @jest-environment jsdom
 */

import mermaid from 'mermaid';
import { Mermaid } from '../../webview/extensions/mermaid';

interface TestMermaidNodeView {
  dom: HTMLElement;
  destroy(): void;
}

type TestMermaidNodeViewFactory = (args: Record<string, unknown>) => TestMermaidNodeView;

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

/** Mirrors VS Code's webview applyStyles: body class first, then theme variables. */
function applyVsCodeTheme(kind: 'vscode-light' | 'vscode-dark', background: string): void {
  document.body.classList.remove('vscode-light', 'vscode-dark');
  document.body.classList.add(kind);
  document.documentElement.style.setProperty('--vscode-editor-background', background);
}

async function flushObserverAndRender(): Promise<void> {
  for (let i = 0; i < 4; i += 1) await Promise.resolve();
}

describe('Mermaid re-renders when the VS Code theme changes', () => {
  const renderMock = mermaid.render as jest.MockedFunction<typeof mermaid.render>;
  const initializeMock = mermaid.initialize as jest.MockedFunction<typeof mermaid.initialize>;
  const views: TestMermaidNodeView[] = [];

  beforeEach(() => {
    renderMock.mockReset();
    renderMock.mockResolvedValue({ svg: '<svg></svg>', diagramType: 'flowchart-v2' });
    initializeMock.mockClear();
    applyVsCodeTheme('vscode-dark', '#1e1e1e');
  });

  afterEach(() => {
    views.splice(0).forEach(view => view.destroy());
    document.body.innerHTML = '';
  });

  function mount(code: string): TestMermaidNodeView {
    const view = createMermaidNodeView(code);
    views.push(view);
    document.body.append(view.dom);
    return view;
  }

  it('re-renders every diagram with the light theme after switching from dark to light', async () => {
    mount('flowchart LR\nA-->B');
    mount('sequenceDiagram\nA->>B: hi');
    await flushObserverAndRender();
    expect(renderMock).toHaveBeenCalledTimes(2);
    expect(initializeMock).toHaveBeenLastCalledWith(expect.objectContaining({ theme: 'dark' }));

    applyVsCodeTheme('vscode-light', '#ffffff');
    await flushObserverAndRender();

    expect(renderMock).toHaveBeenCalledTimes(4);
    expect(initializeMock).toHaveBeenLastCalledWith(expect.objectContaining({ theme: 'default' }));
  });

  it('keeps the old diagram on screen until the re-themed one is ready', async () => {
    renderMock.mockResolvedValueOnce({ svg: '<svg id="dark-svg"></svg>', diagramType: 'x' });
    const view = mount('flowchart LR\nA-->B');
    await flushObserverAndRender();

    let resolveLight!: (value: Awaited<ReturnType<typeof mermaid.render>>) => void;
    renderMock.mockReturnValueOnce(new Promise(resolve => (resolveLight = resolve)));
    applyVsCodeTheme('vscode-light', '#ffffff');
    await flushObserverAndRender();

    // A blank diagram mid-render would shift the page under the reader.
    expect(view.dom.querySelector('#dark-svg')).not.toBeNull();

    resolveLight({ svg: '<svg id="light-svg"></svg>', diagramType: 'x' });
    await flushObserverAndRender();
    expect(view.dom.querySelector('#dark-svg')).toBeNull();
    expect(view.dom.querySelector('#light-svg')).not.toBeNull();
  });

  it('does not re-render when a body class changes without a theme change', async () => {
    mount('flowchart LR\nA-->B');
    await flushObserverAndRender();
    expect(renderMock).toHaveBeenCalledTimes(1);

    document.body.classList.add('saving-feedback');
    await flushObserverAndRender();
    document.body.classList.remove('saving-feedback');
    await flushObserverAndRender();

    expect(renderMock).toHaveBeenCalledTimes(1);
  });

  it('does not re-render a destroyed diagram', async () => {
    const view = mount('flowchart LR\nA-->B');
    await flushObserverAndRender();
    view.destroy();
    views.splice(views.indexOf(view), 1);

    applyVsCodeTheme('vscode-light', '#ffffff');
    await flushObserverAndRender();

    expect(renderMock).toHaveBeenCalledTimes(1);
  });
});
