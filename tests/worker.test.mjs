import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

import { test } from 'node:test';
import worker, { BotState } from '../public/worker.js';
// All credentials, users and Telegram responses below are synthetic.
const baseEnv = { BOT_TOKEN: '123456:synthetic-audit-token', ADMIN_KEY: 'synthetic-operator-key', WEBHOOK_SECRET: 'synthetic-webhook-secret' };
const user = { id: 101, first_name: 'Audit', language_code: 'en' };
let calls, fixture;
function reset() { calls = []; delete baseEnv.MEDIA_LIBRARY; baseEnv.BOT_STATE = namespace(); fixture = { userStatus: 'administrator', userPost: true, userEdit: true, userDelete: true, botStatus: 'administrator', botPost: true, botDelete: true }; }
function namespace() {
 const stores=new Map(), instances=new Map();
 const ns={idFromName:name=>name,get:name=>({fetch:(url,options)=>{
  if(!stores.has(name))stores.set(name,new Map());
  const entries=stores.get(name);
  const storage={get:async key=>structuredClone(entries.get(key)),put:async(key,value)=>{if(key==='library'&&fixture.failLibraryStore)throw new Error('Synthetic storage failure');entries.set(key,structuredClone(value));},deleteAll:async()=>entries.clear(),setAlarm:async()=>{},list:async({prefix})=>new Map([...entries].filter(([key])=>key.startsWith(prefix))),delete:async key=>entries.delete(key)};
  if(!instances.has(name))instances.set(name,new BotState({storage},{...ns.env,BOT_STATE:ns}));
  return instances.get(name).fetch(new Request(url,options));
 }})};
 ns.env=baseEnv;ns.restart=()=>instances.clear();return ns;
}
globalThis.fetch = async (url, options) => {
  assert.equal(new URL(url).origin, 'https://api.telegram.org');
  const method = new URL(url).pathname.split('/').at(-1);
  const multipart=options.body instanceof FormData;
  const data=multipart?Object.fromEntries([...options.body].filter(([,value])=>typeof value==='string').map(([key,value])=>[key,/^(\{|\[)/.test(value)?JSON.parse(value):value])):JSON.parse(options.body);
  const files=multipart?await Promise.all([...options.body].filter(([,value])=>typeof value!=='string').map(async([name,value])=>({name,mime:value.type,size:value.size,bytes:new Uint8Array(await value.arrayBuffer())}))):[];
  calls.push({ method, data, files });
  if (fixture.failMethod===method) return Response.json({ok:false,error_code:429,parameters:{retry_after:4},description:'Synthetic rate limit'},{status:429});
  if (fixture.outage) return Response.json({ ok: false, error_code: 503, description: 'Synthetic Telegram outage' }, { status: 503 });
  let result = true;
  if (method === 'getMe') result = { id: 999, is_bot: true, username: 'synthetic_audit_bot', first_name: 'Audit bot' };
  else if (method === 'getChat') result = { id: data.chat_id === '@audit_channel' ? -1001234 : Number(data.chat_id), type: Number(data.chat_id) > 0 ? 'private' : fixture.chatType || 'channel', title: 'Synthetic destination' };
  else if (method === 'getChatMember') result = data.user_id === 999 ? { status: fixture.botStatus, can_post_messages: fixture.botPost, can_delete_messages: fixture.botDelete } : { status: fixture.userStatus, can_post_messages: fixture.userPost, can_edit_messages: fixture.userEdit, can_delete_messages: fixture.userDelete };
  else if (['sendRichMessage', 'editMessageText', 'sendMessage', 'copyMessage'].includes(method)) result = { message_id: 55, chat: { id: data.chat_id }, text: 'Synthetic response' };
  return Response.json({ ok: true, result });
};
function signed(extra = {}, token = baseEnv.BOT_TOKEN) {
  const params = new URLSearchParams({ auth_date: String(Math.floor(Date.now() / 1000)), query_id: 'synthetic-query', user: JSON.stringify(user), ...extra });
  params.sort();
  const secret = createHmac('sha256', 'WebAppData').update(token).digest();
  const hash = createHmac('sha256', secret).update([...params].map(([k,v]) => `${k}=${v}`).join('\n')).digest('hex');
  params.set('hash', hash);
  return params.toString();
}
async function request(path, { body = {}, headers = {}, env = {}, method = 'POST', raw } = {}) {
  const pending = [];
  const req = new Request('https://audit.example' + path, { method, headers: { 'Content-Type': 'application/json', ...headers }, ...(method !== 'GET' && method !== 'OPTIONS' ? { body: raw ?? JSON.stringify(body) } : {}) });
  const requestEnv={...baseEnv,...env};if(requestEnv.BOT_STATE)requestEnv.BOT_STATE.env=requestEnv;
  const response = await worker.fetch(req, requestEnv, { waitUntil: p => pending.push(p) });
  const content = await response.text();
  await Promise.all(pending);
  let json;try{json=JSON.parse(content);}catch{}
  return { status: response.status, content, json, headers: Object.fromEntries(response.headers) };
}
const miniHeaders = () => ({ 'X-Telegram-Init-Data': signed() });
const operatorHeaders = { Authorization: 'Bearer ' + baseEnv.ADMIN_KEY };
const rich = { markdown: 'Synthetic test message' };
const mutating = () => calls.filter(c => ['sendRichMessage', 'editMessageText', 'deleteMessage', 'copyMessage', 'setWebhook', 'deleteEphemeralMessage'].includes(c.method));
function probe(name,fn){return test(name,async()=>{reset();await fn();});}
probe('API rejects anonymous caller', async () => { assert.equal((await request('/api/send', { body: { rich_message: rich } })).status, 401); assert.equal(calls.length, 0); });
probe('API rejects wrong ADMIN_KEY', async () => { assert.equal((await request('/api/connect', { headers: { Authorization: 'Bearer wrong' } })).status, 401); });
probe('Valid operator connects', async () => { assert.equal((await request('/api/connect', { headers: operatorHeaders })).status, 200); });
probe('Operator credential intentionally bypasses ADMINS_ID', async () => { assert.equal((await request('/api/connect', { headers: operatorHeaders, env: { ADMINS_ID: '202' } })).status, 200); });
probe('Valid signed Mini App connects', async () => { assert.equal((await request('/api/connect', { headers: miniHeaders() })).status, 200); });
probe('Signed signature field supported in HMAC input', async () => { assert.equal((await request('/api/connect', { headers: { 'X-Telegram-Init-Data': signed({ signature: 'synthetic-ed25519-signature' }) } })).status, 200); });
probe('Tampered Telegram user rejected', async () => { const p = new URLSearchParams(signed()); p.set('user', JSON.stringify({ id: 202 })); assert.equal((await request('/api/connect', { headers: { 'X-Telegram-Init-Data': p.toString() } })).status, 401); });
probe('Signature from another bot rejected', async () => { assert.equal((await request('/api/connect', { headers: { 'X-Telegram-Init-Data': signed({}, 'other-synthetic-token') } })).status, 401); });
probe('Expired Telegram session rejected', async () => { assert.equal((await request('/api/connect', { headers: { 'X-Telegram-Init-Data': signed({ auth_date: String(Math.floor(Date.now()/1000)-3601) }) } })).status, 401); });
probe('Future Telegram session rejected', async () => { assert.equal((await request('/api/connect', { headers: { 'X-Telegram-Init-Data': signed({ auth_date: String(Math.floor(Date.now()/1000)+60) }) } })).status, 401); });
probe('ADMINS_ID rejects valid unlisted user', async () => { assert.equal((await request('/api/connect', { headers: miniHeaders(), env: { ADMINS_ID: '202,303' } })).status, 403); });
probe('ADMINS_ID permits listed user', async () => { assert.equal((await request('/api/connect', { headers: miniHeaders(), env: { ADMINS_ID: '101,303' } })).status, 200); });
probe('Current code does not exempt historical hardcoded owner', async () => { assert.equal((await request('/api/connect', { headers: { 'X-Telegram-Init-Data': signed({ user: JSON.stringify({ id: 102026299 }) }) }, env: { ADMINS_ID: '101' } })).status, 403); });
probe('Private destination isolated by user ID', async () => { assert.equal((await request('/api/send', { headers: miniHeaders(), body: { chat_id: 202, rich_message: rich } })).status, 403); assert.equal(mutating().length, 0); });
probe('Private self-send succeeds', async () => { assert.equal((await request('/api/send', { headers: miniHeaders(), body: { rich_message: rich } })).status, 200); assert.equal(mutating()[0].data.chat_id, 101); });
probe('Channel rejects ordinary member', async () => { fixture.userStatus = 'member'; assert.equal((await request('/api/send', { headers: miniHeaders(), body: { chat_id: -1001234, rich_message: rich } })).status, 403); assert.equal(mutating().length, 0); });
probe('Channel rejects bot without posting right', async () => { fixture.botPost = false; assert.equal((await request('/api/send', { headers: miniHeaders(), body: { chat_id: -1001234, rich_message: rich } })).status, 403); assert.equal(mutating().length, 0); });
for (const [action,permission] of [['send','userPost'],['edit','userEdit'],['delete','userDelete']]) {
  probe(`channel ${action} enforces user's granular permission`, async () => { fixture[permission] = false; const r = await request('/api/'+action, { headers: miniHeaders(), body: { chat_id: -1001234, message_id: 77, rich_message: rich } }); assert.equal(r.status, 403); assert.equal(mutating().length, 0); }, 'finding');
}
probe('supergroup deletion enforces user delete right', async () => { fixture.chatType = 'supergroup'; fixture.userDelete = false; const r = await request('/api/delete', { headers: miniHeaders(), body: { chat_id: -1001234, message_id: 77 } }); assert.equal(r.status, 403); assert.equal(mutating().length, 0); }, 'finding');
probe('Mini App cannot reconfigure webhook', async () => { assert.equal((await request('/api/webhook', { headers: miniHeaders() })).status, 403); assert.equal(mutating().length, 0); });
probe('Operator webhook registration uses secret and own origin', async () => { assert.equal((await request('/api/webhook', { headers: operatorHeaders })).status, 200); const call = calls.find(c => c.method === 'setWebhook'); assert.equal(call.data.url, 'https://audit.example/webhook'); assert.equal(call.data.secret_token, baseEnv.WEBHOOK_SECRET); });
probe('Wrong webhook secret rejected', async () => { assert.equal((await request('/webhook', { headers: { 'X-Telegram-Bot-Api-Secret-Token': 'wrong' } })).status, 401); assert.equal(calls.length, 0); });
probe('Missing configured webhook secret fails closed', async () => { assert.equal((await request('/webhook', { env: { WEBHOOK_SECRET: '' } })).status, 401); });
probe('Ephemeral modification rejects another receiver', async () => { fixture.chatType='supergroup'; assert.equal((await request('/api/deleteEphemeralMessage', { headers: miniHeaders(), body: { chat_id: -1001234, receiver_user_id: 202, ephemeral_message_id: 7 } })).status, 403); });
probe('Invalid JSON rejected', async () => { assert.equal((await request('/api/send', { headers: miniHeaders(), raw: '{' })).status, 400); });
probe('Oversized API body rejected', async () => { assert.equal((await request('/api/send', { headers: miniHeaders(), raw: 'x'.repeat(524289) })).status, 413); });
probe('Oversized rich message rejected', async () => { assert.equal((await request('/api/send', { headers: miniHeaders(), body: { rich_message: { markdown: 'x'.repeat(32769) } } })).status, 400); assert.equal(mutating().length, 0); });
probe('Ambiguous rich format rejected', async () => { assert.equal((await request('/api/send', { headers: miniHeaders(), body: { rich_message: { markdown: 'x', html: 'x' } } })).status, 400); });
probe('Disallowed CORS origin rejected', async () => { assert.equal((await request('/api/connect', { headers: { ...miniHeaders(), Origin: 'https://other.example' }, env: { ALLOWED_ORIGIN: 'https://audit.example' } })).status, 403); });
probe('Same origin allowed with restrictive CORS', async () => { assert.equal((await request('/api/connect', { headers: { ...miniHeaders(), Origin: 'https://audit.example' }, env: { ALLOWED_ORIGIN: 'https://audit.example' } })).status, 200); });
probe('Unknown API method blocked', async () => { assert.equal((await request('/api/setChatAdministratorCustomTitle', { headers: miniHeaders() })).status, 404); assert.equal(calls.length, 0); });
probe('GET API blocked', async () => { assert.equal((await request('/api/connect', { method: 'GET', headers: miniHeaders() })).status, 405); });
const update = { update_id: 123, message: { message_id: 7, text: 'Synthetic incoming text', from: user, chat: { id: 101, type: 'private' } } };
const webhookHeaders = { 'X-Telegram-Bot-Api-Secret-Token': baseEnv.WEBHOOK_SECRET };
probe('Webhook rejects unlisted bot user', async () => { assert.equal((await request('/webhook', { headers: webhookHeaders, body: update, env: { ADMINS_ID: '202' } })).status, 200); assert.equal(calls.filter(c => c.method === 'sendRichMessage').length, 0); });
probe('Group update never exposes private draft', async () => { assert.equal((await request('/webhook', { headers: webhookHeaders, body: { ...update, message: { ...update.message, chat: { id: -1001234, type: 'supergroup' } } } })).status, 200); assert.equal(calls.length, 0); });
probe('duplicate update_id is processed once', async () => { await request('/webhook', { headers: webhookHeaders, body: update }); await request('/webhook', { headers: webhookHeaders, body: update }); assert.equal(calls.filter(c => c.method === 'sendRichMessage').length, 1); return { update_id: 123, sendCount: 1 }; }, 'finding');
probe('Telegram outage remains retryable', async () => { fixture.outage = true; const r = await request('/webhook', { headers: webhookHeaders, body: update }); assert.equal(r.status, 503); assert.equal(calls.filter(c => c.method === 'sendRichMessage').length, 3); return { status: r.status, sendFailed: true, retriesOfOriginalSend: 2 }; }, 'finding');
probe('authenticated JSON null is rejected with 400', async () => { assert.equal((await request('/api/send', { headers: miniHeaders(), raw: 'null' })).status, 400); }, 'finding');
probe('concurrent duplicate updates send only once', async()=>{await Promise.all(Array.from({length:8},()=>request('/webhook',{headers:webhookHeaders,body:update})));assert.equal(calls.filter(c=>c.method==='sendRichMessage').length,1);});
probe('duplicate detection survives object eviction',async()=>{await request('/webhook',{headers:webhookHeaders,body:update});baseEnv.BOT_STATE.restart();await request('/webhook',{headers:webhookHeaders,body:update});assert.equal(calls.filter(c=>c.method==='sendRichMessage').length,1);});
probe('failed delivery can succeed on the next Telegram retry',async()=>{fixture.outage=true;assert.equal((await request('/webhook',{headers:webhookHeaders,body:update})).status,503);fixture.outage=false;assert.equal((await request('/webhook',{headers:webhookHeaders,body:update})).status,200);assert.equal(calls.filter(c=>c.method==='sendRichMessage').length,4);});
probe('changed payload cannot reuse a completed update_id',async()=>{await request('/webhook',{headers:webhookHeaders,body:update});assert.equal((await request('/webhook',{headers:webhookHeaders,body:{...update,message:{...update.message,text:'Changed'}}})).status,400);});
probe('concurrent rate limiting is shared by all requests',async()=>{const results=await Promise.all(Array.from({length:65},()=>request('/api/connect',{headers:operatorHeaders})));assert.equal(results.filter(r=>r.status===200).length,60);assert.equal(results.filter(r=>r.status===429).length,5);assert.ok(results.find(r=>r.status===429).headers['retry-after']);});
probe('missing durable state fails closed',async()=>{assert.equal((await request('/webhook',{headers:webhookHeaders,body:update,env:{BOT_STATE:undefined}})).status,503);});
probe('channel owner retains all operation rights',async()=>{fixture.userStatus='creator';fixture.userPost=false;fixture.userEdit=false;fixture.userDelete=false;for(const action of ['send','edit','delete'])assert.equal((await request('/api/'+action,{headers:miniHeaders(),body:{chat_id:-1001234,message_id:7,rich_message:rich}})).status,200);});
probe('a group author can edit their own bot message',async()=>{fixture.chatType='supergroup';await request('/api/send',{headers:miniHeaders(),body:{chat_id:-1001234,rich_message:rich}});assert.equal((await request('/api/edit',{headers:miniHeaders(),body:{chat_id:-1001234,message_id:55,rich_message:rich}})).status,200);});
probe('another group administrator cannot edit a bot message they did not create',async()=>{fixture.chatType='supergroup';await request('/api/send',{headers:miniHeaders(),body:{chat_id:-1001234,rich_message:rich}});assert.equal((await request('/api/edit',{headers:{'X-Telegram-Init-Data':signed({user:JSON.stringify({id:202})})},body:{chat_id:-1001234,message_id:55,rich_message:rich}})).status,403);});
probe('JSON arrays, negative message IDs and invalid block structures are rejected',async()=>{for(const raw of ['[]','null','true'])assert.equal((await request('/api/send',{headers:miniHeaders(),raw})).status,400);for(const id of [0,-7,1.5])assert.equal((await request('/api/delete',{headers:miniHeaders(),body:{message_id:id}})).status,400);for(const blocks of [[],[null],[{}]])assert.equal((await request('/api/send',{headers:miniHeaders(),body:{rich_message:{blocks}}})).status,400);});
probe('request size is bounded in UTF-8 bytes without Content-Length',async()=>{assert.equal((await request('/api/send',{headers:miniHeaders(),raw:JSON.stringify({text:'س'.repeat(262145)})})).status,413);});
probe('keyboard cardinality, callback bytes and active URL schemes are validated',async()=>{for(const button of [{text:'x',url:'javascript:alert(1)'},{text:'x',callback_data:'س'.repeat(33)},{text:'x',url:'https://example.com',callback_data:'x'},{text:'x',web_app:{url:'http://example.com'}}])assert.equal((await request('/api/send',{headers:miniHeaders(),body:{rich_message:rich,reply_markup:{inline_keyboard:[[button]]}}})).status,400);});
probe('valid disabled inline buttons remain supported',async()=>{assert.equal((await request('/api/send',{headers:miniHeaders(),body:{rich_message:rich,reply_markup:{inline_keyboard:[[{text:'Disabled',disabled:true,callback_data:'disabled'}]]}}})).status,200);});

probe('successful copy is checkpointed when a later confirmation fails',async()=>{
 const publish={...update,message:{...update.message,text:'@audit_channel',reply_to_message:{from:{is_bot:true},text:'TR:publish:55:en'}}};
 fixture.failMethod='sendMessage';assert.equal((await request('/webhook',{headers:webhookHeaders,body:publish})).status,503);fixture.failMethod=null;assert.equal((await request('/webhook',{headers:webhookHeaders,body:publish})).status,200);assert.equal(calls.filter(c=>c.method==='copyMessage').length,1);
});
probe('own ephemeral messages remain editable in a group',async()=>{fixture.chatType='supergroup';assert.equal((await request('/api/deleteEphemeralMessage',{headers:miniHeaders(),body:{chat_id:-1001234,receiver_user_id:101,ephemeral_message_id:7}})).status,200);});
probe('throttled webhook updates remain retryable after the shared rate window resets',async()=>{
 for(let index=0;index<20;index++)assert.equal((await request('/webhook',{headers:webhookHeaders,body:{...update,update_id:1000+index}})).status,200);
 const excess={...update,update_id:1020};assert.equal((await request('/webhook',{headers:webhookHeaders,body:excess})).status,503);
 const now=Date.now;
 try{Date.now=()=>now()+60001;assert.equal((await request('/webhook',{headers:webhookHeaders,body:excess})).status,200);}finally{Date.now=now;}
 assert.equal(calls.filter(c=>c.method==='sendRichMessage').length,21);
});

const pixel=Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aVp8AAAAASUVORK5CYII=','base64'));
function bucket(){
 const objects=new Map();baseEnv.MEDIA_LIBRARY={
  put:async(key,data,options)=>{objects.set(key,{bytes:Uint8Array.from(data),mime:options.httpMetadata.contentType});},
  get:async key=>{const image=objects.get(key);return image?{body:image.bytes.slice()}:null;},
  delete:async key=>{if(fixture.failR2Delete)throw new Error('Synthetic R2 failure');objects.delete(key);},
 };return objects;
}
const upload=(options={})=>request('/api/library/upload',{headers:{...operatorHeaders,'Content-Type':'image/png','X-File-Name':encodeURIComponent('عکس.png'),...options.headers},raw:options.raw||pixel,env:options.env});
const library=(action,body={},headers=operatorHeaders,env={})=>request('/api/library/'+action,{body,headers,env});
probe('library rejects anonymous reads, uploads and deletes',async()=>{
 bucket();for(const action of ['list','upload','delete-photo','add-link','delete-link'])assert.equal((await request('/api/library/'+action)).status,401);
});
probe('links work without R2 and persist after object eviction',async()=>{
 let response=await library('list');assert.equal(response.json.result.r2_ready,false);
 assert.equal((await library('add-link',{name:'محصول',url:'https://example.com/product'})).status,200);
 baseEnv.BOT_STATE.restart();response=await library('list');assert.equal(response.json.result.links[0].name,'محصول');
 const id=response.json.result.links[0].id;assert.equal((await library('delete-link',{id})).status,200);assert.equal((await library('list')).json.result.links.length,0);
});
probe('gallery fails clearly without the R2 binding',async()=>{assert.equal((await upload()).status,503);});
probe('uploaded photos are private and deletion removes both file and metadata',async()=>{
 const objects=bucket();const saved=await upload();assert.equal(saved.status,200);const image=saved.json.result.images[0];assert.equal(image.name,'عکس.png');assert.equal(objects.size,1);assert.equal(image.key,undefined);
 const response=await library('photo',{id:image.id});assert.equal(response.status,200);assert.equal(response.headers['content-type'],'image/png');
 assert.equal((await request('/media/'+image.id,{method:'GET'})).status,404);
 baseEnv.BOT_STATE.restart();assert.equal((await library('list')).json.result.images.length,1);
 assert.equal((await library('delete-photo',{id:image.id})).status,200);assert.equal(objects.size,0);assert.equal((await library('list')).json.result.images.length,0);assert.equal((await library('photo',{id:image.id})).status,404);
});
probe('another verified user cannot read, delete or send a library photo',async()=>{
 const objects=bucket();const saved=await upload({headers:miniHeaders()});const image=saved.json.result.images[0];
 const other={'X-Telegram-Init-Data':signed({user:JSON.stringify({id:202})}),'X-Library-Scope':'123456:user:101'};
 assert.equal((await library('list',{},other)).json.result.images.length,0);
 for(const action of ['photo','delete-photo'])assert.equal((await library(action,{id:image.id},other)).status,404);
 assert.equal((await request('/api/send',{headers:other,body:{chat_id:202,rich_message:{html:`<img src="tg://photo?id=library_${image.id}"/>`}}})).status,404);assert.equal(mutating().length,0);assert.equal(objects.size,1);
});
probe('single-admin personal bot shares its gallery with the operator and that user',async()=>{
 bucket();const env={ADMINS_ID:'101'};await upload({env});assert.equal((await library('list',{},miniHeaders(),env)).json.result.images.length,1);
 assert.equal((await library('list',{},miniHeaders(),{ADMINS_ID:'101,202'})).json.result.images.length,1);
 assert.equal((await library('list',{},operatorHeaders,{ADMINS_ID:'101,202'})).json.result.images.length,0);
});
probe('concurrent gallery uploads enforce exactly twenty photos',async()=>{
 const objects=bucket();const responses=await Promise.all(Array.from({length:21},()=>upload()));assert.equal(responses.filter(response=>response.status===200).length,20);assert.equal(responses.filter(response=>response.status===409).length,1);assert.equal(objects.size,20);assert.equal((await library('list')).json.result.images.length,20);
 const id=(await library('list')).json.result.images[0].id;await library('delete-photo',{id});assert.equal((await upload()).status,200);assert.equal(objects.size,20);
});
probe('file signatures, MIME types, file size and request size are validated',async()=>{
 const objects=bucket();for(const [raw,mime] of [[new TextEncoder().encode('<svg onload="alert(1)"></svg>'),'image/svg+xml'],[pixel,'image/jpeg'],[new Uint8Array(5*1024*1024+1),'image/png']])assert.ok([400,413].includes((await upload({raw,headers:{'Content-Type':mime}})).status));assert.equal(objects.size,0);
 assert.equal((await library('add-link',{name:'a'.repeat(16385),url:'https://example.com'})).status,413);
});
probe('failed metadata storage removes an uploaded R2 object',async()=>{
 const objects=bucket();fixture.failLibraryStore=true;assert.equal((await upload()).status,503);assert.equal(objects.size,0);fixture.failLibraryStore=false;assert.equal((await library('list')).json.result.images.length,0);
});
probe('failed R2 deletion leaves the saved photo available for retry',async()=>{
 const objects=bucket(),saved=await upload(),id=saved.json.result.images[0].id;fixture.failR2Delete=true;assert.equal((await library('delete-photo',{id})).status,503);assert.equal(objects.size,1);assert.equal((await library('list')).json.result.images.length,1);fixture.failR2Delete=false;assert.equal((await library('delete-photo',{id})).status,200);
});
probe('rich messages and edits attach private gallery photos as multipart files',async()=>{
 bucket();const id=(await upload()).json.result.images[0].id,rich_message={html:`<img src="tg://photo?id=library_${id}"/><p>سلام</p>`};
 for(const action of ['send','edit']){
  assert.equal((await request('/api/'+action,{headers:operatorHeaders,body:{chat_id:101,message_id:55,rich_message}})).status,200);
  const sent=mutating().at(-1);assert.deepEqual(sent.data.rich_message.media,[{id:'library_'+id,media:{type:'photo',media:'attach://photo0'}}]);assert.equal(sent.files.length,1);assert.equal(sent.files[0].mime,'image/png');assert.deepEqual(sent.files[0].bytes,pixel);
 }
 await library('delete-photo',{id});assert.equal((await request('/api/send',{headers:operatorHeaders,body:{chat_id:101,rich_message}})).status,404);assert.equal(mutating().length,2);
});
probe('saved links reject active schemes, credentials, duplicates and excess entries',async()=>{
 for(const url of ['javascript:alert(1)','http://example.com','https://user:pass@example.com'])assert.equal((await library('add-link',{name:'Invalid',url})).status,400);
 for(let index=0;index<20;index++)assert.equal((await library('add-link',{name:'Link '+index,url:'https://example.com/'+index})).status,200);
 assert.equal((await library('add-link',{name:'Extra',url:'https://example.com/extra'})).status,409);
 const saved=(await library('list')).json.result.links[0];await library('delete-link',{id:saved.id});assert.equal((await library('add-link',{name:'Replacement',url:'https://example.com/extra'})).status,200);
});
probe('library media IDs in plain text do not trigger photo uploads',async()=>{
 assert.equal((await request('/api/send',{headers:operatorHeaders,body:{chat_id:101,rich_message:{markdown:'library_12345678-1234-4234-8234-123456789abc'}}})).status,200);assert.equal(mutating()[0].files.length,0);
});
