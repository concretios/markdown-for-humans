/** @jest-environment jsdom */

/**
 * Copyright (c) 2025-2026 Concret.io
 *
 * Licensed under the MIT License. See LICENSE file in the project root for details.
 *
 * Localization of the image dialogs: resize, rename, insert, save confirmation,
 * large image, resize warning, outside-workspace, SVG display size, the image
 * menu and the hover metadata footer. Each group runs once in English (the
 * rendered text must not change) and once with a small translated bundle.
 */

import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from '@tiptap/markdown';
import * as l10n from '../../webview/l10n';
import { CustomImage } from '../../webview/extensions/customImage';
import { MarkdownParagraph } from '../../webview/extensions/markdownParagraph';
import { MAX_PENDING_IMAGE_SAVES } from '../../shared/pendingImageProtocol';
import {
  showImageResizeModal,
  hideImageResizeModal,
} from '../../webview/features/imageResizeModal';
import { showImageRenameDialog } from '../../webview/features/imageRenameDialog';
import { showImageInsertDialog } from '../../webview/features/imageInsertDialog';
import { confirmImageDrop } from '../../webview/features/imageConfirmation';
import { showHugeImageDialog } from '../../webview/features/hugeImageDialog';
import { showImageResizeWarning } from '../../webview/features/imageResizeWarning';
import { showLocalImageOutsideRepoDialog } from '../../webview/features/localImageOutsideRepoDialog';
import { showSvgDisplaySize } from '../../webview/features/svgDisplaySize';
import { createImageMenu, createImageMenuButton } from '../../webview/features/imageMenu';
import {
  createMetadataFooter,
  formatDate,
  formatFileSize,
  type ImageMetadata,
} from '../../webview/features/imageMetadata';
import {
  insertImage,
  releasePendingImageSave,
  tryReservePendingImageSave,
} from '../../webview/features/imageDragDrop';

const flush = () => new Promise(resolve => setTimeout(resolve, 0));
const text = (element: Element | null | undefined): string =>
  (element?.textContent ?? '').replace(/\s+/g, ' ').trim();

type ReferenceWindow = Window & {
  getImageReferences?: unknown;
  checkImageRename?: unknown;
  imagePathBase?: unknown;
  _workspaceCheckCallbacks?: unknown;
};
const referenceWindow = window as unknown as ReferenceWindow;

const references = (otherFiles: number) => ({
  currentFileCount: 3,
  otherFiles: Array.from({ length: otherFiles }, (_, index) => ({
    fsPath: `/docs/page${index}.md`,
    matches: [
      { line: 0, text: '' },
      { line: 4, text: '' },
    ],
  })),
});

afterEach(() => {
  l10n.resetL10n();
  document.body.replaceChildren();
  document.documentElement.lang = '';
  delete referenceWindow.getImageReferences;
  delete referenceWindow.checkImageRename;
  delete referenceWindow.imagePathBase;
});

