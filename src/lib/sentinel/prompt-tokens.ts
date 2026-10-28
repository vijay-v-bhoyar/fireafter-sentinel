import 'server-only';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {Tokenizer} from '@huggingface/tokenizers';

export const PINNED_NEMOTRON_MODEL='nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B';
export const TOKENIZER_REVISION='bf77c3174f68ad409e1c2aa60daeb46e32d1c606';
export const PROMPT_TOKEN_RESERVE=512;
type Message={role:'system'|'user';content:string};
const hashes={
 'tokenizer.json':'c6021eb6847e682f89aa52d5eb6e8c7d902a23acfc8137e25211cf84828f1592',
 'tokenizer_config.json':'3d568e506d0905285ae90a3fdd1482be7b6d0bf0b8ca9514d75dad4257b0827a',
 'chat_template.jinja':'ab7813c3abdd9cb655905a410728b26c7884eca45ddfab8d9f931553485a7862',
} as const;
let tokenizer:Tokenizer|undefined;
function pinnedTokenizer(){
 if(tokenizer)return tokenizer;
 const dir=path.join(process.cwd(),'src/lib/sentinel/tokenizer-data');
 const read=(name:keyof typeof hashes)=>{
  const bytes=readFileSync(path.join(dir,name));
  if(createHash('sha256').update(bytes).digest('hex')!==hashes[name])throw new Error('TOKENIZER_INTEGRITY_INVALID');
  return bytes.toString('utf8');
 };
 const data=read('tokenizer.json'),config=read('tokenizer_config.json');read('chat_template.jinja');
 tokenizer=new Tokenizer(JSON.parse(data),JSON.parse(config));
 return tokenizer;
}
/** Pinned NVIDIA template's system/user-only, enable_thinking=false branch. */
export function renderNemotronPrompt(messages:Message[]){
 if(messages.length<2||messages.length>3||messages[0].role!=='system'||messages.slice(1).some(m=>m.role!=='user')||messages.some(m=>!m.content||m.content.length>200000||!m.content.isWellFormed()))throw new Error('PROMPT_INPUT_INVALID');
 return messages.map(m=>`<|im_start|>${m.role}\n${m.content}<|im_end|>\n`).join('')+'<|im_start|>assistant\n<think></think>';
}
/** Local tokenizer count plus the existing512-token envelope; never a funding attestation. */
export function reservedPromptInputTokens(messages:Message[],model:string|undefined){
 if(model!==PINNED_NEMOTRON_MODEL)return Buffer.byteLength(JSON.stringify(messages),'utf8')*4+PROMPT_TOKEN_RESERVE;
 const rendered=renderNemotronPrompt(messages);
 return pinnedTokenizer().encode(rendered,{add_special_tokens:false}).ids.length+PROMPT_TOKEN_RESERVE;
}
