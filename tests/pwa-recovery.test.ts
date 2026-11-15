import { strict as assert } from "node:assert";
import { test } from "node:test";
import { isChunkLoadFailure, canAutoRecover } from "../src/lib/pwa-recovery.ts";

const CHUNK = "https://studentplatform.dev/_next/static/chunks/123-abc.js";

test("chunk-load messages are stale-build failures", () => {
  assert.equal(isChunkLoadFailure("Loading chunk 123 failed"), true);
  assert.equal(isChunkLoadFailure("ChunkLoadError: Loading chunk 42 failed"), true);
  assert.equal(
    isChunkLoadFailure("Failed to fetch dynamically imported module: " + CHUNK),
    true,
  );
  assert.equal(isChunkLoadFailure("Loading CSS chunk 5 failed"), true);
  assert.equal(isChunkLoadFailure("Importing a module script failed."), true);
});

test("'Script error.' only counts when the file is one of our chunks", () => {
  assert.equal(isChunkLoadFailure("Script error.", CHUNK), true);
  assert.equal(isChunkLoadFailure("Script error."), false);
  assert.equal(isChunkLoadFailure("Script error.", "https://example.com/other.js"), false);
  assert.equal(
    isChunkLoadFailure("Script error.", "https://studentplatform.dev/_next/static/chunks/app/page-1.js"),
    true,
  );
});

test("ordinary errors never trigger a recovery", () => {
  assert.equal(isChunkLoadFailure("Cannot read properties of undefined (reading 'x')"), false);
  assert.equal(isChunkLoadFailure(""), false);
  assert.equal(isChunkLoadFailure("NetworkError when attempting to fetch resource."), false);
  assert.equal(isChunkLoadFailure("Failed to load resource: the server responded with a status of 404 (Not Found)"), false);
  assert.equal(
    isChunkLoadFailure("Something went wrong", "chrome-extension://abcdef/script.js"),
    false,
  );
});

test("a resource error naming our chunk counts", () => {
  assert.equal(
    isChunkLoadFailure("Failed to load resource: the server responded with a status of 404", CHUNK),
    true,
  );
});

test("loop guard: one recovery per 30 minutes", () => {
  const store = new Map<string, string>();
  (globalThis as Record<string, unknown>).sessionStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => store.set(k, v),
  };
  const now = Date.now();
  assert.equal(canAutoRecover(now), true);
  store.set("sp_pwa_recovery_at", String(now));
  assert.equal(canAutoRecover(now + 1000), false);
  assert.equal(canAutoRecover(now + 29 * 60 * 1000), false);
  assert.equal(canAutoRecover(now + 31 * 60 * 1000), true);
  delete (globalThis as Record<string, unknown>).sessionStorage;
});
