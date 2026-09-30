/** Real-browser regressions for production image nodes, Markdown, and CSS. */
import { Editor, type JSONContent } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from '@tiptap/markdown';
import { CustomImage } from '../../src/webview/extensions/customImage';
import { MarkdownParagraph } from '../../src/webview/extensions/markdownParagraph';
import { BlankLinePreservation } from '../../src/webview/extensions/blankLinePreservation';
import { installBlankLineLexerNormalizer } from '../../src/webview/utils/markedLexerNormalizer';
import { SpaceFriendlyImagePaths } from '../../src/webview/extensions/spaceFriendlyImagePaths';
import { getEditorMarkdownForSync } from '../../src/webview/utils/markdownSerialization';
import { collectExportContent } from '../../src/webview/utils/exportContent';
import { domToPng } from 'modern-screenshot';
import { createModernScreenshotRasterizer } from '../../src/webview/features/feedbackDomCapture';
import { enumerateCanonicalFeedbackBlocks } from '../../src/webview/features/feedbackReview';
import { buildFeedbackAnchorMap } from '../../src/editor/feedbackAnchors';
import { isMarkdownRendererEquivalent } from '../../src/editor/markdownAstEquivalence';
import { closeHistory } from '@tiptap/pm/history';

interface FixtureResult {
  passed: boolean;
  checks: Record<string, boolean>;
  images: Array<{
    alt: string;
    width: number;
    height: number;
    naturalWidth: number;
    naturalHeight: number;
  }>;
  roundTripStable: boolean;
  exportHtml: string;
  feedbackAnchorError?: string;
  roundTripDifference?: { before: string; after: string };
}

declare global {
  interface Window {
    fixtureReady?: boolean;
    fixtureEditor?: Editor;
    fixtureResult?: FixtureResult;
    runSvgFixture?: (theme: string, privateDeck?: boolean) => Promise<FixtureResult>;
    captureSvgFixture?: () => Promise<{ dataUrl: string; marker: number[] }>;
    runSvgSizeFlow?: () => Promise<{ passed: boolean; checks: Record<string, boolean> }>;
    collectSvgPdfFixture?: () => Promise<string>;
    resolveImagePath?: (source: string) => Promise<string>;
  }
}

window.resolveImagePath = async source => {
  const resource = new URL(source, window.location.href);
  resource.hostname = 'file+.vscode-resource.vscode-cdn.net';
  return resource.href;
};
Object.assign(window, { vscode: { postMessage: () => undefined } });

const source = [
  '# SVG rendering regression',
  '',
  'A viewBox-only SVG must have visible image and wrapper bounds.',
  '',
  '## ViewBox',
  '',
  '![viewbox](assets/viewbox.svg)',
  '',
  '## Literal Marp alt text',
  '',
  '![w:1000](assets/viewbox.svg)',
  '',
  '## Percentage dimensions',
  '',
  '![percent](assets/percent.svg)',
  '',
  '## Explicit dimensions',
  '',
  '![explicit](assets/explicit.svg)',
  '',
  '## Small images',
  '',
  '![icon](assets/icon.svg) ![raster](assets/raster.png)',
  '',
  '## Authored display size',
  '',
  '<img src="assets/viewbox.svg" alt="sized" width="320" title="Sized diagram">',
  '',
  '## Missing resource',
  '',
  '![missing](assets/missing.svg)',
  '',
  '## Malformed SVG',
  '',
  '![malformed](assets/malformed.svg)',
  '',
  '## Script isolation',
  '',
  '![scripted](assets/scripted.svg)',
  '',
  'End of image matrix.',
].join('\n');

const editor = new Editor({
  element: document.querySelector('#editor') as HTMLElement,
  extensions: [
    SpaceFriendlyImagePaths,
    StarterKit.configure({ paragraph: false }),
    MarkdownParagraph,
    BlankLinePreservation,
    Markdown.configure({ markedOptions: { gfm: true, breaks: true } }),
    CustomImage,
  ],
  contentType: 'markdown',
  content: source,
});
installBlankLineLexerNormalizer(editor.markdown!.instance);
window.fixtureEditor = editor;

async function settleImages(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 30));
  await Promise.all(
    Array.from(editor.view.dom.querySelectorAll<HTMLImageElement>('img.markdown-image')).map(
      image =>
        Promise.race([
          image.decode().catch(() => undefined),
          new Promise(resolve => setTimeout(resolve, 2000)),
        ])
    )
  );
  await new Promise<void>(resolve =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  );
}

