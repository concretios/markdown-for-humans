/**
 * Copyright (c) 2025-2026 Concret.io
 *
 * Licensed under the MIT License. See LICENSE file in the project root for details.
 */

import * as vscode from 'vscode';
import { MarkdownEditorProvider } from './editor/MarkdownEditorProvider';
import { WordCountFeature } from './features/wordCount';
import { getActiveWebviewPanel } from './activeWebview';
import { outlineViewProvider } from './features/outlineView';
import type { FeedbackHostMessage } from './shared/feedbackProtocol';

type FeedbackCommand = Extract<FeedbackHostMessage, { type: 'feedback.command' }>['command'];

export function activate(context: vscode.ExtensionContext) {
  // Register the custom editor provider
  const provider = MarkdownEditorProvider.register(context);
  context.subscriptions.push(provider);

  // Clear active context when switching to non-markdown-for-humans editors
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(editor => {
      // Custom editors appear as undefined in activeTextEditor, so if we get a text editor here, disable context
      if (editor && editor.document.languageId !== 'markdown') {
        // If a regular text editor is active, clear our active context
        // Note: markdown languageId for default text editor; webview handled via view state events
        vscode.commands.executeCommand('setContext', 'markdownForHumans.isActive', false);
      }
    })
  );

  // Register outline tree view provider (Explorer)
  const outlineTreeView = vscode.window.createTreeView('markdownForHumansOutline', {
    treeDataProvider: outlineViewProvider,
    showCollapseAll: true,
  });
  outlineViewProvider.setTreeView(outlineTreeView);
  context.subscriptions.push(outlineTreeView);

  // Initialize Word Count feature
  const wordCount = new WordCountFeature();
  wordCount.activate(context);

  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand('markdownForHumans.openFile', async (uri?: vscode.Uri) => {
      let targetUri = uri;

      const activeEditor = vscode.window.activeTextEditor;

      // If no URI passed (e.g. run from command palette), prefer the active markdown editor
      if (!targetUri && activeEditor && activeEditor.document.languageId === 'markdown') {
        const document = activeEditor.document;

        // Support both file and untitled schemes
        if (document.uri.scheme === 'file' || document.uri.scheme === 'untitled') {
          targetUri = document.uri;
        }
      }

      // If we still don't have a URI, ask user to pick a file
      if (!targetUri) {
        const uris = await vscode.window.showOpenDialog({
          canSelectMany: false,
          filters: {
            Markdown: ['md', 'markdown'],
          },
        });
        if (uris && uris[0]) {
          targetUri = uris[0];
        }
      }

      if (targetUri) {
        await vscode.commands.executeCommand(
          'vscode.openWith',
          targetUri,
          'markdownForHumans.editor'
        );
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('markdownForHumans.toggleSource', () => {
      // This will be handled by the webview
      vscode.window.activeTextEditor?.show();
    })
  );

  // Register word count detailed stats command
  context.subscriptions.push(
    vscode.commands.registerCommand('markdownForHumans.showDetailedStats', () => {
      wordCount.showDetailedStats();
    })
  );

  // Register TOC outline toggle command (Option 2 - TOC Overlay)
  context.subscriptions.push(
    vscode.commands.registerCommand('markdownForHumans.toggleTocOutlineView', () => {
      const panel = getActiveWebviewPanel();
      if (panel) {
        panel.webview.postMessage({ type: 'toggleTocOutlineView' });
      }
    })
  );

  // Navigate to heading from outline tree
  context.subscriptions.push(
    vscode.commands.registerCommand('markdownForHumans.navigateToHeading', (pos: number) => {
      const panel = getActiveWebviewPanel();
      if (panel) {
        panel.webview.postMessage({ type: 'navigateToHeading', pos });
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('markdownForHumans.outline.revealCurrent', () => {
      outlineViewProvider.revealActive(outlineTreeView);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('markdownForHumans.outline.filter', () => {
      outlineViewProvider.showFilterInput();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('markdownForHumans.outline.clearFilter', () => {
      outlineViewProvider.clearFilter();
    })
  );

  // Forward the keybinding to the active webview, which runs the same code path
  // as the toolbar button. The webview owns the selection state, so the host
  // command stays a thin trigger.
  context.subscriptions.push(
    vscode.commands.registerCommand('markdownForHumans.copyAiContextRef', () => {
      const panel = getActiveWebviewPanel();
      if (panel) {
        panel.webview.postMessage({ type: 'triggerCopyAiContextRef' });
      }
    })
  );

  // Flip the persisted setting (not just webview-local state) so it survives
  // reloads and stays in sync with settings.json, reusing the same
  // onDidChangeConfiguration -> postMessage sync path the setting already has.
  context.subscriptions.push(
    vscode.commands.registerCommand('markdownForHumans.toggleFormattingShortcuts', async () => {
      const config = vscode.workspace.getConfiguration();
      const current = config.get<boolean>('markdownForHumans.formattingShortcuts.enabled', true);
      await config.update(
        'markdownForHumans.formattingShortcuts.enabled',
        !current,
        vscode.ConfigurationTarget.Global
      );
      vscode.window.setStatusBarMessage(
        `Markdown for Humans: formatting shortcuts ${!current ? 'enabled' : 'disabled'}`,
        3000
      );
    })
  );

  // Feedback commands are intentionally unbound. They remain discoverable in
  // the Command Palette and can be assigned personal keybindings without the
  // extension claiming chords owned by VS Code or other extensions.
  const feedbackCommands = [
    ['markdownForHumans.feedback.start', 'start'],
    ['markdownForHumans.feedback.commentSelection', 'commentSelection'],
    ['markdownForHumans.feedback.captureArea', 'captureArea'],
    ['markdownForHumans.feedback.captureSelectedBlocks', 'captureSelectedBlocks'],
    ['markdownForHumans.feedback.toggleComments', 'toggleComments'],
    ['markdownForHumans.feedback.next', 'nextFeedback'],
    ['markdownForHumans.feedback.previous', 'previousFeedback'],
    ['markdownForHumans.feedback.finish', 'finish'],
    ['markdownForHumans.feedback.reveal', 'reveal'],
    ['markdownForHumans.feedback.discard', 'discard'],
  ] as const satisfies ReadonlyArray<readonly [string, FeedbackCommand]>;
  for (const [commandId, command] of feedbackCommands) {
    context.subscriptions.push(
      vscode.commands.registerCommand(commandId, () => {
        const panel = getActiveWebviewPanel();
        if (panel) {
          const message: FeedbackHostMessage = { type: 'feedback.command', command };
          void panel.webview.postMessage(message);
        }
      })
    );
  }
}

export function deactivate() {
  // Cleanup handled by VS Code's subscription disposal
}
