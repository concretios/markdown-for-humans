/** @jest-environment jsdom */

import { Editor } from '@tiptap/core';
import ImageExtension from '@tiptap/extension-image';
import StarterKit from '@tiptap/starter-kit';
import {
  getImageFiles,
  getPendingImageCount,
  insertImage,
  releasePendingImageSave,
  setupImageDragDrop,
} from '../../webview/features/imageDragDrop';
import { showImageInsertDialog } from '../../webview/features/imageInsertDialog';
import { setRememberedFolder } from '../../webview/features/imageConfirmation';

const SVG =
  '<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 560"><title>Résumé &amp; diagram</title><path d="M0 0h1280v560H0z"/></svg>\n';
const PendingImage = ImageExtension.extend({
  addAttributes() {
    return { ...this.parent?.(), 'data-placeholder-id': { default: null } };
  },
});

function svgFile(name = 'diagram.svg', type = 'image/svg+xml', content = SVG): File {
  const file = new File([content], name, { type });
  Object.defineProperty(file, 'arrayBuffer', {
    value: jest.fn(async () => Uint8Array.from(Buffer.from(content)).buffer),
  });
  return file;
}

function transfer(files: File[]): DataTransfer {
  return {
    files,
    types: ['Files'],
    items: files.map(file => ({ type: file.type, getAsFile: () => file })),
    getData: () => '',
  } as unknown as DataTransfer;
}

function nextTask(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0));
}

