/**
 * The contact record.
 *
 * The property under test is not "it logs". It is that a candidate cannot be contacted twice,
 * and that the guard survives a restart — which is why the restart case builds a *new* store on
 * the same file rather than reusing the instance. An in-memory guard would pass every other
 * check here and still greet someone twice after the process came back.
 *
 * The other half is the distinction the plan hangs its no-resend rule on: a click that landed
 * is not a conversation that started, so "done" and "believed done" are different statuses.
 *
 * Run: node test/records-check.mjs
 */

import './isolate.mjs';
import assert from 'node:assert/strict';
import { appendFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const { Records, validateEntry, RECORD_STATUSES, RECORD_KINDS } = await import('../lib/records.js');

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

const dir = join(tmpdir(), `dsh-scout-records-${process.pid}`);
const file = join(dir, 'contacts.jsonl');
const store = () => new Records({ file });

const intent = (over = {}) => ({
  at: '2026-10-01T10:00:00.000Z', kind: 'intent', posting: 'quality-engineer', account: 'example.test',
  identity: 'C-1001', action: 'greet', status: 'pending', name: '徐先生', url: 'https://example.test/resume/1001',
  greetingVersion: 'v1', window: 'w1', ...over,
});
const result = (status, over = {}) => intent({ kind: 'result', status, evidence: 'the page showed 已发送', ...over });

console.log('=== a line must be complete before it is written ===');
{
  const refusals = [
    ['an unknown key', intent({ nickname: 'x' })],
    ['a missing required field', (() => { const e = intent(); delete e.identity; return e; })()],
    ['a timestamp that is not a timestamp', intent({ at: 'yesterday' })],
    ['an unknown kind', intent({ kind: 'note' })],
    ['an unknown status', intent({ status: 'maybe' })],
    ['an intent claiming to be done', intent({ status: 'confirmed' })],
    ['a result that is pending', result('pending')],
  ];
  for (const [label, entry] of refusals) {
    let threw = null;
    try { validateEntry(entry); } catch (error) { threw = error.message; }
    await verify(`refuses ${label}`, async () => {
      assert.ok(threw, 'the entry was accepted');
      assert.match(threw, /invalid record entry: /);
    });
  }
  await verify('the vocabulary is closed', async () => {
    assert.deepEqual(RECORD_KINDS, ['intent', 'result']);
    assert.deepEqual(RECORD_STATUSES, ['pending', 'executed_unverified', 'confirmed', 'failed']);
  });
  await verify('a refused entry never reaches the file', async () => {
    const { access } = await import('node:fs/promises');
    const path = join(dir, 'refused.jsonl');
    await assert.rejects(() => new Records({ file: path }).append(intent({ status: 'nope' })));
    // The file must not exist at all. An absent file reads as an empty history by design — that
    // is "never contacted", not an error — so absence is asserted directly rather than through
    // readAll, which would also pass on a file of blank lines.
    await assert.rejects(() => access(path), 'a refused entry created the file anyway');
  });
}

console.log('\n=== the file ===');
await verify('lines round-trip in order', async () => {
  const s = store();
  await s.append(intent());
  await s.append(result('confirmed'));
  const entries = await s.readAll();
  assert.equal(entries.length, 2);
  assert.equal(entries[0].kind, 'intent');
  assert.equal(entries[1].status, 'confirmed');
});

await verify('concurrent appends do not interleave', async () => {
  const s = new Records({ file: join(dir, 'concurrent.jsonl') });
  await Promise.all(Array.from({ length: 25 }, (_, i) => s.append(intent({ identity: `C-${2000 + i}` }))));
  const entries = await s.readAll();
  assert.equal(entries.length, 25, `${entries.length} of 25 lines survived`);
  assert.equal(new Set(entries.map((e) => e.identity)).size, 25);
});

await verify('an unreadable line throws and names itself', async () => {
  const path = join(dir, 'corrupt.jsonl');
  await appendFile(path, `${JSON.stringify(intent())}\n{ not json\n`, 'utf8');
  await assert.rejects(() => new Records({ file: path }).readAll(), /unreadable line 2/);
});

console.log('\n=== the guard that matters ===');
await verify('a candidate with no record may proceed', async () => {
  const decision = await store().decide('C-9999', { account: 'example.test', action: 'greet' });
  assert.equal(decision.skip, false);
});

for (const [status, why] of [
  ['pending', 'an intent whose outcome was never recorded'],
  ['confirmed', 'a confirmed send'],
  ['executed_unverified', 'a send that was never confirmed'],
]) {
  await verify(`${status} blocks a second send (${why})`, async () => {
    const path = join(dir, `guard-${status}.jsonl`);
    const s = new Records({ file: path });
    await s.append(intent({ identity: 'C-1' }));
    if (status !== 'pending') await s.append(result(status, { identity: 'C-1' }));
    const decision = await s.decide('C-1', { account: 'example.test', action: 'greet' });
    assert.equal(decision.skip, true, `a ${status} record did not block`);
    assert.ok(decision.reason.length > 0, 'the refusal gave no reason');
    assert.equal(decision.status, status);
  });
}

await verify('an explicit failure leaves the candidate retryable', async () => {
  const path = join(dir, 'guard-failed.jsonl');
  const s = new Records({ file: path });
  await s.append(intent({ identity: 'C-1' }));
  await s.append(result('failed', { identity: 'C-1' }));
  const decision = await s.decide('C-1', { account: 'example.test', action: 'greet' });
  assert.equal(decision.skip, false, 'a failed attempt blocked a retry');
});

await verify('the guard survives a restart', async () => {
  const path = join(dir, 'restart.jsonl');
  await new Records({ file: path }).append(intent({ identity: 'C-restart' }));
  // A different instance, as a restarted process would build: nothing is carried in memory.
  const decision = await new Records({ file: path }).decide('C-restart', { account: 'example.test', action: 'greet' });
  assert.equal(decision.skip, true, 'an unresolved intent was forgotten across a restart');
});

await verify('an identity that cannot be deduplicated is refused, not guessed', async () => {
  const decision = await store().decide('', { account: 'example.test', action: 'greet' });
  assert.equal(decision.skip, true);
  assert.match(decision.reason, /no stable identity/);
});

await verify('the same person on two accounts is two conversations', async () => {
  const path = join(dir, 'accounts.jsonl');
  const s = new Records({ file: path });
  await s.append(intent({ identity: 'C-1', account: 'a.test' }));
  await s.append(intent({ identity: 'C-1', account: 'b.test' }));
  const table = await s.summarise();
  assert.equal(table.length, 2, 'identities from different accounts were merged');
  assert.equal((await s.decide('C-1', { account: 'a.test' })).skip, true);
});

console.log('\n=== the one table ===');
await verify('the latest line wins and nothing known is cleared', async () => {
  const path = join(dir, 'table.jsonl');
  const s = new Records({ file: path });
  await s.append(intent({ identity: 'C-1', name: '徐先生' }));
  await s.append(result('confirmed', { identity: 'C-1', name: undefined, evidence: '页面显示已发送' }));
  const [row] = await s.summarise();
  assert.equal(row.status, 'confirmed');
  assert.equal(row.name, '徐先生', 'a later line that omitted the name erased it');
  assert.equal(row.attempts, 2);
  assert.equal(row.evidence, '页面显示已发送');
  assert.equal(row.firstAt, '2026-10-01T10:00:00.000Z');
});

await rm(dir, { recursive: true, force: true }).catch(() => {});
console.log(`\n===== ${failures} failure(s) =====`);
process.exit(failures === 0 ? 0 : 1);
