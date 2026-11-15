import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { firstActiveBatchForCollege } from '../src/lib/registration-batch.ts';

// Live incident 11 Nov 2026: a GNITC student holding a registration token
// for GNITC Batch 2 (active, seats available) was told registrations were
// paused, because the register page concluded "no active batch" without
// ever looking the college's active batch up. The page must resolve the
// college's active batch first and only waitlist when there really is none.

const GNITC_B2 = { slug: 'gnitc-batch-2', college: 'GNITC', fee_amount: 2200, status: 'active' };
const GNITC_B1_CLOSED = { slug: 'gnitc-batch-1', college: 'GNITC', fee_amount: 1100, status: 'closed' };
const GNIT_B2 = { slug: 'gnit-batch-2', college: 'GNIT', fee_amount: 2200, status: 'active' };

test('resolves the college\u2019s active batch (the live GNITC case)', () => {
  const found = firstActiveBatchForCollege([GNITC_B1_CLOSED, GNITC_B2], 'GNITC');
  assert.deepEqual(found, GNITC_B2);
});

test('returns null when the college has no active batch (only a closed one)', () => {
  assert.equal(firstActiveBatchForCollege([GNITC_B1_CLOSED], 'GNITC'), null);
});

test('returns null when the list is empty', () => {
  assert.equal(firstActiveBatchForCollege([], 'GNITC'), null);
});

test('never returns another college\u2019s active batch', () => {
  assert.equal(firstActiveBatchForCollege([GNIT_B2], 'GNITC'), null);
});

test('returns null for a missing college or a missing list', () => {
  assert.equal(firstActiveBatchForCollege([GNITC_B2], ''), null);
  assert.equal(firstActiveBatchForCollege(null, 'GNITC'), null);
  assert.equal(firstActiveBatchForCollege(undefined, 'GNITC'), null);
});
