import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from '@tiptap/markdown';
import { TableKit, Table } from '@tiptap/extension-table';
import { renderTableToMarkdownWithBreaks } from './src/webview/utils/tableMarkdownSerializer';
import { MarkdownParagraph } from './src/webview/extensions/markdownParagraph';

const editor = new Editor({
    extensions: [
        StarterKit.configure({ paragraph: false }),
        MarkdownParagraph,
        Markdown.configure({ markedOptions: { gfm: true, breaks: true } }),
        Table.extend({
            renderMarkdown(node, h) {
                return renderTableToMarkdownWithBreaks(node, h);
            },
        }),
        TableKit.configure({ table: false }),
    ],
    content: `
| A | B |
|---|---|
| Line 1<br>Line 2 | B1 |
`,
});

// Set a table that contains a bullet list
editor.commands.setContent({
    type: 'doc',
    content: [
        {
            type: 'table',
            content: [
                {
                    type: 'tableRow',
                    content: [
                        {
                            type: 'tableCell',
                            content: [
                                {
                                    type: 'bulletList',
                                    content: [
                                        { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Item 1' }] }] },
                                        { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Item 2' }] }] }
                                    ]
                                }
                            ]
                        }
                    ]
                }
            ]
        }
    ]
});

console.log("MARKDOWN OUTPUT:");
console.log((editor as any).storage.markdown.getMarkdown());
