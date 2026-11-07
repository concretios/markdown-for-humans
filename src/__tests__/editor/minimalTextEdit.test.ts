import { computeMinimalTextReplacement } from '../../editor/minimalTextEdit';

function applyReplacement(
  source: string,
  replacement: NonNullable<ReturnType<typeof computeMinimalTextReplacement>>
): string {
  return `${source.slice(0, replacement.startOffset)}${replacement.text}${source.slice(
    replacement.endOffset
  )}`;
}

describe('computeMinimalTextReplacement', () => {
  it.each([
    ['middle insertion', 'Alpha omega\n', 'Alpha beta omega\n'],
    ['middle deletion', 'Alpha beta omega\n', 'Alpha omega\n'],
    ['multiline replacement', 'A\nold one\nold two\nZ\n', 'A\nnew\nZ\n'],
    ['empty to content', '', '# Heading\n'],
    ['content to empty', '# Heading\n', ''],
    ['CRLF content', 'A\r\nold\r\nZ\r\n', 'A\r\nnew\r\nZ\r\n'],
    ['astral Unicode', 'A😀B\n', 'A😃B\n'],
    ['combining text', 'Cafe\u0301 old\n', 'Cafe\u0301 new\n'],
  ])('reconstructs the target for %s', (_label, source, target) => {
    const replacement = computeMinimalTextReplacement(source, target);

    expect(replacement).not.toBeNull();
    expect(applyReplacement(source, replacement!)).toBe(target);
    expect(replacement!.startOffset).toBeGreaterThanOrEqual(0);
    expect(replacement!.endOffset).toBeGreaterThanOrEqual(replacement!.startOffset);
    expect(replacement!.endOffset).toBeLessThanOrEqual(source.length);
  });

  it('keeps the unchanged prefix and suffix outside a small edit', () => {
    const source = 'prefix: old value :suffix';
    const replacement = computeMinimalTextReplacement(source, 'prefix: new value :suffix');

    expect(replacement).toEqual({
      startOffset: 'prefix: '.length,
      endOffset: 'prefix: old'.length,
      text: 'new',
    });
  });

  it('never splits a UTF-16 surrogate pair at either range boundary', () => {
    const source = 'A😀B😀C';
    const replacement = computeMinimalTextReplacement(source, 'A😃B😄C');

    expect(replacement).not.toBeNull();
    const startCode = source.charCodeAt(replacement!.startOffset);
    const endCode = source.charCodeAt(replacement!.endOffset - 1);
    expect(startCode >= 0xdc00 && startCode <= 0xdfff).toBe(false);
    expect(endCode >= 0xd800 && endCode <= 0xdbff).toBe(false);
    expect(applyReplacement(source, replacement!)).toBe('A😃B😄C');
  });

  it('never puts a range boundary inside a CRLF pair', () => {
    const source = 'A\r\nB\r\nC';
    const replacement = computeMinimalTextReplacement(source, 'A\rX\nB\r\nC');

    expect(replacement).not.toBeNull();
    expect(source.slice(replacement!.startOffset - 1, replacement!.startOffset + 1)).not.toBe(
      '\r\n'
    );
    expect(source.slice(replacement!.endOffset - 1, replacement!.endOffset + 1)).not.toBe('\r\n');
    expect(applyReplacement(source, replacement!)).toBe('A\rX\nB\r\nC');
  });

  it('returns null for identical text', () => {
    expect(computeMinimalTextReplacement('Unchanged\n', 'Unchanged\n')).toBeNull();
  });
});
