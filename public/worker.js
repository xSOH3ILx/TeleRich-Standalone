// TeleRich Studio — Telegram Bot API 10.3
// Deploy with wrangler.jsonc and BOT_STATE. MEDIA_LIBRARY is the optional private R2 gallery.
// Secrets: BOT_TOKEN, ADMIN_KEY, WEBHOOK_SECRET. Optional: ADMINS_ID="123,456".
// Never expose BOT_TOKEN or ADMIN_KEY in index.js. ADMIN_KEY is a trusted operator credential.
import html, { guides, releases, setup, workerSource, librarySource, contentSecurityPolicy } from './index.js';
import { handleLibrary, libraryScope, libraryState, mediaPayload } from './library.js';

const encoder = new TextEncoder();
const escape = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const admins = env => String(env.ADMINS_ID || '').split(/[\s,]+/).filter(Boolean);
const allowed = (env, id) => !admins(env).length || admins(env).includes(String(id));
const result = (data, status = 200, headers = {}) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store', ...headers } });
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const delivery = Symbol('delivery');
const libraryOwner = Symbol('libraryOwner');
const positiveId = value => Number.isSafeInteger(value) && value > 0;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
async function readJson(request) {
  if (Number(request.headers.get('content-length') || 0) > 524288) throw fail('Request too large.', 413);
  const reader = request.body?.getReader();
  let length = 0, raw = '';
  const decoder = new TextDecoder();
  if (reader) while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > 524288) { await reader.cancel(); throw fail('Request too large.', 413); }
    raw += decoder.decode(value, { stream: true });
  }
  raw += decoder.decode();
  let data;
  try { data = JSON.parse(raw || '{}'); } catch { throw fail('Invalid JSON.'); }
  if (!object(data)) throw fail('JSON body must be an object.');
  return data;
}
async function stateCall(env, name, path, data) {
  if (!env.BOT_STATE) throw fail('BOT_STATE is not configured. Deploy using wrangler.jsonc.', 503);
  return env.BOT_STATE.get(env.BOT_STATE.idFromName(name)).fetch('https://state.internal/' + path, { method: 'POST', body: JSON.stringify(data) });
}
async function consumeRate(env, key, limit) {
  const response = await stateCall(env, 'rate:' + key, 'rate', { limit });
  if (!response.ok) throw fail('Rate limiter unavailable.', 503);
  return response.json();
}
async function equal(a, b) {
  const hash = async s => new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(s)));
  const [aa, bb] = await Promise.all([hash(a), hash(b)]);
  let diff = 0;
  for (let i = 0; i < aa.length; i++) diff |= aa[i] ^ bb[i];
  return diff === 0;
}
async function hmac(key, data) {
  const k = await crypto.subtle.importKey('raw', typeof key === 'string' ? encoder.encode(key) : key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return crypto.subtle.sign('HMAC', k, encoder.encode(data));
}
async function telegram(env, method, data = {}) {
  if (!env.BOT_TOKEN) throw fail('BOT_TOKEN is not configured on the Worker.', 503);
  const payload = JSON.stringify(data), checkpoint = env[delivery];
  const digest = checkpoint ? [...new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(payload)))].map(v => v.toString(16).padStart(2, '0')).join('') : '';
  // Checkpoint successful side effects so a later failure does not repeat them.
  const step = checkpoint ? checkpoint.next++ : 0;
  const saved = checkpoint?.calls[step];
  if (saved?.method === method && saved.digest === digest) return saved.result;
  const media = data.rich_message ? await mediaPayload(env, env[libraryOwner], data) : null;
  for (let attempt = 0; attempt < 3; attempt++) {
    let response, body;
    try {
      response = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, { method: 'POST', headers: media ? {} : { 'Content-Type': 'application/json' }, body: media || payload, signal: AbortSignal.timeout(6000) });
      body = await response.json();
    } catch { throw fail('Telegram is temporarily unavailable. Please retry.', 503); }
    if (body.ok) {
      if (checkpoint && !['getMe', 'getChat', 'getChatMember'].includes(method)) {
        checkpoint.calls[step] = { method, digest, result: true };
        await checkpoint.save();
      }
      return body.result;
    }
    const status = body.error_code || response.status;
    if (status === 429 || status >= 500) {
      const delay = status === 429 ? Math.max(1, Number(body.parameters?.retry_after) || 1) : attempt + 1;
      if (attempt < 2 && delay <= 3) { await new Promise(resolve => setTimeout(resolve, delay * 1000)); continue; }
      throw Object.assign(fail('Telegram is temporarily unavailable. Please retry.', 503), { retryAfter: delay });
    }
    throw fail(body.description || 'Telegram request failed.', 400);
  }
}
async function authenticate(request, env) {
  const token = request.headers.get('Authorization') || '';
  if (env.ADMIN_KEY && token.startsWith('Bearer ') && await equal(token.slice(7), env.ADMIN_KEY)) return { operator: true };
  const raw = request.headers.get('X-Telegram-Init-Data');
  if (!raw) throw fail('Open this app from your Telegram bot, or connect using ADMIN_KEY.', 401);
  if (!env.BOT_TOKEN) throw fail('BOT_TOKEN is not configured on the Worker.', 503);
  const params = new URLSearchParams(raw);
  const signature = params.get('hash') || '';
  params.delete('hash');
  params.sort();
  const check = [...params.entries()].map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = await hmac('WebAppData', env.BOT_TOKEN);
  const computed = [...new Uint8Array(await hmac(secret, check))].map(v => v.toString(16).padStart(2, '0')).join('');
  if (!await equal(computed, signature)) throw fail('Invalid Telegram session signature.', 401);
  const age = Date.now() / 1000 - Number(params.get('auth_date'));
  if (!Number.isFinite(age) || age < -30 || age > 3600) throw fail('Your Telegram session expired. Reopen the Mini App.', 401);
  let user;
  try { user = JSON.parse(params.get('user') || '{}'); } catch { throw fail('Invalid Telegram user.', 401); }
  if (!object(user) || !positiveId(user.id)) throw fail('No Telegram user in session.', 401);
  if (!allowed(env, user.id)) throw fail('This bot is restricted to its configured administrators.', 403);
  return { operator: false, user };
}
function requireBotPermission(chat, bot, action) {
  if (chat.type !== 'channel' || bot.status === 'creator') return;
  const permitted = action === 'delete' ? bot.can_delete_messages || bot.can_post_messages : action === 'edit' ? bot.can_edit_messages || bot.can_post_messages : bot.can_post_messages;
  if (!permitted) throw fail('The bot lacks permission for this operation.', 403);
}
async function authorizeChat(env, identity, chatId, action = 'send', messageId) {
  if (!(Number.isSafeInteger(chatId) && chatId !== 0) && !(typeof chatId === 'string' && /^(@[A-Za-z][\w]{3,}|-?\d+)$/.test(chatId))) throw fail('A valid chat ID is required.');
  const chat = await telegram(env, 'getChat', { chat_id: chatId });
  if (identity.operator) {
    if (chat.type === 'channel' || chat.type === 'supergroup' || chat.type === 'group') {
      const me = await telegram(env, 'getMe');
      const member = await telegram(env, 'getChatMember', { chat_id: chat.id, user_id: me.id });
      if (!['administrator', 'creator'].includes(member.status)) throw fail('Add the bot as a chat administrator before publishing.', 403);
      requireBotPermission(chat, member, action);
    }
    return chat;
  }
  if (chat.type === 'private') {
    if (String(chat.id) !== String(identity.user.id)) throw fail('You may only send to your own private chat.', 403);
    return chat;
  }
  const me = await telegram(env, 'getMe');
  const [user, bot] = await Promise.all([
    telegram(env, 'getChatMember', { chat_id: chat.id, user_id: identity.user.id }),
    telegram(env, 'getChatMember', { chat_id: chat.id, user_id: me.id })
  ]);
  if (!['administrator', 'creator'].includes(user.status)) throw fail('You must be an administrator of the destination.', 403);
  if (!['administrator', 'creator'].includes(bot.status)) throw fail('The bot must be an administrator of the destination.', 403);
  requireBotPermission(chat, bot, action);
  const permission = action === 'delete' ? 'can_delete_messages' : action === 'edit' && chat.type === 'channel' ? 'can_edit_messages' : chat.type === 'channel' ? 'can_post_messages' : null;
  if (user.status !== 'creator' && permission && !user[permission]) throw fail('You do not have permission for this operation.', 403);
  if (action === 'edit' && chat.type !== 'channel' && user.status !== 'creator') {
    const response = await stateCall(env, 'chat:' + chat.id, 'owner', { message_id: messageId });
    const owner = await response.json();
    if (!response.ok || owner.user_id !== identity.user.id) throw fail('You may only edit group messages created by you.', 403);
  }
  return chat;
}
function validateRich(rich) {
  if (!object(rich)) throw fail('rich_message is required.');
  const keys = ['html', 'markdown', 'blocks'].filter(k => rich[k] !== undefined);
  if (keys.length !== 1) throw fail('Use exactly one of html, markdown or blocks.');
  if (keys[0] !== 'blocks' && (typeof rich[keys[0]] !== 'string' || !rich[keys[0]].trim() || rich[keys[0]].length > 32768)) throw fail('Message must contain 1–32,768 characters.');
  if (keys[0] === 'blocks' && (!Array.isArray(rich.blocks) || !rich.blocks.length || rich.blocks.length > 100 || rich.blocks.some(block => !object(block) || typeof block.type !== 'string'))) throw fail('blocks must contain 1–100 typed objects.');
  return rich;
}
const copyFields = (source, names) => Object.fromEntries(names.filter(k => source[k] !== undefined).map(k => [k, source[k]]));
function validateKeyboard(markup) {
  if (!object(markup) || !Array.isArray(markup.inline_keyboard) || markup.inline_keyboard.length > 20) throw fail('Invalid inline keyboard.');
  let count = 0;
  const actions = ['url', 'callback_data', 'web_app', 'switch_inline_query', 'switch_inline_query_current_chat', 'switch_inline_query_chosen_chat', 'copy_text', 'disabled'];
  for (const row of markup.inline_keyboard) {
    if (!Array.isArray(row) || !row.length || row.length > 8) throw fail('Keyboard rows must contain 1–8 buttons.');
    for (const button of row) {
      if (++count > 100 || !object(button) || typeof button.text !== 'string' || !button.text.trim() || button.text.length > 256) throw fail('Invalid keyboard button.');
      if (button.disabled !== undefined && button.disabled !== true) throw fail('disabled must be true.');
      for (const key of ['switch_inline_query', 'switch_inline_query_current_chat']) if (button[key] !== undefined && typeof button[key] !== 'string') throw fail('Invalid inline query.');
      if (button.switch_inline_query_chosen_chat !== undefined && !object(button.switch_inline_query_chosen_chat)) throw fail('Invalid chosen chat action.');
      const present = actions.filter(key => button[key] !== undefined && !(button.disabled && key === 'callback_data'));
      if (present.length !== 1) throw fail('Each button must have exactly one action.');
      if (button.callback_data !== undefined && !button.disabled && (typeof button.callback_data !== 'string' || !encoder.encode(button.callback_data).length || encoder.encode(button.callback_data).length > 64)) throw fail('callback_data must contain 1–64 bytes.');
      if (button.url !== undefined && (typeof button.url !== 'string' || !/^(https:\/\/|tg:\/\/)/i.test(button.url))) throw fail('Button URLs require HTTPS or tg://.');
      if (button.web_app !== undefined && (!object(button.web_app) || typeof button.web_app.url !== 'string' || !/^https:\/\//i.test(button.web_app.url))) throw fail('Web App URLs require HTTPS.');
      if (button.copy_text !== undefined && (!object(button.copy_text) || typeof button.copy_text.text !== 'string' || !button.copy_text.text.length || button.copy_text.text.length > 256)) throw fail('Copy text must contain 1–256 characters.');
    }
  }
}

// One persistent object per update/rate key/chat. A serialized promise chain
// protects concurrent requests without holding a database transaction over HTTP.
export class BotState {
  constructor(state, env) { this.state = state; this.env = env; this.pending = Promise.resolve(); }
  fetch(request) {
    const response = this.pending.catch(() => {}).then(() => this.handle(request));
    this.pending = response;
    return response;
  }
  async handle(request) {
    if (new URL(request.url).pathname.startsWith('/library/')) return handleLibrary(request, this.state.storage, this.env);
    const path = new URL(request.url).pathname, data = await readJson(request), storage = this.state.storage;
    if (path === '/rate') {
      const now = Date.now(), previous = await storage.get('rate');
      const rate = previous && previous.reset > now ? previous : { count: 0, reset: now + 60000 };
      if (rate.count >= data.limit) return result({ allowed: false, retryAfter: Math.max(1, Math.ceil((rate.reset - now) / 1000)) });
      rate.count++;
      await storage.put('rate', rate);
      await storage.setAlarm(rate.reset);
      return result({ allowed: true });
    }
    if (path === '/owner') {
      if (!positiveId(data.message_id)) return result({}, 400);
      const key = 'message:' + data.message_id;
      if (data.remove) { await storage.delete(key); return result({}); }
      if (data.user_id !== undefined) {
        await storage.put(key, { user_id: data.user_id });
      }
      const owner = await storage.get(key);
      return result(owner ? { user_id: owner.user_id } : {});
    }
    if (path !== '/update') return result({}, 404);
    const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(JSON.stringify(data.update))))].map(v => v.toString(16).padStart(2, '0')).join('');
    const previous = await storage.get('update');
    if (previous && previous.digest !== digest) return new Response('Update mismatch', { status: 400 });
    if (previous?.done) return new Response('OK');
    const record = previous || { digest, calls: [], rateChecked: false };
    await storage.setAlarm(Date.now() + 86400000);
    const checkpoint = { calls: record.calls, next: 0, save: () => storage.put('update', record) };
    const env = { ...this.env, [delivery]: checkpoint };
    try {
      if (!record.rateChecked) {
        const user = data.update.callback_query?.from || data.update.message?.from;
        if (user) {
          const rate = await consumeRate(env, 'webhook:' + user.id, 20);
          if (!rate.allowed) return new Response('Rate limited', { status: 503, headers: { 'Retry-After': String(rate.retryAfter) } });
        }
        record.rateChecked = true;
        await checkpoint.save();
      }
      try { await onUpdate(data.update, env, data.origin); }
      catch (error) {
        if (!error.status || error.status >= 500) throw error;
        const chat = data.update.message?.chat || data.update.callback_query?.message?.chat;
        if (chat?.type === 'private') await plain(env, chat.id, `⚠️ ${escape(error.message)}\n\n/help — menu / راهنما`);
      }
      record.done = true;
      // Completed updates only retain a digest and a completion flag.
      record.calls = [];
      await storage.put('update', record);
      return new Response('OK');
    } catch (error) {
      return new Response('Temporary processing failure', { status: 503, headers: { 'Retry-After': String(error.retryAfter || 2) } });
    }
  }
  async alarm() {
    const rate = await this.state.storage.get('rate');
    if (rate?.reset > Date.now()) { await this.state.storage.setAlarm(rate.reset); return; }
    await this.state.storage.deleteAll();
  }}

