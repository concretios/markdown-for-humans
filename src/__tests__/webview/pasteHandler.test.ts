/**
 * Tests for pasteHandler - HTML to Markdown conversion
 *
 * Tests the smart paste functionality that converts HTML from clipboard
 * to clean markdown for insertion into the editor.
 */

import {
  htmlToMarkdown,
  hasHtmlContent,
  hasImageContent,
  getPlainText,
  getHtmlContent,
  processPasteContent,
  isRichHtml,
  looksLikeMarkdown,
  markdownToHtml,
  parseFencedCode,
} from '../../webview/utils/pasteHandler';

describe('pasteHandler', () => {
  describe('htmlToMarkdown', () => {
    it('should return empty string for empty input', () => {
      expect(htmlToMarkdown('')).toBe('');
      expect(htmlToMarkdown('   ')).toBe('');
    });

    it('should convert basic formatting', () => {
      expect(htmlToMarkdown('<strong>bold</strong>')).toBe('**bold**');
      expect(htmlToMarkdown('<b>bold</b>')).toBe('**bold**');
      expect(htmlToMarkdown('<em>italic</em>')).toBe('*italic*');
      expect(htmlToMarkdown('<i>italic</i>')).toBe('*italic*');
    });

    it('should convert strikethrough', () => {
      expect(htmlToMarkdown('<del>deleted</del>')).toBe('~~deleted~~');
      expect(htmlToMarkdown('<s>strikethrough</s>')).toBe('~~strikethrough~~');
      expect(htmlToMarkdown('<strike>strike</strike>')).toBe('~~strike~~');
    });

    it('should convert headings to ATX style', () => {
      expect(htmlToMarkdown('<h1>Heading 1</h1>')).toBe('# Heading 1');
      expect(htmlToMarkdown('<h2>Heading 2</h2>')).toBe('## Heading 2');
      expect(htmlToMarkdown('<h3>Heading 3</h3>')).toBe('### Heading 3');
      expect(htmlToMarkdown('<h4>Heading 4</h4>')).toBe('#### Heading 4');
      expect(htmlToMarkdown('<h5>Heading 5</h5>')).toBe('##### Heading 5');
      expect(htmlToMarkdown('<h6>Heading 6</h6>')).toBe('###### Heading 6');
    });

    it('should convert unordered lists', () => {
      const html = '<ul><li>Item 1</li><li>Item 2</li><li>Item 3</li></ul>';
      const result = htmlToMarkdown(html);
      // Check for list markers and content (whitespace may vary)
      expect(result).toMatch(/-\s+Item 1/);
      expect(result).toMatch(/-\s+Item 2/);
      expect(result).toMatch(/-\s+Item 3/);
    });

    it('should convert ordered lists', () => {
      const html = '<ol><li>First</li><li>Second</li><li>Third</li></ol>';
      const result = htmlToMarkdown(html);
      expect(result).toContain('1.');
      expect(result).toContain('First');
      expect(result).toContain('Second');
      expect(result).toContain('Third');
    });

    it('should convert links', () => {
      expect(htmlToMarkdown('<a href="https://example.com">Example</a>')).toBe(
        '[Example](https://example.com)'
      );
    });

    it('should convert inline code', () => {
      expect(htmlToMarkdown('<code>inline code</code>')).toBe('`inline code`');
    });

    it('should convert code blocks', () => {
      const html = '<pre><code class="language-javascript">const x = 1;</code></pre>';
      const result = htmlToMarkdown(html);
      expect(result).toContain('```javascript');
      expect(result).toContain('const x = 1;');
      expect(result).toContain('```');
    });

    it('should convert blockquotes', () => {
      expect(htmlToMarkdown('<blockquote>Quote text</blockquote>')).toBe('> Quote text');
    });

    it('should convert paragraphs', () => {
      const html = '<p>First paragraph</p><p>Second paragraph</p>';
      const result = htmlToMarkdown(html);
      expect(result).toContain('First paragraph');
      expect(result).toContain('Second paragraph');
    });

    it('should handle nested formatting', () => {
      expect(htmlToMarkdown('<strong><em>bold italic</em></strong>')).toBe('***bold italic***');
    });

    it('should remove script and style tags', () => {
      const html = '<script>alert("xss")</script><p>Content</p><style>.foo{}</style>';
      const result = htmlToMarkdown(html);
      expect(result).toBe('Content');
      expect(result).not.toContain('script');
      expect(result).not.toContain('alert');
      expect(result).not.toContain('style');
    });

    it('should handle Word-specific markup', () => {
      const html = '<!--[if gte mso 9]>Word stuff<![endif]--><p>Real content</p>';
      const result = htmlToMarkdown(html);
      expect(result).toBe('Real content');
      expect(result).not.toContain('mso');
    });

    it('should remove excessive blank lines', () => {
      const html = '<p>Line 1</p><p></p><p></p><p></p><p>Line 2</p>';
      const result = htmlToMarkdown(html);
      // Should not have more than 2 consecutive newlines
      expect(result).not.toMatch(/\n{3,}/);
    });

    it('should handle complex Google Docs content', () => {
      const html = `
        <span style="font-weight:700">Bold text</span>
        <span style="font-style:italic">Italic text</span>
        <a href="https://google.com">Link</a>
      `;
      const result = htmlToMarkdown(html);
      expect(result).toContain('Bold text');
      expect(result).toContain('Italic text');
      expect(result).toContain('[Link](https://google.com)');
    });
  });

  describe('hasHtmlContent', () => {
    it('should return false for null', () => {
      expect(hasHtmlContent(null)).toBe(false);
    });

    it('should return false for empty HTML', () => {
      const mockDataTransfer = createMockDataTransfer({ 'text/html': '' });
      expect(hasHtmlContent(mockDataTransfer)).toBe(false);
    });

    it('should return true for HTML content', () => {
      const mockDataTransfer = createMockDataTransfer({ 'text/html': '<p>Hello</p>' });
      expect(hasHtmlContent(mockDataTransfer)).toBe(true);
    });
  });

  describe('hasImageContent', () => {
    it('should return false for null', () => {
      expect(hasImageContent(null)).toBe(false);
    });

    it('should return false for non-image content', () => {
      const mockDataTransfer = createMockDataTransfer({ 'text/plain': 'Hello' });
      expect(hasImageContent(mockDataTransfer)).toBe(false);
    });

    it('should return true for image content', () => {
      const mockDataTransfer = createMockDataTransferWithImage();
      expect(hasImageContent(mockDataTransfer)).toBe(true);
    });
  });

  describe('getPlainText', () => {
    it('should return empty string for null', () => {
      expect(getPlainText(null)).toBe('');
    });

    it('should return plain text content', () => {
      const mockDataTransfer = createMockDataTransfer({ 'text/plain': 'Hello World' });
      expect(getPlainText(mockDataTransfer)).toBe('Hello World');
    });
  });

  describe('getHtmlContent', () => {
    it('should return empty string for null', () => {
      expect(getHtmlContent(null)).toBe('');
    });

    it('should return HTML content', () => {
      const mockDataTransfer = createMockDataTransfer({ 'text/html': '<p>Hello</p>' });
      expect(getHtmlContent(mockDataTransfer)).toBe('<p>Hello</p>');
    });
  });

  describe('processPasteContent', () => {
    it('should return empty result for null', () => {
      const result = processPasteContent(null);
      expect(result).toEqual({ content: '', wasConverted: false, isImage: false, isHtml: false });
    });

    it('should detect image content', () => {
      const mockDataTransfer = createMockDataTransferWithImage();
      const result = processPasteContent(mockDataTransfer);
      expect(result.isImage).toBe(true);
      expect(result.wasConverted).toBe(false);
    });

    it('should convert HTML to HTML (via markdown normalization)', () => {
      const mockDataTransfer = createMockDataTransfer({
        'text/html': '<strong>Bold</strong> and <em>italic</em>',
        'text/plain': 'Bold and italic',
      });
      const result = processPasteContent(mockDataTransfer);
      expect(result.wasConverted).toBe(true);
      expect(result.isHtml).toBe(true);
      expect(result.content).toContain('<strong>'); // HTML output
      expect(result.isImage).toBe(false);
    });

    it('should fall back to plain text if no HTML and not markdown', () => {
      const mockDataTransfer = createMockDataTransfer({
        'text/plain': 'Just plain text',
      });
      const result = processPasteContent(mockDataTransfer);
      expect(result.wasConverted).toBe(false);
      expect(result.isHtml).toBe(false);
      expect(result.content).toBe('Just plain text');
    });

    it('should convert markdown tables to HTML', () => {
      const mockDataTransfer = createMockDataTransfer({
        'text/plain': '| A | B |\n| --- | --- |\n| 1 | 2 |',
      });
      const result = processPasteContent(mockDataTransfer);
      expect(result.wasConverted).toBe(true);
      expect(result.isHtml).toBe(true);
      // Tables rendered from pipe syntax carry a marker so HtmlPreservingTable
      // knows not to save them back as HTML.
      expect(result.content).toContain('<table data-markdown-table="true">');
    });

    it('should convert markdown lists to HTML', () => {
      const mockDataTransfer = createMockDataTransfer({
        'text/plain': '- Item 1\n- Item 2\n- Item 3',
      });
      const result = processPasteContent(mockDataTransfer);
      expect(result.wasConverted).toBe(true);
      expect(result.isHtml).toBe(true);
      expect(result.content).toContain('<ul>');
      expect(result.content).toContain('<li>');
    });

    it('should use plain text when HTML is just a wrapper', () => {
      // VS Code often wraps plain text in spans - should use plain text
      const mockDataTransfer = createMockDataTransfer({
        'text/html': '<span>Plain text content</span>',
        'text/plain': 'Plain text content',
      });
      const result = processPasteContent(mockDataTransfer);
      expect(result.wasConverted).toBe(false);
      expect(result.isHtml).toBe(false);
      expect(result.content).toBe('Plain text content');
    });

    it('should preserve raw HTML source as plain text (no conversion)', () => {
      const htmlSource = [
        '<!DOCTYPE html>',
        '<html>',
        '<head><style>.sq-table { border-collapse: collapse; }</style></head>',
        '<body>',
        '<table class="sq-table"><tr><th>Name</th><th>Age</th></tr></table>',
        '</body>',
        '</html>',
      ].join('\n');

      const mockDataTransfer = createMockDataTransfer({
        'text/html': htmlSource,
        'text/plain': htmlSource,
      });

      const result = processPasteContent(mockDataTransfer);
      expect(result.wasConverted).toBe(false);
      expect(result.isHtml).toBe(false);
      expect(result.content).toBe(htmlSource);
    });
  });

  describe('looksLikeMarkdown', () => {
    it('should return false for empty input', () => {
      expect(looksLikeMarkdown('')).toBe(false);
    });

    it('should detect tables', () => {
      expect(looksLikeMarkdown('| A | B |')).toBe(true);
      expect(looksLikeMarkdown('| --- | --- |')).toBe(true);
    });

    it('should detect lists', () => {
      expect(looksLikeMarkdown('- Item')).toBe(true);
      expect(looksLikeMarkdown('* Item')).toBe(true);
      expect(looksLikeMarkdown('1. Item')).toBe(true);
    });

    it('should detect headers', () => {
      expect(looksLikeMarkdown('# Header')).toBe(true);
      expect(looksLikeMarkdown('## Header')).toBe(true);
    });

    it('should detect bold/italic', () => {
      expect(looksLikeMarkdown('**bold**')).toBe(true);
      expect(looksLikeMarkdown('*italic*')).toBe(true);
    });

    it('should detect code', () => {
      expect(looksLikeMarkdown('`code`')).toBe(true);
      expect(looksLikeMarkdown('```\ncode\n```')).toBe(true);
    });

    it('should detect links', () => {
      expect(looksLikeMarkdown('[link](url)')).toBe(true);
    });

    it('should return false for plain text', () => {
      expect(looksLikeMarkdown('Just plain text')).toBe(false);
      expect(looksLikeMarkdown('Hello world')).toBe(false);
    });
  });

  describe('markdownToHtml', () => {
    it('should return empty for empty input', () => {
      expect(markdownToHtml('')).toBe('');
    });

    it('should convert tables', () => {
      const md = '| A | B |\n| --- | --- |\n| 1 | 2 |';
      const html = markdownToHtml(md);
      expect(html).toContain('<table data-markdown-table="true">');
      expect(html).toContain('<th>');
      expect(html).toContain('<td>');
    });

    it('should convert lists', () => {
      const html = markdownToHtml('- Item 1\n- Item 2');
      expect(html).toContain('<ul>');
      expect(html).toContain('<li>');
    });

    it('should convert headers', () => {
      expect(markdownToHtml('# Header')).toContain('<h1>');
      expect(markdownToHtml('## Header')).toContain('<h2>');
    });

    // Regression tests for P1 newline rendering bug
    describe('single newline preservation (breaks: true)', () => {
      it('should convert single newlines to <br> in plain text blocks', () => {
        const md = 'Line 1\nLine 2\nLine 3';
        const html = markdownToHtml(md);
        // Single newlines should become <br> tags
        expect(html).toContain('<br>');
        expect(html).toContain('Line 1');
        expect(html).toContain('Line 2');
        expect(html).toContain('Line 3');
      });

      it('should preserve newlines in email subject options (real-world example)', () => {
        const md = `Subject Option 1: Markdown is broken. I fixed it.
Subject Option 2: Stop writing raw Markdown (seriously)
Subject Option 3: Write Markdown like a human 🧠`;
        const html = markdownToHtml(md);
        // Each line should be separated by <br>, not collapsed into one paragraph
        expect(html).toContain('<br>');
        expect(html).toContain('Subject Option 1');
        expect(html).toContain('Subject Option 2');
        expect(html).toContain('Subject Option 3');
        // Should NOT be one long paragraph without breaks
        expect(html).not.toMatch(/Subject Option 1.*Subject Option 2.*Subject Option 3(?!.*<br>)/);
      });

      it('should still create paragraph breaks for double newlines', () => {
        const md = 'Paragraph 1\n\nParagraph 2';
        const html = markdownToHtml(md);
        // Double newlines should create separate paragraphs
        expect(html).toMatch(/<p>.*Paragraph 1.*<\/p>/);
        expect(html).toMatch(/<p>.*Paragraph 2.*<\/p>/);
      });

      it('should not affect list rendering', () => {
        const md = '- Item 1\n- Item 2\n- Item 3';
        const html = markdownToHtml(md);
        // Lists should render as lists, not have <br> between items
        expect(html).toContain('<ul>');
        expect(html).toContain('<li>');
        // Each item should be a separate <li>
        expect(html.match(/<li>/g)?.length).toBe(3);
      });

      it('should not affect heading rendering', () => {
        const md = '# Heading 1\n\n## Heading 2';
        const html = markdownToHtml(md);
        expect(html).toContain('<h1>');
        expect(html).toContain('<h2>');
      });
    });
  });

  describe('isRichHtml', () => {
    it('should return false for empty inputs', () => {
      expect(isRichHtml('', '')).toBe(false);
      expect(isRichHtml('<p>test</p>', '')).toBe(false);
      expect(isRichHtml('', 'test')).toBe(false);
    });

    it('should return false when HTML is just a span wrapper', () => {
      expect(isRichHtml('<span>Hello world</span>', 'Hello world')).toBe(false);
      expect(isRichHtml('<div>Simple text</div>', 'Simple text')).toBe(false);
    });

    it('should return true when HTML has formatting tags', () => {
      expect(isRichHtml('<strong>Bold text</strong>', 'Bold text')).toBe(true);
      expect(isRichHtml('<em>Italic text</em>', 'Italic text')).toBe(true);
      expect(isRichHtml('<a href="url">Link</a>', 'Link')).toBe(true);
      expect(isRichHtml('<ul><li>Item</li></ul>', 'Item')).toBe(true);
      expect(isRichHtml('<h1>Heading</h1>', 'Heading')).toBe(true);
    });

    it('should return false when HTML text matches plain text', () => {
      // When normalized text content is the same, prefer plain text
      expect(isRichHtml('<p>Para 1</p><p>Para 2</p>', 'Para 1 Para 2')).toBe(false);
      expect(isRichHtml('<div>Same text</div>', 'Same text')).toBe(false);
    });

    it('should return true when HTML text differs from plain text', () => {
      // When HTML has extra content not in plain text
      expect(isRichHtml('<p>Extra <span>content</span> here</p>', 'Different text')).toBe(true);
    });

    it('should return true for code blocks', () => {
      expect(isRichHtml('<pre><code>const x = 1;</code></pre>', 'const x = 1;')).toBe(true);
    });

    it('should return false when plain text is raw HTML source', () => {
      const htmlSource = '<table class="sq-table"><tr><td>Alice</td></tr></table>';
      expect(isRichHtml(htmlSource, htmlSource)).toBe(false);
    });
  });

  describe('parseFencedCode', () => {
    it('should parse triple backtick fenced code with language', () => {
      const code = '```javascript\nconst x = 1;\n```';
      const result = parseFencedCode(code);
      expect(result).toEqual({
        language: 'javascript',
        content: 'const x = 1;',
      });
    });

    it('should parse triple backtick fenced code without language', () => {
      const code = '```\nconst x = 1;\n```';
      const result = parseFencedCode(code);
      expect(result).toEqual({
        language: '',
        content: 'const x = 1;',
      });
    });

    it('should parse triple tilde fenced code', () => {
      const code = '~~~python\ndef hello():\n    pass\n~~~';
      const result = parseFencedCode(code);
      expect(result).toEqual({
        language: 'python',
        content: 'def hello():\n    pass',
      });
    });

    it('should return null for non-fenced text', () => {
      expect(parseFencedCode('plain text')).toBeNull();
      expect(parseFencedCode('const x = 1;')).toBeNull();
    });

    it('should handle empty code blocks', () => {
      const code = '```\n```';
      const result = parseFencedCode(code);
      expect(result).toEqual({
        language: '',
        content: '',
      });
    });

    it('should preserve indentation and blank lines', () => {
      const code = '```\n  indented\n\n  more\n```';
      const result = parseFencedCode(code);
      expect(result).toEqual({
        language: '',
        content: '  indented\n\n  more',
      });
    });

    it('should handle code with backticks inside', () => {
      const code = '```\nconst x = `template`;\n```';
      const result = parseFencedCode(code);
      expect(result).toEqual({
        language: '',
        content: 'const x = `template`;',
      });
    });

    it('should return null for incomplete fences', () => {
      expect(parseFencedCode('```\ncode')).toBeNull();
      expect(parseFencedCode('code\n```')).toBeNull();
    });

    it('should handle multi-line code with language', () => {
      const code = '```bash\n#!/bin/bash\necho "hello"\n```';
      const result = parseFencedCode(code);
      expect(result).toEqual({
        language: 'bash',
        content: '#!/bin/bash\necho "hello"',
      });
    });

    it('should trim whitespace around fences', () => {
      const code = '  ```js\ncode\n```  ';
      const result = parseFencedCode(code);
      expect(result).toEqual({
        language: 'js',
        content: 'code',
      });
    });

    it('should return null for empty string', () => {
      expect(parseFencedCode('')).toBeNull();
      expect(parseFencedCode('   ')).toBeNull();
    });

    it('should handle language with hyphens', () => {
      const code = '```markdown\n# Heading\n```';
      const result = parseFencedCode(code);
      expect(result).toEqual({
        language: 'markdown',
        content: '# Heading',
      });
    });
  });
});

// Helper functions for creating mock DataTransfer objects

function createMockDataTransfer(data: Record<string, string>): DataTransfer {
  return {
    getData: (type: string) => data[type] || '',
    items: [] as unknown as DataTransferItemList,
    types: Object.keys(data),
    files: [] as unknown as FileList,
    dropEffect: 'none',
    effectAllowed: 'all',
    clearData: jest.fn(),
    setData: jest.fn(),
    setDragImage: jest.fn(),
  } as DataTransfer;
}

function createMockDataTransferWithImage(): DataTransfer {
  const mockItem = {
    kind: 'file',
    type: 'image/png',
    getAsFile: () => new File([], 'test.png', { type: 'image/png' }),
    getAsString: jest.fn(),
    webkitGetAsEntry: jest.fn(),
  };

  return {
    getData: () => '',
    items: {
      length: 1,
      0: mockItem,
      [Symbol.iterator]: function* () {
        yield mockItem;
      },
    } as unknown as DataTransferItemList,
    types: [],
    files: [] as unknown as FileList,
    dropEffect: 'none',
    effectAllowed: 'all',
    clearData: jest.fn(),
    setData: jest.fn(),
    setDragImage: jest.fn(),
  } as DataTransfer;
}
