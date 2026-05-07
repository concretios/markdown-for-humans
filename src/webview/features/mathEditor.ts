/**
 * Copyright (c) 2025-2026 Concret.io
 *
 * Licensed under the MIT License. See LICENSE file in the project root for details.
 */

/**
 * Math (LaTeX/KaTeX) editor modal.
 *
 * Mirrors the structure of mermaidEditor.ts but with a live KaTeX preview pane
 * on the right that updates as the user types (debounced ~150ms). Used for
 * both inline (`$...$`) and display (`$$...$$`) math via the `displayMode`
 * option.
 *
 * Returns the edited LaTeX and whether it was saved.
 */

import katex from 'katex';

interface MathEditOptions {
  initialLatex: string;
  displayMode: boolean;
}

interface MathEditResult {
  latex: string;
  wasSaved: boolean;
}

const PREVIEW_DEBOUNCE_MS = 150;
const KATEX_DOCS_URL = 'https://katex.org/docs/supported.html';

export async function showMathEditor(options: MathEditOptions): Promise<MathEditResult> {
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.className = 'math-editor-overlay';
    overlay.style.cssText = `
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(0, 0, 0, 0.6);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 10000;
    `;

    const dialog = document.createElement('div');
    dialog.className = 'math-editor-dialog';
    dialog.style.cssText = `
      background: var(--vscode-editor-background);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 6px;
      padding: 0;
      width: clamp(60%, 70vw, 1100px);
      max-width: 90vw;
      min-width: 360px;
      height: clamp(60%, 70vh, 90vh);
      max-height: 90vh;
      min-height: 320px;
      display: flex;
      flex-direction: column;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
    `;

    const header = document.createElement('div');
    header.style.cssText = `
      padding: 16px 20px;
      border-bottom: 1px solid var(--vscode-panel-border);
      display: flex;
      justify-content: space-between;
      align-items: center;
    `;
    const titleText = options.displayMode ? 'Edit Display Math' : 'Edit Inline Math';
    header.innerHTML = `
      <h3 style="margin: 0; color: var(--vscode-foreground); font-size: 14px; font-weight: 600;">
        ${titleText}
      </h3>
      <div style="display: flex; gap: 12px; align-items: center;">
        <a id="docs-link" href="${KATEX_DOCS_URL}" target="_blank" rel="noopener noreferrer" style="
          color: var(--vscode-textLink-foreground);
          font-size: 12px;
          text-decoration: none;
        " title="Open KaTeX supported functions reference">KaTeX docs</a>
        <button id="close-btn" style="
          background: none;
          border: none;
          color: var(--vscode-foreground);
          font-size: 24px;
          line-height: 1;
          cursor: pointer;
          padding: 0;
          width: 24px;
          height: 24px;
        " title="Close (Esc)" aria-label="Close">×</button>
      </div>
    `;

    const body = document.createElement('div');
    body.style.cssText = `
      flex: 1;
      display: flex;
      flex-direction: row;
      min-height: 0;
    `;

    const editorPane = document.createElement('div');
    editorPane.style.cssText = `
      flex: 1 1 50%;
      display: flex;
      flex-direction: column;
      border-right: 1px solid var(--vscode-panel-border);
      min-width: 0;
    `;

    const editorLabel = document.createElement('div');
    editorLabel.textContent = 'LaTeX source';
    editorLabel.style.cssText = `
      padding: 8px 16px;
      font-size: 11px;
      letter-spacing: 0.05em;
      text-transform: uppercase;
      color: var(--vscode-descriptionForeground);
      border-bottom: 1px solid var(--vscode-panel-border);
    `;

    const textarea = document.createElement('textarea');
    textarea.className = 'math-editor-textarea';
    textarea.value = options.initialLatex;
    textarea.spellcheck = false;
    textarea.style.cssText = `
      flex: 1;
      padding: 16px 20px;
      margin: 0;
      background: var(--vscode-editor-background);
      color: var(--vscode-editor-foreground);
      border: none;
      font-family: 'SF Mono', Monaco, 'Cascadia Code', 'Roboto Mono', Consolas, monospace;
      font-size: 13px;
      line-height: 1.6;
      resize: none;
      outline: none;
    `;

    editorPane.appendChild(editorLabel);
    editorPane.appendChild(textarea);

    const previewPane = document.createElement('div');
    previewPane.style.cssText = `
      flex: 1 1 50%;
      display: flex;
      flex-direction: column;
      min-width: 0;
    `;

    const previewLabel = document.createElement('div');
    previewLabel.textContent = 'Preview';
    previewLabel.style.cssText = `
      padding: 8px 16px;
      font-size: 11px;
      letter-spacing: 0.05em;
      text-transform: uppercase;
      color: var(--vscode-descriptionForeground);
      border-bottom: 1px solid var(--vscode-panel-border);
    `;

    const previewBox = document.createElement('div');
    previewBox.className = 'math-editor-preview';
    previewBox.style.cssText = `
      flex: 1;
      padding: 20px;
      overflow: auto;
      background: var(--vscode-editor-background);
      color: var(--vscode-editor-foreground);
      font-size: ${options.displayMode ? '1.1em' : '1em'};
      display: flex;
      align-items: ${options.displayMode ? 'center' : 'flex-start'};
      justify-content: ${options.displayMode ? 'center' : 'flex-start'};
      text-align: ${options.displayMode ? 'center' : 'left'};
    `;

    const errorBox = document.createElement('div');
    errorBox.className = 'math-editor-error';
    errorBox.style.cssText = `
      padding: 8px 16px;
      background: var(--vscode-inputValidation-errorBackground, rgba(255, 0, 0, 0.1));
      color: var(--vscode-inputValidation-errorForeground, #f48771);
      border-top: 1px solid var(--vscode-inputValidation-errorBorder, #be1100);
      font-family: 'SF Mono', Monaco, 'Cascadia Code', 'Roboto Mono', Consolas, monospace;
      font-size: 12px;
      line-height: 1.4;
      white-space: pre-wrap;
      display: none;
    `;

    previewPane.appendChild(previewLabel);
    previewPane.appendChild(previewBox);
    previewPane.appendChild(errorBox);

    body.appendChild(editorPane);
    body.appendChild(previewPane);

    const footer = document.createElement('div');
    footer.style.cssText = `
      padding: 12px 20px;
      border-top: 1px solid var(--vscode-panel-border);
      display: flex;
      gap: 8px;
      justify-content: space-between;
      align-items: center;
      background: var(--vscode-editor-background);
    `;
    footer.innerHTML = `
      <span style="
        color: var(--vscode-descriptionForeground);
        font-size: 12px;
      ">Cmd/Ctrl+S to save · Esc to cancel</span>
      <div style="display: flex; gap: 8px;">
        <button id="cancel-btn" style="
          padding: 6px 14px;
          background: var(--vscode-button-secondaryBackground);
          color: var(--vscode-button-secondaryForeground);
          border: none;
          border-radius: 3px;
          cursor: pointer;
          font-family: var(--vscode-font-family);
          font-size: 13px;
        ">Cancel</button>
        <button id="save-btn" style="
          padding: 6px 14px;
          background: var(--vscode-button-background);
          color: var(--vscode-button-foreground);
          border: none;
          border-radius: 3px;
          cursor: pointer;
          font-family: var(--vscode-font-family);
          font-weight: 500;
          font-size: 13px;
        ">Save</button>
      </div>
    `;

    dialog.appendChild(header);
    dialog.appendChild(body);
    dialog.appendChild(footer);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    const closeBtn = header.querySelector('#close-btn') as HTMLButtonElement;
    const cancelBtn = footer.querySelector('#cancel-btn') as HTMLButtonElement;
    const saveBtn = footer.querySelector('#save-btn') as HTMLButtonElement;
    const docsLink = header.querySelector('#docs-link') as HTMLAnchorElement;

    docsLink.addEventListener('click', e => {
      const url = docsLink.getAttribute('href') || KATEX_DOCS_URL;
      const vscodeApi = window.vscode;
      if (vscodeApi && typeof vscodeApi.postMessage === 'function') {
        e.preventDefault();
        vscodeApi.postMessage({ type: 'openExternalLink', url });
      }
    });

    let renderTimeout: number | null = null;

    const renderPreview = () => {
      const latex = textarea.value;

      if (!latex.trim()) {
        previewBox.innerHTML =
          '<span style="color: var(--vscode-descriptionForeground); font-style: italic;">Type LaTeX to see the preview…</span>';
        errorBox.style.display = 'none';
        errorBox.textContent = '';
        return;
      }

      try {
        previewBox.innerHTML = katex.renderToString(latex, {
          throwOnError: true,
          displayMode: options.displayMode,
          output: 'html',
          strict: 'ignore',
        });
        errorBox.style.display = 'none';
        errorBox.textContent = '';
      } catch (err) {
        previewBox.innerHTML =
          '<span style="color: var(--vscode-descriptionForeground); font-style: italic;">Preview unavailable — see error below.</span>';
        const message = err instanceof Error ? err.message : 'KaTeX render error';
        errorBox.style.display = 'block';
        errorBox.textContent = message;
      }
    };

    const scheduleRender = () => {
      if (renderTimeout !== null) {
        window.clearTimeout(renderTimeout);
      }
      renderTimeout = window.setTimeout(() => {
        renderTimeout = null;
        renderPreview();
      }, PREVIEW_DEBOUNCE_MS);
    };

    textarea.addEventListener('input', scheduleRender);
    renderPreview();

    setTimeout(() => {
      textarea.focus();
      const length = textarea.value.length;
      textarea.setSelectionRange(length, length);
    }, 0);

    const cleanup = () => {
      if (renderTimeout !== null) {
        window.clearTimeout(renderTimeout);
        renderTimeout = null;
      }
      if (overlay.parentNode) {
        overlay.parentNode.removeChild(overlay);
      }
    };

    const handleSave = () => {
      const latex = textarea.value.trim();
      cleanup();
      resolve({ latex, wasSaved: true });
    };

    const handleCancel = () => {
      cleanup();
      resolve({ latex: options.initialLatex, wasSaved: false });
    };

    saveBtn.addEventListener('click', handleSave);
    cancelBtn.addEventListener('click', handleCancel);
    closeBtn.addEventListener('click', handleCancel);

    // Intentionally NO click-outside-to-cancel: the dialog only closes via
    // explicit Save / Cancel / × / Esc so an accidental click on the dimmed
    // backdrop doesn't discard the user's in-progress LaTeX.
    overlay.addEventListener('click', e => {
      if (e.target === overlay) {
        // Swallow the click so focus stays where it is and the modal
        // remains open until the user makes an explicit choice.
        e.preventDefault();
        e.stopPropagation();
        textarea.focus();
      }
    });

    // Quarantine all keyboard input inside the modal.
    //
    // The webview installs a document-level `keydown` handler (Ctrl+S save,
    // Ctrl+F search, Ctrl+K link, Ctrl+Alt+C ai-ref, etc.) and TipTap binds
    // its own ProseMirror plugins at the editor view, including Ctrl+Z /
    // Ctrl+Y. Without intervention every keystroke in the textarea bubbles
    // up to those handlers, so Ctrl+Z would run TipTap's undo against the
    // underlying document instead of undoing the LaTeX edit.
    //
    // Solution: register a CAPTURE-phase handler on the overlay. This runs
    // before any document/editor handler, lets the textarea's native
    // behaviour proceed (we never preventDefault for typing/undo/redo),
    // and then stops propagation so nothing outside the modal sees the
    // event. Only Esc and Cmd/Ctrl+S short-circuit to our save/cancel.
    overlay.addEventListener(
      'keydown',
      e => {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          handleCancel();
          return;
        }
        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
          e.preventDefault();
          e.stopPropagation();
          handleSave();
          return;
        }
        // Everything else: let the textarea handle it natively (typing,
        // selection, native undo/redo, copy/paste) but block bubble-up so
        // the document/editor handlers never see it.
        e.stopPropagation();
      },
      true
    );

    // Same isolation for keyup/keypress — some editor shortcuts (chord
    // detection, IME) react to those, and we don't want them firing for
    // keys that were meant for the math textarea.
    const stopBubble = (e: Event) => {
      e.stopPropagation();
    };
    overlay.addEventListener('keyup', stopBubble, true);
    overlay.addEventListener('keypress', stopBubble, true);

    // Also isolate clipboard events. Copy / cut / paste should operate on
    // the textarea selection only — they must not reach the editor's paste
    // handler, which is bound at the document level in capture phase.
    overlay.addEventListener('copy', stopBubble, true);
    overlay.addEventListener('cut', stopBubble, true);
    overlay.addEventListener('paste', stopBubble, true);
  });
}