describe('image resize modal localization', () => {
  const bundle = {
    'Resize Image': 'Bild skalieren',
    'Width (px)': 'Breite (px)',
    Reset: 'Zurücksetzen',
    Cancel: 'Abbrechen',
    Resize: 'Skalieren',
    'A backup of the original will be saved to {0}':
      'Eine Sicherung des Originals wird in {0} abgelegt',
    'Referenced in {0} other file': 'In {0} anderer Datei verwendet',
    'Referenced in {0} other files': 'In {0} anderen Dateien verwendet',
    'Also used {0} times in this file': 'Noch {0} Mal in dieser Datei verwendet',
    'Referenced in other files': 'In anderen Dateien verwendet',
    'Line {0} (+{1} more)': 'Zeile {0} (+{1} weitere)',
    Open: 'Öffnen',
    'Cannot resize external images. Please download the image to your workspace first, then you can resize it.':
      'Externe Bilder können nicht skaliert werden.',
    'Use Display size for SVG images. Raster resize would replace the vector file.':
      'Verwenden Sie für SVG-Bilder die Anzeigegröße.',
  };

  const open = async (otherFiles = 2) => {
    referenceWindow.getImageReferences = jest.fn().mockResolvedValue(references(otherFiles));
    const img = document.createElement('img');
    img.setAttribute('data-markdown-src', './images/foo.png');
    Object.defineProperty(img, 'naturalWidth', { value: 120 });
    Object.defineProperty(img, 'naturalHeight', { value: 80 });
    const postMessage = jest.fn((raw: unknown) => {
      const message = raw as { type: string; requestId?: string };
      if (message.type === 'checkImageInWorkspace') {
        const callbacks = referenceWindow._workspaceCheckCallbacks as Map<
          string,
          (result: { inWorkspace: boolean }) => void
        >;
        callbacks.get(message.requestId!)!({ inWorkspace: true });
      }
    });
    await showImageResizeModal(img, {} as Editor, { postMessage });
    await flush();
    return document.querySelector('.image-resize-modal-panel') as HTMLElement;
  };

  afterEach(() => {
    hideImageResizeModal();
    referenceWindow._workspaceCheckCallbacks = undefined;
  });

  it('shows English text and whole plural sentences by default', async () => {
    let panel = await open(2);
    expect(text(panel.querySelector('h3'))).toBe('Resize Image');
    expect(text(panel.querySelector('#resize-impact-other-files'))).toBe(
      'Referenced in 2 other files'
    );
    expect(text(panel.querySelector('#resize-impact-current-file'))).toBe(
      'Also used 3 times in this file'
    );
    expect(text(panel.querySelector('#resize-backup-note'))).toBe(
      'A backup of the original will be saved to .md4h/image-backups/'
    );
    hideImageResizeModal();

    panel = await open(1);
    expect(text(panel.querySelector('#resize-impact-other-files'))).toBe(
      'Referenced in 1 other file'
    );
    expect(panel.querySelector('#resize-references-pill')?.textContent).toBe('1');
  });

  it('shows the translated labels and the sentences around the count', async () => {
    l10n.configureL10n(bundle);
    const panel = await open(2);

    expect(text(panel.querySelector('h3'))).toBe('Bild skalieren');
    expect(text(panel.querySelector('label'))).toBe('Breite (px)');
    expect(text(panel.querySelector('#reset-resize'))).toBe('Zurücksetzen');
    expect(text(panel.querySelector('#cancel-resize'))).toBe('Abbrechen');
    expect(text(panel.querySelector('#confirm-resize'))).toBe('Skalieren');
    expect(text(panel.querySelector('#resize-backup-note'))).toBe(
      'Eine Sicherung des Originals wird in .md4h/image-backups/ abgelegt'
    );
    expect(text(panel.querySelector('#resize-impact-other-files'))).toBe(
      'In 2 anderen Dateien verwendet'
    );
    expect(text(panel.querySelector('#resize-impact-current-file'))).toBe(
      'Noch 3 Mal in dieser Datei verwendet'
    );
  });

  it('uses the singular sentence for one other file and keeps the count clickable', async () => {
    l10n.configureL10n(bundle);
    const panel = await open(1);
    const pill = panel.querySelector('#resize-references-pill') as HTMLButtonElement;

    expect(text(panel.querySelector('#resize-impact-other-files'))).toBe(
      'In 1 anderer Datei verwendet'
    );
    pill.click();
    const popover = panel.querySelector('#resize-references-popover') as HTMLElement;
    expect(pill.getAttribute('aria-expanded')).toBe('true');
    expect(text(popover.firstElementChild)).toContain('In anderen Dateien verwendet');
    expect(popover.textContent).toContain('Zeile 1 (+1 weitere)');
    expect(popover.textContent).toContain('Öffnen');
  });

  it('translates the errors posted to the host', async () => {
    l10n.configureL10n(bundle);
    const postMessage = jest.fn();
    const external = document.createElement('img');
    external.setAttribute('data-markdown-src', 'https://example.com/photo.png');
    await showImageResizeModal(external, {} as Editor, { postMessage });
    const svg = document.createElement('img');
    svg.setAttribute('data-markdown-src', './diagram.svg');
    await showImageResizeModal(svg, {} as Editor, { postMessage });

    expect(postMessage).toHaveBeenCalledWith({
      type: 'showError',
      message: 'Externe Bilder können nicht skaliert werden.',
    });
    expect(postMessage).toHaveBeenCalledWith({
      type: 'showError',
      message: 'Verwenden Sie für SVG-Bilder die Anzeigegröße.',
    });
  });
});

