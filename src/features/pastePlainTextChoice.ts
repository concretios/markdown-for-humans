/**
 * Copyright (c) 2025-2026 Concret.io
 *
 * Licensed under the MIT License. See LICENSE file in the project root for details.
 */

import * as vscode from 'vscode';

/** Mirrors `PlainPasteMode` in `src/webview/utils/plainTextPaste.ts`. */
type PlainPasteMode = 'plain' | 'code' | 'markdown';

/**
 * Ask how to paste clipboard text that would be read as Markdown the next
 * time the file is loaded, then send it back to the editor with that choice.
 *
 * The serializer does not escape prose, so such text pasted as plain shows as
 * typed and changes on reopen. The webview detects it (`readsAsMarkdown`) and
 * posts `pastePlainText.choose` instead of inserting. Dismissing the choice
 * pastes nothing.
 *
 * @param webview - The editor that asked
 * @param text - The clipboard text, as the webview sent it
 */
export async function choosePlainPasteMode(webview: vscode.Webview, text: unknown): Promise<void> {
  if (typeof text !== 'string' || !text) return;
  const items: Array<vscode.QuickPickItem & { mode: PlainPasteMode }> = [
    {
      mode: 'code',
      label: vscode.l10n.t('Paste as code'),
      detail: vscode.l10n.t('Stays exactly as written, now and when the file is reopened.'),
    },
    {
      mode: 'markdown',
      label: vscode.l10n.t('Paste as Markdown'),
      detail: vscode.l10n.t('Its Markdown syntax is applied as formatting now.'),
    },
    {
      mode: 'plain',
      label: vscode.l10n.t('Paste as plain text'),
      detail: vscode.l10n.t(
        'Shows as typed now. Its Markdown syntax becomes formatting when the file is reopened.'
      ),
    },
  ];
  try {
    const picked = await vscode.window.showQuickPick(items, {
      title: vscode.l10n.t('Markdown Editor for Humans: Paste as Plain Text'),
      placeHolder: vscode.l10n.t('This text contains Markdown syntax. How should it be pasted?'),
    });
    if (picked) await webview.postMessage({ type: 'pastePlainText', text, mode: picked.mode });
  } catch (error) {
    console.error('[MD4H] Paste as plain text choice failed:', error);
  }
}
