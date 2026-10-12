import { marked } from 'marked';

const escape = (value:string) => value.replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

export function markdownToHtml(source:string):string {
 const notes:Record<string,string>={};
 // Keep literal code out of the rich-text replacements.
 const literals:string[]=[];
 let prefix='TELERICHCODE';while(source.includes(prefix))prefix+='X';
 let html=source.replace(/```[\s\S]*?```|`[^`\n]*`/g,value=>{literals.push(value);return `${prefix}${literals.length-1}PLACEHOLDER`;});
 html=html.replace(/^\[\^([^\]]+)\]:\s*(.+)$/gm,(_,id,text)=>{notes[id]=text;return '';});
 html=html.replace(/\[\^([^\]]+)\]/g,(_,id)=>`<sup><a href="#note-${escape(id)}">${escape(id)}</a></sup>`);
 html=html.replace(/\$\$([\s\S]+?)\$\$/g,'<tg-math-block>$1</tg-math-block>').replace(/(?<!\$)\$([^\s$][^$\n]*?)\$(?!\$)/g,'<tg-math>$1</tg-math>');
 html=html.replace(/==([^=\n]+)==/g,'<mark>$1</mark>').replace(/\|\|([^|]+)\|\|/g,'<tg-spoiler>$1</tg-spoiler>');
 const restore=(text:string)=>text.replace(new RegExp(prefix+'(\\d+)PLACEHOLDER','g'),(_,index)=>literals[Number(index)]);
 html=restore(html);
 html=marked.parse(html,{async:false,gfm:true,breaks:true}) as string;
 return html+Object.entries(notes).map(([id,text])=>`<footer id="note-${escape(id)}"><sup>${escape(id)}</sup> ${marked.parseInline(restore(text),{async:false})}</footer>`).join('');
}
