import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  getBriefing, renderBriefing, listPendingPayments, renderPendingPayments,
  listTodayPayments, renderTodayPayments,
  countPaid, listUnpaidStudents, findStudent, listOpenQuestions,
  getBatchStatus, getWaitlist, listMissingSignatures,
  matchFastRead, runFastRead, getStudentDocuments,
} from '../../src/lib/admin-copilot-data';
import { runAdminAgentLoop, parseTextToolCalls, sanitizeAnswer } from '../../src/lib/admin-copilot-loop';

const NOW = Date.parse('2026-09-28T05:00:00Z'); // 10:30 IST
const day = 86400000;
const iso = (ms: number) => new Date(ms).toISOString();

const fixtures: Record<string, any[]> = {
  profiles: [
    { id: 's1', role: 'student', full_name: 'Asha Rao', phone: '9876543210', roll_number: '21GN1A0501', college: 'GNIT', branch: 'CSE', year: '4', batch_id: 'b1', is_profile_complete: true, created_at: iso(NOW - 10 * day), college_id_path: 'docs/s1.jpg', college_id_ai_flag: { hasSignature: true } },
    { id: 's2', role: 'student', full_name: 'Ravi Kumar', phone: '9876543211', roll_number: '21GN1A0502', college: 'GNIT', branch: 'CSE', year: '4', batch_id: 'b1', is_profile_complete: true, created_at: iso(NOW - 2 * day), college_id_path: 'docs/s2.jpg', college_id_ai_flag: { hasSignature: false } },
    { id: 's3', role: 'student', full_name: 'Meena Patil', phone: '9876543212', roll_number: '21GC1A0503', college: 'GNITC', branch: 'ECE', year: '4', batch_id: 'b2', is_profile_complete: true, created_at: iso(NOW - 1 * day), college_id_path: null, college_id_ai_flag: null },
    { id: 's4', role: 'student', full_name: 'Incomplete Guy', phone: '9876543213', roll_number: null, college: 'GNIT', branch: null, year: null, batch_id: 'b1', is_profile_complete: false, created_at: iso(NOW), college_id_path: null, college_id_ai_flag: null },
  ],
  payments: [
    { id: 'p-old-1111', status: 'submitted', amount: 2500, created_at: iso(NOW - 2 * day), reviewed_at: null, student_id: 's1', batch_id: 'b1', utr_number: 'UTR111' },
    { id: 'p-new-2222', status: 'reupload_requested', amount: 2500, created_at: iso(NOW - 1 * day), reviewed_at: null, student_id: 's2', batch_id: 'b1', utr_number: null },
    { id: 'p-ok-3333', status: 'approved', amount: 2500, created_at: iso(NOW - 3 * day), reviewed_at: iso(NOW - 3 * day), student_id: 's3', batch_id: 'b2', utr_number: null },
    { id: 'p-today-44', status: 'approved', amount: 1800, created_at: iso(NOW - 4 * day), reviewed_at: iso(NOW), student_id: 's1', batch_id: 'b1', utr_number: null },
    { id: 'p-rej-5555', status: 'rejected', amount: 2500, created_at: iso(NOW - 5 * day), reviewed_at: iso(NOW - 5 * day), student_id: 's2', batch_id: 'b1', utr_number: null },
  ],
  batches: [
    { id: 'b1', name: 'GNIT Batch 1', college: 'GNIT', status: 'active', fee_amount: 2500, batch_limit: 60, upi_id: 'gnit@upi', whatsapp_group_link: 'https://chat.whatsapp.com/x' },
    { id: 'b2', name: 'GNITC Batch 1', college: 'GNITC', status: 'active', fee_amount: null, batch_limit: 50, upi_id: null, whatsapp_group_link: null },
    { id: 'b0', name: 'GNIT Batch 0', college: 'GNIT', status: 'archived', fee_amount: 2000, batch_limit: 40, upi_id: 'gnit@upi', whatsapp_group_link: null },
  ],
  batch_waiting_queue: [
    { college: 'BIET', phone: '9000000001', created_at: iso(NOW - day), processed_at: null },
    { college: 'BIET', phone: '9000000002', created_at: iso(NOW - day), processed_at: null },
    { college: 'GNIT', phone: '9000000003', created_at: iso(NOW - day), processed_at: null },
  ],
  unknown_questions: [
    { id: 'uq-uuid-1', short_id: 7, question: 'Can I pay in two parts?', created_at: iso(NOW - day), status: 'pending', student_phone: '9876543210' },
    { id: 'uq-uuid-2', short_id: 3, question: 'Already answered', created_at: iso(NOW - 2 * day), status: 'answered', student_phone: null },
  ],
  whatsapp_moderation: [
    { phone: '9876543210', recent_turns: [
      { r: 'u', t: 'When is the last date?', at: iso(NOW - 2 * day) },
      { r: 'b', t: 'The last date is Friday.', at: iso(NOW - 2 * day) },
    ] },
  ],
  student_queries: [
    { id: 'q1', student_id: 's1', message: 'Can I pay in two parts?', created_at: iso(NOW - day) },
  ],
  student_query_messages: [
    { query_id: 'q1', sender: 'student', body: 'Can I pay in two parts?', created_at: iso(NOW - day) },
    { query_id: 'q1', sender: 'admin', body: 'Yes, in two parts.', created_at: iso(NOW - day + 3600000) },
  ],
};

