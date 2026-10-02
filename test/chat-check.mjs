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

await verify('the prompt is sent with an abort signal, because the platform requires one', async () => {
  const seen = [];
  const ctx = {
    sessionController: {
      async list() { return [{ sessionId: 's-1' }]; },
      async resolveAgent() {},
      async prompt(request, signal) { seen.push(signal); return { accepted: true }; },
    },
  };
  await sendChat(ctx, { text: '你好' });
  assert.equal(seen.length, 1);
  // Absent is a crash on the real Host, so the caller supplies one even when it has nothing to
  // cancel with: an un-cancellable prompt is fine, a crashing one is not.
  const supplied = seen[0] === undefined ? null : seen[0];
  assert.ok(supplied, 'no signal reached the platform call');
  assert.equal(typeof supplied?.throwIfAborted, 'function', 'the signal is not a real AbortSignal');
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
    // The panel's conversation is the workbench's own, so the Host must be able to produce one.
    async create(request) { return { sessionId: request?.sessionId ?? 'session-workbench' }; },
    async list() { return [{ sessionId: 's-live', title: '适配智联' }]; },
    async resolveAgent(id) { sent.push(['resolveAgent', id]); },
    async prompt(request, signal) {
      // The real method declares `signal` as its cancellation parameter and calls into it, so
      // omitting it is not "no cancellation" — it throws inside the Host. A stub that ignored the
      // argument let exactly that bug through, so this one insists on it.
      if (!signal || typeof signal.throwIfAborted !== 'function') {
        throw new Error("Cannot read properties of undefined (reading 'throwIfAborted')");
      }
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
  // The workbench's own session, which the Host created here — not the session `list` offered.
  assert.equal(value.sessionId, 'session-workbench');
  // Two resolutions and one prompt: the route resolves the agent so the role can be installed on
  // its own context, and `sendChat` resolves the session it was given before admitting the prompt.
  assert.deepEqual(sent.map((entry) => entry[0]), ['resolveAgent', 'resolveAgent', 'prompt']);
  const request = sent.at(-1)[1];
  assert.equal(request.sessionId, 'session-workbench');
  assert.equal(request.mode, 'queue');
  assert.deepEqual(request.content, [{ type: 'text', text: '筛选前 20 个候选人' }]);
});

await verify('an empty message is refused by the route, not sent', async () => {
  sent.length = 0;
  const response = await post({ text: '   ' });
  assert.equal(response.status, 409);
  assert.match(await response.text(), /empty/);
  // Nothing at all: no session resolved, no agent woken, no prompt. The message is checked before
  // anything is looked up, exactly so that a refusal is not also a side effect.
  assert.deepEqual(sent, [], `an empty message touched the Host: ${JSON.stringify(sent)}`);
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

// ── the stream the panel reads ───────────────────────────────────────────────
// Driven over HTTP as the panel drives it, with a Host stub that yields the frames the platform
// yields, so what is asserted is the path — route, SSE framing, normalisation — and not a helper.
console.log('\n=== the transcript stream ===');

const streamed = [];
const streamCtx = {
  tools: { register() {} },
  effect: () => {},
  logger: { debug() {} },
  inject: () => () => {},
  get: (key) => (key === 'sessionController' ? {
    async create(request) { return { sessionId: request?.sessionId ?? 'session-workbench' }; },
    async list() { return [{ sessionId: 's-live', title: '适配智联' }]; },
    follow(request, signal) {
      streamed.push(request);
      const frames = [
        { type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } },
        { type: 'user/message', seq: 2, time: 2, data: { id: 'u1', role: 'user', content: [{ type: 'text', text: '筛选前 20 个' }] } },
        { type: 'tool/call', seq: 3, time: 3, data: { name: 'browser_inspect' } },
        { type: 'assistant/message', seq: 4, time: 4, data: { turn: 1, step: 1, message: { id: 'a1', role: 'assistant', content: [{ type: 'text', text: '好，我来。' }] } } },
        { type: 'something/unknown', seq: 5, time: 5, data: {} },
      ];
      return (async function* generate() { for (const frame of frames) yield frame; })();
    },
  } : undefined),
};
const streamHandle = apply(streamCtx, { viewer: true, viewerPort: 0, profileDir: `/tmp/jev-chat-stream-${process.pid}` });
await new Promise((resolve) => setTimeout(resolve, 300));

/** Read an SSE response to the end and return the parsed frames. */
async function readStream(url) {
  const response = await fetch(url);
  assert.equal(response.status, 200, `the stream was refused: ${response.status}`);
  const text = await response.text();
  return text.split('\n\n')
    .map((block) => block.split('\n').find((line) => line.startsWith('data: ')))
    .filter(Boolean)
    .map((line) => JSON.parse(line.slice(6)));
}

await verify('the panel is told which session it is reading, before the stream ends', async () => {
  const frames = await readStream(new URL('chat/stream', streamHandle.viewer.url));
  const session = frames.find((frame) => frame.kind === 'session');
  assert.ok(session, `no session frame: ${JSON.stringify(frames)}`);
  // The workbench's own conversation — created for this purpose — not the session that happened
  // to be most recently active. The stub's `list` offers 's-live' and it must not be used.
  assert.equal(session.sessionId, 'session-workbench');
  // The session frame must not be last: a live stream never ends, so a panel that only learned
  // it at the end would never learn it at all.
  assert.notEqual(frames[frames.length - 1].kind, 'session', 'the session was reported only at the end');
});

await verify('the exchange arrives as messages and statuses, and unknowns are counted', async () => {
  const frames = await readStream(new URL('chat/stream', streamHandle.viewer.url));
  const messages = frames.filter((frame) => frame.kind === 'message').map((frame) => [frame.message.role, frame.message.text]);
  assert.deepEqual(messages, [['user', '筛选前 20 个'], ['assistant', '好，我来。']]);
  const statuses = frames.filter((frame) => frame.kind === 'status').map((frame) => frame.text);
  assert.ok(statuses.some((text) => /正在回复/.test(text)), `no busy status: ${JSON.stringify(statuses)}`);
  assert.ok(statuses.some((text) => /browser_inspect/.test(text)), `no tool status: ${JSON.stringify(statuses)}`);
  const end = frames.find((frame) => frame.kind === 'end');
  assert.equal(end.ignored, 1, 'the unrecognised frame was not counted');
});

await verify('the stream asks for the recent messages, without a cursor', async () => {
  assert.equal(streamed.length >= 2, true);
  const request = streamed[0];
  assert.deepEqual(request.address, { kind: 'session', sessionId: 'session-workbench' });
  assert.equal(request.assistantStream, true);
  assert.ok(request.maxMessages > 0);
  assert.equal('throughSeq' in request, false, 'a cursor was sent, which the stream does not take');
});

await verify('a stream that breaks says so rather than showing nothing', async () => {
  const brokenCtx = {
    tools: { register() {} }, effect: () => {}, logger: { debug() {} }, inject: () => () => {},
    get: (key) => (key === 'sessionController' ? {
      async create(request) { return { sessionId: request?.sessionId ?? 'session-workbench' }; },
      async list() { return [{ sessionId: 's-live' }]; },
      follow() { return (async function* generate() { yield { type: 'turn/start', seq: 1, data: { turn: 1 } }; throw new Error('the session log was pruned'); })(); },
    } : undefined),
  };
  const broken = apply(brokenCtx, { viewer: true, viewerPort: 0, profileDir: `/tmp/jev-chat-broken-${process.pid}` });
  await new Promise((resolve) => setTimeout(resolve, 300));
  const frames = await readStream(new URL('chat/stream', broken.viewer.url));
  const error = frames.find((frame) => frame.kind === 'error');
  assert.ok(error, `the break was silent: ${JSON.stringify(frames)}`);
  assert.match(error.text, /pruned/);
  await broken.viewer.close();
});

await streamHandle.viewer.close();
await handle.viewer.close();
await handle.sessions?.closeAll?.().catch?.(() => {});

console.log(`\n===== ${failures} failure(s) =====`);
process.exit(failures === 0 ? 0 : 1);
