/** @jest-environment jsdom */

/**
 * The image drop dialog prefills its folder from `markdownForHumans.imagePath`,
 * which a cloned repository's workspace settings control. It must stay text.
 */

import { confirmImageDrop } from '../../webview/features/imageConfirmation';

describe('confirmImageDrop folder prefill', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('prefills a workspace-configured folder as a value, not markup', async () => {
    const folder = 'images"><img src=https://x/y data-injected="1';

    const resultPromise = confirmImageDrop(1, folder);

    const dialog = document.querySelector('.image-drop-dialog') as HTMLElement;
    expect(dialog.querySelector('img')).toBeNull();
    expect(dialog.querySelector('[data-injected]')).toBeNull();
    const folderInput = document.querySelector('#image-folder-input') as HTMLInputElement;
    expect(folderInput.value).toBe(folder);

    (document.querySelector('#cancel-btn') as HTMLButtonElement).click();
    await expect(resultPromise).resolves.toBeNull();
  });
});
