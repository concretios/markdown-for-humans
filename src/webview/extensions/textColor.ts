import { Color } from '@tiptap/extension-color';
import { TextStyle } from '@tiptap/extension-text-style';
import { marked } from 'marked';
import { Mark } from '@tiptap/core';

// marked.js extension to parse <span style="color: ..."> inline HTML
const colorSpanExtension = {
  name: 'colorSpan',
  level: 'inline',
  start(src: string) {
    return src.match(/<span\s+style="color:/i)?.index;
  },
  tokenizer(this: any, src: string, _tokens: any) {
    // Match <span style="color: value">content</span>
    const rule = /^<span\s+style="color:\s*([^;">]+)[^>]*>(.*?)<\/span>/i;
    const match = rule.exec(src);
    if (match) {
      return {
        type: 'colorSpan',
        raw: match[0],
        color: match[1].trim(),
        // tokenize the inner content so nested markdown works
        tokens: this.lexer.inlineTokens(match[2]),
      };
    }
    return undefined;
  },
  renderer(this: any, token: any) {
    return `<span style="color: ${token.color}">${this.parser.parseInline(token.tokens)}</span>`;
  },
};

// Register the extension with marked globally
marked.use({ extensions: [colorSpanExtension as any] });

// Extend TextStyle so that it serializes and deserializes the color as a span for markdown export
const extensionConfig = {
  parseMarkdown() {
    return {
      mark: 'textStyle',
      getAttrs: (tok: any) => ({
        color: tok.color,
      }),
    };
  },
  toMarkdown: {
    open(_state: any, mark: any, _parent: any, _index: any) {
      if (mark.attrs.color) {
        return `<span style="color: ${mark.attrs.color}">`;
      }
      return '<span>';
    },
    close(_state: any, _mark: any, _parent: any, _index: any) {
      return '</span>';
    },
    mixable: true,
  },
};

// Note: Jest's jest-runtime strips the prototype (including the .extend method)
// from the TextStyle Mark when translating between ESM/CJS for Tiptap packages.
// This runtime fallback correctly instantiates the custom Mark in both prod and test environments.
export const CustomTextStyle = TextStyle.extend
  ? TextStyle.extend(extensionConfig)
  : Mark.create({ ...TextStyle, ...extensionConfig });

// Export the native color extension too so the editor can register it cleanly
export { Color as TextColorMark };
