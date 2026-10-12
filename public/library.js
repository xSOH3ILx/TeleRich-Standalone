export const IMAGE_LIMIT = 20;
export const LINK_LIMIT = 20;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const error = (message, status = 400) => Object.assign(new Error(message), { status });
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const json = (value, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } });

export function libraryScope(env, identity) {
 const bot = String(env.BOT_TOKEN || '').split(':')[0];
 if (!/^\d+$/.test(bot)) throw error('BOT_TOKEN is not configured on the Worker.', 503);
 const admins = [...new Set(String(env.ADMINS_ID || '').split(/[\s,]+/).filter(id => /^\d+$/.test(id)))];
 const owner = identity.operator ? (admins.length === 1 ? 'user:' + admins[0] : 'operator') : 'user:' + identity.user.id;
 return bot + ':' + owner;
}

export function libraryState(env, scope, action, body = {}) {
 if (!env.BOT_STATE) throw error('BOT_STATE is not configured.', 503);
 const headers = { 'X-Library-Scope': scope };
 if (body instanceof Request) {
  headers['Content-Type'] = body.headers.get('Content-Type') || 'application/json';
  headers['X-File-Name'] = body.headers.get('X-File-Name') || '';
  body = body.body;
 } else { headers['Content-Type'] = 'application/json'; body = JSON.stringify(body); }
 return env.BOT_STATE.get(env.BOT_STATE.idFromName('library:' + scope)).fetch('https://state.internal/library/' + action, { method: 'POST', headers, body, duplex: 'half' });
}

async function bytes(request, maximum) {
 if (Number(request.headers.get('Content-Length') || 0) > maximum) throw error('File or request exceeds the size limit.', 413);
 const reader = request.body?.getReader(), chunks = []; let size = 0;
 if (reader) while (true) {
  const { value, done } = await reader.read(); if (done) break;
  size += value.byteLength;
  if (size > maximum) { await reader.cancel(); throw error('File or request exceeds the size limit.', 413); }
  chunks.push(value);
 }
 const data = new Uint8Array(size); let offset = 0;
 for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.byteLength; }
 return data;
}

function imageType(data) {
 if (data[0] === 255 && data[1] === 216 && data[2] === 255) return 'image/jpeg';
 if ([137,80,78,71,13,10,26,10].every((value, i) => data[i] === value)) return 'image/png';
 if (new TextDecoder().decode(data.slice(0,4)) === 'RIFF' && new TextDecoder().decode(data.slice(8,12)) === 'WEBP') return 'image/webp';
 return '';
}

