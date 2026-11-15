import { strict as assert } from 'node:assert';
import { register } from 'node:module';
import { test } from 'node:test';

// Static imports resolve before any module code runs, so the resolve hook
// must be registered before the dynamic import below (same pattern as the
// mocked-DB smoke test). The hook appends `.ts` to extensionless imports,
// which plain node otherwise cannot resolve.
register('../helpers/test-alias-hooks.mjs', import.meta.url);

const { parseAdminActionIntent } = await import('../../src/lib/admin-copilot-intent.ts');

test('existing commands still parse', () => {
  assert.deepEqual(parseAdminActionIntent('set GNIT Batch 2 fee to 2500'), { name: 'set_batch_fee', args: { batch_name: 'GNIT Batch 2', fee_amount: 2500 } });
  assert.deepEqual(parseAdminActionIntent('approve payment abc12345-1234'), { name: 'approve_payment', args: { payment_id: 'abc12345-1234' } });
  assert.deepEqual(parseAdminActionIntent('reject payment abc12345-1234 because blurry screenshot'), { name: 'reject_payment', args: { payment_id: 'abc12345-1234', reason: 'blurry screenshot' } });
  assert.deepEqual(parseAdminActionIntent('who is missing signatures in GNITC batch 1'), { name: 'find_missing_signatures', args: { batch_name: 'GNITC Batch 1' } });
  assert.equal(parseAdminActionIntent('how many students paid?'), null);
});

test('message one student by phone', () => {
  assert.deepEqual(parseAdminActionIntent('message 9876543210: your certificates are ready'), { name: 'message_student', args: { phone: '9876543210', message: 'your certificates are ready' } });
  assert.deepEqual(parseAdminActionIntent('send a message to +91 98765 43210 - hall ticket is out'), { name: 'message_student', args: { phone: '+919876543210', message: 'hall ticket is out' } });
});

test('payment reminder to a batch keeps the college prefix', () => {
  assert.deepEqual(parseAdminActionIntent('remind GNIT batch 2 to pay'), { name: 'send_payment_reminder', args: { batch_name: 'GNIT Batch 2' } });
  assert.deepEqual(parseAdminActionIntent('send a payment reminder to GNITC batch 1'), { name: 'send_payment_reminder', args: { batch_name: 'GNITC Batch 1' } });
});

test('answer a pending question by UQ number', () => {
  assert.deepEqual(parseAdminActionIntent('answer UQ-7: yes, you can pay in two parts'), { name: 'answer_question', args: { short_id: 7, answer: 'yes, you can pay in two parts' } });
  assert.deepEqual(parseAdminActionIntent('answer question 12 - no need to resubmit'), { name: 'answer_question', args: { short_id: 12, answer: 'no need to resubmit' } });
});

test('group link set and send', () => {
  assert.deepEqual(parseAdminActionIntent('set group link for GNIT batch 2 to https://chat.whatsapp.com/AbCdEfG'), { name: 'set_group_link', args: { batch_name: 'GNIT batch 2', url: 'https://chat.whatsapp.com/AbCdEfG' } });
  assert.deepEqual(parseAdminActionIntent('send group link to GNITC batch 1'), { name: 'send_group_link', args: { batch_name: 'GNITC batch 1' } });
});

test('approve and reject by student reference', () => {
  assert.deepEqual(parseAdminActionIntent('approve payment of 9876543210'), { name: 'approve_payment', args: { student_ref: '9876543210' } });
  assert.deepEqual(parseAdminActionIntent('reject payment of 21GN1A0501 because screenshot is blurry'), { name: 'reject_payment', args: { student_ref: '21GN1A0501', reason: 'screenshot is blurry' } });
});

test('create a college (the reported Copilot failure)', () => {
  // Krupal typed these and the Copilot fell back to a stats snapshot.
  assert.deepEqual(parseAdminActionIntent('Create a new college ggg'), { name: 'add_college', args: { name: 'ggg' } });
  assert.deepEqual(parseAdminActionIntent('Create a new collage snsit'), { name: 'add_college', args: { name: 'snsit' } });
  assert.deepEqual(parseAdminActionIntent('add college SNIST'), { name: 'add_college', args: { name: 'SNIST' } });
  assert.deepEqual(parseAdminActionIntent('create a new college Sreenidhi Institute of Science and Technology code SNIST'), { name: 'add_college', args: { name: 'Sreenidhi Institute of Science and Technology', code: 'SNIST' } });
  assert.deepEqual(parseAdminActionIntent('create a new college GNIT'), { name: 'add_college', args: { name: 'GNIT' } });
  // No name given: not a create command — the Copilot asks for the name.
  assert.equal(parseAdminActionIntent('create a new college'), null);
  assert.equal(parseAdminActionIntent('add college'), null);
});