/**
 * Chainable fake that applies the filters production code relies on
 * (eq/neq/is/in/gte/ilike), like a tiny PostgREST. Unknown chain methods
 * are accepted and ignored; awaiting resolves the filtered fixture rows.
 */
function fakeDb() {
  const apply = (rows: any[], ops: any[]) => rows.filter(row => ops.every(([op, f, v]) => {
    if (op === 'eq') return row[f] === v;
    if (op === 'neq') return row[f] !== v;
    if (op === 'is') return row[f] === v;
    if (op === 'in') return Array.isArray(v) && v.includes(row[f]);
    if (op === 'gte') return row[f] != null && row[f] >= v;
    if (op === 'ilike') return String(row[f] ?? '').toLowerCase().includes(String(v).replace(/%/g, '').toLowerCase());
    return true;
  }));
  return {
    from(table: string) {
      const ops: any[] = [];
      const chain: any = new Proxy({}, {
        get(_t, prop) {
          if (prop === 'then') {
            return (resolve: any) => {
              const data = apply(fixtures[table] ?? [], ops);
              return Promise.resolve({ data, count: data.length }).then(resolve);
            };
          }
          if (['eq', 'neq', 'is', 'in', 'gte', 'ilike'].includes(String(prop))) {
            return (f: string, v: unknown) => { ops.push([prop, f, v]); return chain; };
          }
          return (..._args: any[]) => chain;
        },
      });
      return chain;
    },
  } as any;
}

function withFrozenNow(fn: () => Promise<void>): () => Promise<void> {
  return async () => {
    const saved = Date.now;
    Date.now = () => NOW;
    try { await fn(); } finally { Date.now = saved; }
  };
}

test('briefing flags pending payments, no-fee batch, missing signature, open question and waitlist', withFrozenNow(async () => {
  const b = await getBriefing(fakeDb());
  const text = renderBriefing(b);
  assert.match(text, /2 payments waiting for review — oldest is 2 days old/);
  assert.match(text, /GNITC Batch 1 has no fee set/);
  assert.match(text, /1 verified College ID missing the student signature/);
  assert.match(text, /1 student question waiting for an answer/);
  assert.match(text, /3 students on waitlists \(2 colleges\): BIET \(2\), GNIT \(1\)/);
  assert.match(text, /1 payment approved \(₹1,800\)/);
  assert.match(text, /Batches:\n• GNIT Batch 1 — 2 enrolled · fee ₹2,500\n• GNITC Batch 1 — 1 enrolled · no fee set/);
}));

test('pending payments lists only reviewable rows, oldest first, with student join', withFrozenNow(async () => {
  const r = await listPendingPayments(fakeDb());
  assert.equal(r.count, 2);
  assert.deepEqual(r.items.map(i => i.id), ['p-old-1111', 'p-new-2222']);
  assert.equal(r.items[0].student, 'Asha Rao');
  assert.equal(r.items[0].utr, 'UTR111');
  assert.equal(r.items[0].age, '2 days old');
  const text = renderPendingPayments(r);
  assert.match(text, /Asha Rao \(21GN1A0501\) — ₹2,500 — GNIT Batch 1 — 2 days old — UTR UTR111 — id p-old-11/);
}));

test('countPaid gives per-batch paid counts and collections, archived excluded', withFrozenNow(async () => {
  const rows = await countPaid(fakeDb());
  assert.equal(rows.length, 2); // archived batch excluded
  const b1 = rows.find(r => r.batch === 'GNIT Batch 1')!;
  assert.equal(b1.paid, 1); // s1 approved
  assert.equal(b1.collected, 1800);
  assert.equal(b1.enrolled, 2); // complete profiles only
  const gnit = await countPaid(fakeDb(), 'gnit');
  assert.equal(gnit.length, 1);
  assert.equal(gnit[0].batch, 'GNIT Batch 1');
}));

