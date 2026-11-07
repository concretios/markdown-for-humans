/**
 * Word Count Feature Tests
 *
 * Tests the pure logic functions (calculateStats, formatStatsTooltip)
 * and the WordCountFeature class using VS Code API mocks.
 */

import {
  calculateStats,
  formatStatsTooltip,
  DocumentStats,
  WordCountFeature,
  isMarkdownDocument,
} from '../../features/wordCount';
import * as vscode from 'vscode';
import {
  window,
  workspace,
  createMockTextDocument,
  createMockTextEditor,
  mockStatusBarItem,
  Selection,
} from '../../__mocks__/vscode';

describe('calculateStats', () => {
  describe('word counting', () => {
    it('should count words in simple text', () => {
      const stats = calculateStats('Hello world');
      expect(stats.words).toBe(2);
    });

    it('should handle multiple spaces between words', () => {
      const stats = calculateStats('Hello    world');
      expect(stats.words).toBe(2);
    });

    it('should handle tabs and newlines as word separators', () => {
      const stats = calculateStats('Hello\tworld\nfoo bar');
      expect(stats.words).toBe(4);
    });

    it('should count hyphenated words as single words', () => {
      const stats = calculateStats('well-known fact');
      expect(stats.words).toBe(2);
    });

    it('should handle markdown formatting', () => {
      const stats = calculateStats('**bold** and *italic* text');
      expect(stats.words).toBe(4);
    });

    it('should count words with numbers', () => {
      const stats = calculateStats('There are 42 answers');
      expect(stats.words).toBe(4);
    });

    it('should handle contractions', () => {
      const stats = calculateStats("don't can't won't");
      expect(stats.words).toBe(3);
    });
  });

  describe('empty and whitespace-only text', () => {
    it('should return zeros for empty string', () => {
      const stats = calculateStats('');
      expect(stats.words).toBe(0);
      expect(stats.characters).toBe(0);
      expect(stats.charactersNoSpaces).toBe(0);
      expect(stats.paragraphs).toBe(0);
      expect(stats.readingTime).toBe(0);
    });

    it('should return zeros for whitespace-only string', () => {
      const stats = calculateStats('   \t\n  ');
      expect(stats.words).toBe(0);
      expect(stats.paragraphs).toBe(0);
      expect(stats.readingTime).toBe(0);
    });

    it('should count lines in whitespace-only string', () => {
      const stats = calculateStats('\n\n\n');
      expect(stats.lines).toBe(4); // 3 newlines = 4 lines
    });
  });

  describe('character counting', () => {
    it('should count all characters including spaces', () => {
      const stats = calculateStats('Hello world');
      expect(stats.characters).toBe(11);
    });

    it('should count characters without spaces', () => {
      const stats = calculateStats('Hello world');
      expect(stats.charactersNoSpaces).toBe(10);
    });

    it('should handle unicode characters', () => {
      const stats = calculateStats('Hello 世界');
      expect(stats.characters).toBe(8);
      expect(stats.charactersNoSpaces).toBe(7);
    });

    it('should count emojis', () => {
      const stats = calculateStats('Hello 👋 world');
      // Note: emoji may count as 2 chars due to JS string handling
      expect(stats.words).toBe(3);
    });
  });

  describe('line counting', () => {
    it('should count single line', () => {
      const stats = calculateStats('Hello world');
      expect(stats.lines).toBe(1);
    });

    it('should count multiple lines', () => {
      const stats = calculateStats('Line 1\nLine 2\nLine 3');
      expect(stats.lines).toBe(3);
    });

    it('should count empty lines', () => {
      const stats = calculateStats('Line 1\n\nLine 3');
      expect(stats.lines).toBe(3);
    });

    it('should handle trailing newline', () => {
      const stats = calculateStats('Line 1\nLine 2\n');
      expect(stats.lines).toBe(3);
    });
  });

  describe('paragraph counting', () => {
    it('should count single paragraph', () => {
      const stats = calculateStats('This is a paragraph.');
      expect(stats.paragraphs).toBe(1);
    });

    it('should count multiple paragraphs', () => {
      const stats = calculateStats('Paragraph 1.\n\nParagraph 2.\n\nParagraph 3.');
      expect(stats.paragraphs).toBe(3);
    });

    it('should handle multiple blank lines between paragraphs', () => {
      const stats = calculateStats('Paragraph 1.\n\n\n\nParagraph 2.');
      expect(stats.paragraphs).toBe(2);
    });

    it('should not count blank paragraphs', () => {
      const stats = calculateStats('Paragraph 1.\n\n   \n\nParagraph 2.');
      expect(stats.paragraphs).toBe(2);
    });
  });

  describe('text written without spaces between words', () => {
    // Word processors count one per Chinese or Japanese character, plus the other words.
    it('counts each Chinese character', () => {
      expect(calculateStats('我喜欢吃苹果，你喜欢吃什么水果？').words).toBe(14);
    });

    it('counts each Japanese character, kana and kanji alike', () => {
      expect(calculateStats('今日は天気がいいので、公園を散歩しましょう。').words).toBe(20);
      // The long vowel mark is part of the word, as in エディター.
      expect(calculateStats('このエディターはマークダウンファイルを開きます。').words).toBe(23);
    });

    it('adds the spaced words of mixed text to the characters', () => {
      expect(calculateStats('使用 VS Code 打开 Markdown 文件，然后点击 Export 按钮。').words).toBe(
        16
      );
      expect(calculateStats('VS Code で Markdown ファイルを開きます。').words).toBe(13);
    });

    it('finds Latin words that touch Chinese characters without a space', () => {
      expect(calculateStats('打开Markdown文件').words).toBe(5);
      expect(calculateStats('共有3个文件').words).toBe(6);
    });

    it('does not count punctuation or Markdown markers around the characters', () => {
      expect(calculateStats('**你好**，世界！').words).toBe(4);
      expect(calculateStats('「こんにちは」').words).toBe(5);
    });

    it('still counts Korean by its spaces', () => {
      expect(calculateStats('오늘은 날씨가 좋아서 공원에 갑니다.').words).toBe(5);
    });

    it.each([
      ['A well-known, state-of-the-art approach', 4],
      ['See https://example.com/docs/page?id=1 for details', 4],
      ['**bold** and *italic* with `code` and [a link](http://x.y)', 8],
      ['const x = foo.bar(baz); // done', 6],
      ['mail a.b@c.com or open src/app/main.ts', 5],
      ['Сегодня хорошая погода, пойдём гулять.', 5],
    ])('leaves the count of spaced text unchanged: %s', (text, expected) => {
      expect(calculateStats(text).words).toBe(expected);
    });

    it('estimates reading time at 500 characters a minute, added to the time for other words', () => {
      expect(calculateStats('字'.repeat(400)).readingTime).toBe(1);
      expect(calculateStats('字'.repeat(1000)).readingTime).toBe(2);
      // 200 words (1 minute) plus 500 characters (1 minute)
      const mixed = `${Array(200).fill('word').join(' ')} ${'字'.repeat(500)}`;
      expect(calculateStats(mixed).readingTime).toBe(2);
      expect(calculateStats(`${mixed} ${'字'.repeat(10)}`).readingTime).toBe(3);
    });
  });

  describe('reading time calculation', () => {
    it('should calculate 1 minute for short text', () => {
      const stats = calculateStats('A short sentence.');
      expect(stats.readingTime).toBe(1);
    });

    it('should calculate correct time for longer text', () => {
      // 400 words should be 2 minutes at 200 WPM
      const words = Array(400).fill('word').join(' ');
      const stats = calculateStats(words);
      expect(stats.readingTime).toBe(2);
    });

    it('should round up reading time', () => {
      // 250 words should round up to 2 minutes
      const words = Array(250).fill('word').join(' ');
      const stats = calculateStats(words);
      expect(stats.readingTime).toBe(2);
    });

    it('should return 0 for empty text', () => {
      const stats = calculateStats('');
      expect(stats.readingTime).toBe(0);
    });
  });

  describe('real-world markdown documents', () => {
    it('should handle a typical markdown document', () => {
      const markdown = `# Heading

This is a paragraph with **bold** and *italic* text.

## Subheading

- List item 1
- List item 2
- List item 3

\`\`\`javascript
const code = "example";
\`\`\`

Another paragraph here.`;

      const stats = calculateStats(markdown);

      expect(stats.words).toBeGreaterThan(10);
      expect(stats.paragraphs).toBeGreaterThan(3);
      expect(stats.lines).toBeGreaterThan(10);
    });

    it('should handle document with frontmatter', () => {
      const markdown = `---
title: My Document
date: 2024-01-01
---

# My Document

Content here.`;

      const stats = calculateStats(markdown);

      // Frontmatter YAML counts as words/paragraphs
      expect(stats.words).toBeGreaterThan(5);
      expect(stats.paragraphs).toBeGreaterThan(2);
    });
  });
});

