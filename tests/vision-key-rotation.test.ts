import { strict as assert } from 'node:assert';
import { test, beforeEach } from 'node:test';
import { callVision } from '../src/lib/vision';

const IMG = 'https://example.com/id.jpg';
const PROMPT = 'p';
const SUCCESS_TEXT = '{"is_id_card":true,"has_signature":true,"notes":null}';

let geminiCalls: string[] = [];

function mockFetch() {
  (globalThis as any).fetch = async (url: string, init?: any) => {
    if (typeof url === 'string' && url.includes('generativelanguage.googleapis.com')) {
      const key = new URL(url).searchParams.get('key') ?? '';
      geminiCalls.push(key);
      if (key === 'key1') {
        return {
          ok: false, status: 429,
          text: async () => '{"error":{"message":"Quota exceeded for quota metric"}}',
        };
      }
      return {
        ok: true, status: 200,
        json: async () => ({
          candidates: [{ finishReason: 'STOP', content: { parts: [{ text: SUCCESS_TEXT }] } }],
        }),
      };
    }
    // image fetch
    return {
      ok: true,
      headers: { get: () => 'image/jpeg' },
      arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
    };
  };
}

beforeEach(() => {
  geminiCalls = [];
  delete process.env.EMBEDDINGS_API_KEY;
  delete process.env.GROQ_API_KEY;
  process.env.GEMINI_API_KEY = 'key1';
  process.env.GEMINI_API_KEY_2 = 'key2';
  delete process.env.GEMINI_API_KEY_3;
  delete process.env.GEMINI_API_KEY_4;
  delete process.env.GEMINI_API_KEY_5;
  mockFetch();
});

test('rotates to the next free key when the first hits quota', async () => {
  const out = await callVision({ prompt: PROMPT, imageUrl: IMG, label: 'id-ocr' });
  assert.equal(out, SUCCESS_TEXT);
  assert.deepEqual(geminiCalls, ['key1', 'key2']);
});

test('a quarantined key is skipped on the next call', async () => {
  await callVision({ prompt: PROMPT, imageUrl: IMG, label: 'id-ocr' });
  geminiCalls = [];
  // different image URL so the result cache does not mask the key choice
  const out = await callVision({ prompt: PROMPT, imageUrl: IMG + '?v=2', label: 'id-ocr' });
  assert.equal(out, SUCCESS_TEXT);
  assert.deepEqual(geminiCalls, ['key2']);
});

test('identical image+label is served from cache without burning quota', async () => {
  const first = await callVision({ prompt: PROMPT, imageUrl: IMG, label: 'id-ocr' });
  const callsAfterFirst = geminiCalls.length;
  const second = await callVision({ prompt: PROMPT, imageUrl: IMG, label: 'id-ocr' });
  assert.equal(first, SUCCESS_TEXT);
  assert.equal(second, SUCCESS_TEXT);
  assert.equal(geminiCalls.length, callsAfterFirst, 'cache should prevent extra Gemini calls');
});

test('returns null when every key is exhausted and no Groq key exists', async () => {
  process.env.GEMINI_API_KEY = 'key1';
  process.env.GEMINI_API_KEY_2 = 'key1b'; // distinct but also 429
  (globalThis as any).fetch = async (url: string) => {
    if (typeof url === 'string' && url.includes('generativelanguage.googleapis.com')) {
      return {
        ok: false, status: 429,
        text: async () => '{"error":{"message":"Quota exceeded"}}',
      };
    }
    if (typeof url === 'string' && url.includes('api.groq.com')) {
      return { ok: false, status: 401, text: async () => 'no key' };
    }
    return {
      ok: true,
      headers: { get: () => 'image/jpeg' },
      arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
    };
  };
  const out = await callVision({ prompt: PROMPT, imageUrl: IMG + '?v=3', label: 'id-ocr' });
  assert.equal(out, null);
});
