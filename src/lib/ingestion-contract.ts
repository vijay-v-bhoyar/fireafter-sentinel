import { z } from "zod";

export const IngestionRequest = z.object({
  operationId: z.uuid(),
  kind: z.enum(["create", "refresh"]),
  target: z.string().min(1).max(256),
}).strict();

export type IngestionStatus = {
  id: string;
  incidentId: string;
  county: string;
  status: "queued" | "running" | "failed" | "completed";
  stage: string;
  updatedAt: string;
  published: boolean;
  terrainCompleted: number;
  terrainTotal: number;
  inventory?: { source: string; saved: number; total: number };
  crossings?: { roadsCompleted: number; candidatesSaved: number };
  errorCode: string | null;
};

export const CORE_SOURCES = ["wfigs", "nws", "observations", "pwfdf", "bridges", "structures"] as const;
export const EXTRA_SOURCES = ["wfigsYtd", "firms", "mtbs", "roads", "hydro", "epqs"] as const;
export const INGESTION_SOURCES = [...CORE_SOURCES, ...EXTRA_SOURCES];
export const TERRAIN_CHUNK_SIZE = 128;

export function ingestionLabel(stage: string) {
  if (stage === "initialize") return "Preparing county workspace";
  if (stage.startsWith("source:")) return `Loading ${stage.slice(7)} evidence`;
  if (stage.startsWith("terrain:")) return "Enriching terrain in saved batches";
  if (stage.startsWith("derive:")) return "Linking infrastructure to available hazard evidence";
  if (stage.startsWith("prepare:") || stage.startsWith("commit:")) return "Saving evidence and checking the commit receipt";
  return stage === "done" ? "Processing complete; review source coverage" : "Processing county evidence";
}
