import { beforeEach, describe, expect, it, vi } from 'vitest';
const {read}=vi.hoisted(()=>({read:vi.fn()}));
vi.mock('./claims',()=>({readClaimPage:read}));
import { GET } from '@/app/api/sentinel/documents/[id]/claims/route';
const id=(n:number)=>`10000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const scope={organizationId:id(1),incidentId:id(2),mode:'synthetic'};
const url=`http://localhost/api/sentinel/documents/${id(3)}/claims?incidentId=${id(2)}&mode=synthetic`;
const context={params:Promise.resolve({id:id(3)})};
beforeEach(()=>read.mockReset());
describe('member claim-list HTTP binding',()=>{
 it('returns the bounded helper page privately without its internal continuation',async()=>{read.mockResolvedValue({scope,versionId:id(3),items:[{sequence:1}],hasMore:true,nextAfterSequence:1});const r=await GET(new Request(url),context);const value=await r.json();expect(r.status).toBe(200);expect(r.headers.get('cache-control')).toContain('no-store');expect(value.nextAfterSequence).toBeUndefined();expect(value.nextCursor).toBeTypeOf('string');expect(read).toHaveBeenCalledWith(id(2),'synthetic',id(3),0);});
 it('continues using the exact original incident/mode/version binding',async()=>{read.mockResolvedValue({scope,versionId:id(3),items:[],hasMore:false,nextAfterSequence:null});const c=Buffer.from(JSON.stringify({v:1,kind:'claim_page',incidentId:id(2),mode:'synthetic',versionId:id(3),afterSequence:25})).toString('base64url');const r=await GET(new Request(url+'&cursor='+c),context);expect(r.status).toBe(200);expect(read).toHaveBeenCalledWith(id(2),'synthetic',id(3),25);});
 it.each(['&mode=live','&incidentId='+id(4),'&cursor=bad','&unexpected=1','&cursor=','&cursor='+('a'.repeat(257))])('rejects ambiguous or malformed query %s without reading storage',async extra=>{expect((await GET(new Request(url+extra),context)).status).toBe(400);expect(read).not.toHaveBeenCalled();});
 it.each([{versionId:id(4)},{incidentId:id(4)},{mode:'live'},{afterSequence:0}])('rejects a cross-context continuation %j',async different=>{const c=Buffer.from(JSON.stringify({v:1,kind:'claim_page',incidentId:id(2),mode:'synthetic',versionId:id(3),afterSequence:1,...different})).toString('base64url');expect((await GET(new Request(url+'&cursor='+c),context)).status).toBe(400);expect(read).not.toHaveBeenCalled();});
 it('returns unavailable when the scoped helper cannot expose a version',async()=>{read.mockResolvedValue(null);expect((await GET(new Request(url),context)).status).toBe(404);});
 it('rejects malformed immutable version IDs without reading storage',async()=>{expect((await GET(new Request(url),{params:Promise.resolve({id:'other'})})).status).toBe(400);expect(read).not.toHaveBeenCalled();});
});
