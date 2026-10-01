/**
 * One authorisation per task, and the account total it spends from.
 *
 * The load-bearing check is the race: two windows arriving at the last slot at the same
 * moment must not both send. That is why `reserve` is synchronous — the check and the take are
 * one step — and the test drives it the way the run does, from two concurrent paths, rather
 * than asserting that the code looks atomic.
 *
 * The other half is that a slot is only given back for a *known* failure. A send whose result
 * is unknown keeps its slot, because the person may already be in a conversation.
 *
 * Run: node test/authorize-check.mjs
 */

import './isolate.mjs';
import assert from 'node:assert/strict';
import { appendFile, rm } from 'node:fs/promises';

const {
  createAuthorization, validateAuthorization, authorizationCovers, Spend,
  recordAuthorization, readAuthorizations, authorisationFile, AUTHORISABLE_ACTIONS,
} = await import('../lib/authorize.js');

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

const base = {
  account: 'zhaopin:马某',
  posting: 'quality-engineer',
  postingVersion: 3,
  siteVersion: 1,
  actions: ['greet'],
  limit: 20,
  expiresAt: '2027-01-01T00:00:00.000Z',
  greetingVersion: 'v2',
};
const request = { account: base.account, posting: base.posting, postingVersion: 3, siteVersion: 1, greetingVersion: 'v2', action: 'greet' };

console.log('=== the range has to be nameable ===');
{
  const refusal = (label, input) => verify(label, async () => {
    let threw = null;
    try { createAuthorization(input); } catch (error) { threw = error.message; }
    assert.ok(threw, 'the authorisation was accepted');
    assert.match(threw, /invalid authorisation: /);
  });
  await refusal('an unknown key', { ...base, anything: true });
  await refusal('no actions', { ...base, actions: [] });
  await refusal('an action kind that does not exist', { ...base, actions: ['send-anything'] });
  await refusal('no posting', { ...base, posting: '' });
  await refusal('a negative limit', { ...base, limit: -1 });
  await refusal('a non-integer limit', { ...base, limit: 2.5 });
  await refusal('an expiry that is not a time', { ...base, expiresAt: 'eventually' });

  await verify('a misspelled key is refused rather than silently dropped', async () => {
    // `expires` instead of `expiresAt` would otherwise build an authorisation with no expiry
    // while the caller believes it set one.
    let threw = null;
    try { createAuthorization({ ...base, expires: '2027-01-01T00:00:00.000Z' }); } catch (error) { threw = error.message; }
    assert.ok(threw, 'a misspelled key was silently discarded');
    assert.match(threw, /unknown key "expires"/);
  });

  await verify('the vocabulary is closed', async () => {
    assert.deepEqual(AUTHORISABLE_ACTIONS, ['greet', 'message', 'apply']);
  });

  await verify('creating one fills in its identity and time, and drops absent keys', async () => {
    const authorization = createAuthorization({ ...base, note: undefined });
    assert.ok(authorization.id.startsWith('auth-'));
    assert.ok(!Number.isNaN(Date.parse(authorization.at)));
    assert.ok(!('note' in authorization), 'an absent key survived, so it would not round-trip');
    assert.deepEqual(Object.keys(JSON.parse(JSON.stringify(authorization))).sort(), Object.keys(authorization).sort());
  });
}

console.log('\n=== what it covers, and what ends it ===');
{
  const authorization = createAuthorization(base);

  await verify('a request inside the range is covered', async () => {
    assert.equal(authorizationCovers(authorization, request).ok, true);
  });

  const ends = [
    ['a different account', { account: 'other' }, /account/],
    ['a different posting', { posting: 'another-role' }, /posting/],
    ['an edited posting', { postingVersion: 4 }, /posting has changed/],
    ['an updated site configuration', { siteVersion: 2 }, /site configuration has changed/],
    ['changed greeting text', { greetingVersion: 'v3' }, /greeting text has changed/],
    ['an action kind outside the range', { action: 'message' }, /covers greet/],
  ];
  for (const [label, change, pattern] of ends) {
    await verify(`${label} ends it, and says so`, async () => {
      const result = authorizationCovers(authorization, { ...request, ...change });
      assert.equal(result.ok, false);
      assert.match(result.reason, pattern, `the reason was: ${result.reason}`);
    });
  }

  await verify('an expired authorisation is not usable', async () => {
    const result = authorizationCovers(authorization, request, new Date('2027-06-01T00:00:00.000Z'));
    assert.equal(result.ok, false);
    assert.match(result.reason, /expired/);
  });

  await verify('an authorisation with no expiry does not expire', async () => {
    const open = createAuthorization({ ...base, expiresAt: undefined });
    assert.equal(authorizationCovers(open, request, new Date('2030-01-01T00:00:00.000Z')).ok, true);
  });
}

