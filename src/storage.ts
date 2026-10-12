export function readStore<T>(key:string,fallback:T):T {
 try {
  const value=JSON.parse(localStorage.getItem(key)||'null');
  if(value===null||typeof value!==typeof fallback||Array.isArray(value)!==Array.isArray(fallback))return fallback;
  return value;
 }catch{return fallback;}
}

export function writeStore(key:string,value:unknown):boolean {
 try{localStorage.setItem(key,JSON.stringify(value));return true;}catch{return false;}
}

export function removeStore(key:string):boolean {
 try{localStorage.removeItem(key);return true;}catch{return false;}
}

export const workspaceKey=(scope:string,key:string)=>`tr-workspace:${scope}:${key}`;

export function clearWorkspace(scope:string):boolean {
 try{for(const key of Object.keys(localStorage))if(key.startsWith(`tr-workspace:${scope}:`))localStorage.removeItem(key);return true;}catch{return false;}
}