async function webApi(request, env, url) {
  if (request.method !== 'POST') throw fail('POST required.', 405);
  const identity = await authenticate(request, env);
  const rate = await consumeRate(env, identity.operator ? 'operator' : 'user:' + identity.user.id, 60);
  if (!rate.allowed) throw Object.assign(fail('Too many requests. Please wait.', 429), { retryAfter: rate.retryAfter });
  const action = url.pathname.slice(5);
  if (action.startsWith('library/')) return libraryState(env, libraryScope(env, identity), action.slice(8), request);
  const data = await readJson(request);
  env = { ...env, [libraryOwner]: libraryScope(env, identity) };
  if (action === 'connect') {
    const bot = await telegram(env, 'getMe');
    return { ...bot, workspace_id: bot.id + ':' + (identity.operator ? 'operator' : 'user:' + identity.user.id) };
  }
  if (action === 'webhook') {
    if (!identity.operator) throw fail('Only the operator may change the webhook.', 403);
    if (!env.WEBHOOK_SECRET) throw fail('Set WEBHOOK_SECRET first.');
    const webhook = await telegram(env, 'setWebhook', { url: `${url.origin}/webhook`, secret_token: env.WEBHOOK_SECRET, allowed_updates: ['message', 'callback_query', 'my_chat_member', 'stopped_message_generation'] });
    const commands = await telegram(env, 'setMyCommands', { commands: [
      { command: 'start', description: 'Open TeleRich · باز کردن تله‌ریچ' },
      { command: 'guide', description: 'Rich text guide · راهنمای متن ریچ' },
      { command: 'html', description: 'Blocks & layout guide · راهنمای بلوک‌ها' },
      { command: 'media', description: 'Media guide · راهنمای مدیا' },
      { command: 'buttons', description: 'Rich buttons example · نمونه دکمه ریچ' },
      { command: 'table', description: 'Table example · نمونه جدول' },
      { command: 'demo', description: 'Full feature demo · دموی کامل' },
      { command: 'setup', description: 'Deployment guide · راهنمای راه‌اندازی' },
      { command: 'updates', description: 'Bot API 10.3 changes · تازه‌های نسخه' },
      { command: 'webapp', description: 'Open the studio · باز کردن استودیو' },
      { command: 'post', description: 'Channel studio · پست‌ساز کانال' },
      { command: 'whoami', description: 'Your numeric ID · شناسه عددی شما' },
      { command: 'about', description: 'Credits · درباره' },
    ] });
    return { webhook, commands };
  }
  if (!['send', 'edit', 'delete', 'channel', 'draft', 'editEphemeralMessageText', 'editEphemeralMessageCaption', 'editEphemeralMessageReplyMarkup', 'deleteEphemeralMessage'].includes(action)) throw fail('Unknown API route.', 404);
  if (['edit', 'delete'].includes(action) && !positiveId(data.message_id)) throw fail('A positive message_id is required.');
  if (data.reply_markup !== undefined) validateKeyboard(data.reply_markup);
  for (const key of ['disable_notification', 'protect_content', 'can_stop', 'keep_on_stop']) if (data[key] !== undefined && typeof data[key] !== 'boolean') throw fail(key + ' must be boolean.');
  if (data.message_thread_id !== undefined && !positiveId(data.message_thread_id)) throw fail('Invalid message_thread_id.');
  const chatId = data.chat_id || identity.user?.id;
  const operation = action === 'delete' ? 'delete' : action === 'edit' ? 'edit' : action.includes('Ephemeral') ? 'ephemeral' : 'send';
  const chat = await authorizeChat(env, identity, chatId, operation, data.message_id);
  if (action === 'channel') return { id: chat.id, title: chat.title, type: chat.type };
  if (action === 'send') {
    const fields = copyFields(data, ['disable_notification', 'protect_content', 'ephemeral_message_parameters', 'reply_markup', 'reply_parameters', 'message_thread_id']);
    if (fields.ephemeral_message_parameters && (!['group', 'supergroup'].includes(chat.type) || !object(fields.ephemeral_message_parameters) || !positiveId(fields.ephemeral_message_parameters.receiver_user_id))) throw fail('Ephemeral messages require a group and a positive receiver_user_id.');
    const sent = await telegram(env, 'sendRichMessage', { ...fields, chat_id: chat.id, rich_message: validateRich(data.rich_message) });
    if (['group', 'supergroup'].includes(chat.type) && sent.message_id) {
      const response = await stateCall(env, 'chat:' + chat.id, 'owner', { message_id: sent.message_id, user_id: identity.operator ? 'operator' : identity.user.id });
      if (!response.ok) throw fail('Message sent, but ownership could not be saved.', 503);
    }
    return sent;
  }
  if (action === 'draft') {
    if (chat.type !== 'private' || !positiveId(data.draft_id)) throw fail('Drafts require a private chat and a positive draft_id.');
    return telegram(env, 'sendRichMessageDraft', { ...copyFields(data, ['draft_id', 'can_stop', 'keep_on_stop', 'message_thread_id']), chat_id: chat.id, rich_message: validateRich(data.rich_message) });
  }
  if (action === 'edit') {
    if (!Number.isSafeInteger(data.message_id)) throw fail('A valid message_id is required.');
    return telegram(env, 'editMessageText', { chat_id: chat.id, message_id: data.message_id, rich_message: validateRich(data.rich_message), ...copyFields(data, ['reply_markup']) });
  }
  if (action === 'delete') {
    if (!Number.isSafeInteger(data.message_id)) throw fail('A valid message_id is required.');
    const deleted = await telegram(env, 'deleteMessage', { chat_id: chat.id, message_id: data.message_id });
    if (['group', 'supergroup'].includes(chat.type)) await stateCall(env, 'chat:' + chat.id, 'owner', { message_id: data.message_id, remove: true });
    return deleted;
  }
  if (!['group', 'supergroup'].includes(chat.type)) throw fail('Ephemeral messages require a group.');
  const fields = copyFields(data, ['receiver_user_id', 'ephemeral_message_id', 'rich_message', 'text', 'parse_mode', 'caption', 'caption_entities', 'show_caption_above_media', 'reply_markup']);
  if (!positiveId(fields.receiver_user_id) || !positiveId(fields.ephemeral_message_id)) throw fail('receiver_user_id and ephemeral_message_id are required.');
  if (!identity.operator && fields.receiver_user_id !== identity.user.id) throw fail('Cannot modify another user’s ephemeral messages.', 403);
  if (fields.rich_message) validateRich(fields.rich_message);
  return telegram(env, action, { ...fields, chat_id: chat.id });
}

