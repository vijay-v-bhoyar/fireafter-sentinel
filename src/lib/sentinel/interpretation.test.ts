import {beforeEach,afterEach,describe,it,expect,vi} from 'vitest';
import {prepareDocumentVersion} from './evidence';
import {extractionPrompt,extractClaims,comparisonPrompt,extractChanges,executionId,citationPassages} from './interpretation';
import notice from './tokenizer-data/retained-notice.json';
import {PINNED_NEMOTRON_MODEL} from './prompt-tokens';
const id=(n:number)=>`75000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const source={scope:{organizationId:id(1),incidentId:id(2),mode:'live'},documentId:id(3),sourceConfigRevision:id(4),issuer:'Synthetic county',jurisdiction:'Fixture',canonicalUrl:'https://example.gov/notice',rawText:'Résumé. Canyon Road is closed.',publishedAt:null,effectiveFrom:null,effectiveUntil:null,availability:'available',contentPermission:'full_text'};
const v=prepareDocumentVersion(source,{id:id(5),retrievedAt:'2026-10-12T08:00:00Z'}).version;
const output={claims:[{excerpt:'Canyon Road is closed.',kind:'road_status',claimText:'Canyon Road is closed.',entityMentions:['Canyon Road']}]};
beforeEach(()=>vi.stubEnv('SENTINEL_TOKENIZER_EVIDENCE_HASH','a'.repeat(64)));afterEach(()=>vi.unstubAllEnvs());
describe('source-local machine drafts, never semantic/human approval',()=>{
 it('preserves the complete source in bounded numbered passages without asking the model to rewrite quotations',()=>{
  vi.stubEnv('SENTINEL_NEMOTRON_EXTRACTION_MODEL',PINNED_NEMOTRON_MODEL);
  const rawText='Résumé 🔥\n'+('é'.repeat(3000))+'\nFor instance, it is vital to know the exact source.';
  const version=prepareDocumentVersion({...source,rawText},{id:id(40),retrievedAt:v.retrievedAt}).version;
  const passages=citationPassages(version.normalizedText!);expect(passages.map(p=>p.excerpt).join('')).toBe(version.normalizedText);
  for(const p of passages){expect(Buffer.byteLength(p.excerpt)).toBeLessThanOrEqual(2000);expect(p.excerpt.isWellFormed()).toBe(true);expect(Buffer.from(version.normalizedText!).subarray(p.excerptStart,p.excerptEnd).toString()).toBe(p.excerpt);}
  const data=JSON.parse(extractionPrompt(version).messages[1].content);expect(data.passages.map((p:{text:string})=>p.text).join('')).toBe(version.normalizedText);expect(data).not.toHaveProperty('text');
 });
 it('resolves a model passage reference to original case and UTF-8 bytes while rejecting the observed capitalized free quote',()=>{
  const rawText='Résumé.\nFor instance, it is vital to know what to do if you are driving and hit a flooded road.';
  const version=prepareDocumentVersion({...source,rawText},{id:id(41),retrievedAt:v.retrievedAt}).version;
  const c=extractClaims({claims:[{passageId:1,kind:'general_notice',claimText:'The source discusses flooded-road safety.',entityMentions:[]}]},version,[],id(6),'fixture')[0];
  expect(c.excerpt).toBe(rawText.split('\n')[1]);expect(c.excerptStart).toBe(Buffer.byteLength('Résumé.\n'));expect(Buffer.from(rawText).subarray(c.excerptStart,c.excerptEnd).toString()).toBe(c.excerpt);
  expect(()=>extractClaims({claims:[{excerpt:'It is vital to know what to do if you are driving and hit a flooded road.',kind:'general_notice',claimText:'Safety',entityMentions:[]}]},version,[],id(6),'fixture')).toThrow('CITATION_AMBIGUOUS');
 });
 it('uses explicit passage positions to disambiguate repeated source text without guessing offsets',()=>{
  const version=prepareDocumentVersion({...source,rawText:'Same Road closed.\nSame Road closed.'},{id:id(42),retrievedAt:v.retrievedAt}).version;
  const c=extractClaims({claims:[{passageId:1,kind:'road_status',claimText:'Same Road closed.',entityMentions:[]}]},version,[],id(6),'fixture')[0];expect(c.excerptStart).toBe(Buffer.byteLength('Same Road closed.\n'));
 });
 it.each([-1,0.5,99999])('rejects an invalid passage reference %s without substituting another quote',passageId=>{
  expect(()=>extractClaims({claims:[{passageId,kind:'general_notice',claimText:'Unverified',entityMentions:[]}]},v,[],id(6),'fixture')).toThrow();
 });
 it('computes exact UTF-8 offsets and locally matches one public candidate without including its ID in inference',()=>{const prompt=extractionPrompt(v);expect(JSON.stringify(prompt)).not.toContain(id(8));const c=extractClaims(output,v,[{id:id(8),name:'Canyon Road'}],id(6),'nvidia/Nemotron-fixture')[0];expect(c.excerptStart).toBe(Buffer.byteLength('Résumé. '));expect(c.entityIds).toEqual([id(8)]);expect(c.excerptEnd-c.excerptStart).toBe(Buffer.byteLength(c.excerpt));});
 it('does not guess which identically named asset is intended',()=>{expect(extractClaims(output,v,[{id:id(8),name:'Canyon Road'},{id:id(9),name:'Canyon Road'}],id(6),'nvidia/Nemotron-fixture')[0].entityIds).toEqual([]);});
 it.each([{claims:[{...output.claims[0],excerpt:'Made up'}]},{claims:[{...output.claims[0],entityMentions:['Private Facility']}]},{claims:[{...output.claims[0],entityIds:[id(9)]}]}])('rejects fabricated quotes, uncited mentions and supplied internal authority %j',bad=>{expect(()=>extractClaims(bad,v,[],id(6),'fixture')).toThrow();});
 it('rejects duplicate quote occurrences instead of inventing byte offsets',()=>{const repeated=prepareDocumentVersion({...source,rawText:'Canyon Road is closed. Canyon Road is closed.'},{id:id(7),retrievedAt:v.retrievedAt}).version;expect(()=>extractClaims(output,repeated,[],id(6),'fixture')).toThrow('CITATION_AMBIGUOUS');});
 it('stops unsupported model context without truncating source text',()=>{const large=prepareDocumentVersion({...source,rawText:'x'.repeat(10000)},{id:id(7),retrievedAt:v.retrievedAt}).version;expect(()=>extractionPrompt(large)).toThrow('MODEL_CONTEXT_UNSUPPORTED');expect(large.normalizedBytes).toBe(10000);});
 it('does not expose candidate IDs or feedback fields in comparison prompts',()=>{const claims=extractClaims(output,v,[{id:id(8),name:'Canyon Road'}],id(6),'fixture'),pairs=[{markerId:id(10),current:v,previous:null,claims}];const p=comparisonPrompt(pairs);expect(JSON.stringify(p)).not.toContain(id(8));expect(JSON.stringify(p)).not.toContain(id(10));const changes=extractChanges({changes:[{index:0,category:'addition',materiality:'material',claimIndexes:[0],explanation:'Synthetic source addition.'}]},pairs,id(6),'fixture');expect(changes[0].claimIds).toEqual([claims[0].id]);expect(changes[0]).not.toHaveProperty('approved');});
 it('rejects the observed real-model combined category and incompatible materiality',()=>{
  const pairs=[{markerId:id(10),current:v,previous:null,claims:extractClaims(output,v,[],id(6),'fixture')}];
  for(const category of ['addition|benign','addition'])expect(()=>extractChanges({changes:[{index:0,category,materiality:'benign',claimIndexes:[0],explanation:'added notice text'}]},pairs,id(6),'fixture')).toThrow();
 });
 it('requires complete unique comparison coverage and valid cited indices',()=>{const pairs=[{markerId:id(10),current:v,previous:null,claims:extractClaims(output,v,[],id(6),'fixture')}];expect(()=>extractChanges({changes:[]},pairs,id(6),'fixture')).toThrow();expect(()=>extractChanges({changes:[{index:0,category:'addition',materiality:'material',claimIndexes:[4],explanation:'Synthetic.'}]},pairs,id(6),'fixture')).toThrow();});
 it('does not treat a new issuer as a benign revision',()=>{const pairs=[{markerId:id(10),current:v,previous:{...v,issuer:'Another issuer'},claims:extractClaims(output,v,[],id(6),'fixture')}];expect(()=>extractChanges({changes:[{index:0,category:'benign',materiality:'benign',claimIndexes:[0],explanation:'Synthetic.'}]},pairs,id(6),'fixture')).toThrow();});
 it('keeps distinct immutable operation identities across runs and stages',()=>{expect(executionId(id(6),'extract')).toBe(executionId(id(6),'extract'));expect(executionId(id(6),'extract')).not.toBe(executionId(id(6),'claims'));expect(executionId(id(6),'extract')).not.toBe(executionId(id(7),'extract'));});
 it('admits both complete retained2614-byte notice versions at the unchanged token cap',()=>{
  vi.stubEnv('SENTINEL_NEMOTRON_EXTRACTION_MODEL',PINNED_NEMOTRON_MODEL);vi.stubEnv('SENTINEL_NEMOTRON_RECONCILIATION_MODEL',PINNED_NEMOTRON_MODEL);
  const retained=prepareDocumentVersion({...source,rawText:notice.text,canonicalUrl:notice.url},{id:id(11),retrievedAt:v.retrievedAt}).version;
  expect(Buffer.byteLength(notice.text)).toBe(2614);const prompt=comparisonPrompt([{markerId:id(10),current:retained,previous:retained,claims:[]}]);
  const pair=JSON.parse(prompt.messages[1].content)[0];expect(pair.current.text).toBe(retained.normalizedText);expect(pair.previous.text).toBe(retained.normalizedText);expect(prompt.inputTokens).toBeLessThanOrEqual(24000);
 });
 it.each(['start','end'] as const)('preserves a changed passage at the %s of a realistic notice without citation drift',position=>{
  vi.stubEnv('SENTINEL_NEMOTRON_RECONCILIATION_MODEL',PINNED_NEMOTRON_MODEL);
  const quote='Café Road 🔥 is closed.',rawText=position==='start'?quote+'\n'+notice.text:notice.text+'\n'+quote;
  const current=prepareDocumentVersion({...source,rawText},{id:id(12),retrievedAt:v.retrievedAt}).version,previous=prepareDocumentVersion({...source,rawText:notice.text},{id:id(11),retrievedAt:v.retrievedAt}).version;
  const claims=extractClaims({claims:[{excerpt:quote,kind:'road_status',claimText:quote,entityMentions:[]}]},current,[],id(6),'fixture');
  const prompt=comparisonPrompt([{markerId:id(10),current,previous,claims}]),pair=JSON.parse(prompt.messages[1].content)[0];
  expect(pair.current.text).toBe(current.normalizedText);expect(pair.previous.text).toBe(previous.normalizedText);expect(Buffer.from(current.normalizedText!).subarray(claims[0].excerptStart,claims[0].excerptEnd).toString()).toBe(quote);expect(prompt.inputTokens).toBeLessThanOrEqual(24000);
 });
 it('retains all five source pairs and repeated passages instead of dropping uncovered sources',()=>{
  vi.stubEnv('SENTINEL_NEMOTRON_RECONCILIATION_MODEL',PINNED_NEMOTRON_MODEL);
  const retained=prepareDocumentVersion({...source,rawText:notice.text},{id:id(11),retrievedAt:v.retrievedAt}).version;
  const pairs=Array.from({length:5},(_,n)=>({markerId:id(20+n),current:retained,previous:retained,claims:[]}));const prompt=comparisonPrompt(pairs),data=JSON.parse(prompt.messages[1].content);
  expect(data).toHaveLength(5);for(const pair of data){expect(pair.current.text).toBe(retained.normalizedText);expect(pair.previous.text).toBe(retained.normalizedText);}expect(prompt.inputTokens).toBeLessThanOrEqual(24000);
 });
 it('still rejects a genuinely oversized tokenized prompt and retains the full original document',()=>{
  vi.stubEnv('SENTINEL_NEMOTRON_EXTRACTION_MODEL',PINNED_NEMOTRON_MODEL);
  const rawText=Array.from({length:16000},(_,i)=>i.toString(36)+';').join(''),large=prepareDocumentVersion({...source,rawText},{id:id(11),retrievedAt:v.retrievedAt}).version;
  expect(()=>extractionPrompt(large)).toThrow('MODEL_CONTEXT_UNSUPPORTED');expect(large.normalizedText).toBe(rawText);expect(large.normalizedBytes).toBe(Buffer.byteLength(rawText));
 });
 it('counts comparison against its configured reconciliation model independently of extraction',()=>{
  vi.stubEnv('SENTINEL_NEMOTRON_EXTRACTION_MODEL','nvidia/Nemotron-fixture');vi.stubEnv('SENTINEL_NEMOTRON_RECONCILIATION_MODEL',PINNED_NEMOTRON_MODEL);
  const retained=prepareDocumentVersion({...source,rawText:notice.text},{id:id(11),retrievedAt:v.retrievedAt}).version;expect(extractionPrompt(retained).inputTokens).toBeGreaterThan(10000);expect(comparisonPrompt([{markerId:id(10),current:retained,previous:retained,claims:[]}]).inputTokens).toBeLessThan(4000);
 });
});
