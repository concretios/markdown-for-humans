/**
 * @jest-environment node
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';
import * as vscode from 'vscode';
import { getActiveWebviewPanel } from '../../activeWebview';
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

type RegisteredCommand = () => void;

const FEEDBACK_COMMANDS = [
  ['markdownForHumans.feedback.start', 'start', 'Markdown for Humans: Start Feedback'],
  [
    'markdownForHumans.feedback.commentSelection',
    'commentSelection',
    'Markdown for Humans: Add Feedback to Selection',
  ],
  [
    'markdownForHumans.feedback.captureArea',
    'captureArea',
    'Markdown for Humans: Capture Feedback Area',
  ],
  [
    'markdownForHumans.feedback.captureSelectedBlocks',
    'captureSelectedBlocks',
    'Markdown for Humans: Capture Selected Blocks',
  ],
  [
    'markdownForHumans.feedback.toggleComments',
    'toggleComments',
    'Markdown for Humans: Toggle Feedback Comments',
  ],
  ['markdownForHumans.feedback.next', 'nextFeedback', 'Markdown for Humans: Next Feedback'],
  [
    'markdownForHumans.feedback.previous',
    'previousFeedback',
    'Markdown for Humans: Previous Feedback',
  ],
  [
    'markdownForHumans.feedback.finish',
    'finish',
    'Markdown for Humans: Finish Feedback and Copy Prompt',
  ],
  ['markdownForHumans.feedback.reveal', 'reveal', 'Markdown for Humans: Reveal Feedback File'],
  ['markdownForHumans.feedback.discard', 'discard', 'Markdown for Humans: Discard Feedback Draft'],
] as const;

describe('Feedback public commands', () => {
  const packageJson = JSON.parse(
    readFileSync(resolve(__dirname, '../../../package.json'), 'utf8')
  ) as {
    contributes: {
      commands: Array<{ command: string; title: string }>;
      keybindings?: Array<{ command: string }>;
    };
  };

  beforeEach(() => {
    jest.clearAllMocks();
    (vscode.window.createTreeView as jest.Mock | undefined) = jest.fn(() => ({
      dispose: jest.fn(),
    }));
  });

  it('contributes every public Feedback command without claiming default keybindings', () => {
    const commandTitles = new Map(
      packageJson.contributes.commands.map(command => [command.command, command.title])
    );
    const boundCommands = new Set(
      (packageJson.contributes.keybindings ?? []).map(keybinding => keybinding.command)
    );

    const contributedFeedbackCommands = packageJson.contributes.commands
      .map(command => command.command)
      .filter(command => command.startsWith('markdownForHumans.feedback.'));

    expect(contributedFeedbackCommands).toEqual(FEEDBACK_COMMANDS.map(([commandId]) => commandId));
    for (const [commandId, , title] of FEEDBACK_COMMANDS) {
      expect(commandTitles.get(commandId)).toBe(title);
      expect(boundCommands).not.toContain(commandId);
    }
  });

  it.each(FEEDBACK_COMMANDS)(
    'routes %s to the active webview as %s',
    (commandId, webviewCommand) => {
      const registeredCommands = new Map<string, RegisteredCommand>();
      (vscode.commands.registerCommand as jest.Mock).mockImplementation(
        (id: string, callback: RegisteredCommand) => {
          registeredCommands.set(id, callback);
          return { dispose: jest.fn() };
        }
      );
      const postMessage = jest.fn(() => Promise.resolve(true));
      (getActiveWebviewPanel as jest.Mock).mockReturnValue({ webview: { postMessage } });

      activate({ subscriptions: [] } as unknown as vscode.ExtensionContext);
      registeredCommands.get(commandId)?.();

      expect(registeredCommands.has(commandId)).toBe(true);
      expect(postMessage).toHaveBeenCalledWith({
        type: 'feedback.command',
        command: webviewCommand,
      });
    }
  );
});