function menu(lang, origin) {
  const fa = lang === 'fa';
  return { inline_keyboard: [
    [{ text: fa ? '✨ استودیوی پیام و پست‌ساز' : '✨ Message & channel studio', web_app: { url: origin }, style: 'primary' }],
    [{ text: fa ? '📖 راهنمای متن ریچ' : '📖 Rich text guide', callback_data: `list:${lang}:Rich text:0` }, { text: fa ? '🧩 بلوک‌ها' : '🧩 Blocks', callback_data: `list:${lang}:Blocks:0` }],
    [{ text: fa ? '🖼 راهنمای مدیا' : '🖼 Media guide', callback_data: `list:${lang}:Media:0` }, { text: fa ? '🎨 دمو کامل' : '🎨 Full demo', callback_data: `demo:${lang}:0`, style: 'success' }],
    [{ text: fa ? '🚀 راه‌اندازی' : '🚀 Deployment', callback_data: `setup:${lang}` }, { text: 'Bot API 10.3', callback_data: `updates:${lang}` }],
    [{ text: fa ? '🌐 English' : '🌐 فارسی', callback_data: `home:${fa ? 'en' : 'fa'}` }]
  ] };
}
const back = (lang, origin) => ({ inline_keyboard: [[{ text: lang === 'fa' ? '← بازگشت به منو' : '← Back to menu', callback_data: `home:${lang}` }, { text: lang === 'fa' ? 'باز کردن استودیو' : 'Open studio', web_app: { url: origin }, style: 'primary' }]] });
async function plain(env, chatId, text, markup, messageId) {
  return telegram(env, messageId ? 'editMessageText' : 'sendMessage', { chat_id: chatId, ...(messageId ? { message_id: messageId } : {}), text, parse_mode: 'HTML', reply_markup: markup, link_preview_options: { is_disabled: true } });
}
async function home(env, chatId, lang, origin, messageId) {
  const en = '<b>✨ TeleRich · Rich Message Studio</b>\n\nSend HTML or Markdown to render a rich message with Bot API 10.3.\n\nExplore individual guides, code examples and live demos. Open the studio for button styles, row layout, media and channel publishing.\n\n/start — menu\n/help — guides\n/post — channel studio\n/about — credits';
  const fa = '<b>✨ TeleRich · استودیوی پیام ریچ</b>\n\nمتن HTML یا Markdown بفرستید تا با Bot API 10.3 به پیام ریچ تبدیل شود.\n\nراهنمای هر قابلیت، نمونه کد و دموی زنده در دسترس است. برای تنظیم رنگ و ردیف دکمه، مدیا و ارسال به کانال، استودیو را باز کنید.\n\n/start — منو\n/help — راهنما\n/post — پست‌ساز\n/about — درباره';
  const text = en + '\n\n〰️〰️〰️〰️〰️〰️〰️〰️\n\n' + fa;
  return plain(env, chatId, text, menu(lang, origin), messageId);
}
function reconstruct(message) {
  const text = message.text || message.caption || '';
  const entities = message.entities || message.caption_entities || [];
  if (!entities.length) return { [/<\/?[a-z][\s\S]*?>/i.test(text) ? 'html' : 'markdown']: text };
  const starts = new Map(), ends = new Map();
  const tags = { bold: ['<b>', '</b>'], italic: ['<i>', '</i>'], underline: ['<u>', '</u>'], strikethrough: ['<s>', '</s>'], spoiler: ['<tg-spoiler>', '</tg-spoiler>'], code: ['<code>', '</code>'], pre: ['<pre><code>', '</code></pre>'], blockquote: ['<blockquote>', '</blockquote>'], expandable_blockquote: ['<blockquote expandable>', '</blockquote>'] };
  for (const e of [...entities].sort((a, b) => a.offset - b.offset || b.length - a.length)) {
    let pair = tags[e.type];
    if (e.type === 'text_link') pair = [`<a href="${escape(e.url)}">`, '</a>'];
    if (e.type === 'text_mention') pair = [`<a href="tg://user?id=${e.user.id}">`, '</a>'];
    if (e.type === 'custom_emoji') pair = [`<tg-emoji emoji-id="${escape(e.custom_emoji_id)}">`, '</tg-emoji>'];
    if (!pair) continue;
    starts.set(e.offset, (starts.get(e.offset) || '') + pair[0]);
    ends.set(e.offset + e.length, pair[1] + (ends.get(e.offset + e.length) || ''));
  }
  let output = '';
  for (let i = 0; i <= text.length; i++) output += (ends.get(i) || '') + (starts.get(i) || '') + (i < text.length ? escape(text[i]) : '');
  return { html: output };
}
function guideIndexByName(name) { return guides.findIndex(g => g.name === name); }
async function sendList(env, chatId, lang, group, offset, origin, messageId) {
  const list = guides.map((g, i) => ({ ...g, i })).filter(g => g.group === group);
  offset = Math.max(0, offset || 0);
  const slice = list.slice(offset, offset + 8);
  const keyboard = slice.map(g => [{ text: lang === 'fa' ? `${g.fa} · ${g.name}` : g.name, callback_data: `guide:${lang}:${g.i}` }]);
  const nav = [];
  if (offset > 0) nav.push({ text: '←', callback_data: `list:${lang}:${group}:${offset - 8}`, style: 'danger' });
  if (offset + 8 < list.length) nav.push({ text: '→', callback_data: `list:${lang}:${group}:${offset + 8}`, style: 'primary' });
  if (nav.length) keyboard.push(nav);
  keyboard.push(back(lang, origin).inline_keyboard[0]);
  return plain(env, chatId, `<b>${escape(group)} · Bot API 10.3</b>\n\n${lang === 'fa' ? 'برای توضیح و نمونه، یک قابلیت انتخاب کنید.' : 'Choose a feature for its explanation and example.'}`, { inline_keyboard: keyboard }, messageId);
}
async function sendGuide(env, chatId, lang, index, origin, messageId) {
  const guide = guides[index];
  if (!guide) return;
  const text = `<b>${escape(guide.name)}</b>\n\n${escape(lang === 'fa' ? guide.descriptionFa : guide.description)}\n\n<pre>${escape(guide.code)}</pre>\n\n<a href="https://core.telegram.org/bots/api#${guide.name.toLowerCase()}">Telegram API reference</a>`;
  return plain(env, chatId, text, { inline_keyboard: [[{ text: lang === 'fa' ? '▶ نمایش نمونه رندرشده' : '▶ Render this example', callback_data: `render:${lang}:${index}`, style: 'success' }], ...back(lang, origin).inline_keyboard] }, messageId);
}
async function sendDemo(env, chatId, lang, offset, origin, messageId) {
  offset = Math.max(0, offset || 0);
  const examples = guides.slice(offset, offset + 5);
  const nav = [];
  if (offset > 0) nav.push({ text: lang === 'fa' ? '← بخش قبل' : '← Previous section', callback_data: `demo:${lang}:${Math.max(0, offset - 5)}`, style: 'danger' });
  if (offset + 5 < guides.length) nav.push({ text: lang === 'fa' ? 'بخش بعد →' : 'Next section →', callback_data: `demo:${lang}:${offset + 5}`, style: 'primary' });
  const rich_message = { markdown: examples.map(g => `## ${g.name}\n\n${g.code}`).join('\n\n') };
  const reply_markup = { inline_keyboard: [...(nav.length ? [nav] : []), ...back(lang, origin).inline_keyboard] };
  // Bot API 10.2+: editMessageText accepts rich_message, so paging through the demo edits
  // the same message instead of sending a new one each time next/back is pressed.
  return telegram(env, messageId ? 'editMessageText' : 'sendRichMessage', { chat_id: chatId, ...(messageId ? { message_id: messageId } : {}), rich_message, reply_markup });
}
async function sendSetup(env, chatId, lang, origin, messageId) {
  const text = '<b>TeleRich · Deployment / راه‌اندازی</b>\n\n' + setup.map((s, i) => `<b>${i + 1}. ${escape(s[lang === 'fa' ? 1 : 0])}</b>\n${escape(s[lang === 'fa' ? 3 : 2])}`).join('\n\n');
  return plain(env, chatId, text.slice(0, 4000), back(lang, origin), messageId);
}
async function sendUpdates(env, chatId, lang, origin, messageId) {
  const release = releases[0];
  const text = `<b>Bot API ${release.version} · ${release.date}</b>\n\n` + release.items.map(item => `<b>${escape(item[0])}</b>\n${escape(item[lang === 'fa' ? 2 : 1])}`).join('\n\n') + '\n\n<a href="https://core.telegram.org/bots/api#august-24-2026">Official changelog</a>';
  return plain(env, chatId, text, back(lang, origin), messageId);
}
async function sendWebapp(env, chatId, lang, origin) {
  return plain(env, chatId, lang === 'fa' ? '✨ استودیوی پیام و پست‌ساز را باز کنید.' : '✨ Open the message & channel studio.', { inline_keyboard: [[{ text: lang === 'fa' ? '✨ باز کردن استودیو' : '✨ Open studio', web_app: { url: origin }, style: 'primary' }], back(lang, origin).inline_keyboard[0]] });
}
async function sendWhoami(env, chatId, lang, origin, user) {
  const restricted = admins(env).length > 0;
  const isAdmin = !restricted || admins(env).includes(String(user.id));
  const text = lang === 'fa'
    ? `<b>شناسه عددی شما</b>\n<code>${user.id}</code>\n\n${restricted ? (isAdmin ? '✅ شما در فهرست ADMINS_ID هستید.' : '⛔ شما در فهرست ADMINS_ID نیستید و به استودیو دسترسی ندارید.') : 'ℹ️ ADMINS_ID تنظیم نشده؛ استفاده از ربات برای همه آزاد است.'}`
    : `<b>Your numeric ID</b>\n<code>${user.id}</code>\n\n${restricted ? (isAdmin ? '✅ You are listed in ADMINS_ID.' : '⛔ You are not listed in ADMINS_ID and cannot use the studio.') : 'ℹ️ ADMINS_ID is not set; anyone may use this bot.'}`;
  return plain(env, chatId, text, back(lang, origin));
}

