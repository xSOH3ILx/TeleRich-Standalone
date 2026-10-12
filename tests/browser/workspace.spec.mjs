import { test, expect } from '@playwright/test';

async function setup(page,{storage={},brokenStorage=false,telegram=true,connected=telegram,libraries=new Map(),r2=true}={}) {
 const calls=[],external=[],errors=[];
 await page.addInitScript(({storage,brokenStorage})=>{
  for(const [key,value] of Object.entries(storage))localStorage.setItem(key,JSON.stringify(value));
  if(brokenStorage)Storage.prototype.setItem=()=>{throw new DOMException('Synthetic quota exhausted','QuotaExceededError');};
  window.__xss=false;
 },{storage,brokenStorage});
 page.on('pageerror',error=>errors.push(error.message));
 await page.route('https://telegram.org/js/telegram-web-app.js',route=>route.fulfill({contentType:'text/javascript',body:`window.Telegram={WebApp:{initData:${JSON.stringify(telegram?'user-101':'')},ready(){},expand(){},onEvent(n,f){this.activate=f},offEvent(){}}};`}));
 await page.route('**/api/**',route=>{
  const request=route.request(),action=new URL(request.url()).pathname.slice(5),body=action==='library/upload'?null:request.postDataJSON();calls.push({url:request.url(),headers:request.headers(),body});
  if(!request.headers()['x-telegram-init-data']&&!request.headers().authorization)return route.fulfill({status:401,contentType:'application/json',body:JSON.stringify({ok:false,description:'Synthetic authentication required'})});
  const id=request.headers()['x-telegram-init-data']==='user-202'?202:101;
  if(action.startsWith('library/')){
   const owner=request.headers()['x-telegram-init-data']?'user:'+id:'operator';if(!libraries.has(owner))libraries.set(owner,{images:[],links:[],image_limit:20,link_limit:20,r2_ready:r2});const library=libraries.get(owner);
   if(action==='library/photo')return library.images.some(image=>image.id===body.id)?route.fulfill({contentType:'image/png',body:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aVp8AAAAASUVORK5CYII=','base64')}):route.fulfill({status:404,contentType:'application/json',body:JSON.stringify({ok:false,description:'Photo not found'})});
   if(action==='library/upload')library.images.push({id:'12345678-1234-4234-8234-123456789abc',name:decodeURIComponent(request.headers()['x-file-name']),mime:'image/png',size:68});
   if(action==='library/delete-photo')library.images=library.images.filter(image=>image.id!==body.id);
   if(action==='library/add-link')library.links.push({id:'link-'+library.links.length,name:body.name,url:body.url});
   if(action==='library/delete-link')library.links=library.links.filter(link=>link.id!==body.id);
   return route.fulfill({contentType:'application/json',body:JSON.stringify({ok:true,result:library})});
  }
  return route.fulfill({contentType:'application/json',body:JSON.stringify({ok:true,result:{id:999,username:'test_bot',first_name:'Test bot',workspace_id:request.headers()['x-telegram-init-data']?'999:user:'+id:'999:operator',message_id:55,chat:{id}}})});
 });
 await page.route(/https:\/\/(?!telegram\.org\/js\/telegram-web-app\.js).*/,route=>{if(new URL(route.request().url()).pathname.startsWith('/api/'))return route.fallback();external.push(route.request().url());return route.abort();});
 await page.goto('/');
 await expect(page.getByRole('button',{name:connected?'Bot connected':'Connect bot',exact:true})).toBeVisible();
 return {calls,external,errors,libraries};
}
const editor=page=>page.getByRole('textbox',{name:'Message source editor'});
const key=(user,field)=>`tr-workspace:http://127.0.0.1:4173:999:user:${user}:${field}`;

async function connectBrowser(page){
 await page.getByRole('button',{name:'Connect bot',exact:true}).click();
 await page.locator('input[type=url]').fill('http://127.0.0.1:4173');
 await page.locator('input[type=password]').fill('synthetic-admin-key');
 await page.getByPlaceholder('e.g. 123456789').fill('101');
 await page.getByRole('button',{name:'Test connection',exact:true}).click();
 await expect(page.getByRole('button',{name:'Bot connected',exact:true})).toBeVisible();
}

test('browser connection survives reload and reopening with the same destination',async({page,context})=>{
 const h=await setup(page,{telegram:false});await connectBrowser(page);
 const connection={url:'http://127.0.0.1:4173',key:'synthetic-admin-key',chatId:'101'};
 await expect.poll(()=>page.evaluate(()=>JSON.parse(localStorage.getItem('tr-connection')))).toEqual(connection);
 await page.reload();await expect(page.getByRole('button',{name:'Bot connected',exact:true})).toBeVisible();
 await page.getByRole('button',{name:'Bot connected',exact:true}).click();
 await expect(page.locator('input[type=url]')).toHaveValue(connection.url);
 await expect(page.locator('input[type=password]')).toHaveValue(connection.key);
 await expect(page.getByPlaceholder('e.g. 123456789')).toHaveValue(connection.chatId);
 await page.getByRole('button',{name:'Close dialog',exact:true}).click();
 await page.getByRole('button',{name:/^Send message/}).click();
 await expect.poll(()=>h.calls.filter(call=>call.url.endsWith('/api/send')).length).toBe(1);
 const sent=h.calls.find(call=>call.url.endsWith('/api/send'));expect(sent.body.chat_id).toBe('101');expect(sent.headers.authorization).toBe('Bearer synthetic-admin-key');expect(sent.headers['x-telegram-init-data']).toBeUndefined();
 await page.close();const reopened=await context.newPage();await setup(reopened,{telegram:false,connected:true});
 await reopened.getByRole('button',{name:'Bot connected',exact:true}).click();
 await expect(reopened.locator('input[type=password]')).toHaveValue(connection.key);
 await expect(reopened.getByPlaceholder('e.g. 123456789')).toHaveValue(connection.chatId);
});

test('saved browser credentials are ignored inside Telegram and remain available for the browser',async({page})=>{
 const connection={url:'https://other.example',key:'synthetic-admin-key',chatId:'303'};
 const h=await setup(page,{storage:{'tr-connection':connection}});
 expect(h.calls.every(call=>!call.headers.authorization&&call.headers['x-telegram-init-data']==='user-101')).toBe(true);
 expect(h.calls.every(call=>new URL(call.url).origin==='http://127.0.0.1:4173')).toBe(true);
 await page.getByRole('button',{name:'Bot connected',exact:true}).click();
 await expect(page.locator('input[type=url]')).toHaveValue('');await expect(page.locator('input[type=password]')).toHaveValue('');await expect(page.getByPlaceholder('e.g. 123456789')).toHaveValue('');
 await page.getByPlaceholder('e.g. 123456789').fill('101');
 expect(await page.evaluate(()=>JSON.parse(localStorage.getItem('tr-connection')))).toEqual(connection);
});

test('restoring an external Worker still requires approval before sending saved credentials',async({page})=>{
 page.once('dialog',dialog=>dialog.dismiss());
 const h=await setup(page,{telegram:false,storage:{'tr-connection':{url:'https://other.example',key:'synthetic-admin-key',chatId:'101'}}});
 await expect(page.locator('.toast')).toContainText('External connection was not approved');expect(h.calls).toEqual([]);
 await page.getByRole('button',{name:'Connect bot',exact:true}).click();page.once('dialog',dialog=>dialog.accept());await page.getByRole('button',{name:'Test connection',exact:true}).click();
 await expect(page.getByRole('button',{name:'Bot connected',exact:true})).toBeVisible();expect(h.calls[0].headers.authorization).toBe('Bearer synthetic-admin-key');expect(h.calls[0].headers['x-telegram-init-data']).toBeUndefined();
 page.once('dialog',dialog=>dialog.dismiss());await page.reload();
 await expect(page.locator('.toast')).toContainText('External connection was not approved');expect(h.calls).toHaveLength(1);
});

test('clearing the saved connection disconnects and preserves private drafts',async({page})=>{
 const scope='tr-workspace:http://127.0.0.1:4173:999:operator:';
 await setup(page,{telegram:false,storage:{[scope+'source']:'Preserve browser draft'}});await connectBrowser(page);
 await page.getByRole('button',{name:'Clear saved connection',exact:true}).click();
 await expect(page.getByRole('button',{name:'Connect bot',exact:true})).toBeVisible();
 await expect.poll(()=>page.evaluate(()=>localStorage.getItem('tr-connection'))).toBeNull();
 expect(await page.evaluate(key=>JSON.parse(localStorage.getItem(key)),scope+'source')).toBe('Preserve browser draft');
 await expect(page.locator('input[type=password]')).toHaveValue('');await expect(page.getByPlaceholder('e.g. 123456789')).toHaveValue('');
 await page.reload();await expect(page.getByRole('button',{name:'Connect bot',exact:true})).toBeVisible();
 await page.getByRole('button',{name:'Connect bot',exact:true}).click();await expect(page.locator('input[type=password]')).toHaveValue('');
 await page.locator('input[type=password]').fill('synthetic-admin-key');await page.getByRole('button',{name:'Test connection',exact:true}).click();
 await expect(page.getByRole('button',{name:'Bot connected',exact:true})).toBeVisible();await expect(page.getByPlaceholder('e.g. 123456789')).toHaveValue('');
});

test('late connection responses cannot reconnect after saved settings are cleared',async({page})=>{
 await setup(page,{telegram:false});await connectBrowser(page);
 let release;const blocked=new Promise(resolve=>{release=resolve;});let started=false;
 await page.route('**/api/connect',async route=>{started=true;await blocked;await route.fulfill({contentType:'application/json',body:JSON.stringify({ok:true,result:{username:'test_bot',first_name:'Test bot',workspace_id:'999:operator'}})});});
 await page.getByRole('button',{name:'Connected',exact:true}).click();await expect.poll(()=>started).toBe(true);
 await page.getByRole('button',{name:'Clear saved connection',exact:true}).click();release();
 await expect(page.getByRole('button',{name:'Connect bot',exact:true})).toBeVisible();await expect.poll(()=>page.evaluate(()=>localStorage.getItem('tr-connection'))).toBeNull();
 await page.waitForTimeout(200);await expect(page.getByRole('button',{name:'Connect bot',exact:true})).toBeVisible();
});

test('connection storage failures are reported without breaking in-memory use',async({page})=>{
 const h=await setup(page,{telegram:false,brokenStorage:true});
 await page.getByRole('button',{name:'Connect bot',exact:true}).click();await page.locator('input[type=password]').fill('synthetic-admin-key');
 await expect(page.locator('.toast')).toContainText('Could not save connection settings in this browser');
 await page.getByRole('button',{name:'Test connection',exact:true}).click();await expect(page.getByRole('button',{name:'Bot connected',exact:true})).toBeVisible();expect(h.errors).toEqual([]);
});

test('malformed saved connection fields are not used as credentials or a destination',async({page})=>{
 const h=await setup(page,{telegram:false,storage:{'tr-connection':{url:{},key:123,chatId:['101']}}});
 await page.getByRole('button',{name:'Connect bot',exact:true}).click();
 await expect(page.locator('input[type=url]')).toHaveValue('');await expect(page.locator('input[type=password]')).toHaveValue('');await expect(page.getByPlaceholder('e.g. 123456789')).toHaveValue('');expect(h.errors).toEqual([]);expect(h.calls.every(call=>!call.headers.authorization)).toBe(true);
});

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
 await page.getByRole('button',{name:'ربات متصل',exact:true}).click();
 const clear=page.getByRole('button',{name:'پاک کردن اتصال ذخیره‌شده',exact:true});await clear.scrollIntoViewIfNeeded();await expect(clear).toBeInViewport();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await page.screenshot({path:'test-results/mobile-connection-rtl.png',fullPage:true});
});