describe('formatStatsTooltip', () => {
  it('should format stats into readable tooltip', () => {
    const stats: DocumentStats = {
      words: 1234,
      characters: 5678,
      charactersNoSpaces: 4444,
      lines: 100,
      paragraphs: 25,
      readingTime: 6,
    };

    const tooltip = formatStatsTooltip(stats);

    expect(tooltip).toContain('5,678 characters');
    expect(tooltip).toContain('4,444 characters (no spaces)');
    expect(tooltip).toContain('100 lines');
    expect(tooltip).toContain('25 paragraphs');
    expect(tooltip).toContain('~6 min read');
  });

  it('groups digits the way the display language does', () => {
    const env = vscode.env as unknown as { language?: string };
    const original = env.language;
    env.language = 'de';
    try {
      const tooltip = formatStatsTooltip({
        words: 1234,
        characters: 5678,
        charactersNoSpaces: 4444,
        lines: 100,
        paragraphs: 25,
        readingTime: 6,
      });
      expect(tooltip).toContain('5.678 characters');
    } finally {
      env.language = original;
    }
  });

  it('uses the singular for a count of exactly one', () => {
    const tooltip = formatStatsTooltip({
      words: 1,
      characters: 1,
      charactersNoSpaces: 1,
      lines: 1,
      paragraphs: 1,
      readingTime: 1,
    });

    expect(tooltip.split('\n')).toEqual([
      '1 character',
      '1 character (no spaces)',
      '1 line',
      '1 paragraph',
      '~1 min read',
    ]);
  });

  it('should handle zero values', () => {
    const stats: DocumentStats = {
      words: 0,
      characters: 0,
      charactersNoSpaces: 0,
      lines: 0,
      paragraphs: 0,
      readingTime: 0,
    };

    const tooltip = formatStatsTooltip(stats);

    expect(tooltip).toContain('0 characters');
    expect(tooltip).toContain('0 lines');
  });

  it('should use locale-aware number formatting', () => {
    const stats: DocumentStats = {
      words: 1000000,
      characters: 5000000,
      charactersNoSpaces: 4000000,
      lines: 50000,
      paragraphs: 10000,
      readingTime: 5000,
    };

    const tooltip = formatStatsTooltip(stats);

    // Should have thousands separators (locale-dependent)
    // Handles both Western (5,000,000) and Indian (50,00,000) numbering systems
    // Match either format: "5,000,000" (Western) or "50,00,000" (Indian) or "5.000.000" (European)
    expect(tooltip).toMatch(/(5,000,000|50,00,000|5\.000\.000|5000000) characters/);
  });
});