async function onUpdate(update, env, origin) {
  const callback = update.callback_query;
  const message = callback?.message || update.message;
  const user = callback?.from || update.message?.from;
  if (!user || !message) return;
  // /whoami is exempt: it is how an owner discovers a user's numeric ID before adding it to ADMINS_ID.
  if (!callback && message.chat.type === 'private' && (message.text || '').split(' ')[0] === '/whoami') {
    return sendWhoami(env, message.chat.id, user.language_code?.startsWith('fa') ? 'fa' : 'en', origin, user);
  }
  if (!allowed(env, user.id)) {
    if (callback) await telegram(env, 'answerCallbackQuery', { callback_query_id: callback.id, text: 'Access restricted / دسترسی محدود', show_alert: true });
    else if (message.chat.type === 'private') await plain(env, message.chat.id, 'Access restricted / دسترسی محدود');
    return;
  }
  // Interactive menus are private-chat only; a bot must not expose another user's draft to a group.
  if (message.chat.type !== 'private') return;
  const chatId = message.chat.id;
  const detectedLang = user.language_code?.startsWith('fa') ? 'fa' : 'en';
  if (callback) {
    const [action, rawLang, arg, page] = (callback.data || '').split(':');
    const lang = rawLang === 'fa' ? 'fa' : 'en';
    await telegram(env, 'answerCallbackQuery', { callback_query_id: callback.id, text: ['home','list','guide','render','demo','setup','updates','publish','edit','delete'].includes(action) ? undefined : `Callback: ${callback.data || ''}` });
    if (action === 'home') return home(env, chatId, lang, origin, message.message_id);
    if (action === 'list') return sendList(env, chatId, lang, ['Rich text','Blocks','Media'].includes(arg) ? arg : 'Rich text', Number(page) || 0, origin, message.message_id);
    if (action === 'guide') return sendGuide(env, chatId, lang, Number(arg), origin, message.message_id);
    if (action === 'render') {
      const guide = guides[Number(arg)];
      if (guide) return telegram(env, 'sendRichMessage', { chat_id: chatId, rich_message: { markdown: guide.code }, reply_markup: back(lang, origin) });
    }
    if (action === 'demo') return sendDemo(env, chatId, lang, Number(arg) || 0, origin, message.message_id);
    if (action === 'setup') return sendSetup(env, chatId, lang, origin, message.message_id);
    if (action === 'updates') return sendUpdates(env, chatId, lang, origin, message.message_id);
    if (action === 'publish' || action === 'edit') {
      const label = action === 'publish' ? (lang === 'fa' ? 'آدرس @کانال یا شناسه -100… را در پاسخ بفرستید. شما و ربات باید مدیر باشید.' : 'Reply with the destination @channel or -100… ID. You and the bot must be administrators.') : (lang === 'fa' ? 'متن جدید HTML یا Markdown را در پاسخ بفرستید.' : 'Reply with your replacement HTML or Markdown.');
      return plain(env, chatId, `${label}\n\n<code>TR:${action}:${arg}:${lang}</code>`, { force_reply: true, selective: true });
    }
    if (action === 'delete') {
      await telegram(env, 'deleteMessage', { chat_id: chatId, message_id: Number(arg) });
      return home(env, chatId, lang, origin);
    }
    return;
  }
  const text = message.text || '';
  const command = text.split(' ')[0];
  if (['/start','/help','/post'].includes(command)) return home(env, chatId, detectedLang, origin);
  if (command === '/about') return plain(env, chatId, '<b>TeleRich · DarknessShade</b>\n\n<a href="https://github.com/DarknessShade/TeleRich">GitHub</a>\n<a href="https://t.me/Paradise_Of_Freedom">Paradise Of Freedom</a>\n<a href="https://t.me/ConfigWireguard">ConfigWireguard</a>', back(detectedLang, origin));
  if (command === '/whoami') return sendWhoami(env, chatId, detectedLang, origin, user);
  if (command === '/guide' || command === '/markdown') return sendList(env, chatId, detectedLang, 'Rich text', 0, origin);
  if (command === '/html') return sendList(env, chatId, detectedLang, 'Blocks', 0, origin);
  if (command === '/media') return sendList(env, chatId, detectedLang, 'Media', 0, origin);
  if (command === '/buttons') { const i = guideIndexByName('RichBlockButtons'); return i >= 0 ? sendGuide(env, chatId, detectedLang, i, origin) : sendList(env, chatId, detectedLang, 'Blocks', 0, origin); }
  if (command === '/table') { const i = guideIndexByName('RichBlockTable'); return i >= 0 ? sendGuide(env, chatId, detectedLang, i, origin) : sendList(env, chatId, detectedLang, 'Blocks', 0, origin); }
  if (command === '/demo') return sendDemo(env, chatId, detectedLang, 0, origin);
  if (command === '/setup') return sendSetup(env, chatId, detectedLang, origin);
  if (command === '/updates') return sendUpdates(env, chatId, detectedLang, origin);
  if (command === '/webapp') return sendWebapp(env, chatId, detectedLang, origin);
  const reply = message.reply_to_message;
  const marker = reply?.from?.is_bot && reply.text?.match(/TR:(publish|edit):(\d+):(en|fa)/);
  if (marker) {
    const [, action, messageId, lang] = marker;
    if (action === 'publish') {
      if (!/^(@[A-Za-z][\w]{3,}|-100\d+)$/.test(text.trim())) throw fail('Reply with a valid @channel or -100… identifier.');
      const target = await authorizeChat(env, { operator: false, user }, text.trim());
      await telegram(env, 'copyMessage', { chat_id: target.id, from_chat_id: chatId, message_id: Number(messageId) });
      return plain(env, chatId, lang === 'fa' ? '✅ پست منتشر شد.' : '✅ Your post is published.', back(lang, origin));
    }
    return telegram(env, 'editMessageText', { chat_id: chatId, message_id: Number(messageId), rich_message: reconstruct(message) });
  }
  if (!text.trim()) return plain(env, chatId, detectedLang === 'fa' ? 'برای مدیا، دکمه و چیدمان پیشرفته، استودیو را باز کنید.' : 'Open the studio to add media, buttons and advanced layouts.', back(detectedLang, origin));
  return telegram(env, 'sendRichMessage', { chat_id: chatId, rich_message: validateRich(reconstruct(message)) });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin');
    const permitted = !env.ALLOWED_ORIGIN || origin === env.ALLOWED_ORIGIN || origin === url.origin;
    const cors = { 'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN ? (permitted ? origin || url.origin : url.origin) : '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Telegram-Init-Data, X-File-Name', 'Access-Control-Max-Age': '86400', 'Vary': 'Origin' };
    if (request.method === 'OPTIONS') return new Response(null, { status: permitted ? 204 : 403, headers: cors });
    if (url.pathname === '/webhook') {
      if (request.method !== 'POST') return new Response('POST required', { status: 405 });
      const received = request.headers.get('X-Telegram-Bot-Api-Secret-Token') || '';
      if (!env.WEBHOOK_SECRET || !await equal(received, env.WEBHOOK_SECRET)) return new Response('Unauthorized', { status: 401 });
      try {
        const update = await readJson(request);
        if (!Number.isSafeInteger(update.update_id) || update.update_id < 0) throw fail('Invalid update_id.');
        return await stateCall(env, 'update:' + update.update_id, 'update', { update, origin: url.origin });
      } catch (error) { return new Response(error.status >= 500 ? 'Processing unavailable' : error.message, { status: error.status || 503 }); }
    }
    if (url.pathname.startsWith('/api/')) {
      if (!permitted) return result({ ok: false, description: 'Origin not allowed.' }, 403, cors);
      try {
        const value = await webApi(request, env, url);
        if (value instanceof Response) return new Response(value.body, { status: value.status, headers: { ...Object.fromEntries(value.headers), ...cors } });
        return result({ ok: true, result: value }, 200, cors);
      }
      catch (error) { return result({ ok: false, description: error.message || 'Request failed.' }, error.status || 500, { ...cors, ...(error.retryAfter ? { 'Retry-After': String(error.retryAfter) } : {}) }); }
    }
    if (request.method === 'GET' && url.pathname === '/worker.js') return new Response(workerSource, { headers: { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-cache' } });
    if (request.method === 'GET' && url.pathname === '/library.js') return new Response(librarySource, { headers: { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-cache' } });
    if (request.method === 'GET' && url.pathname === '/index.js') {
      const values = { guides, releases, setup, workerSource, librarySource, contentSecurityPolicy };
      const source = Object.entries(values).map(([key, value]) => `export const ${key} = ${JSON.stringify(value)};`).join('\n') + '\nexport default ' + JSON.stringify(html) + ';\n';
      return new Response(source, { headers: { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-cache' } });
    }
    if (request.method === 'GET' && url.pathname === '/') return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': contentSecurityPolicy, 'Permissions-Policy': 'camera=(), microphone=(), geolocation=()', 'Cache-Control': 'no-cache' } });
    return new Response('Not found', { status: 404 });
  }
};
