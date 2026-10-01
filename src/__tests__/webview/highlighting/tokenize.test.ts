import { buildSync } from 'esbuild';
import { execFileSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';

// Bundle the real ESM Lowlight runtime rather than mocking its grammars for Jest.
function probe(source: string): unknown {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'md4h-tokenize-'));
  try {
    const filename = path.join(directory, 'probe.cjs');
    buildSync({
      stdin: { contents: source, resolveDir: process.cwd(), loader: 'ts' },
      outfile: filename,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      logLevel: 'silent',
    });
    return JSON.parse(execFileSync(process.execPath, [filename], { encoding: 'utf8' })) as unknown;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe('worker tokenizer with real grammar runtime', () => {
  it('preserves all code and UTF-16 offsets, including Unicode, CRLF, nested and incomplete constructs', () => {
    const result = probe(`
      import {tokenizeCode} from './src/webview/highlighting/tokenize';
      const samples = [
        ['typescript','const value: string = "🌍 &amp; <script>";\\r\\n// comment'],
        ['sql',"SELECT '🌍' AS greeting; -- comment"],
        ['yaml','name: test\\nvalue: true'],
        ['html','<script>const value = "hello";</script><style>a { color: red; }</style>'],
        ['php-template','<div><?php echo "hello"; ?></div>'],
        ['python-repl','>>> print("hello")'],
        ['typescript','const value = "unterminated\\nfunction {']
      ];
      console.log(JSON.stringify(samples.map(([language,source])=>{const result=tokenizeCode(language,source);return {language,reason:result.reason,nonempty:result.spans.length>0,valid:result.spans.every(s=>s.from>=0&&s.to<=source.length&&s.from<s.to),classes:result.spans.every(s=>s.classes.split(' ').every(c=>/^(hljs-[a-z0-9_-]+|[a-z]+_+|language-[a-z0-9_-]+|javascript|css|xml|php|python)$/.test(c)))};})));
    `) as Array<{ reason?: string; nonempty: boolean; valid: boolean; classes: boolean }>;
    expect(result).toHaveLength(7);
    for (const sample of result) {
      expect(sample.reason).toBeUndefined();
      expect(sample.nonempty).toBe(true);
      expect(sample.valid).toBe(true);
      expect(sample.classes).toBe(true);
    }
  });
  it('never guesses languages, enforces source limits and validates AST text', () => {
    const result = probe(`
      import {tokenizeCode,spansFromHighlightTree} from './src/webview/highlighting/tokenize';
      import {HIGHLIGHT_LIMITS} from './src/webview/highlighting/types';
      console.log(JSON.stringify({unknown:tokenizeCode('fictional','const x = 1'),plain:tokenizeCode('text','const x = 1'),empty:tokenizeCode('ts',''),huge:tokenizeCode('ts','x'.repeat(HIGHLIGHT_LIMITS.sourceUnits+1)),mismatch:spansFromHighlightTree({type:'root',children:[{type:'text',value:'changed'}]},'original'),invalid:spansFromHighlightTree({type:'root',children:[{type:'element',properties:{className:['onclick=bad']},children:[{type:'text',value:'ok'}]}]},'ok')}));
    `) as Record<string, { spans: unknown[]; reason?: string }>;
    expect(result.unknown.spans).toEqual([]);
    expect(result.plain.spans).toEqual([]);
    expect(result.empty.spans).toEqual([]);
    expect(result.huge.reason).toBe('source-limit');
    expect(result.mismatch.reason).toBe('invalid-token-output');
    expect(result.invalid.reason).toBe('invalid-token-output');
  });
  it('coalesces equal adjacent classes and bounds output while walking the AST', () => {
    const result = probe(`
      import {spansFromHighlightTree} from './src/webview/highlighting/tokenize';
      import {HIGHLIGHT_LIMITS} from './src/webview/highlighting/types';
      const node=(value,kind)=>({type:'element',properties:{className:[kind]},children:[{type:'text',value}]});
      const merged=spansFromHighlightTree({type:'root',children:[node('a','hljs-string'),node('b','hljs-string')]},'ab');
      const oversized=spansFromHighlightTree({type:'root',children:Array.from({length:HIGHLIGHT_LIMITS.resultRanges+1},(_,i)=>node('x',i%2?'hljs-string':'hljs-comment'))},'x'.repeat(HIGHLIGHT_LIMITS.resultRanges+1));
      console.log(JSON.stringify({merged,oversized}));
    `) as { merged: { spans: unknown[] }; oversized: { reason: string } };
    expect(result.merged.spans).toEqual([{ from: 0, to: 2, classes: 'hljs-string' }]);
    expect(result.oversized.reason).toBe('result-limit');
  });
  it('keeps the deepest repeated scope last so nested strings retain their semantic color', () => {
    const source = 'const value = `outer ${"inner"} ${42}`;';
    const result = probe(`
      import {tokenizeCode,spansFromHighlightTree} from './src/webview/highlighting/tokenize';
      const element=(name,child)=>({type:'element',properties:{className:[name]},children:[child]});
      const ast=element('hljs-string',element('hljs-subst',element('hljs-string',{type:'text',value:'inner'})));
      const source=${JSON.stringify(source)};
      console.log(JSON.stringify({ast:spansFromHighlightTree(ast,'inner'),actual:tokenizeCode('typescript',source).spans.map(span=>({...span,text:source.slice(span.from,span.to)}))}));
    `) as {
      ast: { spans: Array<{ from: number; to: number; classes: string }> };
      actual: Array<{ classes: string; text: string }>;
    };
    expect(result.ast.spans).toEqual([{ from: 0, to: 5, classes: 'hljs-subst hljs-string' }]);
    expect(result.actual.find(span => span.text === '"inner"')?.classes).toBe(
      'hljs-subst hljs-string'
    );
    expect(result.actual.find(span => span.text === '42')?.classes).toBe(
      'hljs-string hljs-subst hljs-number'
    );
  });
  it('rejects malformed worker requests without throwing or echoing source text', () => {
    const result = probe(
      `import {processHighlightRequest} from './src/webview/highlighting/worker';const request={type:'md4h.highlight.request',version:1,session:'view',requestId:1,grammar:'typescript',source:'const x = 1'};console.log(JSON.stringify({valid:processHighlightRequest(request),invalid:processHighlightRequest({...request,requestId:-1}),unknown:processHighlightRequest({...request,grammar:'made-up'}),null:processHighlightRequest(null)}));`
    ) as {
      valid: Record<string, unknown>;
      invalid: unknown;
      unknown: Record<string, unknown>;
      null: unknown;
    };
    expect(result.valid.type).toBe('md4h.highlight.result');
    expect(result.valid).not.toHaveProperty('source');
    expect(result.invalid).toBeNull();
    expect(result.null).toBeNull();
    expect(result.unknown.result).toEqual({ spans: [], reason: 'plain' });
  });
  it('preserves token fingerprints captured independently from unmodified main at 1b8244b', () => {
    const samples = [
      [
        'typescript',
        '// note\nconst value: string = "🌍 &amp; <script>";\r\nexport const read = (n: number): string => `${n}`;',
        '2e80506b8d728611bac0783008d6f90c430e78c0e49035f12535c40cb12dbf37',
      ],
      [
        'sql',
        "-- note\nSELECT account_id, COUNT(*) AS count FROM events WHERE label = '🌍' GROUP BY account_id;",
        'c6978521ad7f2b0fe2ab8f5036956924684442cbca109262a77959f7e726f38f',
      ],
      [
        'html',
        '<script>const value = "hello";</script><style>a { color: red; }</style>',
        'c7b2171b223875e3313c74db213d88428a3d6f77234bc49c31ef5f731df630b9',
      ],
      [
        'php-template',
        '<div><?php echo "hello"; ?></div>',
        '6612b1e2be16a178fd3451fb83b17abb03695ede73d93f83ecae4eef93b98708',
      ],
      [
        'yaml',
        'name: example\nvalue: true\nlist:\n  - 42',
        'ba7446184e95d2e6a5c3cccff020f1f4a4f3155dd02558a7ea12da898e833350',
      ],
      [
        'python-repl',
        '>>> print("hello")',
        'ed20c802b6cf8c383e5f0848d0aad0afeb1e77a09a198b422a2227ced7c10c70',
      ],
      [
        'bash',
        '#!/bin/bash\necho "$HOME" # note',
        '0a97553a4ffd45d5815d01d21627583e1e5df3451f68ccb64d933c9b6a159fe4',
      ],
    ];
    const result = probe(
      `import {createHash} from 'node:crypto';import {tokenizeCode} from './src/webview/highlighting/tokenize';const cases=${JSON.stringify(samples)};console.log(JSON.stringify(cases.map(([language,source,expected])=>({language,expected,actual:createHash('sha256').update(JSON.stringify(tokenizeCode(language,source))).digest('hex')}))));`
    ) as Array<{ actual: string; expected: string }>;
    for (const sample of result) expect(sample.actual).toBe(sample.expected);
    // Deliberate version tripwire. A grammar/engine upgrade needs new compatibility evidence.
    expect(
      JSON.parse(readFileSync(path.resolve('node_modules/lowlight/package.json'), 'utf8')).version
    ).toBe('2.9.0');
    expect(
      JSON.parse(readFileSync(path.resolve('node_modules/highlight.js/package.json'), 'utf8'))
        .version
    ).toBe('11.12.0');
    expect(
      JSON.parse(
        readFileSync(
          path.resolve('node_modules/lowlight/node_modules/highlight.js/package.json'),
          'utf8'
        )
      ).version
    ).toBe('11.8.0');
  });
});
