/**
 * Reading a conversation out of the platform's event stream.
 *
 * Every shape here was read from the platform's live contract, so these are the shapes the real
 * frames have — and the frames that carry no message are asserted to produce nothing rather
 * than an empty bubble, because a transcript padded with blanks looks like a conversation that
 * happened when it did not.
 *
 * Run: node test/transcript-check.mjs
 */

import './isolate.mjs';
import assert from 'node:assert/strict';

const { textOf, normalizeFrame, appendMessage, describeEvent } = await import('../lib/transcript.js');

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

const userEvent = (seq, text) => ({
  type: 'user/message',
  seq,
  time: 1700000000000 + seq,
  data: { id: 'm-' + seq, role: 'user', content: [{ type: 'text', text }], source: 'user' },
});
const assistantEvent = (seq, text) => ({
  type: 'assistant/message',
  seq,
  time: 1700000000000 + seq,
  data: { turn: 1, step: 1, message: { id: 'a-' + seq, role: 'assistant', content: [{ type: 'text', text }], source: 'model' } },
});

await verify('a text message is read out of its content blocks', async () => {
  assert.equal(textOf({ content: [{ type: 'text', text: '你好' }] }), '你好');
  assert.equal(textOf({ content: [{ type: 'text', text: 'a' }, { type: 'image', data: 'x' }, { type: 'text', text: 'b' }] }), 'a\nb');
  assert.equal(textOf({ content: [] }), '');
  assert.equal(textOf(null), '');
  assert.equal(textOf({ content: 'plain' }), 'plain');
});

await verify('a user message becomes a message, in the shape the panel renders', async () => {
  const message = normalizeFrame(userEvent(4, '筛选前 20 个'));
  assert.equal(message.role, 'user');
  assert.equal(message.text, '筛选前 20 个');
  assert.equal(message.at, 1700000000004);
  assert.ok(message.id.includes('4'), `the id does not carry the sequence: ${message.id}`);
});

await verify('an assistant message is read from its event, not from the reply text being nearby', async () => {
  const message = normalizeFrame(assistantEvent(9, '好的，我来筛。'));
  assert.equal(message.role, 'assistant');
  assert.equal(message.text, '好的，我来筛。');
});

await verify('a history record wrapping the event reads the same as the bare event', async () => {
  // `page` yields { type: 'event', event: … } while a stream may yield the event itself.
  const wrapped = normalizeFrame({ type: 'event', event: userEvent(1, '包一层') });
  const bare = normalizeFrame(userEvent(1, '包一层'));
  assert.deepEqual(wrapped, bare);
});

await verify('frames that are not messages produce no message', async () => {
  for (const frame of [
    { type: 'turn/start', seq: 1, data: { turn: 1 } },
    { type: 'tool/call', seq: 2, data: { name: 'bash' } },
    { type: 'user/message', seq: 3, data: { id: 'm', role: 'user', content: [] } },
    null, undefined, 42, 'text',
  ]) {
    assert.equal(normalizeFrame(frame), null, `produced a message from ${JSON.stringify(frame)}`);
  }
});

await verify('a message repeated by a reconnect is not shown twice', async () => {
  let log = [];
  const first = normalizeFrame(userEvent(1, '一次'));
  log = appendMessage(log, first);
  log = appendMessage(log, normalizeFrame(userEvent(1, '一次')));
  assert.equal(log.length, 1, 'the same message was appended twice');
  log = appendMessage(log, normalizeFrame(userEvent(2, '两次')));
  assert.equal(log.length, 2);
  assert.deepEqual(log.map((m) => m.text), ['一次', '两次']);
});

await verify('the transcript is bounded', async () => {
  let log = [];
  for (let i = 0; i < 260; i += 1) log = appendMessage(log, normalizeFrame(userEvent(i, 'x' + i)), { limit: 200 });
  assert.equal(log.length, 200, `kept ${log.length}`);
  assert.equal(log[0].text, 'x60', 'the wrong end was dropped');
  assert.equal(log[199].text, 'x259');
});

await verify('a turn starting or failing is reported as a status', async () => {
  assert.equal(describeEvent({ type: 'turn/start', data: { turn: 1 } }).kind, 'busy');
  assert.equal(describeEvent({ type: 'tool/call', data: { name: 'read' } }).text, '正在调用 read…');
  assert.match(describeEvent({ type: 'turn/end', data: { reason: { kind: 'error' } } }).text, /错误/);
  assert.match(describeEvent({ type: 'turn/end', data: { reason: { kind: 'aborted', reason: { kind: 'user' } } } }).text, /中断/);
  assert.equal(describeEvent({ type: 'turn/end', data: { reason: { kind: 'completed' } } }).text, '');
  assert.equal(describeEvent({ type: 'something/else' }), null);
});

console.log(`\n===== ${failures} failure(s) =====`);
process.exit(failures === 0 ? 0 : 1);
