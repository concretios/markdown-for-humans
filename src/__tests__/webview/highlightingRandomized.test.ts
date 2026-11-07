/** Compare settled production-plugin ranges with fresh real tokenization after seeded edits. */
import { buildSync } from 'esbuild';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';

it('matches fresh Lowlight ranges after seeded content and structural edits', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'md4h-highlight-random-'));
  try {
    const output = path.join(directory, 'probe.cjs');
    const jsdom = require.resolve('jsdom');
    buildSync({
      stdin: {
        resolveDir: process.cwd(),
        loader: 'ts',
        contents: `
import assert from 'node:assert/strict';
import {Schema} from '@tiptap/pm/model';
import {EditorState} from '@tiptap/pm/state';
import {EditorView} from '@tiptap/pm/view';
import {canJoin} from '@tiptap/pm/transform';
import {createCodeHighlightingPlugin,codeHighlightingKey} from './src/webview/highlighting/plugin';
import {tokenizeCode} from './src/webview/highlighting/tokenize';
import {parseFenceInfo} from './src/webview/highlighting/fenceInfo';
const {JSDOM}=require(${JSON.stringify(jsdom)});
const dom=new JSDOM('<!doctype html><body></body>',{pretendToBeVisual:true});
for(const key of ['window','document','navigator','Node','HTMLElement','Element','Text','MutationObserver','DOMParser','CustomEvent','getComputedStyle','requestAnimationFrame','cancelAnimationFrame']) Object.defineProperty(globalThis,key,{configurable:true,value:key==='window'?dom.window:dom.window[key]});
const schema=new Schema({nodes:{doc:{content:'block+'},text:{group:'inline'},paragraph:{group:'block',content:'text*',toDOM:()=>['p',0]},blockquote:{group:'block',content:'block+',toDOM:()=>['blockquote',0]},codeBlock:{group:'block',content:'text*',code:true,attrs:{language:{default:'ts'}},toDOM:()=>['pre',['code',0]]}}});
const code=(source,language='ts')=>schema.nodes.codeBlock.create({language},schema.text(source));
const prose=source=>schema.nodes.paragraph.create(null,schema.text(source));
let calls=0;
const view=new EditorView(document.body,{state:EditorState.create({schema,doc:schema.nodes.doc.create(null,[code('const answer = "first";'),prose('unchanged prose'),schema.nodes.blockquote.create(null,code('/* nested */ const flag = true;')),code('SELECT value FROM items;','sql')]),plugins:[createCodeHighlightingPlugin(()=>({highlight:async(language,source)=>{calls++;return tokenizeCode(language,source);},dispose(){}}))]})});
const sort=ranges=>ranges.sort((a,b)=>a.from-b.from||a.to-b.to||a.classes.localeCompare(b.classes));
const expected=()=>{const ranges=[];view.state.doc.descendants((node,pos)=>{if(node.type.name==='codeBlock'){for(const span of tokenizeCode(parseFenceInfo(node.attrs.language).language,node.textContent).spans)ranges.push({from:pos+1+span.from,to:pos+1+span.to,classes:span.classes});return false;}});return sort(ranges);};
const actual=()=>sort(codeHighlightingKey.getState(view.state).decorations.find().filter(d=>d.type.attrs.class).map(d=>({from:d.from,to:d.to,classes:d.type.attrs.class})));
async function settle(label){const target=expected();for(let tries=0;tries<100;tries++){await new Promise(resolve=>setTimeout(resolve,10));if(JSON.stringify(actual())===JSON.stringify(target)){await new Promise(resolve=>setTimeout(resolve,20));assert.deepEqual(actual(),target,label);return;}}assert.deepEqual(actual(),target,label);}
let seed=0x5eed1234;const random=max=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return Math.floor(seed/0x100000000*max);};
const counts={};
(async()=>{try{await settle('initial');for(let iteration=0;iteration<100;iteration++){
 const blocks=[];view.state.doc.descendants((node,pos)=>{if(node.type.name==='codeBlock'){blocks.push({node,pos});return false;}});
 const choice=random(8);let tr=view.state.tr;let label='';const chosen=blocks.length?blocks[random(blocks.length)]:null;
 if(choice===0&&chosen){const at=chosen.pos+1+random(chosen.node.content.size+1);tr.insertText(['x','\\n','😀','/*','"'][random(5)],at);label='text';}
 else if(choice===1&&chosen){tr.setNodeAttribute(chosen.pos,'language',['ts','sql','unknown','typescript title="kept"','plaintext'][random(5)]);label='language AttrStep';}
 else if(choice===2&&chosen&&chosen.node.content.size>1){tr.split(chosen.pos+2);label='split';}
 else if(choice===3){const boundary=blocks.find(block=>canJoin(tr.doc,block.pos));if(boundary){tr.join(boundary.pos);label='join';}}
 else if(choice===4){tr.insert(tr.doc.content.size,code('const added'+iteration+' = "value";'));label='insert';}
 else if(choice===5){const top=blocks.find(block=>tr.doc.resolve(block.pos).depth===0);if(top){tr.delete(top.pos,top.pos+top.node.nodeSize).insert(tr.doc.content.size,top.node);label='move';}}
 else if(choice===6&&chosen){tr.setNodeMarkup(chosen.pos,schema.nodes.paragraph);label='convert to prose';}
 else if(choice===7){const top=blocks.find(block=>tr.doc.resolve(block.pos).depth===0);if(top){const range=tr.doc.resolve(top.pos).blockRange(tr.doc.resolve(top.pos+top.node.nodeSize));if(range){tr.wrap(range,[{type:schema.nodes.blockquote}]);label='wrap';}}}
 if(!label){tr.insert(tr.doc.content.size,code('const fallback'+iteration+' = true;'));label='insert fallback';}
 view.dispatch(tr);counts[label]=(counts[label]||0)+1;await settle(iteration+': '+label);
}console.log(JSON.stringify({passed:true,edits:100,calls,operations:counts}));}finally{view.destroy();dom.window.close();}})().catch(error=>{console.error(error);process.exitCode=1;});
`,
      },
      outfile: output,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      external: [jsdom],
      logLevel: 'silent',
    });
    const report = JSON.parse(
      execFileSync(process.execPath, [output], { encoding: 'utf8', timeout: 15000 })
    ) as {
      passed: boolean;
      edits: number;
      operations: Record<string, number>;
    };
    expect(report.passed).toBe(true);
    expect(report.edits).toBe(100);
    for (const operation of [
      'text',
      'language AttrStep',
      'split',
      'join',
      'move',
      'wrap',
      'convert to prose',
    ]) {
      expect(report.operations[operation]).toBeGreaterThan(0);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 20000);
