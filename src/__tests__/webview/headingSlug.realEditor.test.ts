/** @jest-environment jsdom */

import { createProductionEditor } from '../helpers/productionEditor';
import { buildHeadingAnchors, resolveHeadingAnchor } from '../../webview/utils/headingSlug';
import { buildOutlineFromEditor } from '../../webview/utils/outline';

describe('heading anchors with the text the production editor gives a heading', () => {
  const headingIndex = (markdown: string, fragment: string): number | undefined => {
    const editor = createProductionEditor();
    editor.commands.setContent(markdown, { contentType: 'markdown' });
    const outline = buildOutlineFromEditor(editor);
    editor.destroy();
    return resolveHeadingAnchor(buildHeadingAnchors(outline.map(entry => entry.text)), fragment);
  };

  it.each<[string, string, number]>([
    ['# Project ![CI](b.svg)\n\n## Project', 'project', 1],
    ['# Project ![CI](b.svg)\n\n## Project', 'project-', 0],
    ['# ![Logo](l.png) My Project', '-my-project', 0],
    ['# <!-- c --> After', '-after', 0],
    ['# Foo\n\n# Foo ![i](i.png)\n\n# Foo', 'foo-1', 2],
    ['# Über uns\n\n# Setup & Config', 'über-uns', 0],
    ['# Über uns\n\n# Setup & Config', 'setup--config', 1],
  ])('%j, #%s', (markdown, fragment, index) => {
    expect(headingIndex(markdown, fragment)).toBe(index);
  });
});
