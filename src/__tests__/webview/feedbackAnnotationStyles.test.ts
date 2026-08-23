import { readFileSync } from 'fs';
import * as path from 'path';

const css = readFileSync(path.resolve(__dirname, '../../webview/editor.css'), 'utf8');

describe('Feedback annotation styles', () => {
  it('uses a document-positioned overlay without creating a second scroll surface', () => {
    const layer = css.match(/\.feedback-annotation-layer\s*\{[^}]*\}/)?.[0] ?? '';
    const cardLayer = css.match(/\.feedback-card-layer\s*\{[^}]*\}/)?.[0] ?? '';

    expect(layer).toMatch(/position:\s*absolute/);
    expect(layer).not.toMatch(/position:\s*fixed/);
    expect(layer).toMatch(/pointer-events:\s*none/);
    expect(cardLayer).not.toMatch(/overflow(?:-y)?:\s*(?:auto|scroll)/);
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

  it('uses the same warm review accent for pending and active fallback targets', () => {
    const pending =
      css.match(
        /\.feedback-review-active\s+\.markdown-editor\s+\.feedback-pending-target\s*\{[^}]*\}/
      )?.[0] ?? '';
    const active =
      css.match(
        /\.feedback-review-active\s+\.markdown-editor\s+\.feedback-active-target\s*\{[^}]*\}/
      )?.[0] ?? '';

    expect(pending).toContain('--vscode-editorWarning-foreground');
    expect(active).toContain('--vscode-editorWarning-foreground');
    expect(css).toMatch(
      /\.vscode-high-contrast\s+\.feedback-review-active\s+\.markdown-editor\s+\.feedback-pending-target[\s\S]*?outline:\s*2px\s+solid/
    );
  });

  it('draws a layout-neutral theme-aware review perimeter only in Feedback mode', () => {
    const perimeter =
      css.match(/\.feedback-review-active\s+\.markdown-editor::after\s*\{[^}]*\}/)?.[0] ?? '';

    expect(perimeter).toMatch(/position:\s*absolute/);
    expect(perimeter).toMatch(/inset:\s*0/);
    expect(perimeter).toMatch(/pointer-events:\s*none/);
    expect(perimeter).toMatch(/border:\s*2px\s+dashed/);
    expect(perimeter).toContain('--vscode-editorWarning-foreground');
    expect(perimeter).not.toMatch(/padding:|margin:/);
    expect(css).not.toMatch(/^\.markdown-editor::after\s*\{/m);
  });

  it('makes the review perimeter solid in high contrast and suppresses it for capture', () => {
    expect(css).toMatch(
      /\.vscode-high-contrast[^\n]*\.feedback-review-active[^\n]*\.markdown-editor::after[\s\S]*?border-style:\s*solid/
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
    expect(count).toContain('--vscode-editorWarning-foreground');
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
