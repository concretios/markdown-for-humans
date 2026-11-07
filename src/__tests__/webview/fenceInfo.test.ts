import { parseFenceInfo, replaceFenceLanguage } from '../../webview/highlighting/fenceInfo';

describe('authored code fence information', () => {
  it('normalizes only the language and preserves the exact metadata suffix', () => {
    expect(parseFenceInfo('TS\t title="A B.ts"  {1,3} ')).toEqual({
      language: 'ts',
      suffix: '\t title="A B.ts"  {1,3} ',
    });
    expect(parseFenceInfo('C++ linenums')).toEqual({ language: 'c++', suffix: ' linenums' });
  });

  it.each([undefined, null, false, 17, {}, ''])('treats %p as an empty fence label', value => {
    expect(parseFenceInfo(value)).toEqual({ language: '', suffix: '' });
  });

  it('handles leading whitespace without trimming authored trailing metadata', () => {
    expect(parseFenceInfo('  SQL\t title="queries.sql"  ')).toEqual({
      language: 'sql',
      suffix: '\t title="queries.sql"  ',
    });
    expect(parseFenceInfo(' \t ')).toEqual({ language: '', suffix: '' });
  });

  it('changes only the language token, including for explicit plain text', () => {
    expect(replaceFenceLanguage('TS\t title="A B.ts"  {1,3} ', 'javascript')).toBe(
      'javascript\t title="A B.ts"  {1,3} '
    );
    expect(replaceFenceLanguage('SQL title="a.sql"', 'plaintext')).toBe('plaintext title="a.sql"');
    expect(replaceFenceLanguage(null, 'typescript')).toBe('typescript');
  });
});