export async function handleLibrary(request, storage, env) {
 try {
  const action = new URL(request.url).pathname.slice('/library/'.length);
  const scope = request.headers.get('X-Library-Scope');
  if (!/^\d+:(operator|user:\d+)$/.test(scope || '')) throw error('Invalid library owner.');
  const library = await storage.get('library') || { images: [], links: [] };
  const snapshot = () => ({ images: library.images.map(({ key, ...image }) => image), links: library.links, image_limit: IMAGE_LIMIT, link_limit: LINK_LIMIT, r2_ready: !!env.MEDIA_LIBRARY });
  if (action === 'list') return json({ ok: true, result: snapshot() });
  if (action === 'upload') {
   if (!env.MEDIA_LIBRARY) throw error('Connect the MEDIA_LIBRARY R2 bucket to enable photo uploads.', 503);
   if (library.images.length >= IMAGE_LIMIT) throw error('Photo library is full (20 photos). Delete a photo first.', 409);
   const content = await bytes(request, MAX_IMAGE_BYTES), mime = imageType(content);
   if (!mime || mime !== request.headers.get('Content-Type')) throw error('Choose a JPG, PNG or WebP image.');
   let name; try { name = decodeURIComponent(request.headers.get('X-File-Name') || 'photo'); } catch { throw error('Invalid file name.'); }
   if (!name.trim() || name.length > 120) throw error('Photo name must contain 1–120 characters.');
   const id = crypto.randomUUID(), key = scope + '/' + id;
   await env.MEDIA_LIBRARY.put(key, content, { httpMetadata: { contentType: mime } });
   library.images.push({ id, key, name: name.trim(), mime, size: content.byteLength });
   try { await storage.put('library', library); }
   catch (cause) { await env.MEDIA_LIBRARY.delete(key); throw cause; }
   return json({ ok: true, result: snapshot() });
  }
  const raw = new TextDecoder().decode(await bytes(request, 16384)); let data;
  try { data = JSON.parse(raw || '{}'); } catch { throw error('Invalid JSON.'); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw error('JSON body must be an object.');
  if (action === 'add-link') {
   if (library.links.length >= LINK_LIMIT) throw error('Link library is full (20 links). Delete a link first.', 409);
   if (typeof data.name !== 'string' || !data.name.trim() || data.name.length > 80) throw error('Link name must contain 1–80 characters.');
   let url; try { url = new URL(data.url); } catch { throw error('Enter a valid HTTPS link.'); }
   if (typeof data.url !== 'string' || data.url.length > 2048 || url.protocol !== 'https:' || url.username || url.password) throw error('Enter a valid HTTPS link.');
   if (library.links.some(link => link.url === url.href)) throw error('This link is already saved.', 409);
   library.links.push({ id: crypto.randomUUID(), name: data.name.trim(), url: url.href });
  } else if (action === 'photo' || action === 'delete-photo') {
   if (!uuid.test(data.id || '')) throw error('Invalid photo ID.');
   const image = library.images.find(image => image.id === data.id);
   if (!image) throw error('Photo is missing or belongs to another library.', 404);
   if (!env.MEDIA_LIBRARY) throw error('The MEDIA_LIBRARY R2 bucket is not connected.', 503);
   if (action === 'photo') {
    const object = await env.MEDIA_LIBRARY.get(image.key);
    if (!object) throw error('Photo is missing from storage.', 404);
    return new Response(object.body, { headers: { 'Content-Type': image.mime, 'Content-Length': String(image.size), 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' } });
   }
   await env.MEDIA_LIBRARY.delete(image.key);
   library.images = library.images.filter(image => image.id !== data.id);
  } else if (action === 'delete-link') {
   if (!library.links.some(link => link.id === data.id)) throw error('Link was not found.', 404);
   library.links = library.links.filter(link => link.id !== data.id);
  } else throw error('Unknown library action.', 404);
  await storage.put('library', library);
  return json({ ok: true, result: snapshot() });
 } catch (cause) { return json({ ok: false, description: cause.message || 'Library unavailable.' }, cause.status || 503); }
}

export async function mediaPayload(env, scope, data) {
 const rich = data.rich_message;
 const ids = [...new Set([...JSON.stringify(rich || {}).matchAll(/tg:\/\/photo\?id=(library_[0-9a-f-]{36})/g)].map(match => match[1]))];
 if (!ids.length) return null;
 if (!scope) throw error('Open the studio to send photos from your library.');
 if (ids.length > IMAGE_LIMIT) throw error('Use at most 20 library photos in a message.');
 if (rich.media !== undefined && !Array.isArray(rich.media)) throw error('Invalid rich message media.');
 const media = [...(rich.media || [])], form = new FormData(); let total = 0;
 for (const [index, id] of ids.entries()) {
  if (media.some(item => item.id === id)) throw error('Duplicate rich message media ID.');
  const response = await libraryState(env, scope, 'photo', { id: id.slice(8) });
  if (!response.ok) { const failure = await response.json(); throw error(failure.description, response.status); }
  total += Number(response.headers.get('Content-Length'));
  if (total > 20 * 1024 * 1024) throw error('Selected photos exceed 20 MB for one message.', 413);
  form.append('photo' + index, await response.blob(), 'photo' + index);
  media.push({ id, media: { type: 'photo', media: 'attach://photo' + index } });
 }
 for (const [name, value] of Object.entries({ ...data, rich_message: { ...rich, media } })) {
  if (value !== undefined) form.append(name, typeof value === 'object' ? JSON.stringify(value) : String(value));
 }
 return form;
}
