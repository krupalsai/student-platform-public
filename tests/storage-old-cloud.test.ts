/**
 * Tests for the pre-rotation Cloudinary fallback in createDownloadUrl
 * (src/lib/storage.ts).
 *
 * Live incident 11 Nov 2026: all 101 stored College ID photos were uploaded
 * before the 10 Nov Cloudinary key rotation, so they live in the OLD cloud
 * (dpqqwqnsd) while the SDK is configured for the NEW cloud (u5xpsmhz).
 * createDownloadUrl rebuilt every delivery URL against the new cloud, so
 * every old document 404'd — the admin opening a student's ID got
 * ERR_INVALID_RESPONSE, and the GNIT Batch 1 document export listed every
 * College ID as MISSING. The fallback below returns the old-cloud delivery
 * URL when the new-cloud URL 404s.
 *
 * The Cloudinary SDK is real here (test credentials); only the HEAD check
 * is faked, via global fetch.
 */
import { strict as assert } from "node:assert";
import { test, beforeEach } from "node:test";

// Env vars must be set BEFORE importing storage.ts — it throws at import
// time when any Cloudinary variable is missing.
process.env.CLOUDINARY_CLOUD_NAME = "u5xpsmhz";
process.env.CLOUDINARY_API_KEY = "test-key";
process.env.CLOUDINARY_API_SECRET = "test-secret";

import { createDownloadUrl } from "../src/lib/storage.ts";

const OLD_ID = "student-documents/air50dtuzmmjubvlzgwm";
const NEW_ID = "student-documents/brand-new-after-rotation";

let headStatus: number | null = 200;
let headCalls = 0;

function fakeFetch(url: string, init?: { method?: string }) {
  assert.equal(init?.method, "HEAD");
  headCalls += 1;
  if (headStatus === null) throw new Error("network down");
  return Promise.resolve({ status: headStatus, ok: headStatus >= 200 && headStatus < 300 });
}

beforeEach(() => {
  headStatus = 200;
  headCalls = 0;
  (globalThis as unknown as { fetch: unknown }).fetch = fakeFetch;
});

test("a document that exists in the new cloud keeps its signed new-cloud URL", async () => {
  headStatus = 200;
  const url = await createDownloadUrl("docs", `cloudinary:${NEW_ID}`);
  assert.match(url, /res\.cloudinary\.com\/u5xpsmhz\//);
  assert.match(url, new RegExp(NEW_ID.replace(/\//g, "\\/")));
  assert.equal(headCalls, 1);
});

test("a document missing from the new cloud falls back to the legacy cloud URL", async () => {
  headStatus = 404;
  const url = await createDownloadUrl("docs", `cloudinary:${OLD_ID}`);
  assert.equal(url, `https://res.cloudinary.com/dpqqwqnsd/image/upload/${OLD_ID}`);
});

test("the fallback URL is the public legacy delivery URL, not a signed one", async () => {
  headStatus = 404;
  const url = await createDownloadUrl("docs", `cloudinary:${OLD_ID}`);
  assert.ok(!url.includes("s--"), "legacy fallback must not carry a new-cloud signature");
  assert.ok(!url.includes("_a="), "legacy fallback must not carry analytics params");
});

test("a network error on the HEAD check keeps the new-cloud URL (never guess on a blip)", async () => {
  headStatus = null;
  const url = await createDownloadUrl("docs", `cloudinary:${NEW_ID}`);
  assert.match(url, /res\.cloudinary\.com\/u5xpsmhz\//);
});

test("a known-legacy asset skips the HEAD check on repeat calls", async () => {
  headStatus = 404;
  await createDownloadUrl("docs", `cloudinary:${OLD_ID}`);
  const callsAfterFirst = headCalls;
  headStatus = 200; // would flip the answer if re-checked
  const url = await createDownloadUrl("docs", `cloudinary:${OLD_ID}`);
  assert.equal(url, `https://res.cloudinary.com/dpqqwqnsd/image/upload/${OLD_ID}`);
  assert.equal(headCalls, callsAfterFirst, "no second HEAD for a known-legacy asset");
});
