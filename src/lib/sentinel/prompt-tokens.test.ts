import {afterEach,describe,expect,it,vi} from 'vitest';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {Tokenizer} from '@huggingface/tokenizers';
import vectors from './tokenizer-data/reference-vectors-no-thinking.json';
import {PINNED_NEMOTRON_MODEL,PROMPT_TOKEN_RESERVE,renderNemotronPrompt,reservedPromptInputTokens} from './prompt-tokens';
const sha=(text:string)=>createHash('sha256').update(text).digest('hex');
type Messages=Parameters<typeof renderNemotronPrompt>[0];
afterEach(()=>{vi.doUnmock('node:fs');vi.resetModules();});
describe('pinned model tokenizer qualification, offline independent Rust/Jinja reference',()=>{
 const dir='src/lib/sentinel/tokenizer-data/';
 const tokenizer=new Tokenizer(JSON.parse(readFileSync(dir+'tokenizer.json','utf8')),JSON.parse(readFileSync(dir+'tokenizer_config.json','utf8')));
 it.each(vectors.vectors)('matches independent template and complete token IDs: $name',v=>{
  const messages=v.messages as Messages,rendered=renderNemotronPrompt(messages),encoded=tokenizer.encode(rendered,{add_special_tokens:false});
  expect(sha(rendered)).toBe(v.renderedSha256);expect(sha(JSON.stringify(encoded.ids))).toBe(v.tokenIdsSha256);
  expect(reservedPromptInputTokens(messages,PINNED_NEMOTRON_MODEL)).toBe(v.tokens+PROMPT_TOKEN_RESERVE);
 });
 it('keeps unknown model IDs on the original conservative reservation',()=>{const messages:Messages=[{role:'system',content:'System'},{role:'user',content:'Café 🔥'}];expect(reservedPromptInputTokens(messages,'nvidia/Nemotron-unknown')).toBe(Buffer.byteLength(JSON.stringify(messages))*4+512);});
 it('refuses tools, assistant history, malformed Unicode and unsupported message shapes',()=>{
  for(const messages of [[],[{role:'user',content:'wrong first role'},{role:'user',content:'x'}],[{role:'system',content:'s'},{role:'assistant',content:'unqualified history'}],[{role:'system',content:'s'},{role:'user',content:'\ud800'}],[{role:'system',content:'s'},{role:'user',content:'x'.repeat(200001)}]])expect(()=>renderNemotronPrompt(messages as Messages)).toThrow('PROMPT_INPUT_INVALID');
 });
 it('fails closed if the pinned data is tampered rather than silently using another tokenizer',async()=>{
  vi.doMock('node:fs',()=>({readFileSync:()=>Buffer.from('{}')}));
  const fresh=await import('./prompt-tokens');expect(()=>fresh.reservedPromptInputTokens([{role:'system',content:'s'},{role:'user',content:'u'}],PINNED_NEMOTRON_MODEL)).toThrow('TOKENIZER_INTEGRITY_INVALID');
 });
});
