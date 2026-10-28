/** Resume already admitted local work only in the explicitly enabled dev profile. */
export async function register() {
  // Keep Node-only SDK dependencies out of Next's separate Edge instrumentation build.
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    if (process.env.NODE_ENV !== 'development' || process.env.SENTINEL_ALLOW_LOCAL_DB !== 'true' ||
        process.env.WORKFLOW_TARGET_WORLD !== 'local' || process.env.WORKFLOW_LOCAL_RECOVER_ACTIVE_RUNS !== 'true') return;
    const {getWorld} = await import('workflow/runtime');
    const world = await getWorld();
    if (!world.start) throw new Error('Local workflow recovery is unavailable');
    await world.start();
  }
}
