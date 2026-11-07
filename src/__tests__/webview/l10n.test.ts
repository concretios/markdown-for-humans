/** @jest-environment jsdom */
/**
 * Copyright (c) 2025-2026 Concret.io
 *
 * Licensed under the MIT License. See LICENSE file in the project root for details.
 */

import { L10N_BUNDLE_ATTRIBUTE } from '../../shared/l10n';
import * as l10n from '../../webview/l10n';

describe('webview l10n', () => {
  afterEach(() => {
    document.body.removeAttribute(L10N_BUNDLE_ATTRIBUTE);
    l10n.resetL10n();
  });

  describe('lookup', () => {
    it('returns the translation when the bundle has the message', () => {
      l10n.configureL10n({ 'No results': '无结果' });
      expect(l10n.t('No results')).toBe('无结果');
    });

    it('substitutes placeholders in the translated message', () => {
      l10n.configureL10n({ '{0} of {1}': '第 {0} 项，共 {1} 项' });
      expect(l10n.t('{0} of {1}', 3, 12)).toBe('第 3 项，共 12 项');
    });
  });

  describe('translator comments', () => {
    it('looks a commented message up under message/comment', () => {
      l10n.configureL10n({ Quote: '报价', 'Quote/Block quote button': '引用' });
      expect(l10n.t('Quote')).toBe('报价');
      expect(l10n.t({ message: 'Quote', comment: 'Block quote button' })).toBe('引用');
    });

    it('substitutes args and falls back to the English message', () => {
      expect(l10n.t({ message: 'Open {0}', args: ['a.md'], comment: ['Verb'] })).toBe('Open a.md');
      l10n.configureL10n({ 'Open {0}/Verb': '打开 {0}' });
      expect(l10n.t({ message: 'Open {0}', args: ['a.md'], comment: ['Verb'] })).toBe('打开 a.md');
    });
  });

  describe('html', () => {
    it('escapes the translation and its arguments', () => {
      l10n.configureL10n({ 'Rename {0}': '<b>重命名</b> {0}' });
      expect(l10n.html('Rename {0}', '<img src=x>')).toBe(
        '&lt;b&gt;重命名&lt;/b&gt; &lt;img src=x&gt;'
      );
    });

    it('lets markup wrap a placeholder that was left without an argument', () => {
      l10n.configureL10n({ 'Add {0} to see the outline': '添加 {0} 以查看大纲' });
      const markup = l10n
        .html('Add {0} to see the outline')
        .replace('{0}', '<code># Heading</code>');
      expect(markup).toBe('添加 <code># Heading</code> 以查看大纲');
    });

    it('accepts a commented message', () => {
      expect(l10n.html({ message: 'Save & close', comment: 'Button' })).toBe('Save &amp; close');
    });
  });

  describe('formatNumber', () => {
    afterEach(() => document.documentElement.removeAttribute('lang'));

    it('formats like English when no display language is set', () => {
      expect(l10n.formatNumber(1.5, 1)).toBe('1.5');
      expect(l10n.formatNumber(1023.94, 1)).toBe('1023.9');
      expect(l10n.formatNumber(42)).toBe('42');
    });

    it('uses the decimal mark of the display language', () => {
      document.documentElement.lang = 'de';
      expect(l10n.formatNumber(1.5, 1)).toBe('1,5');
      document.documentElement.lang = 'pt-br';
      expect(l10n.formatNumber(2.25, 1)).toMatch(/^2,[23]$/);
    });

    it('falls back to plain digits for a language tag the runtime rejects', () => {
      document.documentElement.lang = 'not a language';
      expect(l10n.formatNumber(1.5, 1)).toBe('1.5');
    });
  });

  describe('fallback to English', () => {
    it('returns the source message when no bundle is configured', () => {
      expect(l10n.t('No results')).toBe('No results');
      expect(l10n.t('{0} of {1}', 3, 12)).toBe('3 of 12');
    });

    it('returns the source message when the bundle lacks it', () => {
      l10n.configureL10n({ 'No results': '无结果' });
      expect(l10n.t('Close search')).toBe('Close search');
    });

    it('treats an empty translation as missing', () => {
      l10n.configureL10n({ 'No results': '' });
      expect(l10n.t('No results')).toBe('No results');
    });

    it('ignores inherited object keys', () => {
      l10n.configureL10n({});
      expect(l10n.t('constructor')).toBe('constructor');
      expect(l10n.t('toString')).toBe('toString');
    });
  });

  describe('delivery from the extension host', () => {
    it('reads the bundle the host rendered on <body> on first use', () => {
      document.body.setAttribute(L10N_BUNDLE_ATTRIBUTE, JSON.stringify({ 'No results': '无结果' }));
      expect(l10n.t('No results')).toBe('无结果');
    });

    it('stays in English when the attribute is absent', () => {
      expect(l10n.t('No results')).toBe('No results');
    });

    it('stays in English when the attribute is malformed', () => {
      document.body.setAttribute(L10N_BUNDLE_ATTRIBUTE, '{broken');
      expect(l10n.t('No results')).toBe('No results');
    });

    it('reads the attribute only once', () => {
      const read = jest.spyOn(document.body, 'getAttribute');
      l10n.t('No results');
      l10n.t('No results');
      l10n.t('Close search');
      expect(read.mock.calls.filter(([name]) => name === L10N_BUNDLE_ATTRIBUTE)).toHaveLength(1);
      read.mockRestore();
    });
  });
});