test('listUnpaidStudents excludes approved payers and incomplete profiles', withFrozenNow(async () => {
  const r = await listUnpaidStudents(fakeDb(), 'GNIT Batch 1');
  assert.equal(r.count, 1);
  assert.equal(r.items[0].name, 'Ravi Kumar'); // s1 paid, s4 incomplete
  const gnitc = await listUnpaidStudents(fakeDb(), 'GNITC');
  assert.equal(gnitc.count, 0); // s3 approved
}));

test('findStudent matches by phone, roll and name with latest payment', withFrozenNow(async () => {
  const byPhone = await findStudent(fakeDb(), '+91 98765 43210');
  assert.equal(byPhone[0]?.name, 'Asha Rao');
  const byRoll = await findStudent(fakeDb(), '21gn1a0502');
  assert.equal(byRoll[0]?.name, 'Ravi Kumar');
  assert.equal(byRoll[0].latest_payment?.status, 'reupload_requested'); // newest first
  const byName = await findStudent(fakeDb(), 'meena');
  assert.equal(byName[0]?.batch, 'GNITC Batch 1');
  assert.equal((await findStudent(fakeDb(), 'nobody')).length, 0);
}));

test('open questions lists pending only with UQ display ids, oldest first', withFrozenNow(async () => {
  const r = await listOpenQuestions(fakeDb());
  assert.equal(r.count, 1);
  assert.equal(r.items[0].display_id, 'UQ-007');
  assert.match(r.items[0].question, /two parts/);
}));

test('open questions attach the student conversation for context', withFrozenNow(async () => {
  const r = await listOpenQuestions(fakeDb());
  const conv = r.items[0].conversation;
  assert.ok(conv.some(l => l === 'Student: When is the last date?'), 'whatsapp user turn shown');
  assert.ok(conv.some(l => l === 'Bot: The last date is Friday.'), 'whatsapp bot turn shown');
  assert.ok(conv.some(l => l === 'Student: Can I pay in two parts?'), 'in-app student turn shown');
  assert.ok(conv.some(l => l === 'Admin: Yes, in two parts.'), 'in-app admin turn shown');
}));

test('batch status and waitlist report live shape', withFrozenNow(async () => {
  const bs = await getBatchStatus(fakeDb());
  assert.equal(bs.length, 2);
  const b2 = bs.find(b => b.name === 'GNITC Batch 1')!;
  assert.equal(b2.fee, null);
  assert.equal(b2.upi_set, false);
  const w = await getWaitlist(fakeDb());
  assert.equal(w.total, 3);
  assert.deepEqual(w.by_college, [{ college: 'BIET', waiting: 2 }, { college: 'GNIT', waiting: 1 }]);
  const sigs = await listMissingSignatures(fakeDb());
  assert.equal(sigs.count, 1);
  assert.equal(sigs.items[0].name, 'Ravi Kumar');
}));

test('fast read matcher catches read phrases and ignores actions/lookups', () => {
  assert.equal(matchFastRead('Brief me'), 'briefing');
  assert.equal(matchFastRead('status'), 'briefing');
  assert.equal(matchFastRead('What needs my attention?'), 'briefing');
  assert.equal(matchFastRead("Summarise today's activity"), 'briefing');
  assert.equal(matchFastRead('Show me pending payments'), 'pending_payments');
  assert.equal(matchFastRead('any open questions?'), 'open_questions');
  assert.equal(matchFastRead('which batches are active'), 'batch_status');
  assert.equal(matchFastRead('who is on the waitlist'), 'waitlist');
  assert.equal(matchFastRead('approve payment p-old-1111'), null);
  assert.equal(matchFastRead('payment status of 9876543210'), null);
  assert.equal(matchFastRead('set GNIT Batch 2 fee to 2500'), null);
  assert.equal(matchFastRead(''), null);
});

test('fast read runner renders deterministic answers', withFrozenNow(async () => {
  assert.match(await runFastRead(fakeDb(), 'pending_payments'), /2 payments waiting for review/);
  assert.match(await runFastRead(fakeDb(), 'waitlist'), /BIET: 2/);
  assert.match(await runFastRead(fakeDb(), 'batch_status'), /GNITC Batch 1 \(active\) — 1\/50 — no fee set — no UPI set/);
}));

