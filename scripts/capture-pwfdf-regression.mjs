import { createHash } from "node:crypto";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";

// Captured public USGS response, not fabricated geometry or a runtime data fallback.
const source = readFileSync(new URL("../output/plaskett-provider-basins.json", import.meta.url));
const expected = "5ffb2b8a42b770d5a15774e41139ec2e7c78197ac12815f5d8c80b76284913a4";
if (createHash("sha256").update(source).digest("hex") !== expected) throw new Error("Unexpected provider capture; review provenance before replacing the fixture.");
if (JSON.parse(source).features.length !== 197) throw new Error("Incomplete provider capture");
const directory = new URL("../src/test/fixtures/", import.meta.url);
mkdirSync(directory, { recursive: true });
writeFileSync(new URL("plaskett-pwfdf-20261002.json.gz", directory), gzipSync(source, { level: 9 }));
console.info("Captured all 197 public Plaskett basin features with original response integrity.");
