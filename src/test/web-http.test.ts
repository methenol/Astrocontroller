import fs from 'node:fs';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import type { Request, Response } from 'express';
import { body, HttpError, notFound, queryNumber, rejectCrossSite, route, sameOrigin } from '../web/http.js';
import { MAX_PROMPT_BASE64_CHARS, PromptBody } from '../web/routes/agent.js';
import { ControlBody } from '../web/routes/control.js';
import { ThumbCache } from '../web/routes/media.js';

function fakeRes() {
  const r = { statusCode: 200, sent: undefined as unknown, headersSent: false };
  const res = {
    get headersSent() {
      return r.headersSent;
    },
    status(c: number) {
      r.statusCode = c;
      return res;
    },
    json(v: unknown) {
      r.sent = v;
      r.headersSent = true;
      return res;
    },
  };
  return { r, res: res as unknown as Response };
}
const req = (b: unknown, query: Record<string, string> = {}) => ({ body: b, query }) as unknown as Request;

describe('web http helpers', () => {
  test('route sends the result, or ok for undefined', async () => {
    const a = fakeRes();
    await route(async () => ({ x: 1 }))(req({}), a.res);
    assert.deepEqual(a.r.sent, { x: 1 });
    const b = fakeRes();
    await route(async () => undefined)(req({}), b.res);
    assert.deepEqual(b.r.sent, { ok: true });
  });

  test('route maps errors to their status (400 by default)', async () => {
    const a = fakeRes();
    await route(async () => {
      throw new Error('boom');
    })(req({}), a.res);
    assert.equal(a.r.statusCode, 400);
    assert.deepEqual(a.r.sent, { error: 'boom' });
    const b = fakeRes();
    await route(async () => {
      throw notFound('gone');
    })(req({}), b.res);
    assert.equal(b.r.statusCode, 404);
  });

  test('body names the offending field', () => {
    assert.throws(() => body(req({ n: 'x' }), z.object({ n: z.number() })), (e: unknown) => e instanceof HttpError && e.status === 400 && /^n:/.test(e.message));
    assert.deepEqual(body(req(undefined), z.object({ n: z.number().optional() })), {});
  });

  test('only this app\'s own pages (or non-browser clients) may control the telescope', () => {
    assert.ok(sameOrigin(undefined, ['scope.local:8080']), 'no Origin: curl, MCP');
    assert.ok(sameOrigin('http://scope.local:8080', ['scope.local:8080']));
    assert.ok(sameOrigin('https://astro.example', ['127.0.0.1:8080', 'astro.example']), 'through a reverse proxy');
    assert.ok(!sameOrigin('https://evil.example', ['scope.local:8080']));
    assert.ok(!sameOrigin('null', ['scope.local:8080']));
    const post = (origin?: string) => ({ method: 'POST', headers: { host: 'scope.local:8080', ...(origin ? { origin } : {}) } }) as unknown as Request;
    let passed = 0;
    const a = fakeRes();
    rejectCrossSite(post('https://evil.example'), a.res, () => passed++);
    assert.equal(a.r.statusCode, 403);
    rejectCrossSite(post('http://scope.local:8080'), fakeRes().res, () => passed++);
    rejectCrossSite({ method: 'GET', headers: { host: 'x', origin: 'https://evil.example' } } as unknown as Request, fakeRes().res, () => passed++);
    assert.equal(passed, 2);
  });

  test('prompt images are checked: type, encoding and count', () => {
    assert.ok(PromptBody.safeParse({ text: 'hi', images: [{ data: 'AAAA', mimeType: 'image/jpeg' }] }).success);
    assert.ok(!PromptBody.safeParse({ text: 'hi', images: [{ data: 'AAAA', mimeType: 'text/html' }] }).success);
    assert.ok(!PromptBody.safeParse({ text: 'hi', images: [{ data: '<script>', mimeType: 'image/png' }] }).success);
    assert.ok(!PromptBody.safeParse({ text: 'hi', images: Array(9).fill({ data: 'AAAA', mimeType: 'image/png' }) }).success);
    // each image within its own limit, but together more than a request body holds
    const big = { data: 'A'.repeat(15 * 1024 * 1024), mimeType: 'image/png' };
    const tooMany = PromptBody.safeParse({ text: 'hi', images: [big, big, big, big] });
    assert.ok(!tooMany.success && /together are too large/.test(tooMany.error.issues[0].message));
    assert.ok(PromptBody.safeParse({ text: 'hi', images: [big, big, big] }).success);
    assert.ok(!PromptBody.safeParse({ text: '   ' }).success);
  });

  test('queryNumber ignores empty and non-numeric values', () => {
    assert.equal(queryNumber(req({}, { n: '12' }), 'n'), 12);
    assert.equal(queryNumber(req({}, { n: '' }), 'n'), undefined);
    assert.equal(queryNumber(req({}, { n: 'abc' }), 'n'), undefined);
  });
});

