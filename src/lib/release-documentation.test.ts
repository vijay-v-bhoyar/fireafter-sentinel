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

const start = "<!-- current-security-probes -->";
const end = "<!-- /current-security-probes -->";
const versions = {
  serverOwnedWrites: SERVER_OWNED_WRITE_SECURITY_VERSION,
  serverOwnedReads: SERVER_OWNED_READ_SECURITY_VERSION,
  atomicResponderAction: ATOMIC_RESPONDER_ACTION_SECURITY_VERSION,
  atomicBundlePersistence: ATOMIC_BUNDLE_PERSISTENCE_SECURITY_VERSION,
  operatorAccountIssuanceAudit: OPERATOR_ACCOUNT_ISSUANCE_AUDIT_SECURITY_VERSION,
  scheduledRefresh: SCHEDULED_REFRESH_SECURITY_VERSION,
};

function assertCurrentTable(document: string) {
  expect(document.split(start)).toHaveLength(2);
  expect(document.split(end)).toHaveLength(2);
  expect(document.indexOf(end)).toBeGreaterThan(document.indexOf(start));
  const table = document.split(start)[1].split(end)[0];
  const lines = table.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  expect(lines).toHaveLength(8);
  expect(lines[0]).toMatch(/^\|\s*Control\s*\|\s*Required version\s*\|$/);
  expect(lines[1]).toMatch(/^\|\s*-{3,}\s*\|\s*-{3,}\s*\|$/);
  const rows = lines.slice(2).map(line => {
    const cells = line.split("|").map(cell => cell.trim());
    expect(cells).toHaveLength(4);
    expect(cells[0]).toBe("");
    expect(cells[3]).toBe("");
    expect(cells[2]).toMatch(/^`\d+`$/);
    return [cells[1], cells[2].slice(1, -1)];
  });
  expect(new Set(rows.map(([name]) => name)).size).toBe(6);
  expect(Object.fromEntries(rows)).toEqual(versions);
  // A second untagged control row is also a contradictory current declaration.
  const prose = document.slice(0, document.indexOf(start)) + document.slice(document.indexOf(end) + end.length);
  for (const control of Object.keys(versions)) {
    expect(prose).not.toMatch(new RegExp(`\\|\\s*${control}\\s*\\|`));
  }
}

describe("FA14 unique current release requirements", () => {
  for (const path of ["docs/EVALUATION_AND_TEST_PLAN.md"]) {
    const document = readFileSync(path, "utf8");
    it(`has one exact current table in ${path}`, () => assertCurrentTable(document));
    it(`rejects duplicate or contradictory control tables in ${path}`, () => {
      const duplicate = document.slice(document.indexOf(start), document.indexOf(end) + end.length);
      expect(() => assertCurrentTable(document + "\n" + duplicate)).toThrow();
      expect(() => assertCurrentTable(document + "\n| serverOwnedWrites | `20260904053500` |\n")).toThrow();
      expect(() => assertCurrentTable(document.replace(end, "  |serverOwnedWrites|`20260904053500`|  \n" + end))).toThrow();
      expect(() => assertCurrentTable(document.replace(end, "| unknownControl | `20260904053500` | extra |\n" + end))).toThrow();
      const currentRow = `| serverOwnedWrites | \`${SERVER_OWNED_WRITE_SECURITY_VERSION}\` |`;
      expect(() => assertCurrentTable(document.replace(currentRow, "| serverOwnedWrites | `19990101000000` |"))).toThrow();
    });
  }
});

for (const path of ["docs/OPERATIONS_AND_COST_PLAN.md", "docs/SECURITY_AND_HUMAN_REVIEW.md", "docs/DATA_AND_API_CONTRACTS.md"]) {
  it(`keeps ${path} linked to the sole control owner`, () => {
    const document = readFileSync(path, "utf8");
    expect(document).toContain("EVALUATION_AND_TEST_PLAN.md");
    expect(document).not.toContain("<!-- current-security-probes -->");
  });
}