/* ── agent loop ─────────────────────────────────────────────────── */

type FetchStub = (input: any, init?: any) => Promise<any>;
const groqResponse = (message: any) => ({ ok: true, json: async () => ({ choices: [{ message }] }) });

function withEnv(key: string, value: string | undefined, fn: () => Promise<void>): () => Promise<void> {
  return async () => {
    const savedKey = process.env[key];
    const savedFetch = global.fetch;
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
    try { await fn(); } finally {
      if (savedKey === undefined) delete process.env[key]; else process.env[key] = savedKey;
      global.fetch = savedFetch;
    }
  };
}

test('loop returns null without an API key', withEnv('GROQ_API_KEY', undefined, async () => {
  assert.equal(await runAdminAgentLoop(fakeDb(), 'status', { profileId: 'a1', role: 'admin' }), null);
}));

test('loop calls read tools then answers from their data', withEnv('GROQ_API_KEY', 'test-key', async () => {
  const calls: any[] = [];
  const stub: FetchStub = async (_input, init) => {
    calls.push(JSON.parse(init.body));
    if (calls.length === 1) {
      return groqResponse({ role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'list_pending_payments', arguments: '{}' } }] });
    }
    const toolMsg = calls[1].messages.find((m: any) => m.role === 'tool');
    assert.ok(toolMsg, 'tool result must be fed back to the model');
    const payload = JSON.parse(toolMsg.content);
    assert.equal(payload.count, 2); // real fixture data flowed through
    return groqResponse({ role: 'assistant', content: 'Two payments wait for review, oldest is Asha Rao (2 days).' });
  };
  global.fetch = stub as any;
  const r = await runAdminAgentLoop(fakeDb(), 'what payments are pending?', { profileId: 'a1', role: 'admin' });
  assert.equal(r?.answer, 'Two payments wait for review, oldest is Asha Rao (2 days).');
  assert.deepEqual(r?.toolsUsed, ['list_pending_payments']);
  assert.ok(calls[0].tools.length >= 10, 'tools schema is sent to the model');
}));

test('loop stops at propose_action and returns a validated action without executing it', withEnv('GROQ_API_KEY', 'test-key', async () => {
  let calls = 0;
  global.fetch = (async () => {
    calls++;
    return groqResponse({ role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'propose_action', arguments: '{"action_name":"set_batch_fee","arguments":{"batch_name":"GNIT Batch 2","fee_amount":2500}}' } }] });
  }) as any;
  const r = await runAdminAgentLoop(fakeDb(), 'set GNIT Batch 2 fee to 2500', { profileId: 'a1', role: 'admin' });
  assert.equal(calls, 1);
  assert.deepEqual(r?.action, { name: 'set_batch_fee', args: { batch_name: 'GNIT Batch 2', fee_amount: 2500 } });
  assert.equal(r?.answer, undefined);
}));

test('loop rejects an unknown proposed action name', withEnv('GROQ_API_KEY', 'test-key', async () => {
  global.fetch = (async () => groqResponse({ role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'propose_action', arguments: '{"action_name":"drop_database","arguments":{}}' } }] })) as any;
  assert.equal(await runAdminAgentLoop(fakeDb(), 'drop everything', { profileId: 'a1', role: 'super_admin' }), null);
}));

test('loop returns null when the provider errors', withEnv('GROQ_API_KEY', 'test-key', async () => {
  global.fetch = (async () => ({ ok: false, status: 503, json: async () => ({}) })) as any;
  assert.equal(await runAdminAgentLoop(fakeDb(), 'status', { profileId: 'a1', role: 'admin' }), null);
}));

test('loop survives a tool failure by reporting it back to the model', withEnv('GROQ_API_KEY', 'test-key', async () => {
  let calls = 0;
  global.fetch = (async (_input: any, init?: any) => {
    calls++;
    if (calls === 1) return groqResponse({ role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'no_such_tool', arguments: '{}' } }] });
    const body = JSON.parse(init!.body);
    const toolMsg = body.messages.find((m: any) => m.role === 'tool');
    assert.match(toolMsg.content, /Unknown read tool/);
    return groqResponse({ role: 'assistant', content: 'I could not fetch that.' });
  }) as any;
  const r = await runAdminAgentLoop(fakeDb(), 'something', { profileId: 'a1', role: 'admin' });
  assert.equal(r?.answer, 'I could not fetch that.');
}));


