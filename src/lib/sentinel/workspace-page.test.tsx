import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
const {user,incident,workspace}=vi.hoisted(()=>({user:vi.fn(),incident:vi.fn(),workspace:vi.fn()}));
vi.mock('@/lib/auth',()=>({getCurrentUser:user}));
vi.mock('@/lib/fireafter-supabase',()=>({getIncidentAuthorizationContext:incident}));
vi.mock('@/components/sentinel/sentinel-workspace',()=>({SentinelWorkspace:(props:unknown)=>{workspace(props);return <p>Scoped reviewer workspace</p>;}}));
import Page from '@/app/sentinel/page';
const id=(n:number)=>`10000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
async function html(query:Record<string,string|string[]|undefined>){return renderToStaticMarkup(await Page({searchParams:Promise.resolve(query)}));}
beforeEach(()=>{user.mockReset();incident.mockReset();workspace.mockClear();user.mockResolvedValue({id:id(1),organizationId:id(2),role:'analyst'});incident.mockResolvedValue({databaseIncidentId:id(3),domainIncidentId:'demo-incident',organizationId:id(2)});});
describe('Sentinel server page admission',()=>{
 it('renders only a canonical database scope after current membership is matched',async()=>{expect(await html({incidentId:'demo-incident',mode:'synthetic',view:'plan'})).toContain('Scoped reviewer workspace');expect(workspace).toHaveBeenCalledWith(expect.objectContaining({incidentId:id(3),mode:'synthetic',view:'plan',identity:{id:id(1),organizationId:id(2),role:'analyst'}}));});
 it('does not resolve an incident or display private data before sign-in',async()=>{user.mockResolvedValue(null);expect(await html({incidentId:id(3)})).toContain('Sign in to review evidence');expect(incident).not.toHaveBeenCalled();expect(workspace).not.toHaveBeenCalled();});
 it('does not reveal the other organization incident label or construct a workspace',async()=>{incident.mockResolvedValue({databaseIncidentId:id(3),domainIncidentId:'private-label',organizationId:id(4)});const result=await html({incidentId:id(3)});expect(result).toContain('Incident unavailable');expect(result).not.toContain('private-label');expect(workspace).not.toHaveBeenCalled();});
 it('keeps missing incident and unavailable identity explicit',async()=>{expect(await html({})).toContain('Open an incident');expect(user).not.toHaveBeenCalled();user.mockResolvedValue({id:id(1),organizationId:null,role:null});expect(await html({incidentId:id(3)})).toContain('Workspace access unavailable');});
 it.each([{incidentId:['one','two']},{incidentId:id(3),mode:['live','synthetic']},{incidentId:id(3),view:'unsupported'},{incidentId:id(3),revision:'invalid'},{incidentId:id(3),extra:'1'}])('rejects ambiguous route parameters before lookup %j',async query=>{expect(await html(query)).toContain('Workspace request invalid');expect(user).not.toHaveBeenCalled();expect(workspace).not.toHaveBeenCalled();});
 it('renders an unavailable incident on storage failure without inventing another scope',async()=>{incident.mockRejectedValue(Error('offline'));expect(await html({incidentId:id(3)})).toContain('Incident unavailable');expect(workspace).not.toHaveBeenCalled();});
});
