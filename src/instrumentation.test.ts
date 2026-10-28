import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
const sdk=vi.hoisted(()=>({getWorld:vi.fn(),start:vi.fn()}));
vi.mock('workflow/runtime',()=>({getWorld:sdk.getWorld}));
beforeEach(()=>{vi.resetModules();vi.resetAllMocks();vi.stubEnv('NODE_ENV','development');vi.stubEnv('NEXT_RUNTIME','nodejs');vi.stubEnv('SENTINEL_ALLOW_LOCAL_DB','true');vi.stubEnv('WORKFLOW_TARGET_WORLD','local');vi.stubEnv('WORKFLOW_LOCAL_RECOVER_ACTIVE_RUNS','true');sdk.getWorld.mockResolvedValue({start:sdk.start});sdk.start.mockResolvedValue(undefined);});
afterEach(()=>vi.unstubAllEnvs());
describe('explicit local SDK recovery at Next startup',()=>{
 it('starts the configured local recovery hook before registration completes',async()=>{const {register}=await import('./instrumentation');await register();expect(sdk.getWorld).toHaveBeenCalledTimes(1);expect(sdk.start).toHaveBeenCalledTimes(1);});
 it.each([['NODE_ENV','production'],['NEXT_RUNTIME','edge'],['SENTINEL_ALLOW_LOCAL_DB','false'],['WORKFLOW_TARGET_WORLD','vercel'],['WORKFLOW_LOCAL_RECOVER_ACTIVE_RUNS','false']])('does not initialize a world outside the explicit local Node development recovery profile: %s=%s',async(name,value)=>{vi.stubEnv(name,value);const {register}=await import('./instrumentation');await register();expect(sdk.getWorld).not.toHaveBeenCalled();});
 it('does not report successful startup if the local world cannot recover',async()=>{sdk.start.mockRejectedValue(new Error('Recovery unavailable'));const {register}=await import('./instrumentation');await expect(register()).rejects.toThrow('Recovery unavailable');});
 it('rejects a configured local world with no startup/recovery hook',async()=>{sdk.getWorld.mockResolvedValue({});const {register}=await import('./instrumentation');await expect(register()).rejects.toThrow('Local workflow recovery is unavailable');});
});
