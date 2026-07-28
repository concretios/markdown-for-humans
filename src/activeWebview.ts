/**
 * Copyright (c) 2025-2026 Concret.io
 *
 * Licensed under the MIT License. See LICENSE file in the project root for details.
 */

import * as vscode from 'vscode';

let activeWebviewPanel: vscode.WebviewPanel | undefined;
let activeWebviewDocument: vscode.TextDocument | undefined;

const activeChangeEmitter = new vscode.EventEmitter<void>();
export const onDidChangeActiveWebview = activeChangeEmitter.event;

function setActiveContext(isActive: boolean) {
  vscode.commands.executeCommand('setContext', 'markdownForHumans.isActive', isActive);
}

export function setActiveWebviewPanel(
  panel: vscode.WebviewPanel | undefined,
  document?: vscode.TextDocument
) {
  activeWebviewPanel = panel;
  activeWebviewDocument = panel ? document : undefined;
  setActiveContext(!!panel);
  activeChangeEmitter.fire();
}

export function getActiveWebviewPanel(): vscode.WebviewPanel | undefined {
  return activeWebviewPanel;
}

export function getActiveWebviewDocument(): vscode.TextDocument | undefined {
  return activeWebviewDocument;
}
