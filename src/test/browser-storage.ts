import { createRequire } from "node:module";

// Explicit JSDOM storage for tests on Node versions without global localStorage.
// This narrow type describes only the installed constructor surface used here.
const { JSDOM } = createRequire(import.meta.url)("jsdom") as {
  JSDOM: new (html: string, options: { url: string }) => { window: { localStorage: Storage } };
};
export function createTestStorage(): Storage {
  return new JSDOM("", { url: "https://app.example" }).window.localStorage;
}

// Unit-only lock transport; native cross-tab behavior is covered in Chromium.
export function createTestLocks(): LockManager {
  const held = new Set<string>();
  return { request: async (name: string, options: LockOptions, callback: (lock: Lock | null) => Promise<unknown>) => {
    if (options.mode !== "exclusive" || options.ifAvailable !== true) throw new Error("Unsupported test lock request");
    if (held.has(name)) return callback(null);
    held.add(name);
    try { return await callback({ name, mode: "exclusive" }); }
    finally { held.delete(name); }
  } } as LockManager;
}
