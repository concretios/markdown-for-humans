/** @jest-environment jsdom */

import type { Editor } from '@tiptap/core';
import { collectExportContent, getDocumentTitle } from '../../webview/utils/exportContent';
import * as l10n from '../../webview/l10n';

function createEditor(html: string): Editor {
  const dom = document.createElement('div');
  dom.innerHTML = html;
  return { view: { dom } } as unknown as Editor;
}

const sampleBundle: Record<string, string> = {
  'Untitled Document': '无标题文档',
  'Mermaid diagram {0}': 'Mermaid 图表 {0}',
};

describe('export content localization', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    l10n.resetL10n();
  });

  it('keeps English text when no bundle is loaded', async () => {
    expect(getDocumentTitle(createEditor('<p>No heading</p>'))).toBe('Untitled Document');
  });

  it('translates the fallback document title but never a real heading', () => {
    l10n.configureL10n(sampleBundle);

    expect(getDocumentTitle(createEditor('<p>No heading</p>'))).toBe('无标题文档');
    expect(getDocumentTitle(createEditor('<h1>My Plan</h1>'))).toBe('My Plan');
  });

  it('translates the alt text of an exported Mermaid diagram with its number', async () => {
    jest.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      scale: jest.fn(),
      fillRect: jest.fn(),
      drawImage: jest.fn(),
    } as unknown as CanvasRenderingContext2D);
    jest
      .spyOn(HTMLCanvasElement.prototype, 'toDataURL')
      .mockReturnValue('data:image/png;base64,AAAA');
    // jsdom never loads images, so report a successful load as soon as src is set.
    jest.spyOn(window.Image.prototype, 'src', 'set').mockImplementation(function (
      this: HTMLImageElement
    ) {
      setTimeout(() => this.onload?.(new Event('load')), 0);
    });
    const editor = createEditor(
      '<div class="mermaid-wrapper"><div class="mermaid-render"><svg></svg></div></div>' +
        '<div class="mermaid-wrapper"><div class="mermaid-render"><svg></svg></div></div>'
    );
    const english = await collectExportContent(
      createEditor(
        '<div class="mermaid-wrapper"><div class="mermaid-render"><svg></svg></div></div>'
      )
    );
    expect(english.html).toContain('alt="Mermaid diagram 1"');

    l10n.configureL10n(sampleBundle);
    const translated = await collectExportContent(editor);

    expect(translated.html).toContain('alt="Mermaid 图表 1"');
    expect(translated.html).toContain('alt="Mermaid 图表 2"');
  });
});
