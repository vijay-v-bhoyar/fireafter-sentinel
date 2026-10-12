const messages = {
  uploaded_geometry_invalid: "Stored uploaded geometry is invalid or exceeds validation limits. Ask an operator to correct and reimport the original GIS records; current inventory was not accepted.",
  inference_work: "Crossing inference exceeded its processing budget. Ask an operator to review ingestion capacity before retrying; no partial inference was accepted.",
  inference_candidates: "Crossing inference exceeded its candidate budget. Ask an operator to review ingestion capacity before retrying; no partial inference was accepted.",
  elevation_deadline: "Asset elevation processing exceeded its deadline. Ask an operator to review ingestion capacity before retrying; no partial refresh was accepted.",
  elevation_invalid: "USGS batch elevation returned incomplete or invalid point evidence. No partial refresh was accepted. Ask an operator to verify the elevation source before retrying.",
  elevation_unavailable: "USGS batch elevation is unavailable. No partial refresh was accepted. Check the elevation provider and retry when it is available.",
  read_invalid: "Persisted inventory is incomplete, changed, or has invalid identities. Retry the read; if it repeats, ask an operator to verify database access and inventory integrity.",
  read_budget: "Persisted inventory exceeds the synchronous read budget. Ask an operator to review retention and ingestion capacity; no partial inventory was accepted.",
  read_generation: "Persisted inventory changed during this operation. Reload the incident and review the current evidence before retrying; a mixed inventory was not accepted.",
  read_unverified: "Current inventory membership is unverified or this recommendation has been retired. Reload the incident; ask an authorized responder to refresh sources before recording a new decision.",
} as const;

export class InventoryCapacityError extends Error {
  readonly status = 503;
  constructor(public readonly code: keyof typeof messages) {
    super(messages[code]);
    this.name = "InventoryCapacityError";
  }
}