describe('edge cases', () => {
  it('should handle very long lines', () => {
    const longLine = 'word '.repeat(10000);
    const stats = calculateStats(longLine);
    expect(stats.words).toBe(10000);
    expect(stats.lines).toBe(1);
  });

  it('should handle many short lines', () => {
    const manyLines = Array(10000).fill('word').join('\n');
    const stats = calculateStats(manyLines);
    expect(stats.lines).toBe(10000);
  });

  it('should handle mixed whitespace', () => {
    const mixed = 'word\t\n  \t\nword';
    const stats = calculateStats(mixed);
    expect(stats.words).toBe(2);
  });

  it('should handle non-ASCII text', () => {
    const japanese = 'これは日本語のテキストです。';
    const stats = calculateStats(japanese);
    // Each character separated by empty string counts as 1 "word" with current impl
    expect(stats.characters).toBe(14);
  });
});

describe('isMarkdownDocument', () => {
  it('should return true for markdown documents', () => {
    const doc = createMockTextDocument('# Hello', 'markdown');
    expect(isMarkdownDocument(doc)).toBe(true);
  });

  it('should return false for non-markdown documents', () => {
    const doc = createMockTextDocument('const x = 1;', 'javascript');
    expect(isMarkdownDocument(doc)).toBe(false);
  });

  it('should return false for plaintext documents', () => {
    const doc = createMockTextDocument('Hello world', 'plaintext');
    expect(isMarkdownDocument(doc)).toBe(false);
  });
});

