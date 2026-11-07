import { readFileSync } from 'fs';
import * as path from 'path';
import MarkdownIt from 'markdown-it';
import { findImageSourceReferences } from '../../editor/imageSourceReferences';
import { createScannerWorkProbe } from '../helpers/scannerWorkBudget';

const sourceText = readFileSync(
  path.join(__dirname, '../../editor/imageSourceReferences.ts'),
  'utf8'
);
const scanWithWorkBudget = createScannerWorkProbe(sourceText);

describe('image reference scanner deterministic work budget', () => {
  it.each([
    [
      'nested suffix loops',
      'for (let start = 0; start < source.length; start++)\n' +
        '  for (let cursor = start; cursor < source.length; cursor++) source[cursor];',
    ],
    [
      'repeated suffix slices',
      'for (let start = 0; start < source.length; start++) source.slice(start);',
    ],
  ])('rejects %s even when the scanner returns immediately afterward', (_name, body) => {
    const regressedScanner = createScannerWorkProbe(
      `export function findImageSourceReferences(source: string) { ${body}\nreturn []; }`
    );
    const source = 'x'.repeat(64);
    expect(() => regressedScanner(source, source.length * 20)).toThrow(
      'Image scanner exceeded its linear work budget'
    );
  });

  it.each(['a<b\n', '![open\n', 'a<b', '![open'])(
    'bounds loop iterations and sliced characters for unclosed %j references',
    fragment => {
      for (const size of [280_000, 560_000]) {
        const source =
          fragment.repeat(Math.ceil(size / fragment.length)) + '\n\n![real](actual.png)';
        // A fixed number of source passes is allowed. Repeated suffix loops or
        // regex input slices exceed this bound regardless of runner/coverage speed.
        const budget = source.length * 20;
        const result = scanWithWorkBudget(source, budget);
        expect(result.references).toEqual(findImageSourceReferences(source));
        expect(result.references.map(reference => reference.source)).toEqual(['actual.png']);
        expect(result.work).toBeGreaterThan(source.length);
        expect(result.work).toBeLessThanOrEqual(budget);
      }
    }
  );

  it('does not reparse inline delimiters while collecting block maps', () => {
    const parser = new MarkdownIt();
    const inlineParse = jest.spyOn(Object.getPrototypeOf(parser.inline), 'parse');
    try {
      // Positive control proves the spy observes the parser used by MarkdownIt.
      parser.parse('![control](control.png)', {});
      expect(inlineParse).toHaveBeenCalled();
      inlineParse.mockClear();
      const source = '![open\n'.repeat(40_000) + '\n![real](actual.png)';
      expect(findImageSourceReferences(source).map(reference => reference.source)).toEqual([
        'actual.png',
      ]);
      expect(inlineParse).not.toHaveBeenCalled();
    } finally {
      inlineParse.mockRestore();
    }
  });
});