test('fast reads understand common mixed Telugu and avoid swallowing scoped actions', () => {
  assert.equal(matchFastRead('pending payments enni?'), 'pending_payments');
  assert.equal(matchFastRead('batches chupinchu'), 'batch_status');
  assert.equal(matchFastRead('send reminders for pending payments'), null);
  assert.equal(matchFastRead('GNITC batch 1 pending payments'), null);
});

test('database failures never masquerade as zero students or payments', async () => {
  const broken: any = { from() { const q: any = new Proxy({}, { get(_t, prop) {
    if (prop === 'then') return (resolve: any) => resolve({ data: null, error: { message: 'unavailable' } });
    return () => q;
  } }); return q; } };
  await assert.rejects(() => findStudent(broken, 'Ravi'), /live data is unavailable/);
});

test('provider fallback preserves read tool results instead of restarting', withEnv('GROQ_API_KEY', 'test-key', async () => {
  const saved = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = 'test-router';
  try {
    let count = 0;
    global.fetch = (async (url: any, init: any) => {
      count++;
      if (count === 1) return groqResponse({ role: 'assistant', content: null, tool_calls: [{ id: 'read1', type: 'function', function: { name: 'count_paid', arguments: '{"batch_ref":"GNITC"}' } }] });
      if (count === 2) return { ok: false, status: 503 };
      assert.match(String(url), /groq/);
      const body = JSON.parse(init.body);
      assert.ok(body.messages.some((m: any) => m.role === 'tool' && /GNITC Batch 1/.test(m.content)));
      return groqResponse({ role: 'assistant', content: 'GNITC has one paid student.' });
    }) as any;
    assert.equal((await runAdminAgentLoop(fakeDb(), 'GNITC lo entha mandi kattaru?', { profileId: 'a1', role: 'admin' }))?.answer, 'GNITC has one paid student.');
    assert.equal(count, 3);
  } finally {
    if (saved === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = saved;
  }
}));

test('malformed tool arguments never become a write proposal', withEnv('GROQ_API_KEY', 'test-key', async () => {
  global.fetch = (async () => groqResponse({ role: 'assistant', content: null, tool_calls: [{ id: 'bad', type: 'function', function: { name: 'propose_action', arguments: 'invalid' } }] })) as any;
  assert.equal(await runAdminAgentLoop(fakeDb(), 'change fee', { profileId: 'a1', role: 'admin' }), null);
}));


test('document lookup exposes status metadata, not paths or invented certificate outcomes', async () => {
  const rows = await getStudentDocuments(fakeDb(), 'Ravi');
  assert.equal(rows[0].college_id_uploaded, true);
  assert.equal(rows[0].signature_check, false);
  assert.equal(rows[0].petition, null);
  assert.ok(!JSON.stringify(rows).includes('docs/s2.jpg'));
});

test('malformed provider tool output falls through to another configured provider', withEnv('GROQ_API_KEY', 'test-key', async () => {
  const saved = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = 'test-router';
  try {
    let calls = 0;
    global.fetch = (async () => {
      calls++;
      if (calls === 1) return groqResponse({ role: 'assistant', content: null, tool_calls: [{ id: 'bad', type: 'function', function: { name: 'find_student', arguments: 'not json' } }] });
      return groqResponse({ role: 'assistant', content: 'Which student do you mean?' });
    }) as any;
    assert.equal((await runAdminAgentLoop(fakeDb(), 'find him', { profileId: 'a1', role: 'admin' }))?.answer, 'Which student do you mean?');
    assert.equal(calls, 2);
  } finally {
    if (saved === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = saved;
  }
}));

test('OpenRouter model override cannot opt Jarvis into a paid model', withEnv('GROQ_API_KEY', undefined, async () => {
  const savedKey = process.env.OPENROUTER_API_KEY;
  const savedModel = process.env.OPENROUTER_MODEL;
  process.env.OPENROUTER_API_KEY = 'test-router';
  process.env.OPENROUTER_MODEL = 'paid/model';
  try {
    global.fetch = (async (_url: any, init: any) => {
      assert.ok(JSON.parse(init.body).model.endsWith(':free'));
      return groqResponse({ role: 'assistant', content: 'Which batch?' });
    }) as any;
    assert.ok(await runAdminAgentLoop(fakeDb(), 'fees?', { profileId: 'a1', role: 'admin' }));
  } finally {
    if (savedKey === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = savedKey;
    if (savedModel === undefined) delete process.env.OPENROUTER_MODEL; else process.env.OPENROUTER_MODEL = savedModel;
  }
}));

test('approved payment for a different batch does not clear current batch dues', async () => {
  fixtures.profiles.push({ ...fixtures.profiles[0], id: 'transfer', batch_id: 'b1', full_name: 'Transfer Student' });
  fixtures.payments.push({ ...fixtures.payments[2], id: 'oldbatch', student_id: 'transfer', batch_id: 'b2' });
  try {
    const unpaid = await listUnpaidStudents(fakeDb(), undefined);
    assert.ok(unpaid.items.some(p => p.name === 'Transfer Student'));
  } finally {
    fixtures.profiles.pop(); fixtures.payments.pop();
  }
});

test('listTodayPayments returns only approved payments reviewed today, newest first', withFrozenNow(async () => {
  const r = await listTodayPayments(fakeDb());
  assert.equal(r.count, 1); // p-today-44 only: p-ok-3333 is 3 days old, p-rej-5555 rejected
  assert.equal(r.total, 1800);
  assert.equal(r.items[0].student, 'Asha Rao');
  assert.equal(r.items[0].roll, '21GN1A0501');
  assert.equal(r.items[0].batch, 'GNIT Batch 1');
  const text = renderTodayPayments(r);
  assert.match(text, /Yes — 1 payment approved today \(₹1,800 total\)/);
  assert.match(text, /Asha Rao \(21GN1A0501\) — ₹1,800 — GNIT Batch 1/);
  assert.equal(renderTodayPayments({ count: 0, total: 0, items: [] }), 'No payments have been approved today yet.');
}));

test('fast path: "did anyone paid today" hits today_payments, not pending', withFrozenNow(async () => {
  assert.equal(matchFastRead('did anyone paid today'), 'today_payments');
  assert.equal(matchFastRead('did anyone pay today?'), 'today_payments');
  assert.equal(matchFastRead('who paid today'), 'today_payments');
  assert.equal(matchFastRead("show me today's payments"), 'today_payments');
  assert.equal(matchFastRead('show pending payments'), 'pending_payments'); // regression: review queue untouched
  const text = await runFastRead(fakeDb(), 'today_payments');
  assert.match(text, /Yes — 1 payment approved today/);
}));

test('parseTextToolCalls executes the leaked [[{...}]] block instead of showing it', () => {
  const leaked = '[[{"name":"list_pending_payments","parameters":{"limit":15}}]]';
  assert.deepEqual(parseTextToolCalls(leaked), [{ name: 'list_pending_payments', args: { limit: 15 } }]);
  assert.deepEqual(parseTextToolCalls('[[{"name":"list_today_payments","arguments":{}}]]'), [{ name: 'list_today_payments', args: {} }]);
  assert.deepEqual(parseTextToolCalls('[[{"name":"propose_action","parameters":{"action_name":"delete_student"}}]]'), []); // writes never via text
  assert.deepEqual(parseTextToolCalls('Just a normal answer.'), []);
  assert.deepEqual(parseTextToolCalls('[[not json]]'), []);
});

test('sanitizeAnswer strips every protocol block, keeps the words', () => {
  assert.equal(sanitizeAnswer('[[{"name":"list_pending_payments","parameters":{"limit":15}}]]'), '');
  assert.equal(sanitizeAnswer('Here you go [[ACTION approve_payment]] done'), 'Here you go done');
  assert.equal(sanitizeAnswer('Watch [[VIDEO xyz]] now'), 'Watch now');
  assert.equal(sanitizeAnswer('2 payments waiting for review.'), '2 payments waiting for review.');
});

test('loop executes a textual pseudo-tool-call and answers in words, never raw JSON', withEnv('GROQ_API_KEY', 'test-key', withFrozenNow(async () => {
  let calls = 0;
  global.fetch = (async () => {
    calls++;
    if (calls === 1) return groqResponse({ role: 'assistant', content: '[[{"name":"list_today_payments","parameters":{"limit":15}}]]' });
    return groqResponse({ role: 'assistant', content: 'Yes — 1 payment approved today: Asha Rao paid ₹1,800.' });
  }) as any;
  const res = await runAdminAgentLoop(fakeDb(), 'did anyone paid today', { profileId: 'a1', role: 'admin' });
  assert.ok(res?.answer);
  assert.doesNotMatch(res.answer!, /\[\[/);
  assert.match(res.answer!, /Asha Rao/);
  assert.ok(res.toolsUsed.includes('list_today_payments'));
  assert.equal(calls, 2);
})));
