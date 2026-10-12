import { describe, expect, it } from "vitest";
import {
  isNonOperationalAssetRecord,
  isNonOperationalAuditEventRecord,
  isNonOperationalIncidentId,
  isNonOperationalIncidentRecord,
  isNonOperationalRecommendationRecord,
  isNonOperationalResponderActionRecord,
  isNonOperationalSourceSnapshotRecord,
} from "./non-operational-records";

describe("non-operational persisted record filtering", () => {
  it("identifies known smoke/demo records without rejecting source-backed records", () => {
    expect(isNonOperationalIncidentId("incident-custom-custom-hartford")).toBe(
      true,
    );
    expect(isNonOperationalIncidentId("incident-utah-county-ut")).toBe(false);
    expect(isNonOperationalIncidentId("incident-los-angeles-ca")).toBe(false);
    expect(isNonOperationalIncidentId("incident-ventura-ca")).toBe(false);
    expect(
      isNonOperationalIncidentRecord({
        id: "55555555-5555-4555-8555-555555555555",
        selected_fire: {
          domainIncidentId: "incident-training",
          metadata: { nonOperational: true },
        },
      }),
    ).toBe(true);
    expect(
      isNonOperationalIncidentRecord({
        id: "66666666-6666-4666-8666-666666666666",
        selected_fire: { domainIncidentId: "incident-los-angeles-ca" },
      }),
    ).toBe(false);

    expect(
      isNonOperationalAssetRecord({
        name: "Live DB Test Culvert",
        source: "ventura-county-assets.csv",
      }),
    ).toBe(true);
    expect(
      isNonOperationalAssetRecord({
        name: "COUNTY ROAD bridge @ POND TOWN CREEK",
        source: "FHWA/BTS National Bridge Inventory",
      }),
    ).toBe(false);

    expect(
      isNonOperationalResponderActionRecord({
        actor_name: "J. Smith",
        note: "Supabase connectivity smoke test action.",
      }),
    ).toBe(true);
    expect(
      isNonOperationalResponderActionRecord({
        actor_name: "vijay.v.bhoyar@gmail.com",
        note: "Inspect by 1600. Coordinate with road crew.",
        recommendation_snapshot: {
          assetName: "E 800 N @ Hydro Unenforced Connector",
        },
      }),
    ).toBe(false);

    expect(
      isNonOperationalAuditEventRecord({
        actor_name: "FireAfter",
        summary: "J. Smith accepted Live DB Test Culvert.",
      }),
    ).toBe(true);
    expect(
      isNonOperationalSourceSnapshotRecord({
        source_name: "Legacy scoring",
        raw_payload: {
          detail: "Historical heuristic burn-scar scoring is active.",
        },
      }),
    ).toBe(true);
  });

  it("does not hide legitimate operational language or a matching actor name", () => {
    expect(
      isNonOperationalAssetRecord({
        name: "Smoke Tree Road Culvert",
        source: "County temporary road closure inventory",
        properties: { note: "Temporary access restriction after smoke impacts." },
      }),
    ).toBe(false);
    expect(
      isNonOperationalRecommendationRecord({
        score_breakdown: { assetName: "Smoke Tree Road Culvert" },
        limitations: ["Temporary closure status requires field confirmation."],
      }),
    ).toBe(false);
    expect(
      isNonOperationalResponderActionRecord({
        actor_name: "J. Smith",
        note: "Review temporary closure signs on Smoke Tree Road.",
        recommendation_snapshot: { assetName: "Smoke Tree Road Culvert" },
      }),
    ).toBe(false);
    expect(
      isNonOperationalAuditEventRecord({
        actor_name: "J. Smith",
        summary: "Temporary closure reviewed on Smoke Tree Road.",
        payload: { status: "field review pending" },
      }),
    ).toBe(false);
    expect(
      isNonOperationalSourceSnapshotRecord({
        source_name: "County smoke impact report",
        raw_payload: {
          detail: "Temporary smoke impacts require field confirmation.",
        },
      }),
    ).toBe(false);
  });

  it("supports explicit provenance markers without broad text matching", () => {
    expect(
      isNonOperationalAssetRecord({
        name: "Training Culvert",
        properties: { fireafterNonOperational: true },
      }),
    ).toBe(true);
    expect(
      isNonOperationalAuditEventRecord({
        summary: "Training review",
        payload: { metadata: { non_operational: true } },
      }),
    ).toBe(true);
    expect(
      isNonOperationalSourceSnapshotRecord({
        source_name: "Training source",
        raw_payload: { metadata: { fireafterNonOperational: true } },
      }),
    ).toBe(true);
  });

  it.each([
    { note: "FIREAFTER BROWSER SMOKE" },
    { FireAfter_Non_Operational: true },
    { nested: [[{ nonOperational: true }]] },
  ])("finds late source markers after numeric geometry: %j", (marker) => {
    const coordinates = Array.from({ length: 20000 }, (_, i) => [i / 1000, -120]);
    expect(isNonOperationalSourceSnapshotRecord({ raw_payload: { coordinates, marker } })).toBe(true);
    expect(isNonOperationalSourceSnapshotRecord({ raw_payload: { coordinates,
      nonOperational: "true", note: "Temporary smoke impacts", metadata: { non_operational: false } } })).toBe(false);
  });

  it("handles cyclic/shared source objects without missing a later marker or retaining trust", () => {
    const shared: Record<string, unknown> = { coordinates: [[-120, 35]] };
    const record: Record<string, unknown> = { first: shared, second: shared };
    shared.parent = record;
    expect(isNonOperationalSourceSnapshotRecord(record)).toBe(false);
    shared.nonOperational = true;
    expect(isNonOperationalSourceSnapshotRecord(record)).toBe(true);
    delete shared.nonOperational;
    shared.note = "Supabase connectivity smoke test";
    expect(isNonOperationalSourceSnapshotRecord(record)).toBe(true);
  });
});
