import { Node, JSONContent } from '@tiptap/core';

// List of block-level tags that should NOT be captured by the generic inline mark
const KNOWN_BLOCK_TAGS = [
  'div',
  'p',
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
  'tr',
  'td',
  'th',
  'tbody',
  'thead',
  'blockquote',
  'pre',
  'hr',
  'br',
];

/**
 * An extension that preserves arbitrary inline HTML tags
 */
export const GenericHTMLInline = Node.create({
  name: 'genericHtmlInline',
  group: 'inline',
  inline: true,
  atom: true, // It is a leaf node holding the raw html tag string
  priority: 1,

  addAttributes() {
    return {
      rawHtml: { default: '' },
    };
  },

  parseHTML() {
    return [
      {
        tag: '*',
        getAttrs: element => {
          if (typeof element === 'string') return false;
          if (!(element instanceof HTMLElement)) return false;

          const tag = element.tagName.toLowerCase();
          if (KNOWN_BLOCK_TAGS.includes(tag) || tag === 'br') return false;

          // Ignore <span style="color: ..."> so the TextColor extension can handle it
          if (tag === 'span' && element.style.color) return false;

          return { rawHtml: element.outerHTML.split('>')[0] + '>' }; // Open tag
        },
      },
    ];
  },

  renderHTML({ HTMLAttributes }) {
    // We render it as a span marking the tag, so the user can see it in the editor!
    return [
      'span',
      { class: 'raw-html-tag', 'data-raw': HTMLAttributes.rawHtml },
      HTMLAttributes.rawHtml,
    ];
  },

  // This is required for @tiptap/markdown to ingest raw HTML tokens
  parseMarkdown() {
    return {
      node: 'genericHtmlInline',
      getAttributes: (tok: any) => {
        if (tok.type !== 'html') return false;

        const raw = tok.raw || tok.text || '';
        if (raw.toLowerCase().startsWith('<br')) return false;

        // Ignore <span style="color: ..."> and closing </span> used for colors
        const isColorSpan = /<span\s+style="color:/i.test(raw);
        if (isColorSpan) return false;

        // Optionally ignore mark if we handled it in parser
        return { rawHtml: raw };
      },
    };
  },

  renderMarkdown(node: JSONContent) {
    return node.attrs?.rawHtml || '';
  },
});

/**
 * An extension that preserves arbitrary block-level HTML tags
 */
export const GenericHTMLBlock = Node.create({
  name: 'genericHtmlBlock',
  group: 'block',
  atom: true, // Leaf node holding raw html
  priority: 1,

  addAttributes() {
    return {
      rawHtml: { default: '' },
    };
  },

  parseHTML() {
    return [
      {
        tag: '*',
        getAttrs: element => {
          if (typeof element === 'string') return false;
          if (!(element instanceof HTMLElement)) return false;

          const tag = element.tagName.toLowerCase();
          if (!KNOWN_BLOCK_TAGS.includes(tag) && tag !== 'div') return false;

          return { rawHtml: element.outerHTML.split('>')[0] + '>' };
        },
      },
    ];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'div',
      { class: 'raw-html-tag block-raw-html', 'data-raw': HTMLAttributes.rawHtml },
      HTMLAttributes.rawHtml,
    ];
  },

  parseMarkdown() {
    return {
      node: 'genericHtmlBlock',
      getAttributes: (tok: any) => {
        if (tok.type !== 'html') return false;

        const raw = tok.raw || tok.text || '';
        if (!raw) return false;

        // Discard BRs here too if they bleed into block scope
        if (raw.toLowerCase().startsWith('<br')) return false;

        return { rawHtml: raw.trim() };
      },
    };
  },

  renderMarkdown(node: JSONContent) {
    return (node.attrs?.rawHtml || '') + '\n';
  },
});
