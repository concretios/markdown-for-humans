import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from '@tiptap/markdown';
import { GenericHTMLInline, GenericHTMLBlock } from './src/webview/extensions/htmlPreservation';
import Table from '@tiptap/extension-table';
import TableRow from '@tiptap/extension-table-row';
import TableCell from '@tiptap/extension-table-cell';
import TableHeader from '@tiptap/extension-table-header';
import Highlight from '@tiptap/extension-highlight';

const editor = new Editor({
    extensions: [
        StarterKit,
        GenericHTMLInline,
        GenericHTMLBlock,
        Table, TableRow, TableCell, TableHeader, Highlight,
        Markdown.configure({
            html: true,
            transformPastedText: true,
            transformCopiedText: true,
        }),
    ],
});

editor.commands.setContent(`
| Test                                            |
| ----------------------------------------------- |
| **Works: This is bold text**<br />*Works: This is italics text*<br />~~*Works: This is strikethrough italics text*~~<br /><br />Sample:<br />    * <babayetu>Item 2</babayetu> <br />    * Item 2<br />    * Item 3 is ==now== ==highlighted==<br /><br />\`sdadasdasd\` |
`, { parseOptions: { preserveWhitespace: 'full' } });

const markdown = (editor as any).storage.markdown.getMarkdown();
console.log('--- Editor HTML Output ---');
console.log(editor.getHTML());

console.log('--- Editor Markdown Output ---');
console.log(markdown);
