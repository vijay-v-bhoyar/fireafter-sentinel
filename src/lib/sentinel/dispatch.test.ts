import {beforeEach,describe,it,expect,vi} from 'vitest';
import type {SentinelRun} from './contracts';
const boundary=vi.hoisted(()=>({state:vi.fn(),claim:vi.fn(),ack:vi.fn(),start:vi.fn(),getRun:vi.fn()}));
vi.mock('./execution-store',()=>({dispatchState:boundary.state,claimDispatch:boundary.claim,acknowledgeDispatch:boundary.ack}));
vi.mock('workflow/api',()=>({start:boundary.start,getRun:boundary.getRun}));
vi.mock('@/workflows/sentinel',()=>({executeSentinel:async()=>{}}));
import {dispatchSentinel} from './dispatch';
const id=(n:number)=>`78000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
let run:SentinelRun;
beforeEach(()=>{
 vi.resetAllMocks();const createdAt=new Date().toISOString();
 run={id:id(1),dispatchId:id(1),scope:{organizationId:id(2),incidentId:id(3),mode:'live'},sourceConfigRevision:id(4),createdBy:id(5),createdAt,deadlineAt:new Date(Date.parse(createdAt)+120000).toISOString(),status:'queued',stage:'admitted',fence:0,leaseUntil:null,usage:{tavilyRequests:0,modelRequests:0,inputTokens:0,outputTokens:0}};
 boundary.state.mockResolvedValue({run,attemptId:null,runtimeRunId:null});boundary.claim.mockResolvedValue({attemptId:id(6),dispatchId:run.id});boundary.start.mockResolvedValue({runId:'wrun_fixture'});boundary.ack.mockResolvedValue(true);
});
describe('logical Sentinel dispatch and original-run reconciliation',()=>{
 it('puts only the opaque original dispatch UUID into scheduler history and retains its separate runtime identity',async()=>{expect(await dispatchSentinel(run)).toEqual({dispatchPending:false});expect(boundary.start.mock.calls[0][1]).toEqual([run.id]);expect(boundary.ack).toHaveBeenCalledExactlyOnceWith(run.id,id(6),'wrun_fixture');});
 it.each(['pending','running'])('recognizes an acknowledged %s scheduler invocation without another start',async status=>{boundary.state.mockResolvedValue({run,attemptId:id(6),runtimeRunId:'wrun_fixture'});boundary.getRun.mockReturnValue({status:Promise.resolve(status)});expect(await dispatchSentinel(run)).toEqual({dispatchPending:false});expect(boundary.start).not.toHaveBeenCalled();expect(boundary.claim).not.toHaveBeenCalled();});
 it('does not infer rollback after an uncertain scheduler response or acknowledgment',async()=>{boundary.start.mockRejectedValue(new Error('Private scheduler credential'));expect(await dispatchSentinel(run)).toEqual({dispatchPending:true});expect(run.status).toBe('queued');boundary.start.mockResolvedValue({runId:'wrun_fixture'});boundary.ack.mockRejectedValue(new Error('Lost acknowledgment'));expect(await dispatchSentinel(run)).toEqual({dispatchPending:true});});
 it('does not create a replacement invocation when existing runtime lookup is uncertain',async()=>{boundary.state.mockResolvedValue({run,attemptId:id(6),runtimeRunId:'wrun_fixture'});boundary.getRun.mockReturnValue({status:Promise.reject(new Error('Runtime unavailable'))});expect(await dispatchSentinel(run)).toEqual({dispatchPending:true});expect(boundary.start).not.toHaveBeenCalled();});
 it('redispatches a known terminal scheduler invocation only after the persisted claim gate admits it',async()=>{boundary.state.mockResolvedValue({run,attemptId:id(6),runtimeRunId:'wrun_old'});boundary.getRun.mockReturnValue({status:Promise.resolve('failed')});await dispatchSentinel(run);expect(boundary.claim.mock.calls[0]).toEqual([run.id,expect.any(String),id(6),true]);expect(boundary.start.mock.calls[0][1]).toEqual([run.id]);});
 it('keeps admission pending on a concurrent/early/over-budget claim and never starts anyway',async()=>{boundary.claim.mockResolvedValue(null);expect(await dispatchSentinel(run)).toEqual({dispatchPending:true});expect(boundary.start).not.toHaveBeenCalled();});
 it('does not dispatch canceled, finished, expired or cross-scope runs',async()=>{boundary.state.mockResolvedValue({run:{...run,status:'canceled'},attemptId:null,runtimeRunId:null});expect(await dispatchSentinel(run)).toEqual({dispatchPending:false});boundary.state.mockResolvedValue({run:{...run,scope:{...run.scope,organizationId:id(99)}},attemptId:null,runtimeRunId:null});expect(await dispatchSentinel(run)).toEqual({dispatchPending:true});boundary.state.mockResolvedValue({run:{...run,deadlineAt:new Date(Date.now()-1).toISOString()},attemptId:null,runtimeRunId:null});expect(await dispatchSentinel(run)).toEqual({dispatchPending:false});expect(boundary.start).not.toHaveBeenCalled();});
});
