/**
 * The chat box's Host half.
 *
 * The wire shape is asserted literally, because it is the one part of this file that is not
 * ours: it was read from the platform's live `sessionController.prompt` contract, and if that
 * contract moves, a test that only checked "we called something" would keep passing while
 * every message failed to arrive.
 *
 * The order is asserted too — the session is resumed before the prompt is admitted, because the
 * method documents itself as admitting "after explicitly resuming its Session".
 *
 * Run: node test/chat-check.mjs
 */

import './isolate.mjs';
import assert from 'node:assert/strict';

const {
  buildPrompt, pickSession, sendChat, listSessions, sessionIdOf, sessionLabel, newRequestId, MAX_CHAT_CHARS,
} = await import('../lib/chat.js');

let failures = 0;
async function verify(name, run) {
  try {
    await run();
    console.log(`  PASS  ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`  FAIL  ${name}: ${error.message}`);
  }
}

/** A Host stub that records what it was asked, so order and arguments are observable. */
function fakeCtx({ sessions = [], promptValue = { accepted: true }, throwOnPrompt = null } = {}) {
  const calls = [];
  return {
    calls,
    sessionController: {
      async list() { calls.push(['list']); return sessions; },
      async resolveAgent(id) { calls.push(['resolveAgent', id]); },
      async prompt(request) {
        calls.push(['prompt', request]);
        if (throwOnPrompt) throw throwOnPrompt;
        return promptValue;
      },
    },
  };
}

await verify('the prompt request is exactly the documented shape', async () => {
  const request = buildPrompt({ sessionId: 's-1', text: '筛选前 20 个候选人', requestId: 'r-1', timeZone: 'Asia/Shanghai' });
  assert.deepEqual(request, {
    requestId: 'r-1',
    sessionId: 's-1',
    mode: 'queue',
    content: [{ type: 'text', text: '筛选前 20 个候选人' }],
    clientTimeZone: 'Asia/Shanghai',
  });
  // The optional field is omitted rather than sent empty, so the Host's own default applies.
  const bare = buildPrompt({ sessionId: 's-1', text: 'hi', requestId: 'r-2' });
  assert.equal('clientTimeZone' in bare, false, 'an empty time zone was sent');
  assert.deepEqual(Object.keys(bare).sort(), ['content', 'mode', 'requestId', 'sessionId']);
});

await verify('a message that cannot be sent is refused, not silently dropped', async () => {
  // buildPrompt is synchronous, so each case is wrapped: assert.rejects on a plain function
  // that throws synchronously lets the error through instead of asserting on it.
  await assert.rejects(async () => buildPrompt({ sessionId: 's-1', text: '   ', requestId: 'r' }), /empty/);
  await assert.rejects(async () => buildPrompt({ sessionId: 's-1', text: 'x'.repeat(MAX_CHAT_CHARS + 1), requestId: 'r' }), /the most that may be sent/);
  await assert.rejects(async () => buildPrompt({ sessionId: '', text: 'hi', requestId: 'r' }), /session is required/);
  await assert.rejects(async () => buildPrompt({ sessionId: 's', text: 'hi', requestId: '' }), /request id/);
  await assert.rejects(async () => buildPrompt({ sessionId: 's', text: 'hi', requestId: 'r', mode: 'loud' }), /unknown delivery mode/);
  // Exactly at the limit is allowed: the boundary is a ceiling, not a fence post short of it.
  assert.equal(buildPrompt({ sessionId: 's', text: 'x'.repeat(MAX_CHAT_CHARS), requestId: 'r' }).content[0].text.length, MAX_CHAT_CHARS);
});

await verify('the most recently active session is the one chosen', async () => {
  const list = [
    { sessionId: 's-current', title: '适配智联' },
    { sessionId: 's-older', title: '另一个会话' },
  ];
  assert.equal(sessionIdOf(pickSession(list)), 's-current');
  assert.equal(sessionLabel(pickSession(list)), '适配智联');
  assert.equal(pickSession([]), null);
  assert.equal(pickSession(null), null);
  // Field names are not assumed: a row that names its identity differently still resolves.
  assert.equal(sessionIdOf(pickSession([{ id: 'other' }])), 'other');
});

await verify('sending resumes the session first, then admits the prompt', async () => {
  const ctx = fakeCtx({ sessions: [{ sessionId: 's-1', title: '适配智联' }] });
  const result = await sendChat(ctx, { text: '你好', timeZone: 'Asia/Shanghai' });
  assert.equal(result.accepted, true);
  assert.equal(result.sessionId, 's-1');
  assert.equal(result.session, '适配智联');
  assert.deepEqual(ctx.calls.map((call) => call[0]), ['list', 'resolveAgent', 'prompt']);
  const request = ctx.calls[2][1];
  assert.equal(request.sessionId, 's-1');
  assert.equal(request.mode, 'queue');
  assert.deepEqual(request.content, [{ type: 'text', text: '你好' }]);
  assert.match(request.requestId, /^chat-/);
});

await verify('a named session skips the listing and is used as given', async () => {
  const ctx = fakeCtx();
  const result = await sendChat(ctx, { text: '继续', sessionId: 's-named' });
  assert.equal(result.sessionId, 's-named');
  assert.deepEqual(ctx.calls.map((call) => call[0]), ['resolveAgent', 'prompt']);
});

await verify('steering is available but never the default', async () => {
  const ctx = fakeCtx({ sessions: [{ sessionId: 's-1' }] });
  await sendChat(ctx, { text: '停下', mode: 'steer' });
  // The last call is the prompt regardless of how many calls came before it.
  assert.equal(ctx.calls.at(-1)[1].mode, 'steer');
  const queued = fakeCtx({ sessions: [{ sessionId: 's-1' }] });
  await sendChat(queued, { text: '停下' });
  assert.equal(queued.calls.at(-1)[1].mode, 'queue', 'the default mode became steering, which interrupts work');
});

await verify('nothing to send to is reported, never silently swallowed', async () => {
  await assert.rejects(() => sendChat(fakeCtx({ sessions: [] }), { text: 'hi' }), /no conversation is open/);
  await assert.rejects(() => sendChat({}, { text: 'hi' }), /no session controller/);
  await assert.rejects(() => sendChat({ sessionController: {} }, { text: 'hi' }), /no prompt method/);
  // A Host that refuses the prompt must surface its reason rather than reporting success.
  const refusing = fakeCtx({ sessions: [{ sessionId: 's-1' }], throwOnPrompt: new Error('the agent is not accepting prompts') });
  await assert.rejects(() => sendChat(refusing, { text: 'hi' }), /not accepting prompts/);
});

await verify('a Host that does not acknowledge is not reported as accepted', async () => {
  const ctx = fakeCtx({ sessions: [{ sessionId: 's-1' }], promptValue: {} });
  const result = await sendChat(ctx, { text: 'hi' });
  assert.equal(result.accepted, false, 'an unacknowledged prompt was reported as accepted');
});

await verify('listing tolerates the shapes a Host may return', async () => {
  const wrapped = { sessionController: { async list() { return { items: [{ sessionId: 's-9' }] }; } } };
  assert.equal(sessionIdOf(pickSession(await listSessions(wrapped))), 's-9');
  const direct = { sessionController: { async list() { return [{ sessionId: 's-8' }]; } } };
  assert.equal(sessionIdOf(pickSession(await listSessions(direct))), 's-8');
});

await verify('request ids do not repeat', async () => {
  const ids = new Set();
  for (let i = 0; i < 500; i += 1) ids.add(newRequestId());
  assert.equal(ids.size, 500, `${500 - ids.size} request ids collided`);
});

// ── the route the page actually calls ────────────────────────────────────────
// Driven over HTTP against the plugin's own viewer, so what is exercised is the path the chat
// box takes — fetch, route, body reading, the Host call — rather than the function behind it.
console.log('\n=== the chat route ===');

const { apply } = await import('../index.js');
const sent = [];
let failNext = null;
const ctx = {
  tools: { register() {} },
  effect: () => {},
  logger: { debug() {} },
  inject: () => () => {},
  get: (key) => (key === 'sessionController' ? {
    async list() { return [{ sessionId: 's-live', title: '适配智联' }]; },
    async resolveAgent(id) { sent.push(['resolveAgent', id]); },
    async prompt(request) {
      if (failNext) { const error = failNext; failNext = null; throw error; }
      sent.push(['prompt', request]);
      return { accepted: true };
    },
  } : undefined),
};
const handle = apply(ctx, { viewer: true, viewerPort: 0, profileDir: `/tmp/jev-chat-profile-${process.pid}` });
await new Promise((resolve) => setTimeout(resolve, 300));
const base = handle.viewer.url;
const post = (body) => fetch(new URL('chat', base), {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body),
});

await verify('a message typed on the page reaches the conversation', async () => {
  sent.length = 0;
  const response = await post({ text: '筛选前 20 个候选人' });
  const value = await response.json().catch(async () => ({ body: await response.text() }));
  assert.equal(response.status, 200, JSON.stringify(value));
  assert.equal(value.ok, true);
  assert.equal(value.accepted, true);
  assert.equal(value.sessionId, 's-live');
  assert.equal(value.session, '适配智联');
  assert.deepEqual(sent.map((entry) => entry[0]), ['resolveAgent', 'prompt']);
  const request = sent[1][1];
  assert.equal(request.sessionId, 's-live');
  assert.equal(request.mode, 'queue');
  assert.deepEqual(request.content, [{ type: 'text', text: '筛选前 20 个候选人' }]);
});

await verify('an empty message is refused by the route, not sent', async () => {
  sent.length = 0;
  const response = await post({ text: '   ' });
  assert.equal(response.status, 409);
  assert.match(await response.text(), /empty/);
  assert.equal(sent.length, 0, 'an empty message reached the Host');
});

await verify('a Host that refuses the prompt reports why', async () => {
  failNext = new Error('the conversation is compacting; try again shortly');
  const response = await post({ text: '你好' });
  assert.equal(response.status, 409);
  assert.match(await response.text(), /compacting/);
});

await verify('a malformed body is refused before anything is sent', async () => {
  sent.length = 0;
  const response = await post('{ not json');
  assert.equal(response.status, 400);
  assert.equal(sent.length, 0);
});

await handle.viewer.close();
await handle.sessions?.closeAll?.().catch?.(() => {});

console.log(`\n===== ${failures} failure(s) =====`);
process.exit(failures === 0 ? 0 : 1);
