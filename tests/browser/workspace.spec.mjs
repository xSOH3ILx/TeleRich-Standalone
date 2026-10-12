import { test, expect } from '@playwright/test';

async function setup(page,{storage={},brokenStorage=false}={}) {
 const calls=[],external=[],errors=[];
 await page.addInitScript(({storage,brokenStorage})=>{
  for(const [key,value] of Object.entries(storage))localStorage.setItem(key,JSON.stringify(value));
  if(brokenStorage)Storage.prototype.setItem=()=>{throw new DOMException('Synthetic quota exhausted','QuotaExceededError');};
  window.__xss=false;
 },{storage,brokenStorage});
 page.on('pageerror',error=>errors.push(error.message));
 await page.route('https://telegram.org/js/telegram-web-app.js',route=>route.fulfill({contentType:'text/javascript',body:'window.Telegram={WebApp:{initData:"user-101",ready(){},expand(){},onEvent(n,f){this.activate=f},offEvent(){}}};'}));
 await page.route('**/api/**',route=>{
  const request=route.request();calls.push({url:request.url(),headers:request.headers(),body:request.postDataJSON()});
  const id=request.headers()['x-telegram-init-data']==='user-202'?202:101;
  return route.fulfill({contentType:'application/json',body:JSON.stringify({ok:true,result:{id:999,username:'test_bot',first_name:'Test bot',workspace_id:'999:user:'+id,message_id:55,chat:{id}}})});
 });
 await page.route(/https:\/\/(?!telegram\.org\/js\/telegram-web-app\.js).*/,route=>{if(new URL(route.request().url()).pathname.startsWith('/api/'))return route.fallback();external.push(route.request().url());return route.abort();});
 await page.goto('/');
 await expect(page.getByRole('button',{name:'Bot connected',exact:true})).toBeVisible();
 return {calls,external,errors};
}
const editor=page=>page.getByRole('textbox',{name:'Message source editor'});
const key=(user,field)=>`tr-workspace:http://127.0.0.1:4173:999:user:${user}:${field}`;

test('legacy unassigned data is never loaded into an authenticated account',async({page})=>{
 await setup(page,{storage:{'tr-source':'LEGACY SECRET','tr-drafts':[{id:1,title:'Legacy secret',source:'LEGACY SECRET',mode:'html'}]}});
 await expect(editor(page)).not.toHaveValue('LEGACY SECRET');
 await expect(page.locator('.rich-content')).not.toContainText('LEGACY SECRET');
});

test('two accounts load separate drafts, including an in-app account switch',async({page})=>{
 await setup(page,{storage:{[key(101,'source')]:'Account one private draft',[key(202,'source')]:'Account two private draft'}});
 await expect(editor(page)).toHaveValue('Account one private draft');
 await page.evaluate(()=>{window.Telegram.WebApp.initData='user-202';window.Telegram.WebApp.activate();});
 await expect(editor(page)).toHaveValue('Account two private draft');
 await expect(page.locator('#root')).not.toContainText('Account one private draft');
});

test('late authentication responses cannot restore the previous account content',async({page})=>{
 await setup(page,{storage:{[key(101,'source')]:'Private account one',[key(202,'source')]:'Private account two'}});
 await page.route('**/api/connect',async route=>{
  const id=route.request().headers()['x-telegram-init-data']==='user-202'?202:101;
  if(id===101)await new Promise(resolve=>setTimeout(resolve,400));
  await route.fulfill({contentType:'application/json',body:JSON.stringify({ok:true,result:{id:999,first_name:'Test bot',username:'test_bot',workspace_id:'999:user:'+id}})});
 });
 await page.evaluate(()=>{window.Telegram.WebApp.activate();window.Telegram.WebApp.initData='user-202';window.Telegram.WebApp.activate();});
 await expect(editor(page)).toHaveValue('Private account two');
 await page.waitForTimeout(500);
 await expect(editor(page)).toHaveValue('Private account two');
});

test('storage quota failure keeps the editor usable and reports unsaved content',async({page})=>{
 const h=await setup(page,{brokenStorage:true});await editor(page).fill('Keep this text');
 await expect(page.locator('.autosaved')).toContainText('Not saved');
 await expect(editor(page)).toHaveValue('Keep this text');expect(h.errors).toEqual([]);
});

test('HTML conversion preserves spoilers, highlights, math and footnotes',async({page})=>{
 await setup(page);await editor(page).fill('==mark== ||private|| $x^2$\n\nfoot[^a]\n\n[^a]: note');
 await page.getByRole('button',{name:'HTML',exact:true}).click();
 await expect(page.locator('.rich-content mark')).toHaveCount(1);
 await expect(page.locator('.rich-content .spoiler')).toHaveCount(1);
 await expect(page.locator('.rich-content .math-inline')).toHaveCount(1);
 await expect(page.locator('.rich-content footer')).toHaveCount(1);
});