function imageByAlt(alt: string): HTMLImageElement | undefined {
  return Array.from(editor.view.dom.querySelectorAll<HTMLImageElement>('img.markdown-image')).find(
    image => image.alt === alt
  );
}

function visibleError(image: HTMLImageElement | undefined): boolean {
  if (!image || image.hasAttribute('data-loading')) return false;
  const wrapper = image.closest('.image-wrapper');
  const error = wrapper?.querySelector<HTMLElement>(
    '[role="alert"], .image-load-error, .image-error'
  );
  return Boolean(error && error.textContent?.trim() && error.getBoundingClientRect().height > 0);
}

window.runSvgFixture = async (theme, privateDeck = false) => {
  document.body.className = `vscode-${theme}`;
  const privateSource = privateDeck
    ? await fetch('/private-deck.md').then(response => response.text())
    : source;
  editor.commands.setContent(privateSource, { contentType: 'markdown' });
  await settleImages();
  const images = Array.from(
    editor.view.dom.querySelectorAll<HTMLImageElement>('img.markdown-image')
  ).map(image => {
    const rectangle = image.getBoundingClientRect();
    return {
      alt: image.alt,
      width: rectangle.width,
      height: rectangle.height,
      naturalWidth: image.naturalWidth,
      naturalHeight: image.naturalHeight,
    };
  });
  const checks: Record<string, boolean> = {};
  if (privateDeck) {
    checks.privateImagesVisible =
      images.length >= 3 && images.every(image => image.width > 0 && image.height > 0);
    checks.privateSvgAspect = images
      .filter(image => image.alt === 'w:1000')
      .every(image => Math.abs(image.width / image.height - 1280 / 560) < 0.025);
  } else {
    for (const alt of [
      'viewbox',
      'w:1000',
      'percent',
      'explicit',
      'icon',
      'raster',
      'sized',
      'scripted',
    ]) {
      const actual = images.find(image => image.alt === alt);
      checks[`${alt}Visible`] = Boolean(actual && actual.width > 0 && actual.height > 0);
    }
    for (const alt of ['viewbox', 'w:1000', 'percent', 'sized']) {
      const actual = images.find(image => image.alt === alt);
      checks[`${alt}Aspect`] = Boolean(
        actual && Math.abs(actual.width / actual.height - 1280 / 560) < 0.025
      );
    }
    const sized = imageByAlt('sized');
    checks.sizedWidth = Boolean(
      sized &&
      Math.abs(sized.getBoundingClientRect().width - Math.min(320, editor.view.dom.clientWidth)) <=
        1
    );
    checks.iconNotExpanded = (imageByAlt('icon')?.getBoundingClientRect().width ?? 0) <= 32;
    checks.rasterNotExpanded = (imageByAlt('raster')?.getBoundingClientRect().width ?? 0) <= 32;
    checks.missingVisibleError = visibleError(imageByAlt('missing'));
    checks.malformedVisibleError = visibleError(imageByAlt('malformed'));
    checks.noSvgScriptExecution = !document.body.hasAttribute('data-svg-executed');
    const image = imageByAlt('viewbox');
    const wrapper = image?.closest<HTMLElement>('.image-wrapper');
    wrapper?.dispatchEvent(new MouseEvent('mouseenter'));
    const menuButton = wrapper?.querySelector<HTMLButtonElement>('.image-menu-button');
    checks.hoverMenuReachable = Boolean(
      menuButton && Number(getComputedStyle(menuButton).opacity) > 0
    );
    menuButton?.click();
    const menu = wrapper?.querySelector<HTMLElement>('.image-context-menu');
    checks.vectorAction = Boolean(menu && /Display size/i.test(menu.textContent ?? ''));
    menuButton?.click();
  }
  checks.noHorizontalOverflow = document.documentElement.scrollWidth <= window.innerWidth + 1;
  const before = getEditorMarkdownForSync(editor, 'strip');
  editor.commands.setContent(before, { contentType: 'markdown' });
  const after = getEditorMarkdownForSync(editor, 'strip');
  const roundTripStable = before === after;
  if (!privateDeck) checks.roundTripStable = roundTripStable;
  if (!privateDeck) {
    checks.sizedWidthPersisted = /<img\b[^>]*\bwidth="320"/.test(after);
    checks.sizedTitlePersisted = after.includes('Sized diagram');
    checks.marpAltPreserved = after.includes('![w:1000]');
    checks.sourcesPreserved =
      after.includes('assets/viewbox.svg') && !after.includes(location.origin);
  }
  const anchors = buildFeedbackAnchorMap(after, enumerateCanonicalFeedbackBlocks(editor));
  if (!privateDeck) checks.feedbackAnchorsAfterSave = anchors.ok;
  // The private Marp deck contains frontmatter outside this fixture's editor configuration.
  if (!privateDeck) checks.feedbackRendererEquivalent = isMarkdownRendererEquivalent(after, source);
  await settleImages();
  let firstImagePosition = -1;
  editor.state.doc.descendants((node, position) => {
    if (firstImagePosition < 0 && node.type.name === 'image') firstImagePosition = position;
  });
  const originalCount = editor.view.dom.querySelectorAll('img.markdown-image').length;
  editor.view.dispatch(closeHistory(editor.state.tr));
  editor.commands.setNodeSelection(firstImagePosition);
  checks.imageSelectable = editor.state.selection.from === firstImagePosition;
  editor.commands.deleteSelection();
  checks.imageDeletable =
    editor.view.dom.querySelectorAll('img.markdown-image').length === originalCount - 1;
  editor.commands.undo();
  checks.imageUndo =
    editor.view.dom.querySelectorAll('img.markdown-image').length === originalCount;
  await settleImages();
  const exported = await collectExportContent(editor);
  if (!privateDeck) {
    const container = document.createElement('div');
    container.innerHTML = exported.html;
    checks.exportHasDisplayWidth =
      container.querySelector('img[alt="sized"]')?.getAttribute('width') === '320';
  }
  const result = {
    passed: Object.values(checks).every(Boolean),
    checks,
    images,
    roundTripStable,
    exportHtml: exported.html,
    ...(anchors.ok ? {} : { feedbackAnchorError: anchors.error.detail }),
    ...(!privateDeck && !roundTripStable ? { roundTripDifference: { before, after } } : {}),
  };
  window.fixtureResult = result;
  return result;
};

