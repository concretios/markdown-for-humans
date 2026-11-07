import { explainHighlightFailure } from '../../webview/highlighting/types';
import * as l10n from '../../webview/l10n';

describe('explainHighlightFailure', () => {
  afterEach(() => {
    l10n.resetL10n();
  });

  it('explains each failure in English when no bundle is loaded', () => {
    expect(explainHighlightFailure('source-limit')).toBe(
      'This code block is too large to highlight. Its text remains editable.'
    );
    expect(explainHighlightFailure('range-limit')).toBe(
      'This code block has too many tokens to highlight. Its text remains editable.'
    );
    expect(explainHighlightFailure('worker-timeout')).toBe(
      'Highlighting took too long. The code remains editable.'
    );
    expect(explainHighlightFailure('busy')).toBe('Highlighting is waiting for another code block.');
    expect(explainHighlightFailure('anything-else')).toBe(
      'Highlighting is unavailable for this code block. Its text remains editable.'
    );
  });

  it('translates the notice and still switches on the reason code', () => {
    l10n.configureL10n({
      'This code block is too large to highlight. Its text remains editable.':
        '此代码块过大，无法高亮。其文本仍可编辑。',
      'Highlighting is waiting for another code block.': '正在等待另一个代码块完成高亮。',
    });

    expect(explainHighlightFailure('source-limit')).toBe(
      '此代码块过大，无法高亮。其文本仍可编辑。'
    );
    expect(explainHighlightFailure('busy')).toBe('正在等待另一个代码块完成高亮。');
    // Reason codes that mean "say nothing" stay empty, translated or not.
    expect(explainHighlightFailure('plain')).toBe('');
    expect(explainHighlightFailure('disposed')).toBe('');
  });
});