describe('WordCountFeature', () => {
  let feature: WordCountFeature;
  let mockContext: {
    subscriptions: { push: jest.Mock };
  };

  beforeEach(() => {
    feature = new WordCountFeature();
    mockContext = {
      subscriptions: { push: jest.fn() },
    };
    // Reset window mock
    window.activeTextEditor = undefined;
  });

  afterEach(() => {
    feature.dispose();
  });

  describe('activate', () => {
    it('should register status bar item', () => {
      feature.activate(mockContext as unknown as vscode.ExtensionContext);

      // Should have registered status bar and event listeners
      expect(mockContext.subscriptions.push).toHaveBeenCalled();
      expect(vscode.window.createStatusBarItem).toHaveBeenCalledWith(
        vscode.StatusBarAlignment.Right,
        100
      );
    });

    it('should register event listeners', () => {
      feature.activate(mockContext as unknown as vscode.ExtensionContext);

      expect(workspace.onDidChangeTextDocument).toHaveBeenCalled();
      expect(window.onDidChangeActiveTextEditor).toHaveBeenCalled();
      expect(window.onDidChangeTextEditorSelection).toHaveBeenCalled();
    });
  });

  describe('status bar updates', () => {
    it('should hide status bar when no editor is active', () => {
      window.activeTextEditor = undefined;

      feature.activate(mockContext as unknown as vscode.ExtensionContext);

      // The update method should have been called, hiding the status bar
      expect(mockStatusBarItem.hide).toHaveBeenCalled();
    });

    it('should hide status bar for non-markdown files', () => {
      const doc = createMockTextDocument('const x = 1;', 'javascript');
      window.activeTextEditor = createMockTextEditor(doc);

      feature.activate(mockContext as unknown as vscode.ExtensionContext);

      expect(mockStatusBarItem.hide).toHaveBeenCalled();
    });

    it('should show word count for markdown files', () => {
      const doc = createMockTextDocument('Hello world foo bar', 'markdown');
      window.activeTextEditor = createMockTextEditor(doc);

      feature.activate(mockContext as unknown as vscode.ExtensionContext);

      expect(mockStatusBarItem.show).toHaveBeenCalled();
      expect(mockStatusBarItem.text).toContain('words');
    });
  });

  describe('showDetailedStats', () => {
    it('should show info message when no markdown document is open', () => {
      window.activeTextEditor = undefined;

      feature.showDetailedStats();

      expect(window.showInformationMessage).toHaveBeenCalledWith('No markdown document open');
    });

    it('should show the translated message when VS Code has one', () => {
      window.activeTextEditor = undefined;
      (vscode.l10n.t as jest.Mock).mockReturnValueOnce('没有打开的 Markdown 文档');

      feature.showDetailedStats();

      expect(vscode.l10n.t).toHaveBeenCalledWith('No markdown document open');
      expect(window.showInformationMessage).toHaveBeenCalledWith('没有打开的 Markdown 文档');
    });

    it('should show stats for markdown document', () => {
      const doc = createMockTextDocument('Hello world test', 'markdown');
      window.activeTextEditor = createMockTextEditor(doc);

      feature.showDetailedStats();

      expect(window.showInformationMessage).toHaveBeenCalled();
      const message = (window.showInformationMessage as jest.Mock).mock.calls[0][0];
      expect(message).toContain('Document Statistics');
      expect(message).toContain('Words');
    });
  });

  describe('dispose', () => {
    it('should dispose of status bar item', () => {
      feature.activate(mockContext as unknown as vscode.ExtensionContext);
      feature.dispose();

      expect(mockStatusBarItem.dispose).toHaveBeenCalled();
    });
  });
});

