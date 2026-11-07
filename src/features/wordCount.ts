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
 * Chinese and Japanese are written without spaces between words. Word
 * processors count such text by character, so each Han, hiragana and katakana
 * character (and the katakana long vowel mark) counts as one word.
 */
const HAS_UNSPACED_CHARACTER = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\u30fc]/u;
const UNSPACED_CHARACTER = new RegExp(HAS_UNSPACED_CHARACTER.source, 'gu');
const LETTERS_OR_DIGITS = /[\p{L}\p{N}]+/gu;

/** Words read per minute in spaced text, and characters per minute in Chinese and Japanese. */
const WORDS_PER_MINUTE = 200;
const UNSPACED_CHARACTERS_PER_MINUTE = 500;

/**
 * Count words the way a word processor does for mixed text.
 *
 * @param text - Document or selection text
 * @returns `spaced`: whitespace-separated words; `unspaced`: Chinese and Japanese characters
 */
function countWords(text: string): { spaced: number; unspaced: number } {
  const tokens = text.split(/\s+/).filter(token => token.length > 0);
  // Most documents have none of these characters; keep their count exactly as it always was.
  if (!HAS_UNSPACED_CHARACTER.test(text)) {
    return { spaced: tokens.length, unspaced: 0 };
  }

  let spaced = 0;
  let unspaced = 0;
  for (const token of tokens) {
    const characters = token.match(UNSPACED_CHARACTER);
    if (!characters) {
      spaced++;
      continue;
    }
    unspaced += characters.length;
    // Latin words and numbers that touch the characters, as in "打开Markdown文件".
    spaced += token.replace(UNSPACED_CHARACTER, ' ').match(LETTERS_OR_DIGITS)?.length ?? 0;
  }
  return { spaced, unspaced };
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

  // Word count: whitespace-separated words, plus one per Chinese or Japanese character
  const { spaced, unspaced } = countWords(text);
  const words = spaced + unspaced;

  // Character counts
  const characters = text.length;
  const charactersNoSpaces = text.replace(/\s/g, '').length;

  // Line count (empty document has 1 line)
  const lines = text.split('\n').length;

  // Paragraph count: blocks separated by 2+ newlines
  const paragraphs = text.split(/\n\n+/).filter(p => p.trim()).length;

  // Reading time: 200 words a minute, 500 characters a minute for Chinese and Japanese,
  // minimum 1 minute for non-empty docs
  const readingTime =
    words > 0
      ? Math.max(
          1,
          Math.ceil(spaced / WORDS_PER_MINUTE + unspaced / UNSPACED_CHARACTERS_PER_MINUTE)
        )
      : 0;

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
 * Format a count with the digit grouping of VS Code's display language.
 *
 * Node formats with the operating system's locale by default, which can differ
 * from the language the rest of the UI is shown in.
 */
function formatCount(value: number): string {
  try {
    return value.toLocaleString(vscode.env.language || undefined);
  } catch {
    return value.toLocaleString();
  }
}

/**
 * Format stats into a tooltip string
 */
export function formatStatsTooltip(stats: DocumentStats): string {
  return [
    vscode.l10n.t(
      stats.characters === 1 ? '{0} character' : '{0} characters',
      formatCount(stats.characters)
    ),
    vscode.l10n.t(
      stats.charactersNoSpaces === 1 ? '{0} character (no spaces)' : '{0} characters (no spaces)',
      formatCount(stats.charactersNoSpaces)
    ),
    vscode.l10n.t(stats.lines === 1 ? '{0} line' : '{0} lines', formatCount(stats.lines)),
    vscode.l10n.t(
      stats.paragraphs === 1 ? '{0} paragraph' : '{0} paragraphs',
      formatCount(stats.paragraphs)
    ),
    vscode.l10n.t('~{0} min read', stats.readingTime),
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

    this.statusBarItem.text = `$(pencil) ${vscode.l10n.t(stats.words === 1 ? '{0} word' : '{0} words', formatCount(stats.words))}`;
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

    this.statusBarItem.text = `$(pencil) ${vscode.l10n.t(stats.words === 1 ? '{0} word selected' : '{0} words selected', formatCount(stats.words))}`;
    this.statusBarItem.tooltip = vscode.l10n.t('Selected:\n{0}', formatStatsTooltip(stats));
  }

  /**
   * Show detailed stats in an information message
   */
  showDetailedStats(): void {
    const document = this.getActiveMarkdownDocument();
    if (!document) {
      vscode.window.showInformationMessage(vscode.l10n.t('No markdown document open'));
      return;
    }

    const stats = calculateStats(document.getText());

    const message = [
      vscode.l10n.t('📊 Document Statistics'),
      vscode.l10n.t('Words: {0}', formatCount(stats.words)),
      vscode.l10n.t('Characters: {0}', formatCount(stats.characters)),
      vscode.l10n.t('Lines: {0}', formatCount(stats.lines)),
      vscode.l10n.t('Paragraphs: {0}', formatCount(stats.paragraphs)),
      vscode.l10n.t('Reading time: ~{0} min', stats.readingTime),
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
