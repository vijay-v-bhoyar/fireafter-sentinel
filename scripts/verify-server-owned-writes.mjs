import { existsSync, readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { admitSupabaseTarget } from "./sentinel-target.mjs";
import {
  SECURITY_PROBES,
  buildMigrationContractReport,
  loadMigrationContractFiles,
} from "./migration-contract-verifier.mjs";
import {
  buildProbeResult,
  buildVerificationReport,
} from "./write-boundary-verifier.mjs";

const originalEnv = new Set(Object.keys(process.env));
loadEnvFile(".env");
loadEnvFile(".env.local");

const probes = SECURITY_PROBES;

try {
  await main();
} catch (error) {
  console.error(
    JSON.stringify(
      {
        ok: false,
        failure: "configuration_error",
        message: error instanceof Error ? error.message : "Verifier configuration is invalid.",
      },
      null,
      2,
    ),
  );
  process.exitCode = 1;
}

async function main() {
  const migrationContract = buildMigrationContractReport(loadMigrationContractFiles());
  if (!migrationContract.ok) {
    console.log(JSON.stringify({
      ok: false,
      failure: "migration_contract_unverified",
      migrationContract,
      nextActions: migrationContract.nextActions,
    }, null, 2));
    process.exitCode = 1;
    return;
  }

  const supabaseUrl = admitSupabaseTarget(requiredEnv("NEXT_PUBLIC_SUPABASE_URL"));
  const serviceRoleKey = requiredEnv("SUPABASE_SERVICE_ROLE_KEY");
  let projectHost;
  try {
    projectHost = new URL(supabaseUrl).hostname;
  } catch {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL must be a valid URL.");
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });

  const results = await Promise.all(
    probes.map(async (probe) => {
      try {
        const { data, error } = await supabase.rpc(probe.rpc);
        return {
          name: probe.name,
          ...buildProbeResult(probe, { data, error }),
        };
      } catch {
        return {
          name: probe.name,
          ...buildProbeResult(probe, { error: true }),
        };
      }
    }),
  );

  const report = {
    ...buildVerificationReport(projectHost, results),
    migrationContract,
  };
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 1;
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value?.trim()) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function loadEnvFile(path) {
  if (!existsSync(path)) return;

  for (const rawLine of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const equalsIndex = line.indexOf("=");
    if (equalsIndex === -1) continue;

    const key = line.slice(0, equalsIndex).trim();
    let value = line.slice(equalsIndex + 1).trim();
    if (!key || originalEnv.has(key)) continue;

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    process.env[key] = value;
  }
}