describe('WordCountFeature localization', () => {
  const translate = vscode.l10n.t as jest.Mock;
  const englishTranslate = translate.getMockImplementation();
  // Leaves out "Lines: {0}" on purpose, to exercise the fallback to English.
  const sampleBundle: Record<string, string> = {
    '{0} words': '{0} 个词',
    '{0} words selected': '已选中 {0} 个词',
    '{0} characters': '{0} 个字符',
    '{0} characters (no spaces)': '{0} 个字符（不含空格）',
    '{0} lines': '{0} 行',
    '{0} paragraphs': '{0} 段',
    '~{0} min read': '约 {0} 分钟阅读',
    'Selected:\n{0}': '已选中：\n{0}',
    '📊 Document Statistics': '📊 文档统计',
    'Words: {0}': '词数：{0}',
    'Characters: {0}': '字符数：{0}',
    'Paragraphs: {0}': '段落数：{0}',
    'Reading time: ~{0} min': '阅读时间：约 {0} 分钟',
  };
  let feature: WordCountFeature;
  const mockContext = { subscriptions: { push: jest.fn() } } as unknown as vscode.ExtensionContext;

  beforeEach(() => {
    translate.mockImplementation((message: string, ...args: Array<string | number | boolean>) =>
      (sampleBundle[message] ?? message).replace(/\{(\d+)\}/g, (placeholder, index: string) =>
        args[Number(index)] === undefined ? placeholder : String(args[Number(index)])
      )
    );
    feature = new WordCountFeature();
  });

  afterEach(() => {
    feature.dispose();
    translate.mockImplementation(englishTranslate);
    window.activeTextEditor = undefined;
  });

  it('shows the translated count and tooltip, keeping the icon prefix', () => {
    const doc = createMockTextDocument('Hello world foo bar', 'markdown');
    window.activeTextEditor = createMockTextEditor(doc);

    feature.activate(mockContext);

    expect(mockStatusBarItem.text).toBe('$(pencil) 4 个词');
    expect(mockStatusBarItem.tooltip).toContain('19 个字符');
    expect(mockStatusBarItem.tooltip).toContain('约 1 分钟阅读');
  });

  it('shows the translated selection count and tooltip', () => {
    const doc = createMockTextDocument('Hello world foo bar', 'markdown');
    window.activeTextEditor = createMockTextEditor(
      doc,
      new Selection({ line: 0, character: 0 }, { line: 0, character: 5 })
    );
    feature.activate(mockContext);
    const onSelectionChange = (window.onDidChangeTextEditorSelection as jest.Mock).mock
      .calls[0][0] as () => void;

    onSelectionChange();

    expect(mockStatusBarItem.text).toBe('$(pencil) 已选中 4 个词');
    expect(String(mockStatusBarItem.tooltip).startsWith('已选中：\n19 个字符')).toBe(true);
  });

  it('shows the translated detailed statistics', () => {
    const doc = createMockTextDocument('Hello world test', 'markdown');
    window.activeTextEditor = createMockTextEditor(doc);

    feature.showDetailedStats();

    expect(window.showInformationMessage).toHaveBeenCalledWith(
      '📊 文档统计 | 词数：3 | 字符数：16 | Lines: 1 | 段落数：1 | 阅读时间：约 1 分钟'
    );
  });
});
