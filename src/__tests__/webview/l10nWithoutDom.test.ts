/**
 * Copyright (c) 2025-2026 Concret.io
 *
 * Licensed under the MIT License. See LICENSE file in the project root for details.
 *
 * Runs in the default node environment: no `document`, as in the highlighting
 * worker and in tests that import webview modules without a DOM.
 */

import * as l10n from '../../webview/l10n';

describe('webview l10n without a DOM', () => {
  afterEach(() => l10n.resetL10n());

  it('returns English instead of throwing', () => {
    expect(typeof document).toBe('undefined');
    expect(l10n.t('{0} of {1}', 1, 2)).toBe('1 of 2');
    expect(l10n.html('Save & close')).toBe('Save &amp; close');
  });

  it('still uses translations that were configured directly', () => {
    l10n.configureL10n({ 'No results': '无结果' });
    expect(l10n.t('No results')).toBe('无结果');
  });
});
