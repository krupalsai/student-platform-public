import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { mapUploadError } from '../src/lib/upload-errors.ts';

// Live incident 11 Nov 2026: every POST /api/uploads/college-id 500'd with
// this exact provider error (rotated Cloudinary key pair's cloud did not
// match CLOUDINARY_CLOUD_NAME), and the page showed "Internal server error"
// twice — under the photo and in the save banner. The route now maps any
// storage-upload throw to this descriptor instead of the generic 500.

test('the live Cloudinary error maps to 503 UPLOAD_UNAVAILABLE, not a generic 500', () => {
  const r = mapUploadError(new Error('Invalid cloud_name dpqqwqnsd'));
  assert.equal(r.status, 503);
  assert.equal(r.body.success, false);
  assert.equal(r.body.code, 'UPLOAD_UNAVAILABLE');
  assert.equal(r.body.error, 'Photo upload is temporarily unavailable — please try again in a bit.');
});

test('the failure message is actionable and never the generic 500 text', () => {
  const r = mapUploadError(new Error('Invalid cloud_name dpqqwqnsd'));
  assert.match(r.body.error, /try again/i);
  assert.ok(!r.body.error.includes('Internal server error'));
});

test('any storage-upload throw maps the same way (the step has one failure semantic)', () => {
  for (const err of [new Error('ECONNRESET'), new Error('Upload failed'), 'plain string failure', undefined]) {
    const r = mapUploadError(err);
    assert.equal(r.status, 503);
    assert.equal(r.body.code, 'UPLOAD_UNAVAILABLE');
  }
});

test('the failure body matches the api-response error shape the page renders', () => {
  const { body } = mapUploadError(new Error('Invalid cloud_name dpqqwqnsd'));
  assert.deepEqual(Object.keys(body).sort(), ['code', 'error', 'success']);
});
