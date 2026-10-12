import React, { useMemo, useState, useEffect } from 'react';
import { markdownToHtml } from './markdown';
import katex from 'katex';
import { ChevronLeft, ChevronRight, Image, ExternalLink, FileText, Copy } from 'lucide-react';
import 'katex/dist/katex.min.css';

export function safeUrl(value: string, media = false) {
 if(!media)return /^(https?:\/\/|tg:\/\/|mailto:|tel:|#)/i.test(value)?value:'';
 try{const url=new URL(value),host=url.hostname.toLowerCase();return url.protocol==='https:'&&!url.username&&!url.password&&!/^(localhost|0\.|10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[|.*\.local$|.*\.localhost$)/.test(host)?url.href:'';}catch{return '';}
}
const RTL_CHAR = /[\u0591-\u07FF\u200F\u202B\u202E\uFB1D-\uFDFD\uFE70-\uFEFC]/;
const LTR_CHAR = /[A-Za-z\u00C0-\u02FF\u0370-\u04FF]/;
// "First strong character" direction detection: strip tags/entities, then find the
// first character that is unambiguously RTL (Persian/Arabic/Hebrew) or LTR (Latin etc.)
export function detectRtl(source: string): boolean {
 const text=source.replace(/<[^>]*>/g,' ').replace(/&[a-zA-Z#0-9]+;/g,' ');
 for(const ch of text){ if(RTL_CHAR.test(ch)) return true; if(LTR_CHAR.test(ch)) return false; }
 return false;
}
function Spoiler({children}:{children:React.ReactNode}) { const [open,setOpen]=useState(false); return <button className={'spoiler '+(open?'revealed':'')} onClick={()=>setOpen(!open)} title="Click to reveal">{children}</button>; }
function MediaImage({src,alt}:{src:string;alt:string}) {const [error,setError]=useState(false);useEffect(()=>setError(false),[src]);return !error&&src&&!src.includes('telegram.org/example/')?<img src={src} alt={alt||'Message image'} loading="lazy" referrerPolicy="no-referrer" onError={()=>setError(true)}/>:<div className="media-placeholder"><Image size={28}/><span>{alt||'Your image goes here'}</span><small>External media is hidden until you enable it.</small></div>;}
function Slides({items,caption}:{items:React.ReactNode[];caption:React.ReactNode}) {const [active,setActive]=useState(0);return <div className="slideshow">{items[active]}<div className="slide-navigation"><button onClick={()=>setActive((active-1+items.length)%items.length)} aria-label="Previous slide"><ChevronLeft size={15}/></button><span>{active+1} / {items.length}</span><button onClick={()=>setActive((active+1)%items.length)} aria-label="Next slide"><ChevronRight size={15}/></button></div>{caption}</div>;}
function MathText({text,block}:{text:string;block:boolean}){let result='';try{result=katex.renderToString(text,{throwOnError:false,displayMode:block,trust:false,strict:false});}catch{return <code>{text}</code>;}return <span className={block?'math-block':'math-inline'} dangerouslySetInnerHTML={{__html:result}}/>;}
export function RichPreview({source,mode='markdown',onAction=()=>{},rtl='auto'}:{source:string;mode?:string;onAction?:(message:string)=>void;rtl?:'auto'|'ltr'|'rtl'}) {
 const [loadMedia,setLoadMedia]=useState(false);
 const detectedRtl=useMemo(()=>detectRtl(source),[source]);
 const isRtl=rtl==='auto'?detectedRtl:rtl==='rtl';
 const nodes=useMemo(()=>{
  let html=source;
  if(mode==='blocks'){try{const blocks=JSON.parse(source);html=(Array.isArray(blocks)?blocks:blocks.blocks||[]).map((b:any)=>b.text?.text||b.text||'').join('\n\n');}catch{html='Invalid block JSON';}}
  if(mode!=='html') html=markdownToHtml(html);
  html=html.replace(/<(tg-map|tg-emoji|video|audio)([^>]*?)\s*\/>/g,'<$1$2></$1>');
  const template=document.createElement('template');template.innerHTML=html;
  return Array.from(template.content.childNodes);
 },[source,mode]);
 const render=(node:Node,key:number|string):React.ReactNode=>{
  if(node.nodeType===3) return node.textContent;
  if(node.nodeType!==1)return null;
  const el=node as Element,tag=el.tagName.toLowerCase(), attr=(a:string)=>el.getAttribute(a)||'';
  const children=Array.from(el.childNodes).map((n,i)=>render(n,i));
  if(['script','style','iframe','object','embed','form','svg','link','meta'].includes(tag))return null;
  if(tag==='tg-spoiler')return <Spoiler key={key}>{children}</Spoiler>;
  if(tag==='tg-math'||tag==='tg-math-block')return <MathText key={key} text={el.textContent||''} block={tag==='tg-math-block'}/>;
  if(tag==='tg-time')return <time key={key} className="rich-time" title={new Date(Number(attr('unix'))*1000).toLocaleString()}>{attr('unix')?new Date(Number(attr('unix'))*1000).toLocaleString(undefined,{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}):children}</time>;
  if(tag==='tg-emoji')return <span key={key} title={'Custom emoji: '+attr('emoji-id')}>{children}</span>;
  if(tag==='tg-thinking')return <div key={key} className="thinking"><i/>{children}</div>;
  if(tag==='tg-button-row')return <div key={key} className={'rich-button-row align-'+(attr('align')||'left')}>{children}</div>;
  if(tag==='tg-button') {const type=attr('type'),style=attr('style');return <button key={key} className={'rich-button style-'+style} disabled={type==='disabled'} onClick={()=>{if(type==='copy_text')navigator.clipboard.writeText(attr('text')).then(()=>onAction('Text copied to clipboard')).catch(()=>onAction('Clipboard access unavailable'));else if(type==='url'&&safeUrl(attr('url')))window.open(safeUrl(attr('url')),'_blank','noopener,noreferrer');else onAction(type==='callback_data'?'Preview callback: '+attr('data'):'This '+type+' action runs inside Telegram.');}}>{children}{type==='url'?<ExternalLink size={12}/>:type==='copy_text'?<Copy size={12}/>:null}</button>;}
  if(tag==='tg-map'){const lat=Number(attr('lat')),lon=Number(attr('long'));if(!Number.isFinite(lat)||!Number.isFinite(lon)||Math.abs(lat)>90||Math.abs(lon)>180)return <p key={key}>Invalid map coordinates</p>;return <div key={key} className="rich-map">{loadMedia&&<iframe title="Location preview" loading="lazy" sandbox="allow-scripts" referrerPolicy="no-referrer" src={`https://www.openstreetmap.org/export/embed.html?bbox=${lon-.015},${lat-.012},${lon+.015},${lat+.012}&layer=mapnik&marker=${lat},${lon}`}/>}<small>📍 {lat}, {lon} · Zoom {attr('zoom')||14}</small></div>;}
  if(tag==='tg-collage')return <div key={key} className="rich-collage">{children}</div>;
  if(tag==='tg-slideshow'){const items=Array.from(el.children).filter(x=>x.tagName!=='FIGCAPTION').map((n,i)=>render(n,i));return items.length?<Slides key={key} items={items} caption={Array.from(el.children).filter(x=>x.tagName==='FIGCAPTION').map((n,i)=>render(n,i))}/>:null;}
  if(tag==='img'){const src=loadMedia?safeUrl(attr('src'),true):'';if(/\.(mp4|webm)(\?|$)/i.test(src))return <video key={key} src={src} controls preload="none"/>;if(/\.(ogg|mp3|wav)(\?|$)/i.test(src))return <audio key={key} src={src} controls preload="none"/>;return <MediaImage key={key} src={src} alt={attr('alt')}/>;}
  if(tag==='video'||tag==='audio')return React.createElement(tag,{key,src:loadMedia?safeUrl(attr('src'),true)||undefined:undefined,controls:true,preload:'none'},children);
  if(tag==='a'){const href=safeUrl(attr('href'));if(href.startsWith('tg://document'))return <a key={key} className="document-link" href={href}><FileText size={19}/>{children}</a>;return <a key={key} href={href||undefined} id={attr('name')||attr('id')||undefined} target={href.startsWith('#')?undefined:'_blank'} rel="noopener noreferrer">{children}</a>;}
  if(tag==='blockquote'&&el.hasAttribute('expandable'))return <details key={key} className="expandable-quote"><summary>Expandable quotation</summary><blockquote>{children}</blockquote></details>;
  if(tag==='input')return attr('type')==='checkbox'?<input key={key} type="checkbox" defaultChecked={el.hasAttribute('checked')}/>:null;
  const allowed=['p','b','strong','em','i','u','ins','s','del','mark','sub','sup','h1','h2','h3','h4','h5','h6','br','hr','pre','code','blockquote','aside','cite','details','summary','table','caption','thead','tbody','tr','th','td','ul','ol','li','footer','figcaption','span','div'];
  if(!allowed.includes(tag))return <React.Fragment key={key}>{children}</React.Fragment>;
  const props:Record<string,any>={key};if(attr('id'))props.id=attr('id');
  if(tag==='details')props.open=el.hasAttribute('open');
  if(tag==='table')props.className=[el.hasAttribute('bordered')?'bordered':'',el.hasAttribute('striped')?'striped':'',el.hasAttribute('compact')?'compact':''].join(' ');
  if(tag==='td'||tag==='th'){if(attr('colspan'))props.colSpan=Math.min(20,Number(attr('colspan')));if(attr('rowspan'))props.rowSpan=Math.min(30,Number(attr('rowspan')));props.style={textAlign:['left','center','right'].includes(attr('align'))?attr('align'):undefined,verticalAlign:['top','middle','bottom'].includes(attr('valign'))?attr('valign'):undefined};}
  return React.createElement(tag,props,['br','hr'].includes(tag)?undefined:children);
 };
 return <div className="rich-content" dir={isRtl?'rtl':'ltr'}>{/(<(img|video|audio|tg-map)\b|!\[)/i.test(source)&&<button className="text-button" onClick={()=>setLoadMedia(!loadMedia)}>{document.documentElement.lang==='fa'?(loadMedia?'پنهان کردن رسانه‌های بیرونی':'نمایش رسانه‌های بیرونی'):(loadMedia?'Hide external media':'Load external media')}</button>}{nodes.map((n,i)=>render(n,i))}</div>;
}
