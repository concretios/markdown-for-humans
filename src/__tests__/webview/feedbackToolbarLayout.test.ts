/**
 * @jest-environment node
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';

describe('Feedback toolbar layout CSS', () => {
  const css = readFileSync(resolve(__dirname, '../../webview/editor.css'), 'utf8');

  it('centers only the active Feedback toolbar group', () => {
    const activeRule = css.match(/\.formatting-toolbar\.feedback-toolbar-active\s*\{[^}]*\}/)?.[0];
    const baseRule = css.match(/(?:^|\n)\s*\.formatting-toolbar\s*\{[^}]*\}/)?.[0];

    expect(activeRule).toMatch(/justify-content:\s*center/);
    expect(activeRule).toMatch(/z-index:\s*230/);
    expect(baseRule).not.toMatch(/justify-content:\s*center/);
  });

  it('keeps the centered group as the overflow menu positioning context', () => {
    const groupRule = css.match(/\.feedback-toolbar-group\s*\{[^}]*\}/)?.[0];
    const menuRule = css.match(/\.feedback-more-menu\s*\{[^}]*\}/)?.[0];

    expect(groupRule).toMatch(/position:\s*relative/);
    expect(groupRule).toMatch(/display:\s*flex/);
    expect(menuRule).toMatch(/right:\s*0/);
    expect(menuRule).toMatch(/top:\s*calc\(100%\s*\+\s*9px\)/);
    expect(menuRule).toMatch(/max-width:\s*calc\(100vw\s*-\s*16px\)/);
  });

  it('keeps every closing action visibly disabled, including the active Comments control', () => {
    const busyRule = css.match(
      /\.feedback-toolbar-group\[aria-busy=['"]true['"]\]\s+\.feedback-toolbar-button:disabled\s*\{[^}]*\}/
    )?.[0];

    expect(busyRule).toMatch(/opacity:\s*0?\.\d+/);
    expect(busyRule).toMatch(/cursor:\s*not-allowed/);
  });

  it('retains the narrow icon-only fallback', () => {
    const narrowStart = css.indexOf('@media (max-width: 520px)');
    const narrowEnd = css.indexOf('.vscode-high-contrast', narrowStart);
    const narrowRules = css.slice(narrowStart, narrowEnd);

    expect(narrowStart).toBeGreaterThanOrEqual(0);
    expect(narrowRules).toMatch(
      /\.feedback-toolbar-button\s*\{[^}]*width:\s*28px;[^}]*min-width:\s*28px/
    );
    expect(narrowRules).toMatch(/\.toolbar-button-label\s*\{[^}]*display:\s*none/);
    expect(narrowRules).toMatch(
      /\.feedback-toolbar-group \.feedback-more-menu\s*\{[^}]*left:\s*50%[^}]*transform:\s*translateX\(-50%\)/
    );
  });
});
