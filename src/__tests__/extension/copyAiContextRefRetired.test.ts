/**
 * @jest-environment node
 *
 * Retirement guard for Copy AI Context Reference (@file#lines).
 * Confirms the command, keybinding, setting, modules, and host registration
 * are fully removed — not merely hidden from the toolbar.
 */

import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import * as vscode from 'vscode';
import { activate } from '../../extension';

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

const root = resolve(__dirname, '../../..');
const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
  contributes: {
    commands: Array<{ command: string }>;
    keybindings?: Array<{ command: string; key?: string }>;
    configuration: { properties: Record<string, unknown> };
  };
};

const RETIRED_COMMAND = 'markdownForHumans.copyAiContextRef';
const RETIRED_SETTING = 'markdownForHumans.copyAiContextRef.skipSaveWarning';

describe('Copy AI Context Reference — fully retired', () => {
  it('does not contribute the command, Alt+C keybinding, or skipSaveWarning setting', () => {
    const commandIds = packageJson.contributes.commands.map(c => c.command);
    expect(commandIds).not.toContain(RETIRED_COMMAND);

    const keybindings = packageJson.contributes.keybindings ?? [];
    expect(keybindings.some(kb => kb.command === RETIRED_COMMAND)).toBe(false);
    expect(
      keybindings.some(
        kb => kb.command === RETIRED_COMMAND || (kb.key ?? '').toLowerCase() === 'alt+c'
      )
    ).toBe(false);

    expect(packageJson.contributes.configuration.properties).not.toHaveProperty(RETIRED_SETTING);
  });

  it('removes implementation modules from the tree', () => {
    expect(existsSync(resolve(root, 'src/webview/utils/aiContextReference.ts'))).toBe(false);
    expect(existsSync(resolve(root, 'src/webview/features/aiContextSaveWarning.ts'))).toBe(false);
    expect(existsSync(resolve(root, 'src/__tests__/webview/aiContextReference.test.ts'))).toBe(
      false
    );
    expect(
      existsSync(resolve(root, 'src/__tests__/webview/aiContextReference.realEditor.test.ts'))
    ).toBe(false);
  });

  it('does not register the retired command on activate', () => {
    jest.clearAllMocks();
    (vscode.window.createTreeView as jest.Mock | undefined) = jest.fn(() => ({
      dispose: jest.fn(),
    }));

    const registered = new Map<string, () => void>();
    (vscode.commands.registerCommand as jest.Mock).mockImplementation(
      (id: string, handler: () => void) => {
        registered.set(id, handler);
        return { dispose: jest.fn() };
      }
    );

    activate({ subscriptions: [] } as unknown as vscode.ExtensionContext);

    expect(registered.has(RETIRED_COMMAND)).toBe(false);
  });
});
