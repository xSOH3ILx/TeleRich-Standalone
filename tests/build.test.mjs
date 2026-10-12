import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { transformSync } from 'esbuild';
import html, { workerSource, librarySource, guides, contentSecurityPolicy } from '../public/index.js';

test('generated module matches the current Worker and guide source', () => {
 assert.equal(workerSource,readFileSync(new URL('../public/worker.js',import.meta.url),'utf8'));
 assert.equal(librarySource,readFileSync(new URL('../public/library.js',import.meta.url),'utf8'));
 const mod={exports:{}};
 const {code}=transformSync(readFileSync(new URL('../src/content.ts',import.meta.url),'utf8'),{loader:'ts',format:'cjs'});
 new Function('module','exports',code)(mod,mod.exports);
 assert.deepEqual(guides,mod.exports.GUIDES);
 assert.ok(!/(?:src|href)="\/assets\//.test(html));
 assert.ok(!html.includes('fonts.googleapis.com'));
});

test('CSP authorizes every inline script without unsafe-inline or unsafe-eval', () => {
 const directive=contentSecurityPolicy.split(';').find(s=>s.trim().startsWith('script-src'));
 assert.ok(!directive.includes('unsafe-inline')&&!directive.includes('unsafe-eval'));
 for(const [,attrs,code] of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)){
  if(attrs.includes('src='))continue;
  assert.ok(directive.includes('sha256-'+createHash('sha256').update(code).digest('base64')));
 }
 assert.ok(contentSecurityPolicy.includes("base-uri 'none'"));
});

test('rich Markdown conversion preserves extended formatting and literal code', async () => {
 const {code}=transformSync(readFileSync(new URL('../src/markdown.ts',import.meta.url),'utf8'),{loader:'ts',format:'esm'});
 const {markdownToHtml}=await import('data:text/javascript;base64,'+Buffer.from(code.replace("'marked'",JSON.stringify(new URL('../node_modules/marked/lib/marked.esm.js',import.meta.url).href)).replace('"marked"',JSON.stringify(new URL('../node_modules/marked/lib/marked.esm.js',import.meta.url).href))).toString('base64'));
 const converted=markdownToHtml('==mark== ||hidden|| $x^2$\n\nfoot[^a]\n\n[^a]: **note**');
 for(const tag of ['<mark>','<tg-spoiler>','<tg-math>','<footer','<strong>'])assert.ok(converted.includes(tag));
 assert.ok(markdownToHtml('`||literal||`').includes('<code>||literal||</code>'));
 assert.ok(markdownToHtml('TELERICHCODE0PLACEHOLDER').includes('TELERICHCODE0PLACEHOLDER'));
 assert.ok(!markdownToHtml('[^x" onclick="alert(1)]\n\n[^x" onclick="alert(1)]: note').includes(' onclick="'));
});
