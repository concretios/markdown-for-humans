import { innermostScope } from '../../../webview/highlighting/innermostScope';

describe('innermost visual token scope', () => {
  it.each([
    ['hljs-keyword', 'keyword'],
    ['hljs-string hljs-subst hljs-number', 'number'],
    ['hljs-tag hljs-name', 'name'],
    ['hljs-params hljs-keyword', 'keyword'],
    ['hljs-subst hljs-string', 'string'],
    ['hljs-params hljs-title function_ invoke__', 'title function_ invoke__'],
    ['hljs-subst hljs-variable language_', 'variable language_'],
    ['hljs-string language-javascript', 'string language-javascript'],
    ['language-javascript', ''],
    ['language-hljs-string', ''],
    ['', ''],
  ])('extracts the last semantic scope from %s', (classes, expected) => {
    expect(innermostScope(classes)).toBe(expected);
  });
});
