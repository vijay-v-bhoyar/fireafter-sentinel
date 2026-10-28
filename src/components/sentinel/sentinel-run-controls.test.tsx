// @vitest-environment jsdom
import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import {cleanup,render,fireEvent,screen,waitFor} from '@testing-library/react';
import {webcrypto} from 'node:crypto';
import {ReadableStream} from 'node:stream/web';
import {TextEncoder,TextDecoder} from 'node:util';
import {RunControls,SentinelGettingStarted} from './sentinel-workspace';
import type {EvidenceSummary} from '@/lib/sentinel/workspace-client';
const id=(n:number)=>`79000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const scope={organizationId:id(1),incidentId:id(2),mode:'synthetic' as const},identity={id:id(3),organizationId:id(1),role:'analyst' as const};
vi.mock('next/navigation',()=>({useRouter:()=>({replace:vi.fn()})}));
beforeEach(()=>{sessionStorage.clear();vi.stubGlobal('crypto',webcrypto);vi.stubGlobal('ReadableStream',ReadableStream);vi.stubGlobal('TextEncoder',TextEncoder);vi.stubGlobal('TextDecoder',TextDecoder);});
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
it('explains context capacity failure without offering automatic retry or hiding the original usage',async()=>{
 const createdAt=new Date().toISOString();
 vi.stubGlobal('fetch',vi.fn(async()=>Response.json({id:id(5),dispatchId:id(5),scope,sourceConfigRevision:id(4),createdBy:identity.id,createdAt,deadlineAt:new Date(Date.parse(createdAt)+120000).toISOString(),status:'failed',stage:'model_context_unsupported',fence:5,leaseUntil:null,usage:{tavilyRequests:2,modelRequests:0,inputTokens:0,outputTokens:0}})));
 render(<RunControls scope={scope} identity={identity} summary={{sourceConfigRevision:id(4)} as EvidenceSummary} onRefresh={()=>{}}/>);
 fireEvent.change(screen.getByLabelText('Original run ID'),{target:{value:id(5)}});
 fireEvent.click(screen.getByRole('button',{name:'Read original run status'}));
 await screen.findByText(/The source exceeds the configured model context/);
 expect(screen.getByText(/Reserved: 2 Tavily requests, 0 model requests/)).toBeTruthy();
 expect(screen.getByRole('button',{name:'Cancel original run'})).toHaveProperty('disabled',true);
 expect(sessionStorage.length).toBe(0);
});
it('keeps the confirmed queued run and exact original admission intent until dispatch is confirmed',async()=>{
 let count=0;const requests:string[]=[],createdAt=new Date().toISOString();
 vi.stubGlobal('fetch',vi.fn(async(_url:string,init:RequestInit)=>{
  count++;requests.push(String(init.body));const body=JSON.parse(String(init.body));
  return Response.json({run:{id:id(5),dispatchId:id(5),scope,sourceConfigRevision:id(4),createdBy:identity.id,createdAt,deadlineAt:new Date(Date.parse(createdAt)+120000).toISOString(),status:'queued',stage:'admitted',fence:0,leaseUntil:null,usage:{tavilyRequests:0,modelRequests:0,inputTokens:0,outputTokens:0}},receipt:{runId:id(5),commandId:body.commandId,kind:'admit',status:'queued',at:createdAt},replayed:count>1,dispatchPending:count===1});
 }));
 render(<RunControls scope={scope} identity={identity} summary={{sourceConfigRevision:id(4)} as EvidenceSummary} onRefresh={()=>{}}/>);
 fireEvent.click(screen.getByRole('button',{name:'Queue manual evidence run'}));
 await screen.findByText(/Run is queued. Starting the check is unconfirmed/);
 expect(screen.getByRole('button',{name:'Queue manual evidence run'})).toHaveProperty('disabled',true);expect(sessionStorage.length).toBe(1);
 expect(screen.getByLabelText('Original run ID')).toHaveProperty('value',id(5));
 fireEvent.click(screen.getByRole('button',{name:'Retry original saved command'}));
 await waitFor(()=>expect(sessionStorage.length).toBe(0));expect(requests).toHaveLength(2);expect(requests[1]).toBe(requests[0]);
});

// Guidance must preserve scope and authority without admitting work.
it.each(['viewer','analyst','incident_commander'] as const)('guides %s through scoped first value without network calls',role=>{
 const fetch=vi.fn();vi.stubGlobal('fetch',fetch);
 render(<SentinelGettingStarted scope={scope} role={role}/>);
 expect(screen.getByRole('heading',{name:'Start here for your role'})).toBeTruthy();
 for(const anchor of screen.getAllByRole('link')){
  const url=new URL(anchor.getAttribute('href')!,'http://sentinel.test');
  expect(url.pathname).toBe('/sentinel');expect(url.searchParams.get('incidentId')).toBe(scope.incidentId);expect(url.searchParams.get('mode')).toBe('synthetic');
 }
 expect(screen.getByText(/keep this tab and its original command ID/)).toBeTruthy();
 expect(screen.getByText(/not current field instructions/)).toBeTruthy();
 expect(screen.queryAllByRole('button')).toHaveLength(0);expect(fetch).not.toHaveBeenCalled();
 if(role==='viewer'){
  expect(screen.getByText(/Viewer access cannot approve/)).toBeTruthy();expect(screen.queryByRole('link',{name:'Prepare and review the proposal'})).toBeNull();
 }else if(role==='analyst'){
  expect(screen.getByText(/hand its revision and unresolved limitations to the incident commander/)).toBeTruthy();expect(screen.queryByRole('link',{name:'Review coordinator policy'})).toBeNull();
 }else expect(screen.getByRole('link',{name:'Review coordinator policy'})).toBeTruthy();
});
it.each(['live','replay'] as const)('keeps %s mode in every guidance link',mode=>{
 render(<SentinelGettingStarted scope={{...scope,mode}} role='incident_commander'/>);
 for(const anchor of screen.getAllByRole('link'))expect(new URL(anchor.getAttribute('href')!,'http://sentinel.test').searchParams.get('mode')).toBe(mode);
});
