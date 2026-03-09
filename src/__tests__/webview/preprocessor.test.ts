/**
 * Test suite for preprocessMarkdownContent logic.
 *
 * Uses `marked.lexer()` AST to safely separate code from non-code content.
 * Validates that:
 * 1. Unknown HTML tags in plain text are stripped but content is kept
 * 2. Code blocks and inline code spans are NEVER modified
 * 3. Known tags like <br />, <strong>, etc. are preserved
 * 4. <mark> is converted to == for Highlight
 */

import { marked as markedInstance } from 'marked';

// ── Helpers (mirrored from editor.ts) ──────────────────────────────

const KNOWN_HTML_TAGS = new Set([
  'br',
  'p',
  'div',
  'span',
  'hr',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'ul',
  'ol',
  'li',
  'table',
  'thead',
  'tbody',
  'tr',
  'td',
  'th',
  'strong',
  'b',
  'em',
  'i',
  'u',
  's',
  'del',
  'ins',
  'sub',
  'sup',
  'code',
  'pre',
  'blockquote',
  'a',
  'img',
  'mark',
]);

function stripUnknownHtml(raw: string): string {
  let result = raw.replace(/<mark>/gi, '==').replace(/<\/mark>/gi, '==');
  result = result.replace(/<\/?([a-zA-Z][a-zA-Z0-9-]*)\b[^>]*\/?>/g, (tag, tagName) => {
    return KNOWN_HTML_TAGS.has(tagName.toLowerCase()) ? tag : '';
  });
  return result;
}

type AstToken = { type: string; raw: string; tokens?: unknown[]; items?: unknown[] };

function reconstructFromTokens(tokens: AstToken[]): string {
  return tokens
    .map(token => {
      if (token.type === 'code' || token.type === 'codespan') return token.raw;
      if (token.type === 'html') return stripUnknownHtml(token.raw);
      if (token.tokens && Array.isArray(token.tokens)) {
        const childrenOutput = reconstructFromTokens(token.tokens as AstToken[]);
        const rawInner = (token.tokens as AstToken[]).map(t => t.raw).join('');
        return token.raw.replace(rawInner, childrenOutput);
      }
      if (token.items && Array.isArray(token.items)) {
        const itemsOutput = reconstructFromTokens(token.items as AstToken[]);
        const rawInner = (token.items as AstToken[]).map(i => i.raw).join('');
        return token.raw.replace(rawInner, itemsOutput);
      }
      return token.raw;
    })
    .join('');
}

function preprocessMarkdownContent(content: string): string {
  const tokens = markedInstance.lexer(content) as unknown as AstToken[];
  return reconstructFromTokens(tokens);
}

// ── Tests ──────────────────────────────────────────────────────────

describe('preprocessMarkdownContent (AST-based)', () => {
  it('should preserve text content when stripping unknown HTML tags', () => {
    const input = '<babayetu>This is enclosed in BABAYETU</babayetu>';
    const result = preprocessMarkdownContent(input);
    expect(result).toContain('This is enclosed in BABAYETU');
    expect(result).not.toContain('<babayetu>');
  });

  it('should preserve known tags like <br />', () => {
    const input = 'Hello<br />World';
    expect(preprocessMarkdownContent(input)).toContain('<br />');
  });

  it('should convert <mark> to == for Highlight', () => {
    const input = 'This is <mark>highlighted</mark> text';
    const result = preprocessMarkdownContent(input);
    expect(result).toContain('==highlighted==');
    expect(result).not.toContain('<mark>');
  });

  it('should NEVER modify content inside inline code spans', () => {
    const input = '`This is code <tag a></tag a>`';
    const result = preprocessMarkdownContent(input);
    expect(result).toContain('<tag a>');
    expect(result).toContain('</tag a>');
  });

  it('should NEVER modify content inside fenced code blocks', () => {
    const input = '```\n<custom-tag>inside code block</custom-tag>\n```';
    const result = preprocessMarkdownContent(input);
    expect(result).toContain('<custom-tag>');
    expect(result).toContain('</custom-tag>');
  });

  it('should handle mixed code and non-code with unknown tags', () => {
    const input = '<babayetu>text</babayetu> and `<babayetu>code</babayetu>`';
    const result = preprocessMarkdownContent(input);
    expect(result).not.toMatch(/<babayetu>text<\/babayetu>/);
    expect(result).toContain('text');
    // Code span should be untouched
    expect(result).toContain('`<babayetu>code</babayetu>`');
  });

  it('should handle the full user test case from table cells', () => {
    const input = '**Bold** text<br /><babayetu>Text</babayetu> ' + '`code <tag a></tag a>` ==hi==';
    const result = preprocessMarkdownContent(input);
    expect(result).toContain('Text');
    expect(result).toContain('<tag a>');
    expect(result).toContain('<br />');
    expect(result).not.toContain('<babayetu>');
  });

  it('should preserve <strong>, <em>, and other known inline tags', () => {
    const input = '<strong>bold</strong> and <em>italic</em>';
    const result = preprocessMarkdownContent(input);
    expect(result).toContain('<strong>');
    expect(result).toContain('<em>');
  });

  it('should handle nested backticks and escaped content', () => {
    // marked handles `` `inner` `` as a codespan
    const input = 'before `<unknown>inside</unknown>` after <unknown>outside</unknown>';
    const result = preprocessMarkdownContent(input);
    expect(result).toContain('<unknown>inside</unknown>'); // code span preserved
    expect(result).not.toMatch(/<unknown>outside<\/unknown>/); // non-code stripped
    expect(result).toContain('outside'); // text content kept
  });
});