window.captureSvgFixture = async () => {
  // Isolate capture from intentionally broken images in the negative-case matrix.
  editor.commands.setContent('![viewbox](assets/viewbox.svg)', { contentType: 'markdown' });
  await settleImages();
  const image = imageByAlt('viewbox') ?? editor.view.dom.querySelector('img.markdown-image');
  if (!image) throw new Error('No image available to capture.');
  const bounds = image.getBoundingClientRect();
  const result = await createModernScreenshotRasterizer(domToPng)({
    root: editor.view.dom as HTMLElement,
    rectangle: { left: bounds.left, top: bounds.top, width: bounds.width, height: bounds.height },
    scale: 1,
  });
  const bitmap = await createImageBitmap(
    await fetch(result.dataUrl).then(response => response.blob())
  );
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Capture verification requires a canvas context.');
  context.drawImage(bitmap, 0, 0);
  const marker = Array.from(context.getImageData(5, 5, 1, 1).data);
  bitmap.close();
  return { dataUrl: result.dataUrl, marker };
};

window.runSvgSizeFlow = async () => {
  editor.commands.setContent('![size-flow](assets/viewbox.svg)', { contentType: 'markdown' });
  await settleImages();
  const checks: Record<string, boolean> = {};
  const open = () => {
    const wrapper = imageByAlt('size-flow')?.closest<HTMLElement>('.image-wrapper');
    wrapper?.dispatchEvent(new MouseEvent('mouseenter'));
    wrapper?.querySelector<HTMLButtonElement>('.image-menu-button')?.click();
    wrapper?.querySelector<HTMLElement>('[data-action="displaySize"]')?.click();
    return document.querySelector<HTMLFormElement>('form[aria-label="SVG display size"]');
  };
  let form = open();
  let input = form?.querySelector('input');
  checks.dialogOpened = Boolean(form && input);
  if (!form || !input) return { passed: false, checks };
  checks.inputFocused = document.activeElement === input;
  const unchanged = getEditorMarkdownForSync(editor, 'strip');
  input.value = '0';
  form.requestSubmit();
  checks.invalidSizeRetained =
    form.isConnected && Boolean(form.querySelector('[role="alert"]')?.textContent);
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  checks.escapeCancels =
    !form.isConnected && getEditorMarkdownForSync(editor, 'strip') === unchanged;
  form = open();
  input = form?.querySelector('input');
  if (!form || !input) return { passed: false, checks: { ...checks, reopened: false } };
  input.value = '640';
  form.requestSubmit();
  await settleImages();
  checks.applied =
    !form.isConnected && /width="640"/.test(getEditorMarkdownForSync(editor, 'strip'));
  checks.responsiveWidth =
    Math.abs((imageByAlt('size-flow')?.width ?? 0) - Math.min(640, editor.view.dom.clientWidth)) <=
    1;
  editor.commands.undo();
  checks.undo = getEditorMarkdownForSync(editor, 'strip') === unchanged;
  editor.commands.redo();
  checks.redo = /width="640"/.test(getEditorMarkdownForSync(editor, 'strip'));
  await settleImages();
  form = open();
  form?.querySelector<HTMLButtonElement>('[data-action="reset-size"]')?.click();
  checks.reset = getEditorMarkdownForSync(editor, 'strip') === unchanged;
  // A sized HTML image followed by Markdown image content must retain both nodes.
  const adjacent =
    '<img src="assets/viewbox.svg" alt="first" width="320">\n\n![second](assets/viewbox.svg)';
  editor.commands.setContent(adjacent, { contentType: 'markdown' });
  const serialized = getEditorMarkdownForSync(editor, 'strip');
  editor.commands.setContent(serialized, { contentType: 'markdown' });
  checks.adjacentImagesRetained =
    editor.view.dom.querySelectorAll('img.markdown-image').length === 2;
  checks.adjacentRoundTripStable = getEditorMarkdownForSync(editor, 'strip') === serialized;
  const semantics = (node: JSONContent): JSONContent => ({
    ...node,
    ...(node.type === 'image'
      ? {
          attrs: {
            src: node.attrs?.['markdown-src'] || node.attrs?.src,
            alt: node.attrs?.alt,
            width: node.attrs?.width || null,
            height: node.attrs?.height || null,
          },
        }
      : {}),
    ...(node.content ? { content: node.content.map(semantics) } : {}),
  });
  const snapshot = () => JSON.stringify(semantics(editor.getJSON()));
  const inlineCases = {
    sameLineImage: '![size-flow](assets/viewbox.svg) ![second](assets/raster.png)',
    nextLineImage: '![size-flow](assets/viewbox.svg)\n![second](assets/raster.png)',
    nextLineMarks: '![size-flow](assets/viewbox.svg)\n**bold** [link](https://example.com) `code`',
    multipleLines:
      '![size-flow](assets/viewbox.svg)\n![second](assets/raster.png)\n**bold** and `code`',
  };
  for (const mode of ['preserve', 'strip'] as const) {
    for (const [name, markdown] of Object.entries(inlineCases)) {
      editor.commands.setContent(markdown, { contentType: 'markdown' });
      await settleImages();
      const before = snapshot();
      const sizeForm = open();
      const sizeInput = sizeForm?.querySelector('input');
      if (!sizeForm || !sizeInput) {
        checks[`${mode}_${name}_dialog`] = false;
        continue;
      }
      sizeInput.value = '480';
      sizeForm.requestSubmit();
      const expected = snapshot();
      const saved = getEditorMarkdownForSync(editor, mode);
      checks[`${mode}_${name}_applied`] = /width="480"/.test(saved);
      editor.commands.undo();
      checks[`${mode}_${name}_undo`] = snapshot() === before;
      editor.commands.redo();
      checks[`${mode}_${name}_redo`] = snapshot() === expected;
      for (let round = 1; round <= 2; round++) {
        editor.commands.setContent(saved, { contentType: 'markdown' });
        checks[`${mode}_${name}_reopen${round}`] = snapshot() === expected;
        checks[`${mode}_${name}_stable${round}`] = getEditorMarkdownForSync(editor, mode) === saved;
        checks[`${mode}_${name}_feedback${round}`] = buildFeedbackAnchorMap(
          saved,
          enumerateCanonicalFeedbackBlocks(editor)
        ).ok;
      }
      await settleImages();
      open()?.querySelector<HTMLButtonElement>('[data-action="reset-size"]')?.click();
      const reset = getEditorMarkdownForSync(editor, mode);
      editor.commands.setContent(reset, { contentType: 'markdown' });
      checks[`${mode}_${name}_reset`] = snapshot() === before;
    }
  }
  return { passed: Object.values(checks).every(Boolean), checks };
};
window.collectSvgPdfFixture = async () => {
  editor.commands.setContent(
    '<img src="./assets/diagram%20%231.svg?revision=2#overview" alt="PDF local SVG" width="320" title="SVG export regression">',
    { contentType: 'markdown' }
  );
  await settleImages();
  return (await collectExportContent(editor)).html;
};
window.fixtureReady = true;