describe('image rename dialog localization', () => {
  const bundle = {
    'Rename Image': 'Bild umbenennen',
    'New filename (without extension)': 'Neuer Dateiname (ohne Endung)',
    'Extension: .{0}': 'Endung: .{0}',
    'Referenced in {0} other file': 'In {0} anderer Datei verwendet',
    'Referenced in {0} other files': 'In {0} anderen Dateien verwendet',
    'Also used {0} times in this file': 'Noch {0} Mal in dieser Datei verwendet',
    'A file named {0} already exists. Overwrite it?':
      'Eine Datei namens {0} existiert bereits. Überschreiben?',
    'Line {0} (+{1} more)': 'Zeile {0} (+{1} weitere)',
    Side: 'Daneben',
    'References unavailable': 'Verweise nicht verfügbar',
  };

  const open = async (otherFiles = 2) => {
    referenceWindow.getImageReferences = jest.fn().mockResolvedValue(references(otherFiles));
    const img = document.createElement('img');
    img.setAttribute('data-markdown-src', 'images/photo.png');
    showImageRenameDialog(img, { postMessage: jest.fn() });
    await flush();
    return document.querySelector('.rename-dialog') as HTMLElement;
  };

  it('shows English text and whole plural sentences by default', async () => {
    let dialog = await open(2);
    expect(text(dialog.querySelector('h3'))).toBe('Rename Image');
    expect(text(dialog.querySelector('.rename-extension'))).toBe('Extension: .png');
    expect(text(dialog.querySelector('#rename-impact-other-files'))).toBe(
      'Referenced in 2 other files'
    );
    expect(text(dialog.querySelector('#rename-impact-current-file'))).toBe(
      'Also used 3 times in this file'
    );
    document.body.replaceChildren();

    dialog = await open(1);
    expect(text(dialog.querySelector('#rename-impact-other-files'))).toBe(
      'Referenced in 1 other file'
    );
  });

  it('shows the translated heading, label, extension and reference sentences', async () => {
    l10n.configureL10n(bundle);
    const dialog = await open(2);

    expect(text(dialog.querySelector('h3'))).toBe('Bild umbenennen');
    expect(text(dialog.querySelector('label'))).toBe('Neuer Dateiname (ohne Endung)');
    expect(text(dialog.querySelector('.rename-extension'))).toBe('Endung: .png');
    expect(text(dialog.querySelector('#rename-impact-other-files'))).toBe(
      'In 2 anderen Dateien verwendet'
    );
    expect(text(dialog.querySelector('#rename-impact-current-file'))).toBe(
      'Noch 3 Mal in dieser Datei verwendet'
    );
  });

  it('uses the singular sentence and translates the popover rows', async () => {
    l10n.configureL10n(bundle);
    const dialog = await open(1);
    expect(text(dialog.querySelector('#rename-impact-other-files'))).toBe(
      'In 1 anderer Datei verwendet'
    );

    (dialog.querySelector('#rename-references-pill') as HTMLButtonElement).click();
    const popover = dialog.querySelector('#rename-references-popover') as HTMLElement;
    expect(popover.textContent).toContain('Zeile 1 (+1 weitere)');
    expect(popover.textContent).toContain('Daneben');
  });

  it('translates the name collision sentence around the file name', async () => {
    l10n.configureL10n(bundle);
    referenceWindow.checkImageRename = jest
      .fn()
      .mockResolvedValue({ exists: true, newFilename: 'taken.png' });
    const dialog = await open(0);

    (dialog.querySelector('.rename-input') as HTMLInputElement).value = 'taken';
    (dialog.querySelector('.rename-btn') as HTMLButtonElement).click();
    await flush();

    expect(text(dialog.querySelector('#rename-collision-filename'))).toBe('taken.png');
    expect(text(dialog.querySelector('#rename-collision div:nth-child(2)'))).toBe(
      'Eine Datei namens taken.png existiert bereits. Überschreiben?'
    );
  });

  it('translates the unavailable references notice', async () => {
    l10n.configureL10n(bundle);
    referenceWindow.getImageReferences = jest.fn().mockRejectedValue(new Error('offline'));
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const img = document.createElement('img');
    img.setAttribute('data-markdown-src', 'images/photo.png');
    showImageRenameDialog(img, { postMessage: jest.fn() });
    await flush();

    expect(text(document.querySelector('#rename-impact-loading'))).toBe('Verweise nicht verfügbar');
  });
});

