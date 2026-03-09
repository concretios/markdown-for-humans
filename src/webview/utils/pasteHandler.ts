/**
 * Copyright (c) 2025-2026 Concret.io
 *
 * Licensed under the MIT License. See LICENSE file in the project root for details.
 */

/**
 * Paste Handler - Smart paste for markdown editor
 *
 * - HTML → Markdown: Uses turndown.js to convert rich HTML to markdown
 * - Markdown → HTML: Uses markdown-it to parse markdown for TipTap insertion
 *
 * This enables pasting from Word, Google Docs, Notion, web pages, AND raw markdown.
 */

import TurndownService from 'turndown';
import MarkdownIt from 'markdown-it';
// @ts-expect-error - markdown-it-mark does not have types available
import markdownItMark from 'markdown-it-mark';

// Create and configure turndown instance
const turndown = new TurndownService({
  headingStyle: 'atx', // # style headings
  codeBlockStyle: 'fenced', // ``` style code blocks
  bulletListMarker: '-', // - for bullets
  emDelimiter: '*', // *italic*
  strongDelimiter: '**', // **bold**
  hr: '---',
});

// Add rule for strikethrough (del, s, strike elements)
turndown.addRule('strikethrough', {
  filter: (node: HTMLElement) => {
    const tagName = node.nodeName.toLowerCase();
    return tagName === 'del' || tagName === 's' || tagName === 'strike';
  },
  replacement: content => `~~${content}~~`,
});

// Add rule for highlight (mark elements)
turndown.addRule('highlight', {
  filter: ['mark'],
  replacement: content => `==${content}==`,
});

// Add rule for task lists (checkboxes) - must have actual checkbox input
turndown.addRule('taskListItem', {
  filter: (node: HTMLElement) => {
    if (node.nodeName !== 'LI') return false;
    // Must have checkbox input somewhere in the li
    const checkbox = node.querySelector('input[type="checkbox"]');
    if (!checkbox) return false;
    // Verify it's actually a checkbox (not just any input)
    return (checkbox as HTMLInputElement).type === 'checkbox';
  },
  replacement: (content: string, node: HTMLElement) => {
    const checkbox = node.querySelector('input[type="checkbox"]') as HTMLInputElement;
    const isChecked = checkbox?.checked ?? false;
    // Remove the checkbox from content and trim
    const cleanContent = content.replace(/^\s*\[[ x]\]\s*/i, '').trim();
    return `- [${isChecked ? 'x' : ' '}] ${cleanContent}\n`;
  },
});

// Add rule for preserving code blocks better
turndown.addRule('fencedCodeBlock', {
  filter: (node: HTMLElement) => node.nodeName === 'PRE' && node.querySelector('code') !== null,
  replacement: (_content: string, node: HTMLElement) => {
    const codeElement = node.querySelector('code');
    const code = codeElement?.textContent || '';
    // Try to detect language from class
    const langClass = codeElement?.className.match(/language-(\w+)/);
    const lang = langClass ? langClass[1] : '';
    return `\n\`\`\`${lang}\n${code}\n\`\`\`\n`;
  },
});

// Keep certain elements as-is (don't convert)
turndown.keep(['sup', 'sub', 'u']);

// Remove elements that shouldn't be in markdown
turndown.remove(['script', 'style', 'noscript', 'iframe', 'object', 'embed']);

/**
 * Convert HTML string to Markdown
 *
 * @param html - HTML string to convert
 * @returns Clean markdown string
 */
export function htmlToMarkdown(html: string): string {
  if (!html || !html.trim()) {
    return '';
  }

  try {
    // Clean up common HTML issues before conversion
    const cleanHtml = html
      // Remove Word-specific markup
      .replace(/<!--\[if.*?\]>.*?<!\[endif\]-->/gs, '')
      .replace(/<o:p>.*?<\/o:p>/gs, '')
      // Remove empty paragraphs
      .replace(/<p>\s*<\/p>/gi, '')
      // Normalize whitespace in tags
      .replace(/>\s+</g, '> <');

    const markdown = turndown.turndown(cleanHtml);

    // Post-process markdown
    return (
      markdown
        // Remove excessive blank lines (more than 2)
        .replace(/\n{3,}/g, '\n\n')
        // Trim leading/trailing whitespace
        .trim()
    );
  } catch (error) {
    console.error('[MD4H] Error converting HTML to markdown:', error);
    // Return empty string on error - caller should fall back to plain text
    throw error;
  }
}

// Create markdown-it instance for markdown → HTML conversion
const md = new MarkdownIt({
  html: true,
  breaks: true, // Preserve single newlines as <br> for plain text blocks
  linkify: true,
}).use(markdownItMark);

/**
 * Check if text looks like markdown (has syntax that needs parsing)
 *
 * @param text - Plain text to check
 * @returns true if text contains markdown syntax
 */
export function looksLikeMarkdown(text: string): boolean {
  if (!text) return false;

  // Check for common markdown patterns
  const markdownPatterns = [
    /^\|.+\|$/m, // Table rows
    /^\s*[-*+]\s+/m, // Unordered lists
    /^\s*\d+\.\s+/m, // Ordered lists
    /^#{1,6}\s+/m, // Headers
    /\*\*[^*]+\*\*/, // Bold
    /\*[^*]+\*/, // Italic (but not bold)
    /`[^`]+`/, // Inline code
    /^```/m, // Code blocks
    /^\s*>/m, // Blockquotes
    /\[.+\]\(.+\)/, // Links
    /!\[.*\]\(.+\)/, // Images
    /^---$/m, // Horizontal rules
    /^\s*- \[[ x]\]/im, // Task lists
  ];

  return markdownPatterns.some(pattern => pattern.test(text));
}

