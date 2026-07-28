/**
 * Copyright (c) 2025-2026 Concret.io
 *
 * Licensed under the MIT License. See LICENSE file in the project root for details.
 */

import * as vscode from 'vscode';
import { getActiveWebviewDocument, onDidChangeActiveWebview } from '../activeWebview';

/**
 * Document statistics interface
 */
export interface DocumentStats {
  words: number;
  characters: number;
  charactersNoSpaces: number;
  lines: number;
  paragraphs: number;
  readingTime: number;
}

/**
 * Calculate document statistics from text content
 *
 * This is a pure function that can be easily unit tested.
 * It handles edge cases like empty documents and markdown syntax.
 */
export function calculateStats(text: string): DocumentStats {
  // Handle empty or whitespace-only text
  if (!text || !text.trim()) {
    return {
      words: 0,
      characters: 0,
      charactersNoSpaces: 0,
      lines: text ? text.split('\n').length : 0,
      paragraphs: 0,
      readingTime: 0,
    };
  }

  // Word count: split on whitespace, filter empty strings
  // This handles multiple spaces, tabs, newlines correctly
  const words = text.split(/\s+/).filter(w => w.length > 0).length;

  // Character counts
  const characters = text.length;
  const charactersNoSpaces = text.replace(/\s/g, '').length;

  // Line count (empty document has 1 line)
  const lines = text.split('\n').length;

  // Paragraph count: blocks separated by 2+ newlines
  const paragraphs = text.split(/\n\n+/).filter(p => p.trim()).length;

  // Reading time: average 200 WPM, minimum 1 minute for non-empty docs
  const readingTime = words > 0 ? Math.max(1, Math.ceil(words / 200)) : 0;

  return {
    words,
    characters,
    charactersNoSpaces,
    lines,
    paragraphs,
    readingTime,
  };
}

/**
 * Format stats into a tooltip string
 */
export function formatStatsTooltip(stats: DocumentStats): string {
  return [
    `${stats.characters.toLocaleString()} characters`,
    `${stats.charactersNoSpaces.toLocaleString()} characters (no spaces)`,
    `${stats.lines.toLocaleString()} lines`,
    `${stats.paragraphs.toLocaleString()} paragraphs`,
    `~${stats.readingTime} min read`,
  ].join('\n');
}

/**
 * Check if a document is a markdown file
 */
export function isMarkdownDocument(document: vscode.TextDocument): boolean {
  return document.languageId === 'markdown';
}

/**
 * Word Count Feature for VS Code status bar
 *
 * Shows word count in the status bar for markdown documents.
 * Updates on document changes and shows selection stats when text is selected.
 */
export class WordCountFeature {
  private statusBarItem: vscode.StatusBarItem;
  private disposables: vscode.Disposable[] = [];

  constructor() {
    this.statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      100 // Priority - higher = further left
    );
    this.statusBarItem.command = 'markdownForHumans.showDetailedStats';
  }

  /**
   * Activate the word count feature
   */
  activate(context: vscode.ExtensionContext): void {
    // Register event listeners
    this.disposables.push(
      vscode.workspace.onDidChangeTextDocument(() => this.update()),
      vscode.window.onDidChangeActiveTextEditor(() => this.update()),
      vscode.window.onDidChangeTextEditorSelection(() => this.updateSelection()),
      // Custom-editor webviews don't surface as activeTextEditor, so we react
      // to webview focus changes too — otherwise the status bar stays hidden
      // for the extension's primary use case.
      onDidChangeActiveWebview(() => this.update())
    );

    // Add to subscriptions for cleanup
    context.subscriptions.push(this.statusBarItem, ...this.disposables);

    // Initial update
    this.update();
  }

  /**
   * Resolve the markdown document to count, preferring a regular text editor
   * but falling back to the document hosted by the active custom-editor webview.
   */
  private getActiveMarkdownDocument(): vscode.TextDocument | undefined {
    const editor = vscode.window.activeTextEditor;
    if (editor && isMarkdownDocument(editor.document)) {
      return editor.document;
    }
    const webviewDoc = getActiveWebviewDocument();
    if (webviewDoc && isMarkdownDocument(webviewDoc)) {
      return webviewDoc;
    }
    return undefined;
  }

  /**
   * Update status bar with document stats
   */
  private update(): void {
    const document = this.getActiveMarkdownDocument();
    if (!document) {
      this.statusBarItem.hide();
      return;
    }

    const stats = calculateStats(document.getText());

    this.statusBarItem.text = `$(pencil) ${stats.words.toLocaleString()} words`;
    this.statusBarItem.tooltip = formatStatsTooltip(stats);
    this.statusBarItem.show();
  }

  /**
   * Update status bar with selection stats (when text is selected)
   */
  private updateSelection(): void {
    const editor = vscode.window.activeTextEditor;
    // Selection only applies to regular text editors; custom-editor webviews
    // own their own selection state, so just refresh the full-document count.
    if (!editor || !isMarkdownDocument(editor.document)) {
      this.update();
      return;
    }

    if (editor.selection.isEmpty) {
      this.update();
      return;
    }

    const selectedText = editor.document.getText(editor.selection);
    const stats = calculateStats(selectedText);

    this.statusBarItem.text = `$(pencil) ${stats.words.toLocaleString()} words selected`;
    this.statusBarItem.tooltip = `Selected:\n${formatStatsTooltip(stats)}`;
  }

  /**
   * Show detailed stats in an information message
   */
  showDetailedStats(): void {
    const document = this.getActiveMarkdownDocument();
    if (!document) {
      vscode.window.showInformationMessage('No markdown document open');
      return;
    }

    const stats = calculateStats(document.getText());

    const message = [
      `📊 Document Statistics`,
      `Words: ${stats.words.toLocaleString()}`,
      `Characters: ${stats.characters.toLocaleString()}`,
      `Lines: ${stats.lines.toLocaleString()}`,
      `Paragraphs: ${stats.paragraphs.toLocaleString()}`,
      `Reading time: ~${stats.readingTime} min`,
    ].join(' | ');

    vscode.window.showInformationMessage(message);
  }

  /**
   * Dispose of resources
   */
  dispose(): void {
    this.statusBarItem.dispose();
    this.disposables.forEach(d => d.dispose());
  }
}
