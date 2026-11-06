/** @jest-environment jsdom */

import corpus from '../fixtures/githubHeadingAnchors.json';
import { createProductionEditor } from '../helpers/productionEditor';
import { generateHeadingSlug, type SeenSlugs } from '../../webview/utils/headingSlug';
import { getHeadingsWithAnchorText } from '../../webview/utils/outline';

describe("heading anchors against GitHub's recorded ids", () => {
  it.each(corpus.cases.map(({ markdown, ids }) => [markdown, ids] as [string, string[]]))(
    '%j',
    (markdown, ids) => {
      const editor = createProductionEditor();
      editor.commands.setContent(markdown, { contentType: 'markdown' });
      const seen: SeenSlugs = new Map();
      const anchors = getHeadingsWithAnchorText(editor).map(heading =>
        generateHeadingSlug(heading.anchorText, seen)
      );
      editor.destroy();

      expect(anchors).toEqual(ids);
    }
  );
});
