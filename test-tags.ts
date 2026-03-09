import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from '@tiptap/markdown';
import { GenericHTMLInline, GenericHTMLBlock } from './src/webview/extensions/htmlPreservation';

const editor = new Editor({
    extensions: [
        StarterKit,
        GenericHTMLInline,
        GenericHTMLBlock,
        Markdown.configure({
            markedOptions: { gfm: true, breaks: true },
        }),
    ],
});

editor.commands.setContent('Hello *World*! <babayetu>Custom Tag</babayetu> and `code`', { contentType: 'markdown' });

console.log('--- Editor JSON Structure ---');
console.log(JSON.stringify(editor.getJSON(), null, 2));

console.log('--- Editor HTML Output ---');
console.log(editor.getHTML());

console.log('--- Editor Markdown Output ---');
console.log((editor as any).storage.markdown.getMarkdown());
