import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

// Current source only: inherited historical credentials must be revoked by
// their owner; this check must not print secret values into CI logs.
const files=[...new Set(execFileSync('git',['ls-files','-co','--exclude-standard','-z'],{encoding:'utf8'}).split('\0').filter(Boolean))];
const patterns=[/(?<![\w])[0-9]{6,12}:[A-Za-z0-9_-]{30,50}(?![\w])/,/gh[pousr]_[A-Za-z0-9]{30,}/,/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/];
const matches=[];
for(const file of files){try{const text=readFileSync(file,'utf8');if(patterns.some(pattern=>pattern.test(text)))matches.push(file);}catch{ /* Ignore deleted index entries. */ }}
if(matches.length){console.error('Possible committed credentials in: '+matches.join(', '));process.exitCode=1;}
else console.log('No credential patterns detected in current source.');