describe('image insert dialog localization', () => {
  const bundle = {
    'Insert Image': 'Bild einfügen',
    'Insert Images ({0})': 'Bilder einfügen ({0})',
    'Drag & drop images here': 'Bilder hierher ziehen',
    'Selected: {0}': 'Ausgewählt: {0}',
    '{0} file': '{0} Datei',
    '{0} files': '{0} Dateien',
    '{0}. {1} ({2} KB)': '{0}. {1} ({2} KB)',
    'Copy & paste images ({0}+V)': 'Bilder einfügen ({0}+V)',
    'Please select image files only.': 'Bitte nur Bilddateien auswählen.',
  };

  const png = (name: string, size = 2048) =>
    new File([new Uint8Array(size)], name, { type: 'image/png' });

  const open = async (files: File[]) => {
    const editor = { state: { selection: { from: 1 } } } as unknown as Editor;
    void showImageInsertDialog(editor, { viewGeneration: 'view', postMessage: jest.fn() });
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    Object.defineProperty(fileInput, 'files', { value: files });
    fileInput.dispatchEvent(new Event('change'));
    await flush();
    return document.querySelector('.image-insert-dialog') as HTMLElement;
  };

  it('shows English text and whole phrases for one and several files', async () => {
    let dialog = await open([png('a.png')]);
    expect(text(dialog.querySelector('h3'))).toBe('📷 Insert Image');
    expect(text(dialog.querySelector('#drop-zone'))).toContain('📁 Drag & drop images here');
    expect(text(dialog.querySelector('#selected-files > div'))).toBe('Selected: 1 file');
    expect(text(dialog.querySelector('#file-list'))).toBe('1. a.png (2.0 KB)');
    expect(text(dialog.querySelector('#insert-images'))).toBe('Insert Image');
    expect(text(dialog)).toContain('• Copy & paste images (Ctrl+V)');
    (dialog.querySelector('#cancel-insert') as HTMLButtonElement).click();

    dialog = await open([png('a.png'), png('b.png')]);
    expect(text(dialog.querySelector('#selected-files > div'))).toBe('Selected: 2 files');
    expect(text(dialog.querySelector('#insert-images'))).toBe('Insert Images (2)');
    (dialog.querySelector('#cancel-insert') as HTMLButtonElement).click();
  });

  it('shows the translated heading, tip, file summary and insert button', async () => {
    l10n.configureL10n(bundle);
    const dialog = await open([png('a.png'), png('b.png')]);

    expect(text(dialog.querySelector('h3'))).toBe('📷 Bild einfügen');
    expect(text(dialog.querySelector('#drop-zone'))).toContain('Bilder hierher ziehen');
    expect(text(dialog.querySelector('#selected-files > div'))).toBe('Ausgewählt: 2 Dateien');
    expect(text(dialog.querySelector('#insert-images'))).toBe('Bilder einfügen (2)');
    expect(text(dialog)).toContain('• Bilder einfügen (Ctrl+V)');
    (dialog.querySelector('#cancel-insert') as HTMLButtonElement).click();
  });

  it('translates the alert for files that are not images', async () => {
    l10n.configureL10n(bundle);
    const alert = jest.spyOn(window, 'alert').mockImplementation(() => undefined);
    await open([new File(['x'], 'notes.txt', { type: 'text/plain' })]);

    expect(alert).toHaveBeenCalledWith('Bitte nur Bilddateien auswählen.');
    (document.querySelector('#cancel-insert') as HTMLButtonElement).click();
    alert.mockRestore();
  });
});

describe('image save confirmation localization', () => {
  const bundle = {
    'Save {0} Image': 'Speichere {0} Bild',
    'Save {0} Images': 'Speichere {0} Bilder',
    'Save to folder:': 'In Ordner speichern:',
    'Relative to workspace folder': 'Relativ zum Arbeitsbereichsordner',
    'Relative to current markdown file': 'Relativ zur aktuellen Markdown-Datei',
    'e.g., images, assets/img, docs/screenshots': 'z. B. images, assets/img, docs/screenshots',
    'Remember for this session': 'Für diese Sitzung merken',
    'Save Images': 'Bilder speichern',
  };

  const open = async (count: number) => {
    const result = confirmImageDrop(count, 'images');
    const dialog = document.querySelector('.image-drop-dialog') as HTMLElement;
    const close = async () => {
      (document.querySelector('#cancel-btn') as HTMLButtonElement).click();
      await result;
    };
    return { dialog, close };
  };

  it('shows English text and the plural title by default', async () => {
    let { dialog, close } = await open(1);
    expect(text(dialog.querySelector('h3'))).toBe('📸 Save 1 Image');
    expect(text(dialog.querySelector('small'))).toBe('Relative to current markdown file');
    expect(dialog.querySelector('input')?.getAttribute('placeholder')).toBe(
      'e.g., images, assets/img, docs/screenshots'
    );
    await close();

    ({ dialog, close } = await open(3));
    expect(text(dialog.querySelector('h3'))).toBe('📸 Save 3 Images');
    expect(text(dialog.querySelector('#save-btn'))).toBe('Save Images');
    await close();
  });

  it('shows the translated title, labels and placeholder', async () => {
    l10n.configureL10n(bundle);
    referenceWindow.imagePathBase = 'workspaceFolder';
    let { dialog, close } = await open(3);

    expect(text(dialog.querySelector('h3'))).toBe('📸 Speichere 3 Bilder');
    expect(text(dialog.querySelector('label'))).toBe('In Ordner speichern:');
    expect(text(dialog.querySelector('small'))).toBe('Relativ zum Arbeitsbereichsordner');
    expect(dialog.querySelector('input')?.getAttribute('placeholder')).toBe(
      'z. B. images, assets/img, docs/screenshots'
    );
    expect(text(dialog.querySelector('#save-btn'))).toBe('Bilder speichern');
    await close();

    ({ dialog, close } = await open(1));
    expect(text(dialog.querySelector('h3'))).toBe('📸 Speichere 1 Bild');
    await close();
  });
});