/**
 * Convert markdown text to HTML for TipTap insertion
 *
 * @param markdown - Markdown string
 * @returns HTML string
 */
export function markdownToHtml(markdown: string): string {
  if (!markdown || !markdown.trim()) return '';
  return md.render(markdown);
}

/**
 * Check if clipboard data contains HTML
 *
 * @param clipboardData - ClipboardEvent data
 * @returns true if HTML content is present
 */
export function hasHtmlContent(clipboardData: DataTransfer | null): boolean {
  if (!clipboardData) return false;
  const html = clipboardData.getData('text/html');
  return Boolean(html && html.trim());
}

/**
 * Check if HTML content is "rich" enough to warrant conversion.
 * Simple wrappers (like VS Code's plain text in a span) should use plain text instead.
 *
 * @param html - HTML string
 * @param plainText - Plain text string
 * @returns true if HTML has meaningful formatting worth converting
 */
export function isRichHtml(html: string, plainText: string): boolean {
  if (!html || !plainText) return false;

  // Check if HTML has any meaningful formatting tags (quick check first)
  const formattingPattern =
    /<(strong|b|em|i|u|s|del|strike|a|h[1-6]|ul|ol|li|table|pre|code|blockquote|img)\b/i;
  if (formattingPattern.test(html)) {
    return true;
  }

  // Extract text content from HTML using regex (works in Node.js tests)
  const htmlTextContent = html
    .replace(/<[^>]*>/g, ' ') // Remove all HTML tags
    .replace(/&nbsp;/g, ' ') // Replace &nbsp;
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");

  // Normalize whitespace for comparison
  const normalizedHtml = htmlTextContent.replace(/\s+/g, ' ').trim();
  const normalizedPlain = plainText.replace(/\s+/g, ' ').trim();

  // If text content differs, HTML has structure worth preserving
  return normalizedHtml !== normalizedPlain;
}

/**
 * Check if clipboard data contains an image
 *
 * @param clipboardData - ClipboardEvent data
 * @returns true if image content is present
 */
export function hasImageContent(clipboardData: DataTransfer | null): boolean {
  if (!clipboardData) return false;
  const items = clipboardData.items;
  for (let i = 0; i < items.length; i++) {
    if (items[i].type.startsWith('image/')) {
      return true;
    }
  }
  return false;
}

/**
 * Get plain text from clipboard
 *
 * @param clipboardData - ClipboardEvent data
 * @returns Plain text string or empty string
 */
export function getPlainText(clipboardData: DataTransfer | null): string {
  if (!clipboardData) return '';
  return clipboardData.getData('text/plain') || '';
}

/**
 * Get HTML from clipboard
 *
 * @param clipboardData - ClipboardEvent data
 * @returns HTML string or empty string
 */
export function getHtmlContent(clipboardData: DataTransfer | null): string {
  if (!clipboardData) return '';
  return clipboardData.getData('text/html') || '';
}

/**
 * Parse fenced code block from text (supports ``` and ~~~ fences)
 *
 * @param text - Text that may contain a fenced code block
 * @returns Object with language and raw code content, or null if not fenced
 */
export function parseFencedCode(text: string): {
  language: string;
  content: string;
} | null {
  if (!text || !text.trim()) return null;

  const trimmed = text.trim();

  // Try triple backticks first (most common)
  // Language can contain word characters, hyphens, and underscores
  // Make newline before closing fence optional to handle empty blocks
  const backtickMatch = trimmed.match(/^```([\w-]+)?\n([\s\S]*?)\n?```$/);
  if (backtickMatch) {
    return {
      language: backtickMatch[1] || '',
      content: backtickMatch[2],
    };
  }

  // Try triple tildes
  const tildeMatch = trimmed.match(/^~~~([\w-]+)?\n([\s\S]*?)\n?~~~$/);
  if (tildeMatch) {
    return {
      language: tildeMatch[1] || '',
      content: tildeMatch[2],
    };
  }

  return null;
}

/**
 * Process paste event and return content ready for TipTap insertion
 *
 * @param clipboardData - ClipboardEvent data
 * @returns Object with HTML content (for TipTap), conversion flags
 */
export function processPasteContent(clipboardData: DataTransfer | null): {
  content: string;
  wasConverted: boolean;
  isImage: boolean;
  isHtml: boolean; // If true, content is HTML ready for TipTap
} {
  if (!clipboardData) {
    return { content: '', wasConverted: false, isImage: false, isHtml: false };
  }

  // Check for image first
  if (hasImageContent(clipboardData)) {
    return { content: '', wasConverted: false, isImage: true, isHtml: false };
  }

  // Get both HTML and plain text
  const html = getHtmlContent(clipboardData);
  const plainText = getPlainText(clipboardData);

  // Case 1: Rich HTML from external source (Google Docs, Word, etc.)
  // Convert HTML → Markdown → HTML (to normalize formatting)
  if (html && isRichHtml(html, plainText)) {
    try {
      const markdown = htmlToMarkdown(html);
      if (markdown) {
        // Convert back to HTML for TipTap insertion
        const cleanHtml = markdownToHtml(markdown);
        return { content: cleanHtml, wasConverted: true, isImage: false, isHtml: true };
      }
    } catch {
      // Fall through to plain text handling
    }
  }

  // Case 2: Plain text that looks like markdown (tables, lists, headers, etc.)
  if (plainText && looksLikeMarkdown(plainText)) {
    const htmlContent = markdownToHtml(plainText);
    return { content: htmlContent, wasConverted: true, isImage: false, isHtml: true };
  }

  // Case 3: Plain text without markdown - let TipTap handle it
  return { content: plainText, wasConverted: false, isImage: false, isHtml: false };
}
