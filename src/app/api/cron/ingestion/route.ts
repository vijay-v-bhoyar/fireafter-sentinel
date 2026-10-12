import { timingSafeEqual } from "node:crypto";
import { pendingIngestionDispatches } from "@/lib/ingestion-store";
import { dispatchIngestion } from "@/lib/ingestion-dispatch";

export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return Response.json({ error: "CRON_SECRET is not configured" }, { status: 503 });
  const actual = Buffer.from(request.headers.get("authorization") ?? "");
  const expected = Buffer.from(`Bearer ${secret}`);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (process.env.FIREAFTER_DURABLE_REFRESH_ENABLED !== "true") return Response.json({ dispatched: 0, disabled: true });
  try {
    const jobs = await pendingIngestionDispatches();
    for (const job of jobs) await dispatchIngestion(job);
    return Response.json({ checked: jobs.length });
  } catch {
    return Response.json({ error: "Ingestion outbox dispatch is unconfirmed; saved jobs are retained." }, { status: 503 });
  }
}