describe('SVG imports preserve vector files', () => {
  let editor: Editor;
  let postMessage: jest.Mock;
  let element: HTMLDivElement;

  beforeEach(() => {
    element = document.createElement('div');
    document.body.appendChild(element);
    editor = new Editor({
      element,
      extensions: [StarterKit, PendingImage.configure({ allowBase64: true })],
      content: '<p>Before</p>',
    });
    postMessage = jest.fn();
    setRememberedFolder('images');
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: jest.fn(() => 'blob://image'),
    });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: jest.fn() });
    class MockImage {
      width = 1280;
      height = 560;
      onload: (() => void) | null = null;
      set src(_value: string) {
        this.onload?.();
      }
    }
    Object.defineProperty(globalThis, 'Image', { configurable: true, value: MockImage });
    jest
      .spyOn(HTMLCanvasElement.prototype, 'getContext')
      .mockReturnValue({ drawImage: jest.fn() } as unknown as CanvasRenderingContext2D);
    jest
      .spyOn(HTMLCanvasElement.prototype, 'toBlob')
      .mockImplementation(callback => callback(new Blob(['PNG'], { type: 'image/png' })));
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    for (const [message] of postMessage.mock.calls) {
      if (message.placeholderId) releasePendingImageSave(message.placeholderId);
    }
    editor.destroy();
    document.body.innerHTML = '';
    jest.restoreAllMocks();
  });

  it('does not rasterize even if SVG import is passed raster resize options', async () => {
    await insertImage(editor, svgFile(), { postMessage }, 'images', 'dropped', undefined, {
      width: 320,
      height: 140,
    });
    const saved = postMessage.mock.calls.find(([message]) => message.type === 'saveImage')?.[0];
    expect(saved).toBeDefined();
    expect(Buffer.from(saved.data).toString()).toBe(SVG);
    expect(saved).toMatchObject({ name: 'diagram.svg', mimeType: 'image/svg+xml' });
    expect(HTMLCanvasElement.prototype.getContext).not.toHaveBeenCalled();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it.each(['', 'application/octet-stream', 'text/plain'])(
    'accepts and normalizes a validated SVG with %j MIME',
    async type => {
      const file = svgFile('diagram.SVG', type);
      expect(getImageFiles(transfer([file]))).toEqual([file]);
      await insertImage(editor, file, { postMessage }, 'images', 'pasted');
      const saved = postMessage.mock.calls.find(([message]) => message.type === 'saveImage')?.[0];
      expect(saved).toMatchObject({ name: 'diagram.svg', mimeType: 'image/svg+xml' });
      expect(Buffer.from(saved.data).toString()).toBe(SVG);
      expect(
        editor
          .getJSON()
          .content?.some(
            node => node.type === 'image' && node.attrs?.src.startsWith('data:image/svg+xml;')
          )
      ).toBe(true);
    }
  );

  it.each([
    ['<html><svg xmlns="http://www.w3.org/2000/svg"/></html>', ''],
    ['<svg xmlns="http://www.w3.org/2000/svg"><path></svg>', 'application/octet-stream'],
    ['plain text', 'image/svg+xml'],
    ['<svg xmlns="urn:wrong"/>', ''],
    [
      '<!DOCTYPE svg [<!ENTITY label "example">]><svg xmlns="http://www.w3.org/2000/svg">&label;</svg>',
      'image/svg+xml',
    ],
    ['<svg xmlns="http://www.w3.org/2000/svg"/>', 'application/pdf'],
  ])(
    'rejects invalid or misleading SVG content %s with MIME %s without pending reservations',
    async (content, type) => {
      await insertImage(
        editor,
        svgFile('diagram.svg', type, content),
        { postMessage },
        'images',
        'dropped'
      );
      expect(postMessage.mock.calls.some(([message]) => message.type === 'saveImage')).toBe(false);
      expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'showError' }));
      expect(getPendingImageCount()).toBe(0);
      expect(editor.getJSON().content?.some(node => node.type === 'image')).toBe(false);
    }
  );

  it.each(['diagram#detail.svg', 'diagram?revision.SVG'])(
    'accepts a generic-MIME SVG with literal filename punctuation: %s',
    name => {
      const file = svgFile(name, '');
      expect(getImageFiles(transfer([file]))).toEqual([file]);
    }
  );

  it('rejects oversized SVG before XML decoding or allocating a preview', async () => {
    const file = svgFile();
    Object.defineProperty(file, 'size', { value: 64 * 1024 * 1024 + 1 });
    const readText = jest.spyOn(FileReader.prototype, 'readAsText');
    await insertImage(editor, file, { postMessage }, 'images', 'dropped');
    expect(readText).not.toHaveBeenCalled();
    expect(file.arrayBuffer).not.toHaveBeenCalled();
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'showError' }));
    expect(getPendingImageCount()).toBe(0);
  });

  it('releases the reservation and reports an SVG read failure', async () => {
    jest.spyOn(FileReader.prototype, 'readAsText').mockImplementation(function (this: FileReader) {
      this.dispatchEvent(new ProgressEvent('error'));
    });
    await insertImage(editor, svgFile(), { postMessage }, 'images', 'dropped');
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'showError' }));
    expect(getPendingImageCount()).toBe(0);
  });

  it('does not treat a trailing .png as SVG when the MIME is missing', async () => {
    await insertImage(editor, svgFile('diagram.svg.png', ''), { postMessage }, 'images', 'dropped');
    expect(postMessage.mock.calls.some(([message]) => message.type === 'saveImage')).toBe(false);
    expect(getPendingImageCount()).toBe(0);
  });

  it('abandons an SVG import if its webview editor is destroyed before bytes are ready', async () => {
    const file = new File([SVG], 'diagram.svg', { type: 'image/svg+xml' });
    let finishRead: (bytes: ArrayBuffer) => void = () => undefined;
    const arrayBuffer = jest.fn(
      () =>
        new Promise<ArrayBuffer>(resolve => {
          finishRead = resolve;
        })
    );
    Object.defineProperty(file, 'arrayBuffer', { value: arrayBuffer });
    const insertion = insertImage(editor, file, { postMessage }, 'images', 'dropped');
    for (let index = 0; index < 20 && arrayBuffer.mock.calls.length === 0; index++)
      await nextTask();
    expect(arrayBuffer).toHaveBeenCalledTimes(1);
    editor.destroy();
    finishRead(Uint8Array.from(Buffer.from(SVG)).buffer);
    await insertion;
    expect(postMessage).not.toHaveBeenCalled();
    expect(getPendingImageCount()).toBe(0);
  });

  it('assigns an SVG extension to SVG clipboard data without a filename extension', async () => {
    await insertImage(
      editor,
      svgFile('clipboard-image', 'image/svg+xml'),
      { postMessage },
      'images',
      'pasted'
    );
    const saved = postMessage.mock.calls.find(([message]) => message.type === 'saveImage')?.[0];
    expect(saved.name).toMatch(/\.svg$/);
    expect(saved.name).not.toMatch(/\d+x\d+px/);
  });

  it.each(['paste', 'drop'])(
    'accepts a generic-MIME SVG through the actual editor %s handler',
    async eventType => {
      setupImageDragDrop(editor, { postMessage }, 'svg-import-view');
      jest.spyOn(editor.view, 'posAtCoords').mockReturnValue({ pos: 1, inside: 0 });
      const event = new Event(eventType, { bubbles: true, cancelable: true });
      Object.defineProperty(event, eventType === 'paste' ? 'clipboardData' : 'dataTransfer', {
        value: transfer([svgFile('diagram.svg', '')]),
      });
      editor.view.dom.dispatchEvent(event);
      for (
        let index = 0;
        index < 20 && !postMessage.mock.calls.some(([message]) => message.type === 'saveImage');
        index++
      )
        await nextTask();
      expect(event.defaultPrevented).toBe(true);
      expect(postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'saveImage',
          mimeType: 'image/svg+xml',
          viewGeneration: 'svg-import-view',
        })
      );
    }
  );

  it.each(['file', 'path'])(
    'blocks a locked child paste before any %s side effect',
    async payload => {
      let locked = false;
      setupImageDragDrop(editor, { postMessage }, 'locked-view', () => locked);
      // Feedback installs its capture guard after the image listener.
      editor.view.dom.addEventListener(
        'paste',
        event => {
          event.preventDefault();
          event.stopImmediatePropagation();
        },
        true
      );
      locked = true;
      const event = new Event('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'clipboardData', {
        value:
          payload === 'file'
            ? transfer([svgFile()])
            : {
                ...transfer([]),
                getData: () => '/workspace/image.png',
              },
      });
      editor.view.dom.querySelector('p')!.dispatchEvent(event);
      await new Promise(resolve => setTimeout(resolve, 60));
      expect(postMessage).not.toHaveBeenCalled();
      expect(getPendingImageCount()).toBe(0);
    }
  );

  it('claims image paste before ProseMirror schedules its fallback focus callback', async () => {
    setupImageDragDrop(editor, { postMessage }, 'svg-import-view');
    const event = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', { value: transfer([svgFile()]) });
    const timers = jest.spyOn(window, 'setTimeout');
    editor.view.dom.dispatchEvent(event);
    // ProseMirror's capturePaste fallback schedules focus at 50ms. It must never
    // run for an image paste handled by us, even when this editor closes early.
    expect(timers.mock.calls.filter(([, delay]) => delay === 50)).toHaveLength(0);
    for (let i = 0; i < 20 && !postMessage.mock.calls.some(([m]) => m.type === 'saveImage'); i++)
      await nextTask();
    expect(postMessage.mock.calls.filter(([m]) => m.type === 'saveImage')).toHaveLength(1);
    // Let any broken fallback finish while the editor is alive in the RED run.
    await new Promise(resolve => setTimeout(resolve, 60));
  });

  it('leaves ordinary text paste to ProseMirror', () => {
    setupImageDragDrop(editor, { postMessage }, 'svg-import-view');
    const event = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', {
      value: {
        ...transfer([]),
        getData: (type: string) => (type === 'text/plain' ? 'Plain text' : ''),
      },
    });
    editor.view.dom.dispatchEvent(event);
    expect(editor.getText()).toContain('Plain text');
    expect(postMessage).not.toHaveBeenCalled();
  });

  it('validates and inserts a generic-MIME SVG selected by the file picker', async () => {
    const dialog = showImageInsertDialog(editor, {
      postMessage,
      viewGeneration: 'svg-picker-view',
    });
    const removeListener = jest.spyOn(document, 'removeEventListener');
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    expect(input.accept).toContain('.svg');
    Object.defineProperty(input, 'files', { value: [svgFile('diagram.svg', '')] });
    input.dispatchEvent(new Event('change'));
    for (
      let index = 0;
      index < 20 &&
      (document.querySelector('#insert-images') as HTMLElement).style.display === 'none';
      index++
    )
      await nextTask();
    (document.querySelector('#insert-images') as HTMLButtonElement).click();
    await dialog;
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'saveImage', mimeType: 'image/svg+xml' })
    );
    expect(removeListener).toHaveBeenCalledWith('keydown', expect.any(Function));
  });

  it('renders SVG filenames as text while selecting them', async () => {
    const dialog = showImageInsertDialog(editor, {
      postMessage,
      viewGeneration: 'svg-picker-view',
    });
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const filename = '<img src=x onerror=alert(1)>.svg';
    Object.defineProperty(input, 'files', { value: [svgFile(filename)] });
    input.dispatchEvent(new Event('change'));
    for (
      let index = 0;
      index < 20 && !(document.querySelector('#file-list') as HTMLElement).textContent;
      index++
    )
      await nextTask();
    expect(document.querySelector('#file-list')?.textContent).toContain(filename);
    expect(document.querySelector('#file-list img')).toBeNull();
    (document.querySelector('#cancel-insert') as HTMLButtonElement).click();
    await dialog;
  });
});