describe('large image dialog localization', () => {
  const bundle = {
    'Large Image Detected': 'Großes Bild erkannt',
    'This image is very large:': 'Dieses Bild ist sehr groß:',
    '{0} × {1}px ({2})': '{0} × {1} px ({2})',
    '{0} MB': '{0} Megabyte',
    'Suggested size: {0} × {1}px': 'Vorgeschlagene Größe: {0} × {1} px',
    'Resize to Suggested': 'Auf Vorschlag skalieren',
    'Use Original': 'Original verwenden',
  };
  const originalImage = global.Image;
  const originalCreateObjectURL = URL.createObjectURL;
  const originalRevokeObjectURL = URL.revokeObjectURL;

  beforeEach(() => {
    class MockImage {
      width = 4000;
      height = 3000;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(_value: string) {
        this.onload?.();
      }
    }
    (global as typeof globalThis & { Image: typeof Image }).Image = MockImage as typeof Image;
    URL.createObjectURL = jest.fn(() => 'blob://mock');
    URL.revokeObjectURL = jest.fn();
  });

  afterEach(() => {
    global.Image = originalImage;
    URL.createObjectURL = originalCreateObjectURL;
    URL.revokeObjectURL = originalRevokeObjectURL;
  });

  const open = async () => {
    const file = new File([new Uint8Array(3 * 1024 * 1024)], 'big.png', { type: 'image/png' });
    const result = showHugeImageDialog(file);
    await flush();
    const dialog = document.querySelector('.huge-image-dialog') as HTMLElement;
    return { dialog, result };
  };

  it('shows English text by default', async () => {
    const { dialog, result } = await open();
    expect(text(dialog.querySelector('h3'))).toBe('Large Image Detected');
    expect(text(dialog.querySelectorAll('p')[1])).toBe('4000 × 3000px (3.0 MB)');
    expect(text(dialog.querySelectorAll('p')[2])).toBe('Suggested size: 1120 × 840px');
    (dialog.querySelector('#use-original-btn') as HTMLButtonElement).click();
    await result;
  });

  it('shows the translated text, sizes and buttons', async () => {
    l10n.configureL10n(bundle);
    const { dialog, result } = await open();

    expect(text(dialog.querySelector('h3'))).toBe('Großes Bild erkannt');
    expect(text(dialog.querySelectorAll('p')[0])).toBe('Dieses Bild ist sehr groß:');
    expect(text(dialog.querySelectorAll('p')[1])).toBe('4000 × 3000 px (3.0 Megabyte)');
    expect(text(dialog.querySelectorAll('p')[2])).toBe('Vorgeschlagene Größe: 1120 × 840 px');
    expect(text(dialog.querySelector('#resize-suggested-btn'))).toBe('Auf Vorschlag skalieren');
    expect(text(dialog.querySelector('#use-original-btn'))).toBe('Original verwenden');
    (dialog.querySelector('#use-original-btn') as HTMLButtonElement).click();
    await result;
  });
});

