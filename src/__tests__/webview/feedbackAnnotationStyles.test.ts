import { readFileSync } from 'fs';
import * as path from 'path';

const css = readFileSync(path.resolve(__dirname, '../../webview/editor.css'), 'utf8');
const cssRules = css.match(/[^{}]+\{[^{}]*\}/g) ?? [];
const feedbackCss = css.slice(css.indexOf('Snapshot Feedback review'));

const ruleFor = (selector: string): string =>
  cssRules.find(rule => {
    const selectorList = rule
      .slice(0, rule.indexOf('{'))
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split(',')
      .map(candidate => candidate.replace(/\s+/g, ' ').trim());
    return selectorList.includes(selector);
  }) ?? '';

describe('Feedback annotation styles', () => {
  it('uses a document-positioned overlay without creating a second scroll surface', () => {
    const layer = css.match(/\.feedback-annotation-layer\s*\{[^}]*\}/)?.[0] ?? '';
    const cardLayer = css.match(/\.feedback-card-layer\s*\{[^}]*\}/)?.[0] ?? '';
    const synchronizedRail = ruleFor('.feedback-annotation-layer.feedback-comment-rail');

    expect(layer).toMatch(/position:\s*absolute/);
    expect(layer).not.toMatch(/position:\s*fixed/);
    expect(layer).toMatch(/pointer-events:\s*none/);
    expect(cardLayer).not.toMatch(/overflow(?:-y)?:\s*(?:auto|scroll)/);
    expect(synchronizedRail).toMatch(/background:\s*transparent/);
  });

  it('keeps light-theme feedback cards and composers opaque over document text', () => {
    const lightCard = ruleFor('.vscode-light .feedback-comment-card');
    const lightComposer = ruleFor('.vscode-light .feedback-composer');

    for (const surface of [lightCard, lightComposer]) {
      expect(surface).toContain(
        'background: var(--vscode-editorWidget-background, var(--vscode-editor-background))'
      );
      expect(surface).not.toMatch(/transparent|color-mix|backdrop-filter/);
    }
  });

  it('gates semantic highlights and brackets behind active Feedback mode', () => {
    expect(css).toMatch(/\.feedback-review-active\s+\.markdown-editor\s+\.md4h-feedback-highlight/);
    expect(css).toMatch(
      /\.feedback-review-active\s+\.markdown-editor\s+\.md4h-feedback-block-target/
    );
    expect(css).not.toMatch(/^\.markdown-editor\s+\.md4h-feedback-highlight/m);
    expect(css).toMatch(
      /body\[data-feedback-comments-state=['"]hidden['"]\][\s\S]*md4h-feedback-annotation-inline/
    );
  });

  it('uses the semantic yellow hierarchy for pending and active fallback targets', () => {
    const pending =
      css.match(
        /\.feedback-review-active\s+\.markdown-editor\s+\.feedback-pending-target\s*\{[^}]*\}/
      )?.[0] ?? '';
    const active =
      css.match(
        /\.feedback-review-active\s+\.markdown-editor\s+\.feedback-active-target\s*\{[^}]*\}/
      )?.[0] ?? '';

    expect(pending).toContain('--md4h-feedback-highlight-saved');
    expect(active).toContain('--md4h-feedback-highlight-active');
    expect(active).toContain('--md4h-feedback-highlight-edge');
    expect(css).toMatch(
      /\.vscode-high-contrast\s+\.feedback-review-active\s+\.markdown-editor\s+\.feedback-pending-target[\s\S]*?outline:\s*2px\s+solid/
    );
  });

  it('defines a Feedback-only semantic yellow palette from VS Code warning colors', () => {
    const palette = ruleFor('body.feedback-review-active') || ruleFor('.feedback-review-active');
    const paletteSelectors = palette.slice(0, palette.indexOf('{'));

    for (const token of [
      '--md4h-feedback-accent',
      '--md4h-feedback-on-accent',
      '--md4h-feedback-highlight-saved',
      '--md4h-feedback-highlight-active',
      '--md4h-feedback-highlight-edge',
    ]) {
      expect(palette).toContain(`${token}:`);
    }
    expect(palette).toMatch(
      /--vscode-(?:editorWarning-foreground|statusBarItem-warning(?:Background|Foreground)|notificationsWarningIcon-foreground)/
    );
    expect(palette).not.toMatch(/#[0-9a-f]{3,8}|rgba?\(/i);
    expect(palette).not.toContain('--vscode-focusBorder');
    expect(palette).not.toContain('--vscode-button-background');
    expect(paletteSelectors).toContain('body.feedback-review-starting');
    expect(paletteSelectors).toContain('body.feedback-completion-open');

    const darkPalette =
      ruleFor('body.vscode-dark.feedback-review-active') ||
      ruleFor('.vscode-dark .feedback-review-active');
    expect(darkPalette).toContain('--md4h-feedback-highlight-saved:');
    expect(darkPalette).toContain('--md4h-feedback-highlight-active:');
  });

  it('keeps dark-theme action yellow bright instead of mixing it back into the widget', () => {
    const darkPalette =
      ruleFor('body.vscode-dark.feedback-review-active') ||
      ruleFor('.vscode-dark .feedback-review-active');

    expect(darkPalette).toContain('--md4h-feedback-action-surface:');
    expect(darkPalette).toContain('--md4h-feedback-action-hover:');
    expect(darkPalette).toContain('var(--md4h-feedback-accent)');
    expect(darkPalette).toMatch(/var\(--vscode-editor-foreground/);
    expect(darkPalette).not.toContain('--vscode-editorWidget-background');
  });

  it('paints saved, pending, and active targets with the semantic yellow hierarchy', () => {
    const saved = ruleFor('.feedback-review-active .markdown-editor .md4h-feedback-highlight');
    const active = ruleFor(
      '.feedback-review-active .markdown-editor .md4h-feedback-highlight-active'
    );
    const pending = ruleFor(
      ".feedback-review-active .markdown-editor .md4h-feedback-annotation-inline[data-feedback-ids*='__pending__']"
    );
    const pendingCell = ruleFor(
      ".feedback-review-active .markdown-editor .md4h-feedback-annotation-cell[data-feedback-ids*='__pending__']"
    );
    const fallbackPending = ruleFor(
      '.feedback-review-active .markdown-editor .feedback-pending-target'
    );
    const fallbackActive = ruleFor(
      '.feedback-review-active .markdown-editor .feedback-active-target'
    );

    expect(saved).toContain('var(--md4h-feedback-highlight-saved)');
    expect(active).toContain('var(--md4h-feedback-highlight-active)');
    expect(active).toContain('var(--md4h-feedback-highlight-edge)');
    expect(pending).toContain('var(--md4h-feedback-highlight-active)');
    expect(pending).toContain('var(--md4h-feedback-highlight-edge)');
    expect(pendingCell).toContain('var(--md4h-feedback-highlight-active)');
    expect(pendingCell).toContain('var(--md4h-feedback-highlight-edge)');
    expect(pendingCell).toMatch(/box-shadow:\s*inset/);
    expect(fallbackPending).toContain('var(--md4h-feedback-highlight-saved)');
    expect(fallbackActive).toContain('var(--md4h-feedback-highlight-active)');
    expect(fallbackActive).toContain('var(--md4h-feedback-highlight-edge)');
  });

  it('uses yellow for feedback pins and the contextual Add feedback bubble', () => {
    const marker = ruleFor('.feedback-marker');
    const activeMarker = ruleFor('.feedback-marker.active');
    const selectionAction = ruleFor('.feedback-selection-action');
    const blockAction = ruleFor('.feedback-block-action');
    const activeCard = ruleFor(".feedback-comment-card[data-feedback-card-state='active']");

    expect(marker).toContain('var(--md4h-feedback-accent)');
    expect(activeMarker).toContain('var(--md4h-feedback-accent)');
    expect(activeMarker).toContain('var(--md4h-feedback-on-accent)');
    expect(selectionAction).toContain('var(--md4h-feedback-accent)');
    expect(selectionAction).toContain('var(--md4h-feedback-on-accent)');
    expect(blockAction).toContain('var(--md4h-feedback-accent)');
    expect(blockAction).toContain('var(--md4h-feedback-on-accent)');
    expect(activeCard).toContain('var(--md4h-feedback-highlight-edge)');

    for (const rule of [marker, activeMarker, selectionAction, blockAction, activeCard]) {
      expect(rule).not.toContain('--vscode-button-background');
    }
  });

  it('uses yellow for active feedback toolbar controls while keeping idle controls neutral', () => {
    const idle = ruleFor(".feedback-comments-button[data-feedback-comments-state='hidden']");
    const collapsed = ruleFor(
      ".feedback-comments-button[data-feedback-comments-state='collapsed']"
    );
    const expanded = ruleFor(".feedback-comments-button[data-feedback-comments-state='expanded']");
    const captureActive = ruleFor(".feedback-capture-button[aria-pressed='true']");
    const toolbarHover = ruleFor('.feedback-toolbar-button:not(:disabled):hover');

    expect(idle).not.toContain('var(--md4h-feedback-accent)');
    expect(collapsed).toContain('var(--md4h-feedback-highlight-saved)');
    expect(collapsed).toContain('var(--md4h-feedback-accent)');
    expect(expanded).toContain('var(--md4h-feedback-accent)');
    expect(expanded).toContain('var(--md4h-feedback-on-accent)');
    expect(captureActive).toContain('var(--md4h-feedback-accent)');
    expect(toolbarHover).toContain('var(--md4h-feedback-highlight-saved)');

    for (const rule of [collapsed, expanded, captureActive, toolbarHover]) {
      expect(rule).not.toContain('--vscode-button-background');
    }
  });

  it('keeps active Feedback glyphs yellow while the idle Start action remains neutral', () => {
    const feedbackIcon = ruleFor('.feedback-toolbar-button .toolbar-icon');
    const startIcon = ruleFor('.feedback-start-button .toolbar-icon');
    const expandedIcon = ruleFor(
      ".feedback-comments-button[data-feedback-comments-state='expanded'] .toolbar-icon"
    );
    const captureIcon = ruleFor(".feedback-capture-button[aria-pressed='true'] .toolbar-icon");

    expect(feedbackIcon).toContain('var(--md4h-feedback-accent)');
    expect(startIcon).toMatch(/color:\s*inherit/);
    expect(startIcon).not.toContain('--md4h-feedback-accent');
    expect(expandedIcon).toContain('var(--md4h-feedback-on-accent)');
    expect(captureIcon).toContain('var(--md4h-feedback-on-accent)');
    expect(feedbackIcon).not.toContain('--vscode-button-background');
    expect(startIcon).not.toContain('--vscode-button-background');
  });

  it('renders Start feedback as a compact neutral toolbar action', () => {
    const toolbarButton = ruleFor('.toolbar-button');
    const start = ruleFor('.feedback-start-button');
    const hover = ruleFor('.feedback-start-button:not(:disabled):hover');

    expect(toolbarButton).toMatch(/border-radius:\s*6px/);
    expect(start).toMatch(/color:\s*var\(--md-foreground\)/);
    expect(start).toMatch(/background:\s*transparent/);
    expect(start).toMatch(/border-color:\s*transparent/);
    expect(start).toMatch(/box-shadow:\s*none/);
    expect(start).not.toMatch(/--md4h-feedback-(?:accent|start-surface)/);
    expect(start).not.toMatch(/width:|height:|border-radius:\s*50%|color-mix/);
    expect(hover).toContain('var(--md-hover-bg)');
    expect(hover).toMatch(/box-shadow:\s*none/);
    expect(hover).not.toContain('--md4h-feedback-accent');
  });

  it('separates the visible session discard action from yellow Feedback controls', () => {
    const divider = ruleFor('.feedback-toolbar-divider');
    const menuHost = ruleFor('.feedback-more-menu-host');
    const discard = ruleFor('.feedback-discard-button');
    const discardIcon = ruleFor('.feedback-discard-button .toolbar-icon');
    const discardHover = ruleFor('.feedback-discard-button:not(:disabled):hover');
    const highContrast = ruleFor('.vscode-high-contrast .feedback-discard-button');

    expect(divider).toContain('var(--vscode-editorWidget-border');
    expect(menuHost).toMatch(/position:\s*relative/);
    expect(discard).toContain('var(--vscode-errorForeground)');
    expect(discard).toMatch(/background:\s*transparent/);
    expect(discard).not.toContain('--md4h-feedback-accent');
    expect(discardIcon).toContain('var(--vscode-errorForeground)');
    expect(discardHover).toContain('var(--vscode-errorForeground)');
    expect(discardHover).not.toContain('--md4h-feedback-highlight-saved');
    expect(highContrast).toContain('var(--vscode-contrastBorder');
  });

  it('styles annotation colors as compact swatches with non-color selection and focus cues', () => {
    const group = ruleFor('.feedback-annotation-colors');
    const swatch = ruleFor('.feedback-annotation-color');
    const selected = ruleFor(".feedback-annotation-color[aria-pressed='true']");
    const focus = ruleFor('.feedback-annotation-color:focus-visible');
    const highContrastSelected = ruleFor(
      ".vscode-high-contrast .feedback-annotation-color[aria-pressed='true']"
    );

    expect(group).toMatch(/display:\s*inline-flex/);
    expect(swatch).toMatch(/width:\s*24px/);
    expect(swatch).toMatch(/height:\s*24px/);
    expect(swatch).toContain('var(--md4h-annotation-swatch)');
    expect(selected).toMatch(/box-shadow:/);
    expect(selected).toMatch(/::after|outline:/);
    expect(focus).toContain('--vscode-focusBorder');
    expect(highContrastSelected).toContain('background: var(--md4h-annotation-swatch)');
    expect(highContrastSelected).toContain('--vscode-contrastActiveBorder');
    expect(css).toMatch(
      /\.vscode-high-contrast\s+\.feedback-annotation-color\[aria-pressed=['"]true['"]\][\s\S]*?--vscode-contrastActiveBorder/
    );
  });

  it('uses yellow for native review selection and the area-capture boundary only', () => {
    const reviewSelection = ruleFor('.feedback-review-active .markdown-editor ::selection');
    const captureSelection = ruleFor('.feedback-capture-active .markdown-editor ::selection');
    const crop = ruleFor('.feedback-capture-selection');

    expect(reviewSelection).toContain('var(--md4h-feedback-highlight-active)');
    expect(captureSelection).toMatch(/background(?:-color)?:\s*transparent\s*!important/);
    expect(crop).toContain('var(--md4h-feedback-highlight-edge)');
    expect(crop).not.toContain('--vscode-focusBorder');
  });

  it('uses yellow for primary feedback actions including screenshot submission', () => {
    const primary = ruleFor('.feedback-primary-button');
    const screenshotAdd = ruleFor(".feedback-annotation-actions [data-feedback-action='add']");

    for (const rule of [primary, screenshotAdd]) {
      expect(rule).toContain('var(--md4h-feedback-accent)');
      expect(rule).toContain('var(--md4h-feedback-on-accent)');
      expect(rule).not.toContain('--vscode-button-background');
      expect(rule).not.toContain('--vscode-focusBorder');
    }
  });

  it('reserves yellow for active and recovery actions rather than idle Start', () => {
    const start = ruleFor('.feedback-start-button');
    const draftPrimary = ruleFor('.feedback-draft-banner .feedback-primary-button');
    const warningThemeToken =
      /--vscode-(?:editorWarning-foreground|statusBarItem-warning(?:Background|Foreground)|notificationsWarningIcon-foreground)/;

    expect(start).not.toContain('--md4h-feedback-accent');
    expect(start).not.toMatch(warningThemeToken);
    expect(draftPrimary).toContain('--md4h-feedback-accent');
    expect(draftPrimary).toMatch(warningThemeToken);
    expect(draftPrimary).not.toContain('--vscode-button-background');
  });

  it('does not reintroduce purple or magenta accents into Feedback styling', () => {
    expect(feedbackCss).not.toMatch(
      /\b(?:purple|magenta)\b|#(?:8250df|a371f7|6f42c1|c586c0|bc8cff)\b/i
    );
  });

  it('keeps keyboard focus theme-defined and structurally distinct from yellow activation', () => {
    for (const selector of [
      '.feedback-marker:focus-visible',
      '.feedback-selection-action:focus-visible',
      '.feedback-block-action:focus-visible',
      '.feedback-primary-button:focus-visible',
      '.feedback-toolbar-button:focus-visible',
      '.feedback-start-button:focus-visible',
    ]) {
      const rule = ruleFor(selector);
      expect(rule).toMatch(/outline:\s*(?:1px|2px)\s+solid\s+var\(--vscode-focusBorder/);
      expect(rule).not.toContain('--md4h-feedback-accent');
      expect(rule).not.toContain('--md4h-feedback-highlight-edge');
    }
  });

  it('hides the whole-block action during capture and gives it a high-contrast boundary', () => {
    expect(ruleFor('.feedback-capture-active .feedback-block-action')).toMatch(
      /visibility:\s*hidden\s*!important/
    );
    for (const selector of [
      '.vscode-high-contrast .feedback-block-action',
      '.vscode-high-contrast-light .feedback-block-action',
    ]) {
      expect(ruleFor(selector)).toMatch(/border:\s*2px\s+solid/);
    }
  });

  it('previews the hovered whole block with paint-only theme styling and motion fallbacks', () => {
    const preview = ruleFor(
      '.feedback-review-active .markdown-editor ~ .feedback-block-target-preview'
    );
    const highContrast = ruleFor(
      'body.vscode-high-contrast.feedback-review-active .markdown-editor ~ .feedback-block-target-preview'
    );

    expect(preview).toMatch(/position:\s*absolute/);
    expect(preview).toMatch(/pointer-events:\s*none/);
    expect(preview).toContain('var(--md4h-feedback-highlight-saved)');
    expect(preview).toContain('var(--md4h-feedback-highlight-edge)');
    expect(preview).toMatch(/box-shadow:\s*inset/);
    expect(preview).toMatch(/animation:\s*feedback-block-target-preview-in\s+1(?:2|5|6)0ms/);
    expect(preview).not.toMatch(/(?:margin|padding|border(?:-width)?|transform):/);
    expect(highContrast).toMatch(/box-shadow:\s*inset\s+0\s+0\s+0\s+2px/);
    expect(highContrast).toMatch(/background:\s*transparent/);
    expect(css).toMatch(
      /@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*?\.feedback-block-target-preview[\s\S]*?animation:\s*none\s*!important/
    );
    expect(ruleFor('.feedback-capture-active .feedback-block-target-preview')).toMatch(
      /animation:\s*none\s*!important/
    );
  });

  it('lets high-contrast button colors override the yellow primary-action fill', () => {
    const darkHighContrast = ruleFor('.vscode-high-contrast .feedback-primary-button');
    const lightHighContrast = ruleFor('.vscode-high-contrast-light .feedback-primary-button');

    for (const rule of [darkHighContrast, lightHighContrast]) {
      expect(rule).toContain('--vscode-contrastActiveBorder');
      expect(rule).not.toContain('--md4h-feedback-highlight-saved');
      expect(rule).not.toContain('--md4h-feedback-highlight-active');
    }
  });

  it('keeps high-contrast action surfaces opaque through hover states', () => {
    const highContrastPalette = ruleFor('body.vscode-high-contrast.feedback-review-active');
    const paletteSelectors = highContrastPalette.slice(0, highContrastPalette.indexOf('{'));

    expect(highContrastPalette).toContain('--md4h-feedback-action-surface:');
    expect(highContrastPalette).toContain('--md4h-feedback-action-hover:');
    expect(highContrastPalette).toContain('--vscode-editorWidget-background');
    expect(highContrastPalette).toContain('--vscode-editorWidget-foreground');
    expect(paletteSelectors).toContain('body.vscode-high-contrast-light.feedback-review-active');
    expect(paletteSelectors).toContain('body.vscode-high-contrast.feedback-review-starting');
    expect(paletteSelectors).toContain('body.vscode-high-contrast.feedback-completion-open');
  });

  it('draws a thick layout-neutral review perimeter outside the prose edge', () => {
    const perimeter =
      css.match(/\.feedback-review-active\s+\.markdown-editor::after\s*\{[^}]*\}/)?.[0] ?? '';
    const editorBase = css.match(/^\s*\.markdown-editor\s*\{[^}]*\}/m)?.[0] ?? '';

    expect(perimeter).toMatch(/position:\s*absolute/);
    expect(perimeter).toMatch(/inset:\s*6px\s+0/);
    expect(perimeter).toMatch(/pointer-events:\s*none/);
    expect(perimeter).toMatch(/outline:\s*3px\s+dashed/);
    expect(perimeter).toMatch(/outline-offset:\s*11px/);
    expect(perimeter).toContain('--md4h-feedback-highlight-edge');
    expect(perimeter).not.toMatch(/padding:|margin:|border:/);
    expect(css).not.toMatch(/^\.markdown-editor::after\s*\{/m);

    const horizontalMargin = Number(editorBase.match(/margin:\s*\d+px\s+(\d+)px/)?.[1]);
    const outlineWidth = Number(perimeter.match(/outline:\s*(\d+)px/)?.[1]);
    const outlineOffset = Number(perimeter.match(/outline-offset:\s*(\d+)px/)?.[1]);
    expect(horizontalMargin).toBeGreaterThan(outlineWidth + outlineOffset);
  });

  it('makes the review perimeter solid in high contrast and suppresses it for capture', () => {
    expect(css).toMatch(
      /\.vscode-high-contrast[^\n]*\.feedback-review-active[^\n]*\.markdown-editor::after[\s\S]*?outline-style:\s*solid/
    );
    expect(css).toMatch(
      /\.feedback-capture-active\s+\.markdown-editor::after\s*\{[^}]*display:\s*none/
    );
  });

  it('keeps Cancel capture reachable while armed and hides the toolbar while rasterizing', () => {
    const armedToolbar =
      css.match(
        /body\[data-feedback-capture-state=['"]armed['"]\]\s+\.formatting-toolbar\.feedback-toolbar-active\s*\{[^}]*\}/
      )?.[0] ?? '';
    const rasterizingToolbar =
      css.match(
        /body\[data-feedback-capture-state=['"]rasterizing['"]\]\s+\.formatting-toolbar\s*\{[^}]*\}/
      )?.[0] ?? '';

    expect(armedToolbar).toMatch(/z-index:\s*5001/);
    expect(armedToolbar).toMatch(/visibility:\s*visible\s*!important/);
    expect(rasterizingToolbar).toMatch(/visibility:\s*hidden\s*!important/);
    expect(css).not.toMatch(/\.feedback-capture-active\s+\.formatting-toolbar\s*,/);
  });

  it('gives the finish checkpoint a compact, theme-aware, readable surface', () => {
    const panel = css.match(/\.feedback-completion-panel\s*\{[^}]*\}/)?.[0] ?? '';
    const count = css.match(/\.feedback-completion-count\s*\{[^}]*\}/)?.[0] ?? '';
    const path = css.match(/\.feedback-completion-path\s*\{[^}]*\}/)?.[0] ?? '';

    expect(panel).toMatch(/width:\s*min\(520px,\s*calc\(100vw\s*-\s*32px\)\)/);
    expect(panel).toMatch(/max-height:\s*min\(620px,\s*calc\(100vh\s*-\s*32px\)\)/);
    expect(count).toContain('--vscode-editor-foreground');
    expect(count).toMatch(/font-weight:\s*400/);
    expect(count).not.toContain('--md4h-feedback-accent');
    expect(count).not.toContain('--md4h-feedback-highlight');
    expect(count).not.toMatch(/background:|border:|padding:/);
    expect(path).toMatch(/overflow-wrap:\s*anywhere/);
    expect(path).toMatch(/user-select:\s*text/);
  });

  it('keeps completion state non-animated and opaque in accessibility modes', () => {
    const dialog = css.match(/\.feedback-completion-dialog\s*\{[^}]*\}/)?.[0] ?? '';
    const panel = css.match(/\.feedback-completion-panel\s*\{[^}]*\}/)?.[0] ?? '';

    expect(dialog).toMatch(/overflow:\s*hidden/);
    expect(dialog).toMatch(/overscroll-behavior:\s*contain/);
    expect(panel).toMatch(/overscroll-behavior:\s*contain/);
    expect(css).toMatch(
      /\.feedback-completion-dialog\[data-feedback-completion-state=['"]finishing['"]\][\s\S]*?cursor:\s*progress/
    );
    expect(css).toMatch(
      /\.vscode-high-contrast\s+\.feedback-completion-dialog[\s\S]*?background:\s*var\(--vscode-editor-background\)/
    );
    expect(css).toMatch(
      /\.vscode-using-screen-reader\s+\.feedback-completion-dialog[\s\S]*?backdrop-filter:\s*none/
    );
    expect(css).toMatch(
      /@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*?\.feedback-completion-dialog/
    );
    expect(css).toMatch(
      /@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*?\.feedback-start-button/
    );
    expect(css).toMatch(
      /@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*?\.feedback-start-button:hover[\s\S]*?transform:\s*none/
    );
  });

  it('styles the discard checkpoint as a compact, topmost, theme-aware modal', () => {
    const annotationDialog = ruleFor('.feedback-annotation-dialog');
    const dialog = ruleFor('.feedback-discard-dialog');
    const panel = ruleFor('.feedback-discard-panel');
    const description = ruleFor('.feedback-discard-description');
    const actions = ruleFor('.feedback-discard-actions');
    const confirm = ruleFor('.feedback-discard-confirm');
    const confirmFocus = ruleFor('.feedback-discard-confirm:focus-visible');
    const highContrastDialog = ruleFor('.vscode-high-contrast .feedback-discard-dialog');
    const highContrastConfirm = ruleFor('.vscode-high-contrast .feedback-discard-confirm');
    const screenReaderDialog = ruleFor('.vscode-using-screen-reader .feedback-discard-dialog');
    const baseZIndex = Number(annotationDialog.match(/z-index:\s*(\d+)/)?.[1]);
    const discardZIndex = Number(dialog.match(/z-index:\s*(\d+)/)?.[1]);

    expect(discardZIndex).toBeGreaterThan(baseZIndex);
    expect(panel).toMatch(/width:\s*min\(440px,\s*calc\(100vw\s*-\s*32px\)\)/);
    expect(description).toContain('--vscode-descriptionForeground');
    expect(actions).toMatch(/justify-content:\s*flex-end/);
    expect(confirm).toContain('--vscode-errorForeground');
    expect(confirmFocus).toContain('--vscode-focusBorder');
    expect(highContrastDialog).toContain('background: var(--vscode-editor-background)');
    expect(highContrastDialog).toContain('backdrop-filter: none');
    expect(highContrastConfirm).toContain('--vscode-contrastActiveBorder');
    expect(screenReaderDialog).toContain('background: var(--vscode-editor-background)');
    expect(screenReaderDialog).toContain('backdrop-filter: none');
    expect(css).toMatch(
      /@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*?\.feedback-discard-dialog/
    );
  });

  it('provides explicit high-contrast and reduced-motion annotation treatments', () => {
    expect(css).toMatch(
      /\.vscode-high-contrast[^\n]*\.md4h-feedback-highlight|\.vscode-high-contrast\s+\.feedback-review-active[\s\S]*?\.md4h-feedback-highlight/
    );
    expect(css).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*feedback-card/);
    expect(css).toMatch(/\.feedback-connectors[^}]*pointer-events:\s*none/);
  });

  it('keeps high-contrast inline feedback indicators paint-only', () => {
    const highContrastInlineRule =
      css.match(
        /\.vscode-high-contrast\s+\.feedback-review-active\s+\.markdown-editor\s+\.md4h-feedback-highlight,[\s\S]*?body\.vscode-high-contrast-light\.feedback-review-active[\s\S]*?\.md4h-feedback-annotation-inline\s*\{[^}]*\}/
      )?.[0] ?? '';

    expect(highContrastInlineRule).toMatch(/box-shadow:\s*inset\s+0\s+-2px\s+0/);
    expect(highContrastInlineRule).not.toMatch(/border-bottom:/);
  });

  it('gives armed area capture a high-contrast non-color cue', () => {
    expect(css).toMatch(
      /\.vscode-high-contrast\s+\.feedback-capture-button\[aria-pressed=['"]true['"]\],[\s\S]*?outline:\s*2px\s+solid\s+var\(--vscode-contrastActiveBorder/
    );
  });

  it('centers marker geometry and keeps keyboard focus distinct from activation', () => {
    const marker = css.match(/\.feedback-marker\s*\{[^}]*\}/)?.[0] ?? '';

    expect(marker).toMatch(/box-sizing:\s*border-box/);
    expect(marker).toMatch(/transform:\s*translateY\(-50%\)/);
    expect(css).toMatch(/\.feedback-marker:focus-visible\s*\{[^}]*outline:/);
  });

  it('visually distinguishes every disabled feedback action from an enabled button', () => {
    const rules = css.match(/[^{}]+\{[^{}]*\}/g) ?? [];
    for (const selector of [
      '.feedback-card-action:disabled',
      '.feedback-secondary-button:disabled',
      '.feedback-primary-button:disabled',
      '.feedback-undo-delete:disabled',
    ]) {
      const rule = rules.find(candidate =>
        candidate.slice(0, candidate.indexOf('{')).includes(selector)
      );
      expect(rule ?? '').toMatch(/opacity:\s*0?\.\d+/);
      expect(rule ?? '').toMatch(/cursor:\s*not-allowed/);
    }

    const primaryDisabledRules = rules.filter(candidate =>
      candidate.slice(0, candidate.indexOf('{')).includes('.feedback-primary-button:disabled')
    );
    expect(primaryDisabledRules.at(-1) ?? '').toContain('--vscode-button-secondaryBackground');
    expect(feedbackCss).toContain('.feedback-primary-button:not(:disabled):hover');
    expect(feedbackCss).toContain("[data-feedback-action='add']:not(:disabled):hover");
  });

  it('separates the inline feedback editor with theme-derived review styling', () => {
    const editForm = ruleFor('.feedback-card-edit-form');

    expect(editForm).toContain('border-top:');
    expect(editForm).toContain('var(--md4h-feedback-highlight-edge)');
    expect(editForm).not.toMatch(/#[0-9a-f]{3,8}|rgba?\(/i);
    expect(ruleFor('.feedback-card-edit-form .feedback-composer-actions')).toContain('margin-top:');
  });

  it('bounds adaptive composer input growth without introducing a second default scrollbar', () => {
    const heading = ruleFor('.feedback-composer-heading');
    const sizeToggle = ruleFor('.feedback-composer-size-toggle');
    const input = ruleFor('.feedback-composer-input');

    expect(heading).toContain('display: flex');
    expect(heading).toContain('justify-content: space-between');
    expect(sizeToggle).toContain('var(--vscode-font-family)');
    expect(sizeToggle).not.toMatch(/#[0-9a-f]{3,8}|rgba?\(/i);
    expect(input).toMatch(/min-height:\s*96px/);
    expect(input).toMatch(/max-height:\s*min\(420px, 40vh\)/);
    expect(input).toMatch(/overflow-y:\s*hidden/);
    expect(input).toMatch(/resize:\s*none/);
  });

  it('contains long literal code and opt-in expanded target previews', () => {
    const code = ruleFor('.feedback-target-code');
    const expanded = ruleFor('.feedback-target-expanded');

    expect(code).toMatch(/white-space:\s*pre/);
    expect(code).toMatch(/overflow-x:\s*auto/);
    expect(expanded).toMatch(/max-height:\s*min\(320px, 40vh\)/);
    expect(expanded).toMatch(/overflow:\s*auto/);
  });

  it('keeps saved highlights fully hidden in high-contrast themes', () => {
    expect(css).toMatch(
      /body\[data-feedback-comments-state=['"]hidden['"]\]\.vscode-high-contrast[\s\S]*?\.md4h-feedback-annotation-inline\s*\{[^}]*border:\s*0[^}]*outline:\s*none/
    );
    expect(css).toMatch(
      /body\[data-feedback-comments-state=['"]hidden['"]\]\.vscode-high-contrast[\s\S]*?\.md4h-feedback-annotation-node\s*\{[^}]*box-shadow:\s*none/
    );
  });

  it('removes the review frame itself while capture pixels are generated', () => {
    expect(css).toMatch(
      /\.feedback-capture-active\s+\.markdown-editor\s*\{[^}]*box-shadow:\s*none[^}]*border-radius:\s*0/
    );
  });

  it('keeps search matches visible during review and suppresses them only for capture', () => {
    expect(css).not.toMatch(/\.feedback-review-active\s+\.markdown-editor\s+\.search-match/);
    expect(css).toMatch(
      /\.feedback-capture-active\s+\.markdown-editor\s+\.search-match[\s\S]*?background:\s*transparent\s*!important/
    );
  });

  it('styles fallback brackets as decorative, active, high-contrast-safe review chrome', () => {
    const bracket = css.match(/\.feedback-target-bracket\s*\{[^}]*\}/)?.[0] ?? '';

    expect(bracket).toMatch(/position:\s*absolute/);
    expect(bracket).toMatch(/pointer-events:\s*none/);
    expect(bracket).toMatch(/border-left:/);
    expect(css).toMatch(/\.feedback-target-bracket\.active\s*\{[^}]*border-left-color:/);
    expect(css).toMatch(
      /\.vscode-high-contrast\s+\.feedback-target-bracket[\s\S]*?border-left-width:\s*2px/
    );
    expect(css).toMatch(
      /body\[data-feedback-comments-state=['"]hidden['"]\][\s\S]*?\.feedback-target-bracket-layer\s*\{[^}]*display:\s*none/
    );
    expect(css).toMatch(
      /\.feedback-capture-active\s+\.feedback-target-bracket-layer\s*\{[^}]*visibility:\s*hidden/
    );
  });
});