test('external media requires opt-in and private-address media remains blocked',async({page})=>{
 const h=await setup(page);await editor(page).fill('<img src="https://tracker.example/photo.jpg"><img src="https://127.0.0.1/private.jpg">');
 await expect(page.getByRole('button',{name:'Load external media',exact:true})).toBeVisible();expect(h.external).toEqual([]);
 await page.getByRole('button',{name:'Load external media',exact:true}).click();
 await expect.poll(()=>h.external.length).toBe(1);expect(h.external[0]).toBe('https://tracker.example/photo.jpg');
});

test('XSS corpus cannot execute or inject active attributes into preview',async({page})=>{
 const h=await setup(page);
 for(const source of ['<script>window.__xss=true</script>','<img src="https://tracker.example/x" onerror="window.__xss=true">','<svg onload="window.__xss=true"></svg>','<iframe srcdoc="<script>parent.__xss=true</script>"></iframe>','<a href="javascript:window.__xss=true">link</a>','<a href="&#106;avascript:window.__xss=true">link</a>','<tg-math>\\href{javascript:window.__xss=true}{click}</tg-math>']){
  await editor(page).fill(source);await expect(page.locator('.rich-content [onclick], .rich-content [onerror], .rich-content [onload], .rich-content script, .rich-content [href^="javascript:"]')).toHaveCount(0);expect(await page.evaluate(()=>window.__xss)).toBe(false);
 }
 expect(h.errors).toEqual([]);expect(h.external).toEqual([]);
});

test('credentials and initData are not sent to an unapproved external origin',async({page})=>{
 const h=await setup(page);await page.getByRole('button',{name:'Bot connected',exact:true}).click();
 await page.getByRole('dialog').locator('input[type=url]').fill('https://other.example');await page.locator('input[type=password]').fill('synthetic-admin-key');
 page.once('dialog',dialog=>dialog.dismiss());await page.getByRole('button',{name:'Test connection',exact:true}).click();
 expect(h.calls.every(call=>new URL(call.url).origin==='http://127.0.0.1:4173')).toBe(true);
 expect((await page.evaluate(()=>JSON.stringify(localStorage))).includes('synthetic-admin-key')).toBe(false);
});

test('explicitly approved external Worker receives only the admin key',async({page})=>{
 const h=await setup(page);await page.getByRole('button',{name:'Bot connected',exact:true}).click();await page.getByRole('dialog').locator('input[type=url]').fill('https://other.example');await page.locator('input[type=password]').fill('synthetic-admin-key');page.once('dialog',dialog=>dialog.accept());await page.getByRole('button',{name:'Test connection',exact:true}).click();
 await expect.poll(()=>h.calls.filter(call=>call.url.startsWith('https://other.example')).length).toBe(1);
 const sent=h.calls.find(call=>call.url.startsWith('https://other.example'));expect(sent.headers.authorization).toBe('Bearer synthetic-admin-key');expect(sent.headers['x-telegram-init-data']).toBeUndefined();
});

test('a saved draft restores its own keyboard rather than another message keyboard',async({page})=>{
 const draft={id:1,title:'Stored message',source:'Stored message',mode:'markdown',date:'test',keyboard:[[{text:'Draft button',callback_data:'draft'}]],options:{silent:true,protect:true,rtlMode:'rtl',ephemeral:false,receiver:'',channelMode:false,destination:''}};
 await setup(page,{storage:{[key(101,'drafts')]:[draft],[key(101,'inline-keyboard')]:[[{text:'Other button',callback_data:'other'}]]}});
 await page.getByRole('button',{name:/^Saved drafts/}).click();await page.getByRole('button',{name:'Continue editing'}).click();await expect(page.locator('.inline-keyboard')).toContainText('Draft button');await expect(page.locator('.inline-keyboard')).not.toContainText('Other button');
});

test('mobile Persian layout stays within the viewport after the menu transition',async({page})=>{
 await setup(page);await page.getByRole('button',{name:'EN',exact:true}).click();await page.setViewportSize({width:390,height:844});
 await expect.poll(()=>page.locator('.sidebar').evaluate(el=>el.getBoundingClientRect().right)).toBeLessThanOrEqual(0);
 await page.getByRole('textbox',{name:'ویرایشگر کد پیام'}).fill('سلام، آزمون فارسی');await expect(page.locator('.rich-content')).toHaveAttribute('dir','rtl');expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await page.screenshot({path:'test-results/mobile-rtl.png',fullPage:true});
});
