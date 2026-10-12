import { createHash, timingSafeEqual } from "node:crypto";

const compromisedDemoPasswordHashes = new Set([
  "e7a886dab999638b59930e24abefb4ca4ac9e08439ae5756cd52665542aec328",
]);

export function assertDemoPasswordNotCompromised(password, variableName) {
  if (matchesBlockedPasswordHash(password)) {
    throw new Error(
      `${variableName} matches a credential exposed in repository history. Rotate it before use.`,
    );
  }
}

export function matchesBlockedPasswordHash(
  password,
  blockedHashes = compromisedDemoPasswordHashes,
) {
  const digest = createHash("sha256").update(password, "utf8").digest();
  for (const blockedHash of blockedHashes) {
    const blocked = Buffer.from(blockedHash, "hex");
    if (blocked.length === digest.length && timingSafeEqual(digest, blocked)) {
      return true;
    }
  }
  return false;
}
