import { MarkdownManager } from '@tiptap/markdown';
import { Document } from '@tiptap/extension-document';
import { HardBreak } from '@tiptap/extension-hard-break';
import CodeBlock from '@tiptap/extension-code-block';
import Heading from '@tiptap/extension-heading';
import { MarkdownParagraph } from '../../webview/extensions/markdownParagraph';
import { CustomImage } from '../../webview/extensions/customImage';
import { IndentedImageCodeBlock } from '../../webview/extensions/indentedImageCodeBlock';
import {
  parsePreservedCodeBlock,
  renderPreservedCodeBlock,
} from '../../webview/extensions/preservedCodeBlock';

// Mirror the editor wiring: extend CodeBlock with our custom parse/render handlers
// plus the indent-prefix attribute. We use CodeBlock (not CodeBlockLowlight) here
// to avoid needing the lowlight runtime in unit tests.
const PreservedCodeBlock = CodeBlock.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      'indent-prefix': { default: null },
      'fence-marker': { default: null },
    };
  },
  parseMarkdown: parsePreservedCodeBlock,
  renderMarkdown: renderPreservedCodeBlock,
});

function createMarkdownManager() {
  return new MarkdownManager({
    markedOptions: { gfm: true, breaks: true },
    extensions: [
      Document,
      MarkdownParagraph,
      HardBreak,
      CustomImage,
      Heading,
      IndentedImageCodeBlock,
      PreservedCodeBlock,
    ],
  });
}

describe('PreservedCodeBlock: indent-prefix round-trip', () => {
  it('preserves 2-space indented fenced code block (Bug 1: previously dropped entirely)', () => {
    const manager = createMarkdownManager();
    const md = '  ```\n  hello\n  ```\n';
    const doc = manager.parse(md);

    const codeBlocks = (doc.content ?? []).filter(n => n.type === 'codeBlock');
    expect(codeBlocks).toHaveLength(1);
    expect(codeBlocks[0].attrs?.['indent-prefix']).toBe('  ');
    expect(codeBlocks[0].content?.[0]?.text).toBe('hello');

    const serialized = manager.serialize(doc);
    expect(serialized).toBe('  ```\n  hello\n  ```');
  });

  it('preserves 4-space indented code block (Bug 2: previously corrupted by wrapping in fence)', () => {
    const manager = createMarkdownManager();
    const md = '    ```\n    hello\n    ```\n';
    const doc = manager.parse(md);

    const codeBlocks = (doc.content ?? []).filter(n => n.type === 'codeBlock');
    expect(codeBlocks).toHaveLength(1);
    expect(codeBlocks[0].attrs?.['indent-prefix']).toBe('    ');
    // Indented code block content is literal: the three lines INCLUDING the backticks.
    expect(codeBlocks[0].content?.[0]?.text).toBe('```\nhello\n```');

    const serialized = manager.serialize(doc);
    expect(serialized).toBe('    ```\n    hello\n    ```');

    // Round-trip: re-parsing the serialized output must yield the same structure.
    const doc2 = manager.parse(serialized + '\n');
    expect(doc2).toEqual(doc);
  });

  it('preserves no-indent fenced code block (baseline)', () => {
    const manager = createMarkdownManager();
    const md = '```\nhello\n```\n';
    const doc = manager.parse(md);

    const codeBlocks = (doc.content ?? []).filter(n => n.type === 'codeBlock');
    expect(codeBlocks).toHaveLength(1);
    // No prefix → attribute should be absent/null
    expect(codeBlocks[0].attrs?.['indent-prefix'] ?? null).toBeNull();

    expect(manager.serialize(doc)).toBe('```\nhello\n```');
  });

  it('handles the full user test case with three code blocks', () => {
    const manager = createMarkdownManager();
    const md =
      '# no space\n\n' +
      '```\nhello\n```\n\n' +
      '# 2 Space\n\n' +
      '  ```\n  hello\n  ```\n\n' +
      '# 4 space\n\n' +
      '    ```\n    hello\n    ```\n';

    const doc = manager.parse(md);

    const codeBlocks = (doc.content ?? []).filter(n => n.type === 'codeBlock');
    expect(codeBlocks).toHaveLength(3);
    expect(codeBlocks[0].attrs?.['indent-prefix'] ?? null).toBeNull();
    expect(codeBlocks[1].attrs?.['indent-prefix']).toBe('  ');
    expect(codeBlocks[2].attrs?.['indent-prefix']).toBe('    ');

    const serialized = manager.serialize(doc);
    // Round-trip: re-parsing yields identical doc tree.
    const doc2 = manager.parse(serialized);
    expect(doc2).toEqual(doc);
  });

  it('preserves fenced code block with language tag', () => {
    const manager = createMarkdownManager();
    const md = '```js\nconst x = 1\n```\n';
    const doc = manager.parse(md);

    const codeBlock = doc.content?.[0];
    expect(codeBlock?.type).toBe('codeBlock');
    expect(codeBlock?.attrs?.language).toBe('js');

    expect(manager.serialize(doc)).toBe('```js\nconst x = 1\n```');
  });

  it('preserves an authored four-backtick fence around nested triple backticks', () => {
    const manager = createMarkdownManager();
    const markdown = ['````markdown', '```ts', 'const value = true;', '```', '````'].join('\n');

    const doc = manager.parse(markdown);

    expect(doc.content?.[0]?.attrs?.['fence-marker']).toBe('````');
    expect(manager.serialize(doc)).toBe(markdown);
  });

  it('preserves an authored tilde fence instead of rewriting it as backticks', () => {
    const manager = createMarkdownManager();
    const markdown = ['~~~~JavaScript', 'const fence = "```";', '~~~~'].join('\n');

    const doc = manager.parse(markdown);

    expect(doc.content?.[0]?.attrs?.['fence-marker']).toBe('~~~~');
    expect(manager.serialize(doc)).toBe(markdown);
  });

  it('non-image indented code block still falls back to codeBlock', () => {
    const manager = createMarkdownManager();
    const doc = manager.parse('    const x = 1\n');
    expect(doc.content?.[0]?.type).toBe('codeBlock');
    expect(doc.content?.[0]?.attrs?.['indent-prefix']).toBe('    ');
  });
});
