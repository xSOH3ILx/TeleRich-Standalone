import { useEffect, useState } from 'react';
import { Image, Link2, Loader2, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { useLibraryPhotos } from './useLibraryPhotos';

type Photo={id:string;name:string;mime:string;size:number};
type Link={id:string;name:string;url:string};
type LibraryData={images:Photo[];links:Link[];image_limit:number;link_limit:number;r2_ready:boolean};
export type LibraryApi=(path:string,body?:any,binary?:boolean)=>Promise<any>;

export default function Library({lang,api,onPhoto,onLink}:{lang:'en'|'fa';api:LibraryApi;onPhoto:(id:string)=>void;onLink:(link:Link)=>void}){
 const t=(en:string,fa:string)=>lang==='fa'?fa:en;
 const [tab,setTab]=useState('photos'),[data,setData]=useState<LibraryData|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const [file,setFile]=useState<File|null>(null),[name,setName]=useState(''),[url,setUrl]=useState('');
 const photos=useLibraryPhotos((data?.images||[]).map(image=>'tg://photo?id=library_'+image.id).join('\n'),'gallery',!!data,api,data?.images);
 useEffect(()=>{let active=true;api('library/list').then(value=>{if(active)setData(value);}).catch(cause=>{if(active)setError(cause.message);});return()=>{active=false;};},[]);
 async function change(action:string,body?:any){setBusy(true);setError('');try{setData(await api('library/'+action,body));return true;}catch(cause){setError((cause as Error).message);return false;}finally{setBusy(false);}}
 async function upload(){if(!file)return;if(file.size>5*1024*1024)return setError(t('Choose a photo smaller than 5 MB.','عکسی با حجم حداکثر ۵ مگابایت انتخاب کنید.'));if(await change('upload',file))setFile(null);}
 return <section className="panel saved-library">
  <div className="library-heading"><div><h2>{t('Your photo and link library','گالری عکس و لینک‌های شما')}</h2><p>{t('Save once, choose again on any device.','یک بار ذخیره کنید؛ از هر دستگاه دوباره انتخاب کنید.')}</p></div><button className="button subtle" disabled={busy} onClick={()=>change('list')}><RefreshCw size={16}/>{t('Refresh','تازه‌سازی')}</button></div>
  <div className="segmented-control"><button className={tab==='photos'?'active':''} onClick={()=>setTab('photos')}><Image size={16}/>{t('Photos','عکس‌ها')} {data&&`${data.images.length}/${data.image_limit}`}</button><button className={tab==='links'?'active':''} onClick={()=>setTab('links')}><Link2 size={16}/>{t('Saved links','لینک‌های ذخیره‌شده')} {data&&`${data.links.length}/${data.link_limit}`}</button></div>
  {error&&<p className="library-error" role="alert">{error}</p>}
  {!data&&!error&&<p className="library-loading"><Loader2 size={18} className="spin"/>{t('Loading your library…','در حال بارگذاری گالری…')}</p>}
  {data&&tab==='photos'&&<>
   {!data.r2_ready&&<div className="info-box">{t('Photo uploads need the MEDIA_LIBRARY R2 binding. Follow the gallery setup in the deployment guide. Your bucket stays private.','برای آپلود عکس، اتصال باکت R2 با نام MEDIA_LIBRARY لازم است. مراحل گالری را در راهنمای استقرار دنبال کنید؛ باکت خصوصی می‌ماند.')}</div>}
   <div className="library-upload"><label className="field-label">{t('Choose a photo','انتخاب عکس')}<span className="photo-file-picker"><span>{file?.name||t('Select a photo from your device','عکس را از دستگاه خود انتخاب کنید')}</span><input type="file" accept="image/jpeg,image/png,image/webp" disabled={busy||!data.r2_ready||data.images.length>=data.image_limit} onChange={event=>setFile(event.target.files?.[0]||null)}/></span><small>{t('JPG, PNG or WebP, up to 5 MB. Suggested banner: 1200 × 640 pixels.','JPG، PNG یا WebP، حداکثر ۵ مگابایت. بنر پیشنهادی: ۱۲۰۰ × ۶۴۰ پیکسل.')}</small></label><button className="button primary" disabled={busy||!file||!data.r2_ready||data.images.length>=data.image_limit} onClick={upload}>{busy?<Loader2 className="spin" size={16}/>:<Plus size={16}/>} {t('Upload photo','آپلود عکس')}</button></div>
   {data.images.length>=data.image_limit&&<p className="muted">{t('Library full. Delete a photo to add another.','گالری پر است؛ برای افزودن عکس جدید، یکی را حذف کنید.')}</p>}
   <div className="photo-library-grid">{data.images.map(image=><article className="library-photo" key={image.id}><div className="library-thumbnail">{photos['tg://photo?id=library_'+image.id]?<img src={photos['tg://photo?id=library_'+image.id]} alt={image.name}/>:<Image size={28}/>}</div><strong>{image.name}</strong><small>{Math.ceil(image.size/1024)} KB</small><div><button className="button primary" onClick={()=>onPhoto(image.id)}>{t('Insert photo','افزودن عکس به پیام')}</button><button className="icon-button danger-text" disabled={busy} aria-label={t('Delete photo: ','حذف عکس: ')+image.name} onClick={()=>change('delete-photo',{id:image.id})}><Trash2 size={17}/></button></div></article>)}</div>
   {!data.images.length&&<p className="library-empty">{t('No saved photos yet.','هنوز عکسی ذخیره نشده است.')}</p>}
   <p className="library-note">{t('Deleting a photo affects future use; messages already published in Telegram keep their photos.','حذف عکس روی استفاده‌های بعدی اثر دارد؛ عکس پیام‌های قبلاً منتشرشده در تلگرام باقی می‌ماند.')}</p>
  </>}
  {data&&tab==='links'&&<>
   <div className="library-link-form"><label className="field-label">{t('Link name','نام لینک')}<input maxLength={80} value={name} onChange={event=>setName(event.target.value)} placeholder={t('Website or product page','سایت یا صفحه محصول')}/></label><label className="field-label">{t('Link URL','آدرس لینک')}<input type="url" dir="ltr" maxLength={2048} value={url} onChange={event=>setUrl(event.target.value)} placeholder="https://example.com"/></label><button className="button primary" disabled={busy||!name.trim()||!url.trim()||data.links.length>=data.link_limit} onClick={async()=>{if(await change('add-link',{name,url})){setName('');setUrl('');}}}><Plus size={16}/>{t('Save link','ذخیره لینک')}</button></div>
   {data.links.length>=data.link_limit&&<p className="muted">{t('Link library full. Delete a link to add another.','فهرست لینک‌ها پر است؛ برای افزودن لینک جدید، یکی را حذف کنید.')}</p>}
   <div className="saved-link-list">{data.links.map(link=><article className="saved-link" key={link.id}><Link2 size={18}/><div><strong>{link.name}</strong><span dir="ltr">{link.url}</span></div><button className="button subtle" onClick={()=>onLink(link)}>{t('Insert link','افزودن لینک به پیام')}</button><button className="icon-button danger-text" disabled={busy} aria-label={t('Delete link: ','حذف لینک: ')+link.name} onClick={()=>change('delete-link',{id:link.id})}><Trash2 size={17}/></button></article>)}</div>
   {!data.links.length&&<p className="library-empty">{t('No saved links yet.','هنوز لینکی ذخیره نشده است.')}</p>}
  </>}
 </section>;
}
