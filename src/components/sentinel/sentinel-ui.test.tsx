// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { webcrypto } from 'node:crypto';
import { ReadableStream } from 'node:stream/web';
import { TextDecoder, TextEncoder } from 'node:util';
import { useSentinelCommand, CommandRecovery, parseIntent } from './use-sentinel-command';
import { SentinelPlan } from './sentinel-plan';
import { SentinelEvidence } from './sentinel-evidence';
import { SentinelPolicy } from './sentinel-policy';
const id=(n:number)=>`10000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const scope={organizationId:id(1),incidentId:id(2),mode:'synthetic' as const},actor=id(3);
const body={incidentId:scope.incidentId,mode:scope.mode,commandId:id(4),expectedConstraintRevision:null,configuration:{}};
function Harness(){const c=useSentinelCommand(scope,actor,'test');const confirm=(v:unknown)=>{if(!(v as {confirmed?:boolean}).confirmed)throw Error('Receipt not confirmed');};return <><button disabled={c.blocked||c.busy} onClick={()=>void c.execute('/api/sentinel/constraints',body,confirm).catch(()=>{})}>Save command</button><CommandRecovery command={c} onRetry={()=>void c.retry(confirm).catch(()=>{})}/></>;}
beforeEach(()=>{sessionStorage.clear();vi.stubGlobal('crypto',webcrypto);vi.stubGlobal('TextEncoder',TextEncoder);vi.stubGlobal('TextDecoder',TextDecoder);vi.stubGlobal('ReadableStream',ReadableStream);});
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
describe('recoverable reviewer commands',()=>{
 it('retains uncertainty across remount and retries the byte-identical original body',async()=>{const fetch=vi.fn().mockRejectedValueOnce(Error('network lost')).mockResolvedValueOnce(new Response(JSON.stringify({confirmed:true})));vi.stubGlobal('fetch',fetch);const r=render(<Harness/>);fireEvent.click(screen.getByRole('button',{name:'Save command'}));await screen.findByText('Command confirmation pending');expect(screen.getByRole('button',{name:'Save command'})).toHaveProperty('disabled',true);r.unmount();render(<Harness/>);fireEvent.click(screen.getByRole('button',{name:'Retry original saved command'}));await waitFor(()=>expect(fetch).toHaveBeenCalledTimes(2));expect(fetch.mock.calls[0][1].body).toBe(fetch.mock.calls[1][1].body);await waitFor(()=>expect(screen.queryByText('Command confirmation pending')).toBeNull());});
 it('keeps the original identity after an unconfirmed response',async()=>{vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(JSON.stringify({confirmed:false}))));render(<Harness/>);fireEvent.click(screen.getByRole('button',{name:'Save command'}));await screen.findByText('Command confirmation pending');expect(sessionStorage.length).toBe(1);});
 it('clears only a definitive server denial so a refreshed review can proceed',async()=>{const fetch=vi.fn().mockResolvedValue(new Response(JSON.stringify({error:'Changed',code:'CONSTRAINT_CONFLICT'}),{status:409}));vi.stubGlobal('fetch',fetch);render(<Harness/>);fireEvent.click(screen.getByRole('button',{name:'Save command'}));await waitFor(()=>expect(sessionStorage.length).toBe(0));expect(screen.getByRole('button',{name:'Save command'})).toHaveProperty('disabled',false);});
 it('blocks a second synchronous click before React state can update',async()=>{const fetch=vi.fn().mockReturnValue(new Promise(()=>{}));vi.stubGlobal('fetch',fetch);render(<Harness/>);const b=screen.getByRole('button',{name:'Save command'});fireEvent.click(b);fireEvent.click(b);expect(fetch).toHaveBeenCalledTimes(1);});
 it.each([{path:'https://outside.invalid'},{actorId:id(9)},{scope:{...scope,mode:'live'}},{body:{...body,incidentId:id(9)}},{body:{...body,commandId:'bad'}}])('rejects altered saved context %j',different=>{expect(()=>parseIntent(JSON.stringify({actorId:actor,scope,path:'/api/sentinel/constraints',body,...different}),scope,actor)).toThrow();});
});
describe('reviewer role and missingness UI',()=>{
 it.each(['viewer','analyst'] as const)('never exposes terminal decision controls to %s',role=>{render(<SentinelPlan scope={scope} identity={{id:actor,organizationId:scope.organizationId,role}} plan={null} constraints={null} claims={[]} onRefresh={()=>{}} onOpenRevision={()=>{}}/>);expect(screen.queryByRole('button',{name:'Accept reviewed proposal'})).toBeNull();expect(screen.queryByRole('button',{name:'Reject proposal'})).toBeNull();expect(screen.getByText('Author the bounded crew and task inputs before creating a proposal.')).toBeDefined();});
 it('labels missing sources and avoids inventing a successful zero-change check',()=>{render(<SentinelEvidence scope={scope} actorId={actor} canWrite={false} summary={null} changes={null} onRefresh={()=>{}} onClaims={()=>{}}/>);expect(screen.getByText(/Source registry not configured/)).toBeDefined();expect(screen.queryByText(/No changes found/)).toBeNull();});
 it('disables policy mutation for an analyst while retaining its readable fields',()=>{render(<SentinelPolicy scope={scope} identity={{id:actor,organizationId:scope.organizationId,role:'analyst'}} policy={null} summary={null} onRefresh={()=>{}}/>);expect(screen.getByRole('button',{name:'Save coordinator policy'})).toHaveProperty('disabled',true);expect(screen.getByText(/Only a coordinator can change policy/)).toBeDefined();});
});