describe('image resize warning localization', () => {
  const bundle = {
    'Resize Image': 'Bild skalieren',
    'Markdown Editor for Humans will reduce the resolution of this image to fit the size. This action cannot be undone, but a backup will be created.':
      'Die Auflösung dieses Bildes wird verringert.',
    'Never ask again': 'Nie wieder fragen',
    Cancel: 'Abbrechen',
    Resize: 'Skalieren',
  };

  it('shows English text by default', async () => {
    const result = showImageResizeWarning();
    const dialog = document.querySelector('.image-resize-warning-dialog') as HTMLElement;
    expect(text(dialog.querySelector('h3'))).toBe('⚠️ Resize Image');
    expect(text(dialog.querySelector('label'))).toBe('Never ask again');
    expect(text(dialog.querySelector('#resize-btn'))).toBe('Resize');
    (dialog.querySelector('#cancel-btn') as HTMLButtonElement).click();
    await result;
  });

  it('shows the translated heading, explanation and buttons', async () => {
    l10n.configureL10n(bundle);
    const result = showImageResizeWarning();
    const dialog = document.querySelector('.image-resize-warning-dialog') as HTMLElement;

    expect(text(dialog.querySelector('h3'))).toBe('⚠️ Bild skalieren');
    expect(text(dialog.querySelector('p'))).toBe('Die Auflösung dieses Bildes wird verringert.');
    expect(text(dialog.querySelector('label'))).toBe('Nie wieder fragen');
    expect(text(dialog.querySelector('#cancel-btn'))).toBe('Abbrechen');
    expect(text(dialog.querySelector('#resize-btn'))).toBe('Skalieren');
    (dialog.querySelector('#cancel-btn') as HTMLButtonElement).click();
    await result;
  });
});

describe('image outside workspace dialog localization', () => {
  const bundle = {
    'Image Outside Workspace': 'Bild außerhalb des Arbeitsbereichs',
    'Image Path:': 'Bildpfad:',
    'Edit in Place': 'Am Ort bearbeiten',
    'Copy to Workspace & Edit': 'In Arbeitsbereich kopieren und bearbeiten',
    'e.g., images, assets/img': 'z. B. images, assets/img',
    'Relative to current markdown file': 'Relativ zur aktuellen Markdown-Datei',
    Continue: 'Weiter',
  };

  it('shows English text by default', async () => {
    const result = showLocalImageOutsideRepoDialog('/outside/photo.png', 'images');
    const dialog = document.querySelector('.local-image-outside-repo-dialog') as HTMLElement;
    expect(text(dialog.querySelector('h3'))).toBe('Image Outside Workspace');
    expect(text(dialog.querySelector('#local-image-path'))).toBe('/outside/photo.png');
    expect(text(dialog.querySelector('#confirm-local-image'))).toBe('Continue');
    (dialog.querySelector('#cancel-local-image') as HTMLButtonElement).click();
    await result;
  });

  it('shows the translated text, placeholder and keeps the path untouched', async () => {
    l10n.configureL10n(bundle);
    const result = showLocalImageOutsideRepoDialog('/outside/photo.png', 'images');
    const dialog = document.querySelector('.local-image-outside-repo-dialog') as HTMLElement;

    expect(text(dialog.querySelector('h3'))).toBe('Bild außerhalb des Arbeitsbereichs');
    expect(text(dialog)).toContain('Bildpfad:');
    expect(text(dialog)).toContain('Am Ort bearbeiten');
    expect(text(dialog)).toContain('In Arbeitsbereich kopieren und bearbeiten');
    expect(dialog.querySelector('#copy-image-folder-input')?.getAttribute('placeholder')).toBe(
      'z. B. images, assets/img'
    );
    expect(text(dialog.querySelector('#local-image-path'))).toBe('/outside/photo.png');
    expect(text(dialog.querySelector('#confirm-local-image'))).toBe('Weiter');
    (dialog.querySelector('#cancel-local-image') as HTMLButtonElement).click();
    await result;
  });
});