test('photo library uploads, previews and inserts a private photo, then deletes it',async({page})=>{
 const h=await setup(page);await page.getByRole('button',{name:'Photos & links',exact:true}).click();
 const file={name:'banner.png',mimeType:'image/png',buffer:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aVp8AAAAASUVORK5CYII=','base64')};
 await page.locator('input[type=file]').setInputFiles(file);await page.getByRole('button',{name:'Upload photo',exact:true}).click();
 await expect(page.locator('.library-photo')).toContainText('banner.png');await expect(page.locator('.library-thumbnail img')).toBeVisible();
 await page.getByRole('button',{name:'Insert photo',exact:true}).click();await expect(editor(page)).toHaveValue(/^<img src="tg:\/\/photo\?id=library_/);await expect(page.locator('.rich-content img')).toBeVisible();
 await expect.poll(()=>page.evaluate(()=>localStorage.getItem('tr-workspace:http://127.0.0.1:4173:999:user:101:source'))).toContain('tg://photo?id=library_');
 await page.reload();await expect(page.locator('.rich-content img')).toBeVisible();await page.getByRole('button',{name:'Photos & links',exact:true}).click();
 await page.getByRole('button',{name:'Delete photo: banner.png',exact:true}).click();await expect(page.locator('.library-photo')).toHaveCount(0);expect(h.libraries.get('user:101').images).toHaveLength(0);expect(h.external).toEqual([]);expect(h.errors).toEqual([]);
});

test('saved links can be reused from another browser page and deleted',async({page,context})=>{
 const h=await setup(page);await page.getByRole('button',{name:'Photos & links',exact:true}).click();await page.getByRole('button',{name:/^Saved links/}).click();
 await page.getByLabel('Link name',{exact:true}).fill('My product');await page.getByLabel('Link URL',{exact:true}).fill('https://example.com/product');await page.getByRole('button',{name:'Save link',exact:true}).click();await expect(page.locator('.saved-link')).toContainText('My product');
 const other=await context.newPage();await setup(other,{libraries:h.libraries});await other.getByRole('button',{name:'Photos & links',exact:true}).click();await other.getByRole('button',{name:/^Saved links/}).click();await expect(other.locator('.saved-link')).toContainText('My product');
 await other.getByRole('button',{name:'Insert link',exact:true}).click();await expect(editor(other)).toHaveValue(/<a href="https:\/\/example.com\/product">My product<\/a>/);
 await other.getByRole('button',{name:'Photos & links',exact:true}).click();await other.getByRole('button',{name:/^Saved links/}).click();await other.getByRole('button',{name:'Delete link: My product',exact:true}).click();await expect(other.locator('.saved-link')).toHaveCount(0);expect(h.libraries.get('user:101').links).toHaveLength(0);
});

test('gallery account switch removes the previous account photos and links',async({page})=>{
 const libraries=new Map([['user:101',{images:[],links:[{id:'a',name:'Private account one link',url:'https://example.com/one'}],image_limit:20,link_limit:20,r2_ready:true}],['user:202',{images:[],links:[],image_limit:20,link_limit:20,r2_ready:true}]]);
 await setup(page,{libraries});await page.getByRole('button',{name:'Photos & links',exact:true}).click();await page.getByRole('button',{name:/^Saved links/}).click();await expect(page.locator('.saved-link')).toContainText('Private account one link');
 await page.evaluate(()=>{window.Telegram.WebApp.initData='user-202';window.Telegram.WebApp.activate();});await expect(page.locator('.saved-link')).toHaveCount(0);await expect(page.locator('#root')).not.toContainText('Private account one link');
});

test('gallery photo cap and missing R2 disable uploads without hiding saved links',async({page})=>{
 const libraries=new Map([['user:101',{images:Array.from({length:20},(_,index)=>({id:'id-'+index,name:'Photo '+index,mime:'image/png',size:68})),links:[],image_limit:20,link_limit:20,r2_ready:true}]]);
 await setup(page,{libraries});await page.getByRole('button',{name:'Photos & links',exact:true}).click();await expect(page.getByRole('button',{name:'Upload photo',exact:true})).toBeDisabled();await expect(page.locator('input[type=file]')).toBeDisabled();await expect(page.locator('.saved-library')).toContainText('Library full');
 libraries.get('user:101').r2_ready=false;libraries.get('user:101').images=[];await page.getByRole('button',{name:'Refresh',exact:true}).click();await expect(page.locator('.info-box')).toContainText('MEDIA_LIBRARY');await expect(page.getByRole('button',{name:'Upload photo',exact:true})).toBeDisabled();await page.getByRole('button',{name:/^Saved links/}).click();await expect(page.getByLabel('Link name',{exact:true})).toBeEnabled();
});

test('blue appearance, local Vazirmatn and personal panel survive reload',async({page})=>{
 const h=await setup(page);await expect.poll(()=>page.evaluate(()=>document.fonts.check('14px Vazirmatn'))).toBe(true);
 expect(await page.locator('.app').evaluate(element=>getComputedStyle(element).getPropertyValue('--accent').trim())).toBe('#6b9fff');await expect(page.locator('.profile')).toContainText('TeleRich');await expect(page.locator('#root')).not.toContainText('DarknessShade');
 await page.getByRole('button',{name:'Toggle appearance',exact:true}).click();await expect(page.locator('.app')).toHaveClass(/light/);await page.reload();await expect(page.locator('.app')).toHaveClass(/light/);
 await page.getByRole('button',{name:'Settings',exact:true}).click();await expect(page.locator('.about-card')).not.toContainText('DarknessShade');await expect(page.locator('a[href*="Paradise_Of_Freedom"],a[href*="ConfigWireguard"]')).toHaveCount(0);expect(h.external).toEqual([]);
});

test('Persian gallery fits mobile and both blue themes have readable controls',async({page})=>{
 await setup(page);await page.getByRole('button',{name:'Photos & links',exact:true}).click();await page.getByRole('button',{name:'EN',exact:true}).click();await page.setViewportSize({width:390,height:844});
 await expect.poll(()=>page.locator('.sidebar').evaluate(element=>element.getBoundingClientRect().right)).toBeLessThanOrEqual(0);await expect(page.getByRole('button',{name:'آپلود عکس',exact:true})).toBeVisible();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await page.screenshot({path:'test-results/gallery-dark-rtl.png',fullPage:true});await page.getByRole('button',{name:'Toggle appearance',exact:true}).click();await page.getByRole('button',{name:/^لینک‌های ذخیره‌شده/}).click();await expect(page.getByLabel('آدرس لینک',{exact:true})).toBeVisible();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await expect(page.locator('.segmented-control button.active')).toHaveCSS('background-color','rgb(220, 232, 255)');const contrast=await page.locator('.segmented-control button.active').evaluate(element=>{const style=getComputedStyle(element),luminance=color=>{const channels=color.match(/[\d.]+/g).slice(0,3).map(value=>Number(value)/255).map(value=>value<=.04045?value/12.92:((value+.055)/1.055)**2.4);return channels[0]*.2126+channels[1]*.7152+channels[2]*.0722;};const foreground=luminance(style.color),background=luminance(style.backgroundColor);return (Math.max(foreground,background)+.05)/(Math.min(foreground,background)+.05);});expect(contrast).toBeGreaterThanOrEqual(4.5);await page.screenshot({path:'test-results/gallery-light-rtl.png',fullPage:true});
});

test('saving a link does not download all gallery thumbnails again',async({page})=>{
 const libraries=new Map([['user:101',{images:[{id:'12345678-1234-4234-8234-123456789abc',name:'Cached photo',mime:'image/png',size:68}],links:[],image_limit:20,link_limit:20,r2_ready:true}]]);
 const h=await setup(page,{libraries});await page.getByRole('button',{name:'Photos & links',exact:true}).click();await expect(page.locator('.library-thumbnail img')).toBeVisible();expect(h.calls.filter(call=>call.url.endsWith('/api/library/photo'))).toHaveLength(1);
 await page.getByRole('button',{name:/^Saved links/}).click();await page.getByLabel('Link name',{exact:true}).fill('Cached gallery link');await page.getByLabel('Link URL',{exact:true}).fill('https://example.com/cached');await page.getByRole('button',{name:'Save link',exact:true}).click();await expect(page.locator('.saved-link')).toContainText('Cached gallery link');
 await page.getByRole('button',{name:/^Photos 1/}).click();await expect(page.locator('.library-thumbnail img')).toBeVisible();expect(h.calls.filter(call=>call.url.endsWith('/api/library/photo'))).toHaveLength(1);
});