describe('manual control bodies', () => {
  test('nudge gets defaults and rejects bad numbers before anything is sent', () => {
    assert.deepEqual(ControlBody.parse({ action: 'nudge', angle: 90 }), { action: 'nudge', angle: 90, speed: 0.5, ms: 600 });
    assert.equal(ControlBody.safeParse({ action: 'nudge', angle: 'left' }).success, false);
    assert.equal(ControlBody.safeParse({ action: 'nudge', speed: 5 }).success, false);
  });

  test('unknown actions and a GoTo without a name are refused', () => {
    assert.equal(ControlBody.safeParse({ action: 'warp' }).success, false);
    assert.equal(ControlBody.safeParse({ action: 'goto' }).success, false);
    assert.equal(ControlBody.safeParse({ action: 'park' }).success, true);
  });

  test('focus steps are bounded', () => {
    assert.equal(ControlBody.safeParse({ action: 'focus', direction: 'far', steps: 3 }).success, true);
    assert.equal(ControlBody.safeParse({ action: 'focus', direction: 'far', steps: 5000 }).success, false);
    assert.deepEqual(ControlBody.parse({ action: 'timelapse', camera: 'tele', on: true, intervalS: '5' }), { action: 'timelapse', camera: 'tele', on: true, intervalS: 5 });
    assert.equal(ControlBody.safeParse({ action: 'timelapse', intervalS: 600 }).success, false);
  });
});

describe('thumbnail cache', () => {
  test('keeps small files, skips large ones, evicts the oldest', () => {
    const c = new ThumbCache();
    c.put('/a', Buffer.alloc(10), 'image/jpeg');
    c.put('/big', Buffer.alloc(3e6), 'image/jpeg');
    assert.ok(c.get('/a'));
    assert.equal(c.get('/big'), null);
    for (let i = 0; i < 300; i++) c.put(`/f${i}`, Buffer.alloc(1), 'image/jpeg');
    assert.equal(c.get('/a'), null);
    assert.ok(c.get('/f299'));
    c.clear();
    assert.equal(c.get('/f299'), null);
  });

  test('all entries together stay within the byte budget', () => {
    const c = new ThumbCache();
    for (let i = 0; i < 100; i++) c.put(`/p${i}`, Buffer.alloc(1.9e6), 'image/jpeg');
    assert.ok(c.size <= 64 * 1024 * 1024, `${c.size} bytes held`);
    assert.ok(c.get('/p99'), 'the newest stays');
    assert.equal(c.get('/p0'), null, 'the oldest went first');
    c.put('/p99', Buffer.alloc(10), 'image/jpeg');
    c.clear();
    assert.equal(c.size, 0);
  });
});

describe('the web UI attachment limits', () => {
  // public/js/chat.js checks an image when it is attached: its limits must be the server's, or a
  // message the UI accepted is refused only after it was typed and sent
  const chat = fs.readFileSync(new URL('../../public/js/chat.js', import.meta.url), 'utf8');
  const constant = (name: string) => {
    const m = new RegExp(`const ${name} = ([^;]+);`).exec(chat);
    assert.ok(m, `${name} in chat.js`);
    return Function(`return (${m[1]})`)() as number;
  };

  test('the per-message total, the per-image size and the count match the prompt schema', () => {
    assert.equal(constant('MAX_ATTACH_TOTAL_B64_CHARS'), MAX_PROMPT_BASE64_CHARS);
    const big = { data: 'A'.repeat(constant('MAX_ATTACH_B64_CHARS')), mimeType: 'image/png' };
    assert.ok(PromptBody.safeParse({ text: 'hi', images: [big] }).success);
    assert.ok(!PromptBody.safeParse({ text: 'hi', images: [{ ...big, data: `${big.data}AAAA` }] }).success);
    const n = constant('MAX_ATTACHMENTS');
    assert.ok(PromptBody.safeParse({ text: 'hi', images: Array(n).fill({ data: 'AAAA', mimeType: 'image/png' }) }).success);
    assert.ok(!PromptBody.safeParse({ text: 'hi', images: Array(n + 1).fill({ data: 'AAAA', mimeType: 'image/png' }) }).success);
  });
});
