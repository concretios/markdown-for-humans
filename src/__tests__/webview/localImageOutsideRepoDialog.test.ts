/** @jest-environment jsdom */

import { showLocalImageOutsideRepoDialog } from '../../webview/features/localImageOutsideRepoDialog';
import { getRememberedFolder, setRememberedFolder } from '../../webview/features/imageConfirmation';

jest.mock('../../webview/features/imageConfirmation', () => ({
  getRememberedFolder: jest.fn(),
  setRememberedFolder: jest.fn(),
}));

describe('localImageOutsideRepoDialog', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    (getRememberedFolder as jest.Mock).mockReset();
    (setRememberedFolder as jest.Mock).mockReset();
  });

  it('prefills folder using remembered preference and returns edit-in-place by default', async () => {
    (getRememberedFolder as jest.Mock).mockReturnValue('assets');

    const resultPromise = showLocalImageOutsideRepoDialog('/outside/path/image.png');

    const folderInput = document.querySelector('#copy-image-folder-input') as HTMLInputElement;
    expect(folderInput.value).toBe('assets');

    // Default selection is edit-in-place; confirm to resolve
    const confirmButton = document.querySelector('#confirm-local-image') as HTMLButtonElement;
    confirmButton.click();

    await expect(resultPromise).resolves.toEqual({
      action: 'edit-in-place',
      targetFolder: undefined,
    });
    expect(setRememberedFolder).not.toHaveBeenCalled();
  });

  it('stores folder preference when user selects copy-to-repo and remembers choice', async () => {
    (getRememberedFolder as jest.Mock).mockReturnValue(null);

    const resultPromise = showLocalImageOutsideRepoDialog('/outside/path/image.png', 'images');

    const copyRadio = document.querySelector('input[value="copy-to-repo"]') as HTMLInputElement;
    const rememberCheckbox = document.querySelector('#remember-local-choice') as HTMLInputElement;
    const folderInput = document.querySelector('#copy-image-folder-input') as HTMLInputElement;
    const confirmButton = document.querySelector('#confirm-local-image') as HTMLButtonElement;

    copyRadio.checked = true;
    copyRadio.dispatchEvent(new Event('change'));
    folderInput.value = 'assets/img';
    rememberCheckbox.checked = true;

    confirmButton.click();

    await expect(resultPromise).resolves.toEqual({
      action: 'copy-to-repo',
      targetFolder: 'assets/img',
    });
    expect(setRememberedFolder).toHaveBeenCalledWith('assets/img');
  });

  it('shows host path and folder text literally, without markup or attribute injection', async () => {
    (getRememberedFolder as jest.Mock).mockReturnValue(null);
    const imagePath = '/outside/<img src=https:evil.example>.png';
    const folder = 'images" data-injected="1';

    const resultPromise = showLocalImageOutsideRepoDialog(imagePath, folder);

    const dialog = document.querySelector('.local-image-outside-repo-dialog') as HTMLElement;
    expect(dialog.querySelector('img')).toBeNull();
    expect(dialog.querySelector('[data-injected]')).toBeNull();
    expect(dialog.textContent).toContain(imagePath);
    const folderInput = document.querySelector('#copy-image-folder-input') as HTMLInputElement;
    expect(folderInput.value).toBe(folder);

    (document.querySelector('#cancel-local-image') as HTMLButtonElement).click();
    await expect(resultPromise).resolves.toBeNull();
  });
});