describe('SVG display size localization', () => {
  const bundle = {
    'SVG display size': 'SVG-Anzeigegröße',
    'Display size': 'Anzeigegröße',
    'Change this image in the document. The SVG file stays unchanged.':
      'Ändert dieses Bild im Dokument. Die SVG-Datei bleibt unverändert.',
    'Width (px)': 'Breite (px)',
    'Reset size': 'Größe zurücksetzen',
    Cancel: 'Abbrechen',
    Apply: 'Übernehmen',
    'Enter a whole-number width between 1 and 10000 pixels.':
      'Geben Sie eine ganze Zahl zwischen 1 und 10000 ein.',
  };
  let editor: Editor;

  beforeEach(() => {
    editor = new Editor({
      extensions: [
        StarterKit.configure({ paragraph: false }),
        MarkdownParagraph,
        Markdown,
        CustomImage,
      ],
      content: '',
      contentType: 'markdown',
    });
    editor.commands.setContent('![Diagram](diagram.svg)', { contentType: 'markdown' });
    document.body.appendChild(editor.view.dom);
  });

  afterEach(() => editor.destroy());

  const open = () => {
    let pos = 0;
    editor.state.doc.descendants((node, position) => {
      if (node.type.name === 'image') pos = position;
    });
    showSvgDisplaySize(editor.view.dom.querySelector('img')!, editor, () => pos);
    return document.querySelector('.svg-display-size') as HTMLFormElement;
  };

  it('shows English text by default', () => {
    const form = open();
    expect(form.getAttribute('aria-label')).toBe('SVG display size');
    expect(text(form.querySelector('h2'))).toBe('Display size');
    expect(text(form.querySelector('label'))).toBe('Width (px)');
    expect(text(form.querySelector('button[type="submit"]'))).toBe('Apply');
  });

  it('shows the translated dialog and validation message', () => {
    l10n.configureL10n(bundle);
    const form = open();

    expect(form.getAttribute('aria-label')).toBe('SVG-Anzeigegröße');
    expect(text(form.querySelector('h2'))).toBe('Anzeigegröße');
    expect(text(form.querySelector('p'))).toBe(
      'Ändert dieses Bild im Dokument. Die SVG-Datei bleibt unverändert.'
    );
    expect(text(form.querySelector('label'))).toBe('Breite (px)');
    expect(text(form.querySelector('[data-action="reset-size"]'))).toBe('Größe zurücksetzen');
    expect(text(form.querySelector('button[type="submit"]'))).toBe('Übernehmen');

    (form.querySelector('input') as HTMLInputElement).value = '0';
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    expect(text(form.querySelector('[role="alert"]'))).toBe(
      'Geben Sie eine ganze Zahl zwischen 1 und 10000 ein.'
    );
  });
});

describe('image menu localization', () => {
  const bundle = {
    'Image options': 'Bildoptionen',
    'Display size': 'Anzeigegröße',
    Resize: 'Skalieren',
    Rename: 'Umbenennen',
    'Open In Finder/Explorer': 'Im Finder/Explorer öffnen',
    'Show In Workspace': 'Im Arbeitsbereich anzeigen',
  };
  const labels = (menu: HTMLElement) =>
    Array.from(menu.querySelectorAll('.menu-label')).map(label => label.textContent);

  it('shows English labels by default', () => {
    expect(createImageMenuButton().getAttribute('aria-label')).toBe('Image options');
    expect(labels(createImageMenu(true, false))).toEqual([
      'Resize',
      'Rename',
      'Open In Finder/Explorer',
      'Show In Workspace',
    ]);
  });

  it('shows translated labels for raster and SVG images', () => {
    l10n.configureL10n(bundle);

    expect(createImageMenuButton().getAttribute('aria-label')).toBe('Bildoptionen');
    expect(labels(createImageMenu(true, false))).toEqual([
      'Skalieren',
      'Umbenennen',
      'Im Finder/Explorer öffnen',
      'Im Arbeitsbereich anzeigen',
    ]);
    expect(labels(createImageMenu(false, true))).toEqual(['Anzeigegröße', 'Umbenennen']);
  });
});

