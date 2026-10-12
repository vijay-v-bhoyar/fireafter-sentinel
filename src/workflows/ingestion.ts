import { sleep } from "workflow";
import { runIngestionStep } from "@/lib/ingestion-worker";

export async function ingestCounty(jobId: string) {
  "use workflow";
  // Bound orchestration even if every individual provider is unavailable.
  for (let count = 0; count < 4096; count++) {
    const outcome = await step(jobId);
    if (outcome === "stop") return;
    if (outcome === "wait") await sleep("30s");
  }
  throw new Error("Ingestion orchestration limit reached; operator reconciliation required.");
}

async function step(jobId: string) {
  "use step";
  return runIngestionStep(jobId);
}
