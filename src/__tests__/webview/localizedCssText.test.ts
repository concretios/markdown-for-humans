/** @jest-environment jsdom */
/**
 * Copyright (c) 2025-2026 Concret.io
 *
 * Licensed under the MIT License. See LICENSE file in the project root for details.
 */

import { readFileSync } from 'fs';
import * as path from 'path';
import * as l10n from '../../webview/l10n';
import { applyLocalizedCssText, toCssString } from '../../webview/utils/localizedCssText';

const css = readFileSync(path.resolve(__dirname, '../../webview/editor.css'), 'utf8');
const variable = (name: string): string => document.documentElement.style.getPropertyValue(name);

describe('text shown through CSS content', () => {
  afterEach(() => {
    l10n.resetL10n();
    document.documentElement.removeAttribute('style');
  });

  it('keeps the English text as the stylesheet fallback', () => {
    expect(css).toContain("content: var(--md4h-text-start-writing, 'Start writing...');");
    expect(css).toContain("content: var(--md4h-text-drop-image, 'Drop image here');");
  });

  it('publishes the English text when no translation is loaded', () => {
    applyLocalizedCssText();
    expect(variable('--md4h-text-start-writing')).toBe('"Start writing..."');
    expect(variable('--md4h-text-drop-image')).toBe('"Drop image here"');
  });

  it('publishes the translated text', () => {
    l10n.configureL10n({
      'Start writing...': '开始写作...',
      'Drop image here': '将图片拖放到此处',
    });
    applyLocalizedCssText();
    expect(variable('--md4h-text-start-writing')).toBe('"开始写作..."');
    expect(variable('--md4h-text-drop-image')).toBe('"将图片拖放到此处"');
  });

  it('writes a translation as one CSS string, whatever it contains', () => {
    expect(toCssString('say "hi" \\ now')).toBe('"say \\"hi\\" \\\\ now"');
    expect(toCssString('two\nlines')).toBe('"two\\a lines"');
  });
});
