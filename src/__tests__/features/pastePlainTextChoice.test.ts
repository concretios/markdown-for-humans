/**
 * @jest-environment node
 */

/**
 * Paste as plain text: the choice offered when the clipboard text would be
 * read as Markdown the next time the file is loaded.
 *
 * The webview detects that and asks the host. The host shows the three ways to
 * paste and sends the text back with the chosen mode.
 */

import * as vscode from 'vscode';
import { choosePlainPasteMode } from '../../features/pastePlainTextChoice';

type Item = vscode.QuickPickItem & { mode: string };

describe('choosePlainPasteMode', () => {
  let showQuickPick: jest.Mock;
  let postMessage: jest.Mock;
  let webview: vscode.Webview;

  beforeEach(() => {
    showQuickPick = jest.fn(async () => undefined);
    (vscode.window as unknown as { showQuickPick: jest.Mock }).showQuickPick = showQuickPick;
    postMessage = jest.fn(async () => true);
    webview = { postMessage } as unknown as vscode.Webview;
  });

  it('offers code first, then Markdown, then plain text, and says what each one does', async () => {
    await choosePlainPasteMode(webview, '**bold**');

    const [items, options] = showQuickPick.mock.calls[0] as [Item[], vscode.QuickPickOptions];
    expect(items.map(item => [item.mode, item.label])).toEqual([
      ['code', 'Paste as code'],
      ['markdown', 'Paste as Markdown'],
      ['plain', 'Paste as plain text'],
    ]);
    expect(items.map(item => item.detail)).toEqual([
      'Stays exactly as written, now and when the file is reopened.',
      'Its Markdown syntax is applied as formatting now.',
      'Shows as typed now. Its Markdown syntax becomes formatting when the file is reopened.',
    ]);
    expect(options.title).toBe('Markdown Editor for Humans: Paste as Plain Text');
    expect(options.placeHolder).toBe(
      'This text contains Markdown syntax. How should it be pasted?'
    );
  });

  it.each(['code', 'markdown', 'plain'])('sends the text back as %s when picked', async mode => {
    showQuickPick.mockImplementation(async (items: Item[]) =>
      items.find(item => item.mode === mode)
    );

    await choosePlainPasteMode(webview, '**bold**');

    expect(postMessage).toHaveBeenCalledWith({ type: 'pastePlainText', text: '**bold**', mode });
  });

  it('pastes nothing when the choice is dismissed', async () => {
    await choosePlainPasteMode(webview, '**bold**');

    expect(postMessage).not.toHaveBeenCalled();
  });

  it('ignores a request without text', async () => {
    await choosePlainPasteMode(webview, undefined);
    await choosePlainPasteMode(webview, '');
    await choosePlainPasteMode(webview, 42);

    expect(showQuickPick).not.toHaveBeenCalled();
  });
});
