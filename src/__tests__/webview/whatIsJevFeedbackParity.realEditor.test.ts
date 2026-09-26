/** @jest-environment jsdom */

/**
 * Regression: Feedback snapshot parity for the "What Is Jev?" blog patterns.
 * Authored mark-inside-link labels (`[*text*](url)`) round-trip through TipTap
 * as mark-outside-link (`*[text](url)*`). Compact GFM tables also pad on
 * serialize. Feedback must still accept the renderer snapshot.
 */

import { Editor } from '@tiptap/core';
import CodeBlock from '@tiptap/extension-code-block';
import { ListKit } from '@tiptap/extension-list';
import { TableCell, TableHeader, TableRow } from '@tiptap/extension-table';
import { Markdown } from '@tiptap/markdown';
import StarterKit from '@tiptap/starter-kit';
import { isMarkdownRendererEquivalent } from '../../editor/markdownAstEquivalence';
import { ensureSingleTrailingNewline } from '../../editor/MarkdownEditorProvider';
import { applyBlankLinePolicy } from '../../shared/blankLinePolicy';
import { BlankLinePreservation } from '../../webview/extensions/blankLinePreservation';
import { CustomImage } from '../../webview/extensions/customImage';
import { GitHubAlerts } from '../../webview/extensions/githubAlerts';
import { HtmlPreservingTable } from '../../webview/extensions/htmlPreservingTable';
import { IndentedImageCodeBlock } from '../../webview/extensions/indentedImageCodeBlock';
import { MarkdownCode, MarkdownLink } from '../../webview/extensions/markdownCompatibilityMarks';
import { MarkdownParagraph } from '../../webview/extensions/markdownParagraph';
import { InlineMath } from '../../webview/extensions/inlineMath';
import { MathBlock } from '../../webview/extensions/mathBlock';
import { Mermaid } from '../../webview/extensions/mermaid';
import { OrderedListMarkdownFix } from '../../webview/extensions/orderedListMarkdownFix';
import { MarkdownListItem } from '../../webview/extensions/markdownListItem';
import { PreservedMarkdownLiteral } from '../../webview/extensions/preservedMarkdownLiteral';
import {
  parsePreservedCodeBlock,
  renderPreservedCodeBlock,
} from '../../webview/extensions/preservedCodeBlock';
import { SpaceFriendlyImagePaths } from '../../webview/extensions/spaceFriendlyImagePaths';
import { getEditorMarkdownForSync } from '../../webview/utils/markdownSerialization';
import { installBlankLineLexerNormalizer } from '../../webview/utils/markedLexerNormalizer';

const FeedbackSnapshotCodeBlock = CodeBlock.extend({
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

function createFeedbackSnapshotEditor(source: string): Editor {
  const element = document.createElement('div');
  document.body.appendChild(element);
  const editor = new Editor({
    element,
    extensions: [
      Mermaid,
      MathBlock,
      InlineMath,
      IndentedImageCodeBlock,
      SpaceFriendlyImagePaths,
      GitHubAlerts,
      StarterKit.configure({
        paragraph: false,
        code: false,
        codeBlock: false,
        bulletList: false,
        orderedList: false,
        listItem: false,
        listKeymap: false,
        link: false,
      }),
      MarkdownParagraph,
      MarkdownCode,
      PreservedMarkdownLiteral,
      FeedbackSnapshotCodeBlock,
      BlankLinePreservation,
      Markdown.configure({ markedOptions: { gfm: true, breaks: true } }),
      HtmlPreservingTable,
      TableRow,
      TableHeader,
      TableCell,
      ListKit.configure({ listItem: false, orderedList: false, taskItem: { nested: true } }),
      MarkdownListItem,
      OrderedListMarkdownFix,
      MarkdownLink.configure({ openOnClick: false }),
      CustomImage,
    ],
    content: '',
    contentType: 'markdown',
  });
  const storage = editor as unknown as {
    markdown?: { instance?: unknown };
    storage?: { markdown?: { instance?: unknown } };
  };
  const markedInstance = storage.markdown?.instance ?? storage.storage?.markdown?.instance;
  if (markedInstance) installBlankLineLexerNormalizer(markedInstance);
  editor.commands.setContent(source, { contentType: 'markdown' });
  return editor;
}

function normalizeLikeHost(content: string): string {
  return ensureSingleTrailingNewline(applyBlankLinePolicy(content, 'strip'));
}

/** Minimal excerpt covering the blog's Feedback-blocking patterns. */
const JEV_PARITY_EXCERPT = `# What Is Jev?

The psychologist Daniel Kahneman described two modes of human thinking in [*Thinking, Fast and Slow*](https://en.wikipedia.org/wiki/Thinking,_Fast_and_Slow):

| | System 1 | System 2 |
|---|---|---|
| Speed | Instant | Slow |
| Effort | Automatic | Deliberate |

TypeSafe calls its method [**Reinforcement Learning for Calibrated Decisions (RLCD)**](https://docs.typesafe.ai/introduction/machine-learning-primer). The classic example is the [**Brier score**](https://en.wikipedia.org/wiki/Brier_score).

# References

**Official: TypeSafe**
- [Introducing System One Models & Jev (launch post)](https://typesafe.ai/blog/introducing-system-one-models-and-jev)
- [Quick start](https://docs.typesafe.ai/introduction/quickstart)

**Background**
- [Thinking, Fast and Slow, Wikipedia](https://en.wikipedia.org/wiki/Thinking,_Fast_and_Slow)
`;

describe('What Is Jev Feedback snapshot parity', () => {
  afterEach(() => document.body.replaceChildren());

  it('accepts TipTap mark-outside-link and padded-table serialization of the excerpt', () => {
    const editor = createFeedbackSnapshotEditor(JEV_PARITY_EXCERPT);
    try {
      const serialized = `${getEditorMarkdownForSync(editor, 'strip')}\n`;
      const normalizedRenderer = normalizeLikeHost(serialized);
      const normalizedSource = normalizeLikeHost(JEV_PARITY_EXCERPT);
      expect(normalizedRenderer === normalizedSource).toBe(false);
      expect(isMarkdownRendererEquivalent(normalizedRenderer, normalizedSource)).toBe(true);
    } finally {
      editor.destroy();
    }
  });
});