console.log('\n=== the limit is taken before the send, not counted after ===');
{
  await verify('a slot is taken and the remainder reported', async () => {
    const spend = new Spend({ limit: 3 });
    const authorization = createAuthorization({ ...base, limit: 3 });
    const first = spend.reserve(request, { authorization });
    assert.equal(first.ok, true);
    assert.equal(first.remaining, 2);
    assert.equal(spend.spent, 1);
    assert.equal(spend.slots.length, 1);
  });

  await verify('no authorisation means no send', async () => {
    const refused = new Spend({ limit: 3 }).reserve(request, {});
    assert.equal(refused.ok, false);
    assert.match(refused.reason, /no authorisation/);
  });

  await verify('an authorisation that no longer covers the request is refused', async () => {
    const spend = new Spend({ limit: 3 });
    const authorization = createAuthorization({ ...base, actions: ['message'] });
    const refused = spend.reserve(request, { authorization });
    assert.equal(refused.ok, false);
    assert.match(refused.reason, /covers message/);
    assert.equal(spend.spent, 0, 'a refused send still consumed quota');
  });

  await verify('the limit stops the send rather than the count', async () => {
    const spend = new Spend({ limit: 2 });
    const authorization = createAuthorization({ ...base, limit: 2 });
    assert.equal(spend.reserve(request, { authorization }).ok, true);
    assert.equal(spend.reserve(request, { authorization }).ok, true);
    const third = spend.reserve(request, { authorization });
    assert.equal(third.ok, false);
    assert.match(third.reason, /limit of 2/);
    assert.equal(spend.spent, 2);
  });

  await verify('two windows reaching the last slot cannot both win', async () => {
    const spend = new Spend({ limit: 1 });
    const authorization = createAuthorization({ ...base, limit: 1 });
    // Both windows check and take from their own concurrent path, as the run does.
    const results = await Promise.all([
      Promise.resolve().then(() => spend.reserve(request, { authorization })),
      Promise.resolve().then(() => spend.reserve(request, { authorization })),
    ]);
    assert.equal(results.filter((entry) => entry.ok).length, 1, `both windows won: ${JSON.stringify(results)}`);
    assert.equal(spend.spent, 1);
  });

  await verify('a slot is given back only for a known failure', async () => {
    const spend = new Spend({ limit: 1 });
    const authorization = createAuthorization({ ...base, limit: 1 });
    const first = spend.reserve(request, { authorization });
    // Unknown outcome: the person may have been contacted, so the quota stays spent.
    assert.equal(spend.release(first.token, { outcome: 'unconfirmed' }), false);
    assert.equal(spend.remaining, 0, 'an unknown outcome freed the quota');
    assert.equal(spend.release(first.token, { outcome: 'failed' }), true);
    assert.equal(spend.remaining, 1);
    assert.equal(spend.release('slot-nope', { outcome: 'failed' }), false);
  });

  await verify('raising the limit lets more through', async () => {
    const spend = new Spend({ limit: 1 });
    const authorization = createAuthorization({ ...base, limit: 1 });
    assert.equal(spend.reserve(request, { authorization }).ok, true);
    assert.equal(spend.reserve(request, { authorization }).ok, false);
    spend.setLimit(3);
    assert.equal(spend.reserve(request, { authorization }).ok, true);
  });
}

console.log('\n=== the authorisation itself is on record ===');
{
  await verify('it round-trips with its range and time', async () => {
    const authorization = createAuthorization({ ...base, note: 'user approved 20 greetings' });
    const file = await recordAuthorization(authorization);
    assert.equal(file, authorisationFile());
    const entries = await readAuthorizations();
    assert.equal(entries.length >= 1, true);
    const stored = entries[entries.length - 1];
    assert.equal(stored.limit, 20);
    assert.deepEqual(stored.actions, ['greet']);
    assert.ok(!Number.isNaN(Date.parse(stored.at)), 'the record carries no time');
  });

  await verify('an unreadable line throws rather than being skipped', async () => {
    await appendFile(authorisationFile(), '{ not json\n', 'utf8');
    await assert.rejects(() => readAuthorizations(), /unreadable line/);
  });

  await verify('a record that would not validate is refused before it is written', async () => {
    const before = (await readAuthorizations().catch(() => [])).length;
    await assert.rejects(() => recordAuthorization({ ...base, id: 'x', at: new Date().toISOString(), actions: ['nope'] }), /invalid authorisation/);
    assert.equal((await readAuthorizations().catch(() => [])).length, before, 'an invalid authorisation reached the file');
  });
}

await rm(authorisationFile(), { force: true }).catch(() => {});
console.log(`\n===== ${failures} failure(s) =====`);
process.exit(failures === 0 ? 0 : 1);
