/** @jest-environment jsdom */
import { showImageRenameDialog } from '../../webview/features/imageRenameDialog';

describe('image rename dialog uses file identity, not SVG URL suffixes', () => {
  afterEach(() => document.body.replaceChildren());

  it.each([
    ['images/diagram.svg#view.v2', 'diagram'],
    ['images/diagram.svg?revision=1.5#overview', 'diagram'],
    ['images/My%20Diagram%23v1.svg#detail', 'My Diagram#v1'],
  ])('shows the basename and SVG extension for %s', (source, basename) => {
    const img = document.createElement('img');
    img.setAttribute('data-markdown-src', source);
    const api = { postMessage: jest.fn() };
    showImageRenameDialog(img, api);
    expect(document.querySelector<HTMLInputElement>('.rename-input')?.value).toBe(basename);
    expect(document.querySelector('.rename-dialog')?.textContent).toContain('Extension: .svg');
    expect(document.querySelector('.rename-dialog')?.textContent).not.toContain('view.v2');
  });

  it('renders decoded filenames as text without interpreting HTML attributes or elements', () => {
    const img = document.createElement('img');
    img.setAttribute('data-markdown-src', 'images/%22%3E%3Cbutton%20data-injected%3E.svg#view');
    showImageRenameDialog(img, { postMessage: jest.fn() });
    expect(document.querySelector<HTMLInputElement>('.rename-input')?.value).toBe(
      '"><button data-injected>'
    );
    expect(document.querySelector('[data-injected]')).toBeNull();
  });

  it('sends the unchanged source reference to the host after editing the basename', () => {
    const img = document.createElement('img');
    const source = 'images/My%20Diagram%23v1.svg?revision=1.5#overview';
    img.setAttribute('data-markdown-src', source);
    const api = { postMessage: jest.fn() };
    showImageRenameDialog(img, api);
    document.querySelector<HTMLInputElement>('.rename-input')!.value = 'renamed';
    document.querySelector<HTMLButtonElement>('.rename-btn')!.click();
    expect(api.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ oldPath: source, newName: 'renamed' })
    );
  });
});
