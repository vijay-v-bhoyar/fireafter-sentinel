import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ATOMIC_BUNDLE_PERSISTENCE_SECURITY_VERSION,
  ATOMIC_RESPONDER_ACTION_SECURITY_VERSION,
  OPERATOR_ACCOUNT_ISSUANCE_AUDIT_SECURITY_VERSION,
  SCHEDULED_REFRESH_SECURITY_VERSION,
  SERVER_OWNED_READ_SECURITY_VERSION,
  SERVER_OWNED_WRITE_SECURITY_VERSION,
} from "./operational-write-security";

const read = (path: string) => readFileSync(path, "utf8");
const versions = {
  serverOwnedWrites: SERVER_OWNED_WRITE_SECURITY_VERSION,
  serverOwnedReads: SERVER_OWNED_READ_SECURITY_VERSION,
  atomicResponderAction: ATOMIC_RESPONDER_ACTION_SECURITY_VERSION,
  atomicBundlePersistence: ATOMIC_BUNDLE_PERSISTENCE_SECURITY_VERSION,
  operatorAccountIssuanceAudit: OPERATOR_ACCOUNT_ISSUANCE_AUDIT_SECURITY_VERSION,
  scheduledRefresh: SCHEDULED_REFRESH_SECURITY_VERSION,
};

// These are release-document/graph contracts, not database or deployment tests.
describe("FA10-R5 import recovery release trace", () => {
  it("maps the required import identity, recovery route and current database gate", () => {
    const pkg = JSON.parse(read("pkg.json"));
    const post = pkg.apiContracts.find((entry: { id: string }) => entry.id === "api:POST /api/assets/import");
    const lookup = pkg.apiContracts.find((entry: { id: string }) => entry.id === "api:GET /api/assets/import/status");
    expect(post.operationIdRequired).toBe(true);
    expect(post.recovery).toEqual({
      method: "GET", path: "/api/assets/import/status", unconfirmedMeansRollback: false,
      receiptProvesRefresh: false, requiredDatabaseVersion: ATOMIC_BUNDLE_PERSISTENCE_SECURITY_VERSION,
    });
    expect(lookup).toMatchObject({ method: "GET", path: "/api/assets/import/status", cache: "no-store", writes: false });
    expect(pkg.dependencies.development).toContain("libpg-query");
  });

  it("connects the browser, routes, receipt RPCs, table, verifier and tests in the PKG", () => {
    const pkg = JSON.parse(read("pkg.json"));
    const required = [
      ["file:src/components/fireafter-dashboard.tsx", "file:src/lib/import-operation-client.ts", "[imports]"],
      ["api:GET /api/assets/import/status", "function:src/lib/import-operation-server.ts#lookupImportOperation", "[calls]"],
      ["function:src/lib/import-operation-server.ts#lookupImportOperation", "function:public.fireafter_read_import_receipt", "[calls]"],
      ["function:src/lib/fireafter-supabase.ts#persistBundleToSupabase", "function:public.fireafter_commit_import", "[calls]"],
      ["function:public.fireafter_commit_import", "datamodel:public.import_operation_receipts", "[writes]"],
      ["function:public.fireafter_read_import_receipt", "datamodel:public.import_operation_receipts", "[reads]"],
      ["file:src/lib/import-operation-release.test.ts", "config:pkg", "[reads]"],
    ];
    const nodes = new Set(pkg.nodes.map((node: { id: string }) => node.id));
    for (const [from, to, type] of required) {
      expect(nodes.has(from), from).toBe(true);
      expect(nodes.has(to), to).toBe(true);
      expect(pkg.edges).toContainEqual({ from, to, type });
    }
  });

  it.each(["docs/EVALUATION_AND_TEST_PLAN.md"  ])("keeps the current six-probe release table exact in %s", path => {
    const document = read(path);
    const table = document.split("<!-- current-security-probes -->")[1]?.split("<!-- /current-security-probes -->")[0];
    expect(table).toBeDefined();
    const rows = [...(table ?? "").matchAll(/^\| ([A-Za-z]+) \| `(\d+)` \|$/gm)];
    expect(rows).toHaveLength(6);
    expect(Object.fromEntries(rows.map(([, name, version]) => [name, version]))).toEqual(versions);
    expect(document).toContain("20260914090000_import_operation_receipts.sql");
  });

  it("separates historical deployment observations from current release authority", () => {
    for (const path of ["PROVENANCE.md"]) {
      const document = read(path);
      expect(document, path).not.toMatch(/(?:currently resolves|remains Ready and owns|still reported Ready)/);
      expect(document, path).toContain("Historical deployment observation");
      expect(document, path).toContain("not reverified");
    }
    expect(read("docs/EVALUATION_AND_TEST_PLAN.md")).not.toContain("the current worktree passes 322");
    expect(read("docs/OPERATIONS_AND_COST_PLAN.md")).not.toContain("Current client pending state does not survive tab closure");
  });

  it("does not describe offline SQL parsing as PL/pgSQL or deployment proof", () => {
    const plan = read("docs/EVALUATION_AND_TEST_PLAN.md");
    expect(plan).toContain("PL/pgSQL bodies are not validated");
    expect(plan).toContain("candidate safety UNKNOWN");
  });
});
