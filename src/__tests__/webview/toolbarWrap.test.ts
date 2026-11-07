import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The formatting toolbar has 30 or more controls. With `flex-wrap: nowrap` the
 * last ones (Export, Audit, Export settings) were clipped and unreachable once
 * the editor was narrower than the toolbar, which is common beside a sidebar or in
 * a split view. The toolbar now wraps onto a second row instead.
 */
describe('formatting toolbar layout', () => {
  const css = readFileSync(join(__dirname, '../../webview/editor.css'), 'utf8');

  it('wraps onto another row instead of clipping its last buttons', () => {
    const rule = css.match(/\n\s*\.formatting-toolbar\s*\{([^}]*)\}/);
    expect(rule).not.toBeNull();
    expect(rule?.[1]).toMatch(/display:\s*flex/);
    expect(rule?.[1]).toMatch(/flex-wrap:\s*wrap/);
  });
});
