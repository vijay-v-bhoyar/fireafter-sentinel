export const dynamic = "force-dynamic";

export function GET() {
  // Next replaces this literal access at compilation; startup env is not identity.
  const releaseId = process.env.FIREAFTER_COMPILED_RELEASE_ID;
  const headers = { "Cache-Control": "no-store, max-age=0" };
  if (process.env.NODE_ENV !== "production" || !releaseId || !/^[a-f0-9]{64}$/.test(releaseId)) {
    return Response.json({ error: "Build identity unavailable. Build with npm run build before release verification." }, { status: 503, headers });
  }
  return Response.json({ application: "fireafter-sentinel", mode: "production", releaseId }, { headers });
}