describe('image metadata localization', () => {
  const metadata = (lastModified: number): ImageMetadata => ({
    filename: 'photo.png',
    size: 1536,
    dimensions: { width: 800, height: 600 },
    lastModified,
    path: './photo.png',
  });
  const DAY = 24 * 60 * 60 * 1000;
  const largeImage = () => {
    const image = document.createElement('img');
    image.width = 800;
    return image;
  };
  const bundle = {
    'Loading metadata...': 'Metadaten werden geladen...',
    'Vector · {0}×{1} display px': 'Vektor · {0}×{1} Anzeigepixel',
    'Modified: {0}': 'Geändert: {0}',
    '{0} KB': '{0} Kilobyte',
    Today: 'Heute',
    Yesterday: 'Gestern',
    '{0} days ago': 'vor {0} Tagen',
  };

  it('shows English text and keeps the English date format', () => {
    document.documentElement.lang = 'en';
    expect(text(createMetadataFooter(largeImage(), null))).toBe('Loading metadata...');
    expect(formatFileSize(1536)).toBe('1.5 KB');
    expect(formatDate(Date.now())).toBe('Today');
    expect(formatDate(Date.now() - 1.5 * DAY)).toBe('Yesterday');
    expect(formatDate(Date.now() - 3.5 * DAY)).toBe('3 days ago');
    expect(formatDate(new Date(2020, 0, 5, 12).getTime())).toBe('Jan 5, 2020');
    const footer = createMetadataFooter(largeImage(), metadata(Date.now()));
    expect(text(footer.querySelector('.metadata-date'))).toBe('Modified: Today');
    expect(text(footer.querySelector('.metadata-size'))).toBe('1.5 KB');
  });

  it('shows translated words, units and the footer sentences', () => {
    l10n.configureL10n(bundle);
    document.documentElement.lang = 'en';

    expect(text(createMetadataFooter(largeImage(), null))).toBe('Metadaten werden geladen...');
    expect(formatFileSize(1536)).toBe('1.5 Kilobyte');
    expect(formatDate(Date.now())).toBe('Heute');
    expect(formatDate(Date.now() - 1.5 * DAY)).toBe('Gestern');
    expect(formatDate(Date.now() - 3.5 * DAY)).toBe('vor 3 Tagen');
    const footer = createMetadataFooter(largeImage(), metadata(Date.now()));
    expect(text(footer.querySelector('.metadata-date'))).toBe('Geändert: Heute');
    expect(text(footer.querySelector('.metadata-size'))).toBe('1.5 Kilobyte');
  });

  it('translates the vector dimensions', () => {
    l10n.configureL10n(bundle);
    const image = document.createElement('img');
    image.setAttribute('data-markdown-src', './diagram.svg');
    image.width = 480;
    image.height = 210;

    const footer = createMetadataFooter(image, metadata(Date.now()));
    expect(text(footer.querySelector('.metadata-dimensions'))).toBe(
      'Vektor · 480×210 Anzeigepixel'
    );
  });

  it('formats older dates in the document language', () => {
    const older = new Date(2020, 0, 5, 12).getTime();
    document.documentElement.lang = 'de';
    expect(formatDate(older)).toBe('5. Jan. 2020');
    document.documentElement.lang = 'fr';
    expect(formatDate(older)).toBe('5 janv. 2020');
  });
});

describe('image import error localization', () => {
  const bundle = {
    'Cannot insert "{0}". Select a supported image or a valid SVG no larger than 64 MiB.':
      '"{0}" kann nicht eingefügt werden.',
    'Up to {0} images can be saved at once. Wait for current image saves to finish, then try again.':
      'Es können höchstens {0} Bilder gleichzeitig gespeichert werden.',
  };

  it('translates the rejected file message with the file name', async () => {
    l10n.configureL10n(bundle);
    const postMessage = jest.fn();
    const broken = new File(['not an svg'], 'broken.svg', { type: 'image/svg+xml' });

    await insertImage({} as Editor, broken, { postMessage }, 'images', 'dropped');

    expect(postMessage).toHaveBeenCalledWith({
      type: 'showError',
      message: '"broken.svg" kann nicht eingefügt werden.',
    });
  });

  it('keeps the English rejected file message by default', async () => {
    const postMessage = jest.fn();
    const broken = new File(['not an svg'], 'broken.svg', { type: 'image/svg+xml' });

    await insertImage({} as Editor, broken, { postMessage }, 'images', 'dropped');

    expect(postMessage).toHaveBeenCalledWith({
      type: 'showError',
      message:
        'Cannot insert "broken.svg". Select a supported image or a valid SVG no larger than 64 MiB.',
    });
  });

  it('translates the capacity message with the limit', async () => {
    l10n.configureL10n(bundle);
    const reserved: string[] = [];
    for (let index = 0; index < MAX_PENDING_IMAGE_SAVES; index++) {
      const id = `l10n-capacity-${index}`;
      expect(tryReservePendingImageSave(id)).toBe(true);
      reserved.push(id);
    }
    const postMessage = jest.fn();
    const file = new File([new Uint8Array([1])], 'image.png', { type: 'image/png' });

    await insertImage({} as Editor, file, { postMessage }, 'images', 'dropped');
    reserved.forEach(releasePendingImageSave);

    expect(postMessage).toHaveBeenCalledWith({
      type: 'showError',
      message: `Es können höchstens ${MAX_PENDING_IMAGE_SAVES} Bilder gleichzeitig gespeichert werden.`,
    });
  });
});
