/**
 * Tests for the zoom button on a rendered mermaid node
 * @jest-environment jsdom
 */

import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import mermaid from 'mermaid';
import { Mermaid } from '../../webview/extensions/mermaid';

describe('Mermaid zoom button', () => {
  let editor: Editor;

  const settle = () => new Promise(resolve => setTimeout(resolve, 0));

  const createEditor = async () => {
    const element = document.createElement('div');
    document.body.appendChild(element);
    editor = new Editor({
      element,
      extensions: [StarterKit, Mermaid],
      content:
        '<pre data-language="mermaid"><code class="language-mermaid">graph TD\nA--&gt;B</code></pre>',
    });
    await settle();
  };

  const wrapper = () => document.querySelector('.mermaid-wrapper') as HTMLElement;
  const zoomButton = () => document.querySelector('.mermaid-zoom-btn') as HTMLButtonElement;

  beforeEach(() => {
    (mermaid.render as jest.Mock).mockResolvedValue({ svg: '<svg id="diagram"></svg>' });
  });

  afterEach(() => {
    editor?.destroy();
    document.body.innerHTML = '';
  });

  it('should add a zoom button to a rendered diagram', async () => {
    await createEditor();

    expect(zoomButton()).not.toBeNull();
    expect(zoomButton().getAttribute('aria-label')).toBe('Open diagram in full screen');
  });

  it('should open the lightbox showing the rendered diagram', async () => {
    await createEditor();

    zoomButton().click();
    await settle();

    const canvas = document.querySelector('.mermaid-lightbox-canvas') as HTMLElement;
    expect(canvas).not.toBeNull();
    expect(canvas.querySelector('#diagram')).not.toBeNull();
  });

  it('should not highlight the node when the zoom button is clicked', async () => {
    await createEditor();

    zoomButton().click();
    await settle();

    expect(wrapper().classList.contains('highlighted')).toBe(false);
  });

  it('should not open the code editor when the zoom button is double-clicked', async () => {
    await createEditor();

    zoomButton().dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    await settle();

    expect(document.querySelector('.mermaid-editor-overlay')).toBeNull();
  });

  it('should hide the zoom button when the diagram fails to render', async () => {
    (mermaid.render as jest.Mock).mockRejectedValue(new Error('bad syntax'));
    const logged = jest.spyOn(console, 'error').mockImplementation(() => {});

    await createEditor();

    expect(zoomButton().hidden).toBe(true);
    logged.mockRestore();
  });
});

describe('Mermaid zoom button: lightbox fails to load', () => {
  const settle = () => new Promise(resolve => setTimeout(resolve, 0));

  afterEach(() => {
    jest.resetModules();
    document.body.innerHTML = '';
  });

  it('should log the failure instead of raising an unhandled rejection', async () => {
    jest.resetModules();
    jest.doMock('../../webview/features/mermaidLightbox', () => {
      throw new Error('chunk load failed');
    });
    const logged = jest.spyOn(console, 'error').mockImplementation(() => {});
    const unhandled = jest.fn();
    process.on('unhandledRejection', unhandled);

    const { Mermaid: Reloaded } = await import('../../webview/extensions/mermaid');
    const { Editor: FreshEditor } = await import('@tiptap/core');
    const StarterKitFresh = (await import('@tiptap/starter-kit')).default;
    const mermaidLib = (await import('mermaid')).default;
    (mermaidLib.render as jest.Mock).mockResolvedValue({ svg: '<svg id="diagram"></svg>' });

    const element = document.createElement('div');
    document.body.appendChild(element);
    const localEditor = new FreshEditor({
      element,
      extensions: [StarterKitFresh, Reloaded],
      content:
        '<pre data-language="mermaid"><code class="language-mermaid">graph TD\nA--&gt;B</code></pre>',
    });
    await settle();

    (document.querySelector('.mermaid-zoom-btn') as HTMLButtonElement).click();
    await settle();
    await settle();

    expect(logged).toHaveBeenCalled();
    expect(unhandled).not.toHaveBeenCalled();

    process.off('unhandledRejection', unhandled);
    logged.mockRestore();
    localEditor.destroy();
  });
});
