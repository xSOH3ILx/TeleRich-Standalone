import { useEffect, useRef, useState } from 'react';
import type { LibraryApi } from './Library';

export function useLibraryPhotos(source:string,scope:string|null,connected:boolean,api:LibraryApi,refresh?:unknown){
 const [photos,setPhotos]=useState<Record<string,string>>({});
 const cache=useRef({urls:{} as Record<string,string>,pending:new Set<string>(),wanted:new Set<string>()}),request=useRef(api);request.current=api;
 useEffect(()=>{const current={urls:{} as Record<string,string>,pending:new Set<string>(),wanted:new Set<string>()};cache.current=current;setPhotos({});return()=>{if(cache.current===current)cache.current={urls:{},pending:new Set(),wanted:new Set()};for(const url of Object.values(current.urls))URL.revokeObjectURL(url);};},[scope,connected]);
 useEffect(()=>{
  if(!scope||!connected)return;const current=cache.current;
  current.wanted=new Set(source.match(/tg:\/\/photo\?id=library_[0-9a-f-]{36}/g)||[]);
  let removed=false;for(const [reference,url] of Object.entries(current.urls))if(!current.wanted.has(reference)){URL.revokeObjectURL(url);delete current.urls[reference];removed=true;}if(removed)setPhotos({...current.urls});
  for(const reference of current.wanted){
   if(current.urls[reference]||current.pending.has(reference))continue;
   current.pending.add(reference);
   request.current('library/photo',{id:reference.slice('tg://photo?id=library_'.length)},true).then(blob=>{
    if(cache.current!==current||!current.wanted.has(reference))return;const url=URL.createObjectURL(blob);current.urls[reference]=url;setPhotos(previous=>({...previous,[reference]:url}));
   }).catch(()=>{}).finally(()=>current.pending.delete(reference));
  }
 },[source,scope,connected,refresh]);
 return photos;
}
