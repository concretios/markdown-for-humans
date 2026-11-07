/**
 * @jest-environment node
 */

/**
 * Host side of paste as plain text (issue 11).
 *
 * VS Code cancels Ctrl/Cmd+Shift+V inside a webview and forwards the key to
 * the workbench, so the chord is a contributed keybinding. The command reads
 * the clipboard's text flavor on the host and hands it to the active editor.
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';
import * as vscode from 'vscode';
import { getActiveWebviewPanel } from '../../activeWebview';
import { activate } from '../../extension';

jest.mock('../../feedbackCommandReadiness', () => ({
  sendFeedbackCommand: jest.fn(async () => true),
}));

jest.mock('../../editor/MarkdownEditorProvider', () => ({
  MarkdownEditorProvider: {
    register: jest.fn(() => ({ dispose: jest.fn() })),
  },
}));

jest.mock('../../features/wordCount', () => ({
  WordCountFeature: jest.fn(() => ({
    activate: jest.fn(),
    showDetailedStats: jest.fn(),
  })),
}));

jest.mock('../../features/outlineView', () => ({
  outlineViewProvider: {
    setTreeView: jest.fn(),
    revealActive: jest.fn(),
    showFilterInput: jest.fn(),
    clearFilter: jest.fn(),
  },
}));

jest.mock('../../activeWebview', () => ({
  getActiveWebviewPanel: jest.fn(),
}));

const COMMAND_ID = 'markdownForHumans.pastePlainText';

describe('Paste as Plain Text command', () => {
  const packageJson = JSON.parse(
    readFileSync(resolve(__dirname, '../../../package.json'), 'utf8')
  ) as {
    contributes: {
      commands: Array<{ command: string; title: string }>;
      keybindings: Array<{ command: string; key: string; mac?: string; when?: string }>;
    };
  };

  let readText: jest.Mock;
  let postMessage: jest.Mock;

  function registeredCommand(): () => Promise<void> {
    const registered = new Map<string, () => Promise<void>>();
    (vscode.commands.registerCommand as jest.Mock).mockImplementation(
      (id: string, callback: () => Promise<void>) => {
        registered.set(id, callback);
        return { dispose: jest.fn() };
      }
    );
    activate({ subscriptions: [] } as unknown as vscode.ExtensionContext);
    const command = registered.get(COMMAND_ID);
    if (!command) throw new Error(`${COMMAND_ID} is not registered`);
    return command;
  }

  beforeEach(() => {
    jest.clearAllMocks();
    (vscode.window.createTreeView as jest.Mock | undefined) = jest.fn(() => ({
      dispose: jest.fn(),
    }));
    readText = jest.fn(async () => 'clipboard text');
    (vscode.env as unknown as { clipboard: { readText: jest.Mock } }).clipboard = { readText };
    postMessage = jest.fn(() => Promise.resolve(true));
    (getActiveWebviewPanel as jest.Mock).mockReturnValue({ webview: { postMessage } });
  });

  it('is contributed under the product name so it can be found and rebound', () => {
    const command = packageJson.contributes.commands.find(entry => entry.command === COMMAND_ID);
    const english = JSON.parse(
      readFileSync(resolve(__dirname, '../../../package.nls.json'), 'utf8')
    ) as Record<string, string>;

    expect(command?.title).toBe('%command.pastePlainText.title%');
    expect(english['command.pastePlainText.title']).toBe(
      'Markdown Editor for Humans: Paste as Plain Text'
    );
  });

  it('binds Ctrl+Shift+V and Cmd+Shift+V in this editor only', () => {
    const bindings = packageJson.contributes.keybindings.filter(
      entry => entry.command === COMMAND_ID
    );

    expect(bindings).toEqual([
      {
        command: COMMAND_ID,
        key: 'ctrl+shift+v',
        mac: 'cmd+shift+v',
        // Extension keybindings outrank VS Code's own, so the chord must stay
        // out of the terminal (terminal paste on Linux and Windows) and out of
        // VS Code's text inputs.
        when: "activeCustomEditorId == 'markdownForHumans.editor' && !terminalFocus && !inputFocus",
      },
    ]);
  });

  it('sends the clipboard text to the active editor', async () => {
    await registeredCommand()();

    expect(postMessage).toHaveBeenCalledWith({ type: 'pastePlainText', text: 'clipboard text' });
  });

  it('does not read the clipboard when no rich editor is active', async () => {
    (getActiveWebviewPanel as jest.Mock).mockReturnValue(undefined);

    await registeredCommand()();

    expect(readText).not.toHaveBeenCalled();
  });

  it('sends nothing when the clipboard holds no text', async () => {
    readText.mockResolvedValue('');

    await registeredCommand()();

    expect(postMessage).not.toHaveBeenCalled();
  });

  it('reports a clipboard that cannot be read', async () => {
    readText.mockRejectedValue(new Error('denied'));
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    await registeredCommand()();

    expect(postMessage).not.toHaveBeenCalled();
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      'Markdown Editor for Humans: could not read the clipboard.'
    );
    consoleError.mockRestore();
  });
});
