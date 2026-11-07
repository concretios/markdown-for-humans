/**
 * @jest-environment node
 *
 * Contribution and registration of Copy Reference for AI.
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';
import * as vscode from 'vscode';
import { activate } from '../../extension';
import { getActiveWebviewPanel } from '../../activeWebview';

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

const COMMAND = 'markdownForHumans.copyReferenceForAi';
const ACTIVE_EDITOR = "activeCustomEditorId == 'markdownForHumans.editor'";

const root = resolve(__dirname, '../../..');
const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
  contributes: {
    commands: Array<{ command: string; title: string; enablement?: string }>;
    keybindings?: Array<{ command: string }>;
    menus: { commandPalette?: Array<{ command: string; when?: string }> };
    configuration: { properties: Record<string, unknown> };
  };
};

const englishManifestText = JSON.parse(
  readFileSync(resolve(root, 'package.nls.json'), 'utf8')
) as Record<string, string>;

function registerCommands(): Map<string, () => unknown> {
  jest.clearAllMocks();
  (vscode.window.createTreeView as jest.Mock | undefined) = jest.fn(() => ({
    dispose: jest.fn(),
  }));
  const registered = new Map<string, () => unknown>();
  (vscode.commands.registerCommand as jest.Mock).mockImplementation(
    (id: string, handler: () => unknown) => {
      registered.set(id, handler);
      return { dispose: jest.fn() };
    }
  );
  activate({ subscriptions: [] } as unknown as vscode.ExtensionContext);
  return registered;
}

describe('Copy Reference for AI command', () => {
  it('is contributed with its title and only for this editor', () => {
    const command = packageJson.contributes.commands.find(entry => entry.command === COMMAND);
    expect(command).toEqual({
      command: COMMAND,
      title: '%command.copyReferenceForAi.title%',
      enablement: ACTIVE_EDITOR,
    });
    expect(englishManifestText['command.copyReferenceForAi.title']).toBe(
      'Markdown Editor for Humans: Copy Reference for AI'
    );
    expect(packageJson.contributes.menus.commandPalette).toContainEqual({
      command: COMMAND,
      when: ACTIVE_EDITOR,
    });
  });

  it('ships no default keybinding and no setting', () => {
    expect(
      (packageJson.contributes.keybindings ?? []).some(binding => binding.command === COMMAND)
    ).toBe(false);
    expect(
      Object.keys(packageJson.contributes.configuration.properties).some(key =>
        /reference|aiRef/i.test(key)
      )
    ).toBe(false);
  });

  it('asks the active editor to copy, and does nothing without one', () => {
    const registered = registerCommands();
    const handler = registered.get(COMMAND);
    expect(handler).toBeDefined();

    (getActiveWebviewPanel as jest.Mock).mockReturnValue(undefined);
    expect(() => handler?.()).not.toThrow();

    const postMessage = jest.fn();
    (getActiveWebviewPanel as jest.Mock).mockReturnValue({ webview: { postMessage } });
    handler?.();
    expect(postMessage).toHaveBeenCalledWith({ type: 'copyReferenceForAi' });
  });
});
