import { MarkdownManager } from '@tiptap/markdown';
import StarterKit from '@tiptap/starter-kit';
import { ListKit } from '@tiptap/extension-list';
import type { JSONContent } from '@tiptap/core';
import { findImageSourceReferences } from '../../editor/imageSourceReferences';
import { CustomImage } from '../../webview/extensions/customImage';
import { MarkdownParagraph } from '../../webview/extensions/markdownParagraph';
import { SpaceFriendlyImagePaths } from '../../webview/extensions/spaceFriendlyImagePaths';
import { IndentedImageCodeBlock } from '../../webview/extensions/indentedImageCodeBlock';
import { MarkdownListItem } from '../../webview/extensions/markdownListItem';
import { OrderedListMarkdownFix } from '../../webview/extensions/orderedListMarkdownFix';

const manager = new MarkdownManager({
  markedOptions: { gfm: true, breaks: true },
  extensions: [
    IndentedImageCodeBlock,
    SpaceFriendlyImagePaths,
    StarterKit.configure({
      paragraph: false,
      bulletList: false,
      orderedList: false,
      listItem: false,
      listKeymap: false,
    }),
    MarkdownParagraph,
    CustomImage,
    ListKit.configure({ listItem: false, orderedList: false, taskItem: { nested: true } }),
    MarkdownListItem,
    OrderedListMarkdownFix,
  ],
});

function renderedSources(node: JSONContent): string[] {
  if (node.type === 'image') return [String(node.attrs?.src)];
  return (node.content || []).flatMap(renderedSources);
}

describe('space-path image reference scanning matches rendering', () => {
  it.each([
    '![Diagram](assets/My Diagram.svg)',
    '  ![Diagram](  assets/图 表.svg  )  ',
    '![Diagram](assets/My Diagram.svg?rev=2#detail)',
    '- ![Diagram](assets/My Diagram.svg)',
    '- ![Diagram](assets/My Diagram.svg)\n\n  Following paragraph.',
    '- First item\n\n- ![Diagram](assets/My Diagram.svg)',
    '> - ![Diagram](assets/My Diagram.svg)',
    '> ![Diagram](assets/My Diagram.svg)',
    '    ![Diagram](assets/My Diagram.svg "A title")',
    '    ![One](assets/First Diagram.svg)\n    ![Two](assets/Second Diagram.svg)',
    '![Diagram](<assets/My Diagram.svg> "A title")',
    'Prose ![Diagram](assets/My Diagram.svg)',
    '![Diagram](assets/My Diagram.svg)\nfollowing prose',
    '![Diagram](assets/My Diagram.svg)\n![Second](assets/Other Diagram.svg)',
    '![Diagram](assets/My Diagram.svg "A title")',
    '# ![Diagram](assets/My Diagram.svg)',
    '`![Diagram](assets/My Diagram.svg)`',
    '\\![Diagram](assets/My Diagram.svg)',
    '```md\n![Diagram](assets/My Diagram.svg)\n```',
    '    ![Diagram](assets/My Diagram.svg)\n    const code = true;',
    '<!--\n![Diagram](assets/My Diagram.svg)\n-->',
  ])('counts exactly the images rendered from %s', source => {
    expect(findImageSourceReferences(source).map(reference => reference.source)).toEqual(
      renderedSources(manager.parse(source))
    );
  });
});
