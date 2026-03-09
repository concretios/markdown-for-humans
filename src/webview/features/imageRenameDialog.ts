/**
 * Copyright (c) 2025-2026 Concret.io
 *
 * Licensed under the MIT License. See LICENSE file in the project root for details.
 */

/**
 * Image Rename Dialog
 *
 * Provides a simple input dialog for renaming images.
 * The actual rename operation is handled by the extension.
 */

interface VsCodeApi {
  postMessage(message: unknown): void;
}

type ReferenceRow = { fsPath: string; matches: Array<{ line: number; text: string }> };
type ReferencePayload = {
  currentFileCount: number;
  otherFiles: ReferenceRow[];
  error?: string;
};

/**
 * Extract filename without extension from a path
 */
function getFilenameWithoutExt(path: string): string {
  const filename = path.split('/').pop() || path;
  return filename.replace(/\.[^.]+$/, '');
}

/**
 * Get the file extension from a path
 */
function getExtension(path: string): string {
  const match = path.match(/\.([^.]+)$/);
  return match ? match[1] : '';
}

/**
 * Show the image rename dialog
 * Returns the new name (without extension) or null if cancelled
 */
export function showImageRenameDialog(img: HTMLImageElement, vscodeApi: VsCodeApi): void {
  // Get the current image path from data-markdown-src or src
  const imagePath = img.getAttribute('data-markdown-src') || img.getAttribute('src') || img.src;

  // Don't allow renaming external images
  if (
    imagePath.startsWith('http://') ||
    imagePath.startsWith('https://') ||
    imagePath.startsWith('data:')
  ) {
    console.warn('[MD4H] Cannot rename external images');
    return;
  }

  const currentName = getFilenameWithoutExt(imagePath);
  const extension = getExtension(imagePath);

  // Create overlay
  const overlay = document.createElement('div');
  overlay.className = 'rename-dialog-overlay';
  overlay.setAttribute('contenteditable', 'false');
  overlay.style.cssText = `
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(0, 0, 0, 0.5);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 10000;
  `;

  // Create dialog
  const dialog = document.createElement('div');
  dialog.className = 'rename-dialog';
  dialog.setAttribute('contenteditable', 'false');
  dialog.style.cssText = `
    background: var(--vscode-editor-background, var(--md-background));
    border: 1px solid var(--vscode-panel-border, var(--md-border));
    border-radius: 8px;
    padding: 20px;
    min-width: 400px;
    max-width: 500px;
    position: relative;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
  `;

  dialog.innerHTML = `
    <h3 style="margin: 0 0 16px 0; font-size: 16px; color: var(--vscode-foreground);">
      Rename Image
    </h3>

    <div id="rename-impact" style="
      margin: -6px 0 14px 0;
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
      line-height: 1.4;
    ">
      <div id="rename-impact-loading">Checking references…</div>
      <div id="rename-impact-content" style="display: none;">
        <div id="rename-impact-other-files" style="display: none;">
          Referenced in
          <button
            id="rename-references-pill"
            type="button"
            aria-expanded="false"
            style="
              display: inline-flex;
              align-items: center;
              justify-content: center;
              min-width: 26px;
              padding: 0 8px;
              height: 18px;
              margin: 0 4px;
              border-radius: 999px;
              border: 1px solid var(--vscode-button-background);
              background: transparent;
              color: var(--vscode-foreground);
              cursor: pointer;
              font-size: 11px;
              line-height: 1;
            "
          >0</button>
          other file<span id="rename-references-plural">s</span>
        </div>
        <div id="rename-impact-current-file" style="display: none;">
          Also used <span id="rename-current-count">0</span> times in this file
        </div>
      </div>
    </div>

    <div
      id="rename-references-popover"
      style="
        display: none;
        position: absolute;
        z-index: 300;
        min-width: 340px;
        max-width: 460px;
        max-height: 240px;
        overflow: auto;
        background: var(--vscode-editor-background);
        border: 1px solid var(--vscode-panel-border);
        border-radius: 8px;
        box-shadow: 0 10px 32px rgba(0, 0, 0, 0.35);
        padding: 10px;
      "
    ></div>

    <div style="margin-bottom: 16px;">
      <label style="display: block; margin-bottom: 8px; font-size: 13px; color: var(--vscode-descriptionForeground);">
        New filename (without extension)
      </label>
      <input type="text" class="rename-input" value="${currentName}" style="
        width: 100%;
        padding: 8px 12px;
        font-size: 14px;
        background: var(--vscode-input-background);
        color: var(--vscode-input-foreground);
        border: 1px solid var(--vscode-input-border);
        border-radius: 4px;
        outline: none;
        box-sizing: border-box;
      "/>
      <div style="margin-top: 4px; font-size: 12px; color: var(--vscode-descriptionForeground);">
        Extension: .${extension}
      </div>
    </div>

    <div id="rename-collision" style="
      display: none;
      margin: -6px 0 14px 0;
      padding: 10px 12px;
      border-radius: 6px;
      border: 1px solid var(--vscode-inputValidation-warningBorder);
      background: var(--vscode-inputValidation-warningBackground, transparent);
      color: var(--vscode-foreground);
      font-size: 12px;
      line-height: 1.4;
    ">
      <div style="font-weight: 600; margin-bottom: 6px;">Name collision</div>
      <div>
        A file named <code id="rename-collision-filename"></code> already exists.
        Overwrite it?
      </div>
      <div style="display: flex; gap: 8px; justify-content: flex-end; margin-top: 10px;">
        <button id="rename-collision-cancel" type="button" style="
          padding: 6px 10px;
          font-size: 12px;
          background: transparent;
          color: var(--vscode-foreground);
          border: 1px solid var(--vscode-panel-border);
          border-radius: 4px;
          cursor: pointer;
        ">Cancel</button>
        <button id="rename-collision-overwrite" type="button" style="
          padding: 6px 10px;
          font-size: 12px;
          background: var(--vscode-button-background);
          color: var(--vscode-button-foreground);
          border: none;
          border-radius: 4px;
          cursor: pointer;
        ">Overwrite</button>
      </div>
    </div>

    <div style="display: flex; gap: 8px; justify-content: flex-end;">
      <button type="button" class="cancel-btn" style="
        padding: 8px 16px;
        font-size: 13px;
        background: transparent;
        color: var(--vscode-foreground, var(--md-foreground));
        border: 1px solid var(--vscode-panel-border, var(--md-border));
        border-radius: 4px;
        cursor: pointer;
      ">Cancel</button>
      <button type="button" class="rename-btn" style="
        padding: 8px 16px;
        font-size: 13px;
        background: var(--vscode-button-background);
        color: var(--vscode-button-foreground);
        border: none;
        border-radius: 4px;
        cursor: pointer;
      ">Rename</button>
    </div>
  `;

  overlay.appendChild(dialog);
  // Mount outside ProseMirror contentEditable to avoid key/click events leaking into editor.
  document.body.appendChild(overlay);

  const input = dialog.querySelector('.rename-input') as HTMLInputElement;
  const cancelBtn = dialog.querySelector('.cancel-btn') as HTMLButtonElement;
  const renameBtn = dialog.querySelector('.rename-btn') as HTMLButtonElement;
  const impactRoot = dialog.querySelector('#rename-impact') as HTMLElement;
  const impactLoading = dialog.querySelector('#rename-impact-loading') as HTMLElement;
  const impactContent = dialog.querySelector('#rename-impact-content') as HTMLElement;
  const impactOtherFilesRow = dialog.querySelector('#rename-impact-other-files') as HTMLElement;
  const referencesPill = dialog.querySelector('#rename-references-pill') as HTMLButtonElement;
  const referencesPlural = dialog.querySelector('#rename-references-plural') as HTMLElement;
  const impactCurrentFileRow = dialog.querySelector('#rename-impact-current-file') as HTMLElement;
  const currentCount = dialog.querySelector('#rename-current-count') as HTMLElement;
  const referencesPopover = dialog.querySelector('#rename-references-popover') as HTMLElement;
  const collisionBox = dialog.querySelector('#rename-collision') as HTMLElement;
  const collisionFilename = dialog.querySelector('#rename-collision-filename') as HTMLElement;
  const collisionCancel = dialog.querySelector('#rename-collision-cancel') as HTMLButtonElement;
  const collisionOverwrite = dialog.querySelector(
    '#rename-collision-overwrite'
  ) as HTMLButtonElement;

  // Focus and select input
  input.focus();
  input.select();

  // Prevent events inside dialog from bubbling to ProseMirror/editor handlers.
  const stopEventLeak = (event: Event) => {
    event.stopPropagation();
  };

  for (const eventName of ['click', 'mousedown', 'mouseup', 'keydown', 'keypress', 'keyup']) {
    dialog.addEventListener(eventName, stopEventLeak);
  }

  for (const eventName of ['beforeinput', 'input', 'paste']) {
    input.addEventListener(eventName, stopEventLeak);
  }

  const closeDialog = () => {
    if (overlay.parentElement) {
      overlay.parentElement.removeChild(overlay);
    }
  };

  let referencePayload: ReferencePayload | null = null;
  let isReferencesPopoverOpen = false;
  let pendingOverwriteName: string | null = null;

  const closeReferencesPopover = () => {
    referencesPopover.style.display = 'none';
    referencesPill.setAttribute('aria-expanded', 'false');
    isReferencesPopoverOpen = false;
  };

  const renderReferencesPopover = (payload: ReferencePayload) => {
    referencesPopover.replaceChildren();

    const header = document.createElement('div');
    header.style.cssText = `
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 8px;
      gap: 8px;
    `;

    const title = document.createElement('div');
    title.textContent = 'Referenced in other files';
    title.style.cssText = `
      font-size: 12px;
      font-weight: 600;
      color: var(--vscode-foreground);
    `;

    const close = document.createElement('button');
    close.type = 'button';
    close.textContent = '×';
    close.style.cssText = `
      background: transparent;
      border: none;
      color: var(--vscode-foreground);
      cursor: pointer;
      padding: 2px 6px;
      font-size: 16px;
      line-height: 1;
      opacity: 0.7;
    `;
    close.addEventListener('click', e => {
      e.preventDefault();
      e.stopPropagation();
      closeReferencesPopover();
    });

    header.appendChild(title);
    header.appendChild(close);
    referencesPopover.appendChild(header);

    if (!payload.otherFiles || payload.otherFiles.length === 0) {
      const empty = document.createElement('div');
      empty.textContent = 'No other references found.';
      empty.style.cssText = `
        font-size: 12px;
        color: var(--vscode-descriptionForeground);
      `;
      referencesPopover.appendChild(empty);
      return;
    }

    for (const fileRef of payload.otherFiles) {
      const firstMatch = fileRef.matches?.[0];
      const firstLine = typeof firstMatch?.line === 'number' ? firstMatch.line + 1 : 1;
      const additional =
        (fileRef.matches?.length ?? 0) > 1 ? ` (+${fileRef.matches.length - 1} more)` : '';

      const row = document.createElement('div');
      row.style.cssText = `
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 10px;
        padding: 8px 6px;
        border-radius: 6px;
      `;
      row.addEventListener('mouseenter', () => {
        row.style.background = 'var(--vscode-list-hoverBackground)';
      });
      row.addEventListener('mouseleave', () => {
        row.style.background = 'transparent';
      });

      const left = document.createElement('div');
      left.style.cssText = `
        min-width: 0;
        flex: 1;
      `;

      const pathLabel = document.createElement('div');
      pathLabel.textContent = fileRef.fsPath;
      pathLabel.style.cssText = `
        font-size: 12px;
        color: var(--vscode-foreground);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      `;
      pathLabel.title = fileRef.fsPath;

      const meta = document.createElement('div');
      meta.textContent = `Line ${firstLine}${additional}`;
      meta.style.cssText = `
        margin-top: 2px;
        font-size: 11px;
        color: var(--vscode-descriptionForeground);
      `;

      left.appendChild(pathLabel);
      left.appendChild(meta);

      const actions = document.createElement('div');
      actions.style.cssText = `
        display: flex;
        gap: 6px;
        flex-shrink: 0;
      `;

      const makeActionButton = (label: string) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = label;
        btn.style.cssText = `
          padding: 2px 8px;
          font-size: 11px;
          background: var(--vscode-button-secondaryBackground);
          color: var(--vscode-button-secondaryForeground);
          border: none;
          border-radius: 4px;
          cursor: pointer;
          white-space: nowrap;
        `;
        return btn;
      };

      const openBtn = makeActionButton('Open');
      openBtn.addEventListener('click', e => {
        e.preventDefault();
        e.stopPropagation();
        vscodeApi.postMessage({
          type: 'openFileAtLocation',
          fsPath: fileRef.fsPath,
          line: firstLine,
          openToSide: false,
        });
      });

      const openSideBtn = makeActionButton('Side');
      openSideBtn.addEventListener('click', e => {
        e.preventDefault();
        e.stopPropagation();
        vscodeApi.postMessage({
          type: 'openFileAtLocation',
          fsPath: fileRef.fsPath,
          line: firstLine,
          openToSide: true,
        });
      });

      actions.appendChild(openBtn);
      actions.appendChild(openSideBtn);

      row.appendChild(left);
      row.appendChild(actions);
      referencesPopover.appendChild(row);
    }
  };

  const openReferencesPopover = () => {
    if (!referencePayload || referencePayload.otherFiles.length === 0) {
      return;
    }

    renderReferencesPopover(referencePayload);

    const pillRect = referencesPill.getBoundingClientRect();
    const dialogRect = dialog.getBoundingClientRect();
    const left = Math.max(10, Math.min(pillRect.left - dialogRect.left, dialogRect.width - 340));
    const top = pillRect.bottom - dialogRect.top + 8;
    referencesPopover.style.left = `${left}px`;
    referencesPopover.style.top = `${top}px`;

    referencesPopover.style.display = 'block';
    referencesPill.setAttribute('aria-expanded', 'true');
    isReferencesPopoverOpen = true;
  };

  const toggleReferencesPopover = () => {
    if (isReferencesPopoverOpen) {
      closeReferencesPopover();
      return;
    }
    openReferencesPopover();
  };

  impactOtherFilesRow.style.display = 'none';
  impactCurrentFileRow.style.display = 'none';
  impactContent.style.display = 'none';
  referencesPopover.style.display = 'none';

  referencesPill.addEventListener('click', e => {
    e.preventDefault();
    e.stopPropagation();
    toggleReferencesPopover();
  });

  dialog.addEventListener('click', e => {
    if (!isReferencesPopoverOpen) return;
    const target = e.target as Node | null;
    if (!target) {
      closeReferencesPopover();
      return;
    }
    if (referencesPopover.contains(target) || referencesPill.contains(target)) {
      return;
    }
    closeReferencesPopover();
  });

  const getImageReferences = (window as any).getImageReferences as
    | ((path: string) => Promise<unknown>)
    | undefined;

  if (typeof getImageReferences === 'function' && imagePath) {
    getImageReferences(imagePath)
      .then(result => {
        const payload = result as Partial<ReferencePayload>;
        referencePayload = {
          currentFileCount:
            typeof payload.currentFileCount === 'number' ? payload.currentFileCount : 0,
          otherFiles: Array.isArray(payload.otherFiles)
            ? (payload.otherFiles as ReferenceRow[])
            : [],
          error: typeof payload.error === 'string' ? payload.error : undefined,
        };

        impactLoading.style.display = 'none';
        impactContent.style.display = 'block';

        const otherCount = referencePayload.otherFiles.length;
        if (otherCount > 0) {
          referencesPill.textContent = String(otherCount);
          referencesPlural.textContent = otherCount === 1 ? '' : 's';
          impactOtherFilesRow.style.display = 'block';
        }

        if (referencePayload.currentFileCount > 1) {
          currentCount.textContent = String(referencePayload.currentFileCount);
          impactCurrentFileRow.style.display = 'block';
        }

        if (otherCount === 0 && referencePayload.currentFileCount <= 1) {
          impactRoot.style.display = 'none';
        }
      })
      .catch(error => {
        console.warn('[MD4H] Failed to fetch image references:', error);
        impactLoading.textContent = 'References unavailable';
      });
  } else {
    impactRoot.style.display = 'none';
  }

  collisionCancel.addEventListener('click', e => {
    e.preventDefault();
    e.stopPropagation();
    pendingOverwriteName = null;
    collisionBox.style.display = 'none';
  });

  collisionOverwrite.addEventListener('click', e => {
    e.preventDefault();
    e.stopPropagation();
    if (!pendingOverwriteName) {
      return;
    }
    vscodeApi.postMessage({
      type: 'renameImage',
      oldPath: imagePath,
      newName: pendingOverwriteName,
      updateAllReferences: true,
      allowOverwrite: true,
    });
    closeDialog();
  });

  const handleRename = async () => {
    const newName = input.value.trim();

    if (!newName) {
      input.style.borderColor = 'var(--vscode-inputValidation-errorBorder)';
      return;
    }

    if (newName === currentName) {
      closeDialog();
      return;
    }

    // Sanitize the new name
    const sanitizedName = newName
      .replace(/[^a-zA-Z0-9-_]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');

    if (!sanitizedName) {
      input.style.borderColor = 'var(--vscode-inputValidation-errorBorder)';
      return;
    }

    // Preflight collision check
    collisionBox.style.display = 'none';
    pendingOverwriteName = null;

    const checkImageRename = (window as any).checkImageRename as
      | ((oldPath: string, newName: string) => Promise<unknown>)
      | undefined;
    if (typeof checkImageRename === 'function') {
      renameBtn.disabled = true;
      renameBtn.style.opacity = '0.7';
      renameBtn.style.cursor = 'not-allowed';
      try {
        const result = (await checkImageRename(imagePath, sanitizedName)) as any;
        if (result && typeof result.exists === 'boolean' && result.exists === true) {
          pendingOverwriteName = sanitizedName;
          collisionFilename.textContent =
            typeof result.newFilename === 'string' && result.newFilename
              ? result.newFilename
              : `${sanitizedName}${extension ? `.${extension}` : ''}`;
          collisionBox.style.display = 'block';
          return;
        }
      } finally {
        renameBtn.disabled = false;
        renameBtn.style.opacity = '1';
        renameBtn.style.cursor = 'pointer';
      }
    }

    // Send rename request to extension
    vscodeApi.postMessage({
      type: 'renameImage',
      oldPath: imagePath,
      newName: sanitizedName,
      updateAllReferences: true, // Default to updating all references
      allowOverwrite: false,
    });

    closeDialog();
  };

  // Event listeners
  cancelBtn.addEventListener('click', closeDialog);
  renameBtn.addEventListener('click', () => {
    void handleRename();
  });

  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void handleRename();
    } else if (e.key === 'Escape') {
      if (isReferencesPopoverOpen) {
        closeReferencesPopover();
        return;
      }
      closeDialog();
    }
  });

  overlay.addEventListener('click', e => {
    e.stopPropagation();
    if (e.target === overlay) {
      closeDialog();
    }
  });

  overlay.addEventListener('mousedown', e => {
    e.stopPropagation();
  });
}
