/** @jest-environment jsdom */

import { parseFrontmatter } from '../../webview/frontmatter/presentation';
import { renderFrontmatterProperties } from '../../webview/frontmatter/properties';

const source = [
  '---',
  'title: Field notes',
  'tags: [markdown, vscode]',
  'reviewers:',
  '  - Maya',
  '  - Ren',
  'display: {diagrams: false, attempts: 3, owner: null}',
  'updated: 2026-11-15',
  'summary: >-',
  '  Markdown [notes], with punctuation:',
  '  and <img src=x> as text.',
  '---',
].join('\n');

describe('frontmatter presentation', () => {
  it('marks collections and scalar structure without treating prose punctuation as YAML', () => {
    const result = parseFrontmatter(source);
    expect(
      result?.ranges
        .filter(range => range.kind === 'punctuation')
        .map(range => source.slice(range.from, range.to))
    ).toEqual(expect.arrayContaining(['[', ']', ',', '{', '}', '-', '>-']));
    expect(
      result?.ranges.some(
        range => range.kind === 'punctuation' && range.from >= source.indexOf('Markdown [notes]')
      )
    ).toBe(false);
    expect(result?.ranges.some(range => range.kind === 'indent')).toBe(true);
    expect(result?.ranges.some(range => range.kind === 'multiline')).toBe(true);
  });

  it('renders a folded summary, inline list chips and nested data using text nodes', () => {
    const result = parseFrontmatter(source);
    if (!result) throw new Error('Expected frontmatter');
    const dom = renderFrontmatterProperties(result.properties);
    expect(
      Array.from(dom.querySelectorAll('.md4h-frontmatter-chip'), node => node.textContent)
    ).toEqual(['markdown', 'vscode']);
    expect(dom.textContent).toContain(
      'Markdown [notes], with punctuation: and <img src=x> as text.'
    );
    expect(dom.textContent).toContain('false');
    expect(dom.textContent).toContain('null');
    expect(dom.querySelector('img')).toBeNull();
  });

  it.each([
    'title: ordinary YAML',
    '---\ninvalid: [one\n---',
    '---\n- one\n- two\n---',
    '---\n' + 'a'.repeat(20_000) + '\n---',
  ])('falls back to source for unsupported or out-of-budget input', input => {
    expect(parseFrontmatter(input)).toBeNull();
  });

  it('lists aliases by name without expanding them', () => {
    const result = parseFrontmatter('---\nfirst: &first [one]\nsecond: *first\n---');
    expect(result?.properties[1]?.value).toEqual({
      kind: 'scalar',
      text: '*first',
      tone: 'syntax',
    });
  });
});
