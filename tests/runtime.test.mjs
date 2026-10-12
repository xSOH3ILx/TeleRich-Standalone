import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Miniflare, convertV4MiniflareOptions, Response as RuntimeResponse } from 'miniflare';

test('Workers runtime and SQLite Durable Objects',async t=>{
 const calls=[];let outage=false;
 const mf=new Miniflare(convertV4MiniflareOptions({
  name:'telerich',cf:false,telemetry:{enabled:false},
  modules:['worker.js','index.js'].map(file=>({type:'ESModule',path:fileURLToPath(new URL('../public/'+file,import.meta.url))})),modulesRoot:fileURLToPath(new URL('../',import.meta.url)),compatibilityDate:'2026-09-01',
  bindings:{BOT_TOKEN:'123456:synthetic-runtime-token',ADMIN_KEY:'synthetic-operator',WEBHOOK_SECRET:'synthetic-webhook'},
  durableObjects:{BOT_STATE:{className:'BotState',useSQLite:true}},
  outboundService:async request=>{
   assert.equal(new URL(request.url).hostname,'api.telegram.org');const method=new URL(request.url).pathname.split('/').at(-1);calls.push(method);
   return RuntimeResponse.json(outage?{ok:false,error_code:503,description:'Synthetic outage'}:{ok:true,result:{message_id:55,chat:{id:101}}});
  },
 }));
 t.after(()=>mf.dispose());
 const update={update_id:901,message:{message_id:1,text:'Runtime test',from:{id:101},chat:{id:101,type:'private'}}};
 const deliver=body=>mf.dispatchFetch('https://audit.example/webhook',{method:'POST',headers:{'X-Telegram-Bot-Api-Secret-Token':'synthetic-webhook'},body:JSON.stringify(body)});
 await t.test('CSP is served from the actual Worker',async()=>{const response=await mf.dispatchFetch('https://audit.example/');assert.equal(response.status,200);assert.ok(response.headers.get('content-security-policy').includes('sha256-'));});
 await t.test('concurrent duplicates execute one Telegram send',async()=>{const responses=await Promise.all(Array.from({length:6},()=>deliver(update)));assert.ok(responses.every(r=>r.status===200));assert.equal(calls.filter(m=>m==='sendRichMessage').length,1);});
 await t.test('Telegram failure stays retryable and recovery completes the update',async()=>{outage=true;assert.equal((await deliver({...update,update_id:902})).status,503);outage=false;assert.equal((await deliver({...update,update_id:902})).status,200);assert.equal((await deliver({...update,update_id:902})).status,200);assert.equal(calls.filter(m=>m==='sendRichMessage').length,5);});
});
